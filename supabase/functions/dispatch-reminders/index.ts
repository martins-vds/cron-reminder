import { createClient } from 'npm:@supabase/supabase-js@2.117.1';
import { CronExpressionParser } from 'npm:cron-parser@5.10.1';
import webpush from 'npm:web-push@3.6.7';

interface ReminderRow {
  id: string;
  owner_id: string;
  title: string;
  notes: string;
  schedule:
    | { kind: 'once'; at: string }
    | {
        kind: 'cron';
        expression: string;
        startAt?: string;
        endAt?: string;
        occurrenceLimit?: number;
      };
  timezone: string;
  sound: { mode: 'default' | 'silent' | 'vibrate' };
  created_at: string;
}

const DISPATCH_STATE_ID = true;
const MAX_OCCURRENCES_PER_RUN = 500;
const REMINDER_PAGE_SIZE = 1_000;
const ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];

Deno.serve(async (request) => {
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret || request.headers.get('x-cron-secret') !== cronSecret) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const client = createClient(
    required('SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
  );
  const now = new Date();
  const minuteStart = new Date(now);
  minuteStart.setUTCSeconds(0, 0);
  const windowEnd = new Date(minuteStart.getTime() + 60_000);
  const { data: state, error: stateError } = await client
    .from('dispatch_state')
    .select('last_dispatched_at')
    .eq('id', DISPATCH_STATE_ID)
    .maybeSingle();
  if (stateError) return json({ error: 'Unable to load dispatch state' }, 500);
  const windowStart = state?.last_dispatched_at
    ? new Date(state.last_dispatched_at)
    : new Date(minuteStart.getTime() - 60_000);
  let nextWindowStart = windowEnd;
  let delivered = await dispatchPostponed(client, now);

  let reminders: ReminderRow[];
  try {
    reminders = await loadReminders(client);
  } catch {
    return json({ error: 'Unable to load reminders' }, 500);
  }

  for (const reminder of reminders) {
    let dueResult: ReturnType<typeof dueOccurrences>;
    try {
      dueResult = dueOccurrences(reminder, windowStart, windowEnd);
    } catch {
      continue;
    }
    let occurrences = dueResult.occurrences;
    if (!occurrences.length) continue;

    if (
      reminder.schedule.kind === 'cron' &&
      reminder.schedule.occurrenceLimit !== undefined
    ) {
      const { count, error: countError } = await client
        .from('occurrences')
        .select('id', { count: 'exact', head: true })
        .eq('reminder_id', reminder.id);
      if (countError) return json({ error: 'Unable to count occurrences' }, 500);
      const remaining = reminder.schedule.occurrenceLimit - (count ?? 0);
      if (remaining <= 0) continue;
      if (remaining < occurrences.length) dueResult.resumeAt = undefined;
      occurrences = occurrences.slice(0, remaining);
    }
    if (
      dueResult.resumeAt &&
      dueResult.resumeAt.getTime() < nextWindowStart.getTime()
    ) {
      nextWindowStart = dueResult.resumeAt;
    }

    for (const due of occurrences) {
      const occurrenceId = `${reminder.id}:${due.toISOString()}`;
      const missed = due < minuteStart;
      const { error: occurrenceError } = await client
        .from('occurrences')
        .insert({
          id: occurrenceId,
          reminder_id: reminder.id,
          owner_id: reminder.owner_id,
          scheduled_at: due.toISOString(),
          status: missed ? 'missed' : 'triggered',
        });
      if (occurrenceError?.code === '23505') {
        let claimed: boolean;
        try {
          claimed = await claimUndelivered(client, occurrenceId);
        } catch {
          return json({ error: 'Unable to claim occurrence' }, 500);
        }
        if (claimed)
          delivered += await deliverOccurrence(client, reminder, occurrenceId);
        continue;
      }
      if (occurrenceError)
        return json({ error: 'Unable to create occurrence' }, 500);

      if (missed) {
        await client.from('history').insert({
          reminder_id: reminder.id,
          occurrence_id: occurrenceId,
          owner_id: reminder.owner_id,
          event_type: 'missed',
        });
        continue;
      }

      delivered += await deliverOccurrence(client, reminder, occurrenceId);
    }
  }

  const { error: updateStateError } = await client.from('dispatch_state').upsert({
    id: DISPATCH_STATE_ID,
    last_dispatched_at: nextWindowStart.toISOString(),
  });
  if (updateStateError)
    return json({ error: 'Unable to update dispatch state' }, 500);
  await client.rpc('delete_expired_history');
  return json({ delivered });
});

