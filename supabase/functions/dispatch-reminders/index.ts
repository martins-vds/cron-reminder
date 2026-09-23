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
    | { kind: 'cron'; expression: string; startAt?: string; endAt?: string };
  timezone: string;
  sound:
    | { mode: 'default' | 'silent' | 'vibrate' }
    | { mode: 'bundled'; key: string };
}

Deno.serve(async (request) => {
  if (request.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const client = createClient(
    required('SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
  );
  const now = new Date();
  const minuteStart = new Date(now);
  minuteStart.setUTCSeconds(0, 0);
  let delivered = await dispatchPostponed(client, now);
  const { data, error } = await client
    .from('reminders')
    .select('id,owner_id,title,notes,schedule,timezone,sound')
    .eq('status', 'active');
  if (error) return json({ error: 'Unable to load reminders' }, 500);

  for (const reminder of (data ?? []) as ReminderRow[]) {
    let due: Date | null = null;
    try {
      due = dueAt(reminder, minuteStart);
    } catch {
      continue;
    }
    if (!due) continue;
    const occurrenceId = `${reminder.id}:${due.toISOString()}`;
    const { error: occurrenceError } = await client
      .from('occurrences')
      .insert({
        id: occurrenceId,
        reminder_id: reminder.id,
        owner_id: reminder.owner_id,
        scheduled_at: due.toISOString(),
        status: 'triggered',
      });
    if (occurrenceError?.code === '23505') continue;
    if (occurrenceError) continue;

    delivered += await deliverToDevices(client, reminder, occurrenceId);
    await recordHistory(client, reminder, occurrenceId);
  }
  await client.rpc('delete_expired_history');
  return json({ delivered });
});

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
      .select('id,owner_id,title,notes,schedule,timezone,sound')
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
    delivered += await deliverToDevices(
      client,
      reminder as ReminderRow,
      occurrence.id,
    );
    await recordHistory(client, reminder as ReminderRow, occurrence.id);
  }
  return delivered;
}

async function deliverToDevices(
  client: ReturnType<typeof createClient>,
  reminder: ReminderRow,
  occurrenceId: string,
): Promise<number> {
  const { data: devices } = await client
    .from('devices')
    .select('platform,token')
    .eq('owner_id', reminder.owner_id)
    .eq('enabled', true);
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

function dueAt(reminder: ReminderRow, minute: Date): Date | null {
  if (reminder.schedule.kind === 'once') {
    const date = new Date(reminder.schedule.at);
    return date >= minute && date < new Date(minute.getTime() + 60_000)
      ? date
      : null;
  }
  const previousMinute = new Date(minute.getTime() - 60_000);
  const next = CronExpressionParser.parse(reminder.schedule.expression, {
    currentDate: previousMinute,
    startDate: reminder.schedule.startAt,
    endDate: reminder.schedule.endAt,
    tz: reminder.timezone,
  })
    .next()
    .toDate();
  return next >= minute && next < new Date(minute.getTime() + 60_000)
    ? next
    : null;
}

async function sendExpoPush(
  token: string,
  payload: Record<string, unknown>,
  sound: ReminderRow['sound'],
) {
  const nativeSound =
    sound.mode === 'silent' || sound.mode === 'vibrate'
      ? undefined
      : sound.mode === 'bundled'
        ? 'default'
        : 'default';
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
  await webpush.sendNotification(JSON.parse(token), JSON.stringify(payload));
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