async function loadReminders(
  client: ReturnType<typeof createClient>,
): Promise<ReminderRow[]> {
  const reminders: ReminderRow[] = [];
  for (let from = 0; ; from += REMINDER_PAGE_SIZE) {
    const { data, error } = await client
      .from('reminders')
      .select(
        'id,owner_id,title,notes,schedule,timezone,sound,created_at',
      )
      .eq('status', 'active')
      .order('id')
      .range(from, from + REMINDER_PAGE_SIZE - 1);
    if (error) throw error;
    reminders.push(...((data ?? []) as ReminderRow[]));
    if (!data || data.length < REMINDER_PAGE_SIZE) return reminders;
  }
}

async function claimUndelivered(
  client: ReturnType<typeof createClient>,
  occurrenceId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from('occurrences')
    .update({ status: 'triggered' })
    .eq('id', occurrenceId)
    .is('delivered_at', null)
    .in('status', ['triggered', 'delivery-failed'])
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function dispatchPostponed(
  client: ReturnType<typeof createClient>,
  now: Date,
): Promise<number> {
  const { data } = await client
    .from('occurrences')
    .select('id,reminder_id')
    .eq('status', 'postponed')
    .lte('snoozed_until', now.toISOString());
  let delivered = 0;
  for (const occurrence of data ?? []) {
    const { data: reminder } = await client
      .from('reminders')
      .select('id,owner_id,title,notes,schedule,timezone,sound,created_at')
      .eq('id', occurrence.reminder_id)
      .eq('status', 'active')
      .maybeSingle();
    if (!reminder) continue;
    const { data: claimed } = await client
      .from('occurrences')
      .update({ status: 'triggered', acted_at: now.toISOString() })
      .eq('id', occurrence.id)
      .eq('status', 'postponed')
      .select('id')
      .maybeSingle();
    if (!claimed) continue;
    delivered += await deliverOccurrence(
      client,
      reminder as ReminderRow,
      occurrence.id,
    );
  }
  return delivered;
}

async function deliverOccurrence(
  client: ReturnType<typeof createClient>,
  reminder: ReminderRow,
  occurrenceId: string,
): Promise<number> {
  try {
    const delivered = await deliverToDevices(client, reminder, occurrenceId);
    await recordHistory(client, reminder, occurrenceId);
    await client
      .from('occurrences')
      .update({ delivered_at: new Date().toISOString() })
      .eq('id', occurrenceId);
    return delivered;
  } catch {
    await client
      .from('occurrences')
      .update({ status: 'delivery-failed' })
      .eq('id', occurrenceId);
    await client.from('history').insert({
      reminder_id: reminder.id,
      occurrence_id: occurrenceId,
      owner_id: reminder.owner_id,
      event_type: 'delivery-failed',
    });
    return 0;
  }
}

async function deliverToDevices(
  client: ReturnType<typeof createClient>,
  reminder: ReminderRow,
  occurrenceId: string,
): Promise<number> {
  const { data: devices, error } = await client
    .from('devices')
    .select('platform,token')
    .eq('owner_id', reminder.owner_id)
    .eq('enabled', true);
  if (error) throw error;
  let delivered = 0;
  for (const device of devices ?? []) {
    const payload = {
      title: reminder.title,
      body: reminder.notes,
      data: { reminderId: reminder.id, occurrenceId },
    };
    try {
      if (device.platform === 'web') {
        await sendWebPush(device.token, payload);
      } else {
        await sendExpoPush(device.token, payload, reminder.sound);
      }
      delivered++;
    } catch {
      await client.from('history').insert({
        reminder_id: reminder.id,
        occurrence_id: occurrenceId,
        owner_id: reminder.owner_id,
        event_type: 'delivery-failed',
      });
    }
  }
  return delivered;
}

async function recordHistory(
  client: ReturnType<typeof createClient>,
  reminder: ReminderRow,
  occurrenceId: string,
) {
  await client.from('history').insert({
    reminder_id: reminder.id,
    occurrence_id: occurrenceId,
    owner_id: reminder.owner_id,
    event_type: 'triggered',
  });
}

function dueOccurrences(
  reminder: ReminderRow,
  windowStart: Date,
  windowEnd: Date,
): { occurrences: Date[]; resumeAt?: Date } {
  const reminderCreatedAt = new Date(reminder.created_at);
  const lowerBound =
    reminderCreatedAt > windowStart ? reminderCreatedAt : windowStart;
  if (reminder.schedule.kind === 'once') {
    const date = new Date(reminder.schedule.at);
    return {
      occurrences:
        date >= lowerBound && date < windowEnd ? [date] : [],
    };
  }
  const results: Date[] = [];
  const interval = CronExpressionParser.parse(reminder.schedule.expression, {
    currentDate: new Date(lowerBound.getTime() - 1),
    startDate: reminder.schedule.startAt,
    endDate: reminder.schedule.endAt,
    tz: reminder.timezone,
  });
  for (let i = 0; i <= MAX_OCCURRENCES_PER_RUN; i++) {
    let date: Date;
    try {
      date = interval.next().toDate();
    } catch {
      break;
    }
    if (date < lowerBound) continue;
    if (date >= windowEnd) break;
    results.push(date);
  }
  if (results.length > MAX_OCCURRENCES_PER_RUN) {
    const occurrences = results.slice(0, MAX_OCCURRENCES_PER_RUN);
    return {
      occurrences,
      resumeAt: occurrences[occurrences.length - 1],
    };
  }
  return { occurrences: results };
}

async function sendExpoPush(
  token: string,
  payload: Record<string, unknown>,
  sound: ReminderRow['sound'],
) {
  const nativeSound =
    sound.mode === 'silent' || sound.mode === 'vibrate' ? undefined : 'default';
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: token,
      ...payload,
      sound: nativeSound,
      categoryId: 'reminder',
    }),
  });
  if (!response.ok) throw new Error('Expo push failed');
  const ticket: unknown = await response.json();
  if (
    typeof ticket !== 'object' ||
    ticket === null ||
    typeof (ticket as { data?: unknown }).data !== 'object' ||
    (ticket as { data: { status?: unknown } }).data.status !== 'ok'
  ) {
    throw new Error('Expo rejected the push notification');
  }
}

async function sendWebPush(
  token: string,
  payload: Record<string, unknown>,
) {
  webpush.setVapidDetails(
    required('VAPID_SUBJECT'),
    required('VAPID_PUBLIC_KEY'),
    required('VAPID_PRIVATE_KEY'),
  );
  await webpush.sendNotification(
    parseWebPushSubscription(token),
    JSON.stringify(payload),
  );
}

function parseWebPushSubscription(token: string): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    throw new Error('Web push subscription is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Web push subscription is not an object');
  }
  const { endpoint, keys } = parsed as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  if (typeof endpoint !== 'string') {
    throw new Error('Web push subscription has no endpoint');
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Web push endpoint is not a valid URL');
  }
  if (url.protocol !== 'https:' || !isAllowedPushHost(url.hostname)) {
    throw new Error('Web push endpoint host is not allowed');
  }
  if (typeof keys?.p256dh !== 'string' || typeof keys.auth !== 'string') {
    throw new Error('Web push subscription has no keys');
  }
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function isAllowedPushHost(hostname: string): boolean {
  return ALLOWED_PUSH_HOSTS.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
}

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
