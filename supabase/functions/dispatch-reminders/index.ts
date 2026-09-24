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

interface DeviceDeliveryResult {
  delivered: number;
  retryableFailures: number;
}

const DISPATCH_STATE_ID = true;
const MAX_OCCURRENCES_PER_RUN = 500;
const REMINDER_PAGE_SIZE = 1_000;
const DELIVERY_LEASE_MS = 5 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;
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
  let delivered = await dispatchPendingDeliveries(client);
  delivered += await dispatchPostponed(client, now);

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
      if (missed) {
        const { error: missedError } = await client.rpc(
          'record_missed_occurrence',
          {
            p_occurrence_id: occurrenceId,
            p_reminder_id: reminder.id,
            p_owner_id: reminder.owner_id,
            p_scheduled_at: due.toISOString(),
          },
        );
        if (missedError)
          return json({ error: 'Unable to record missed occurrence' }, 500);
        continue;
      }

      const { error: occurrenceError } = await client
        .from('occurrences')
        .insert({
          id: occurrenceId,
          reminder_id: reminder.id,
          owner_id: reminder.owner_id,
          scheduled_at: due.toISOString(),
          status: 'triggered',
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

      if (await claimUndelivered(client, occurrenceId))
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
  const now = new Date();
  const { data, error } = await client
    .from('occurrences')
    .update({ status: 'delivering', acted_at: now.toISOString() })
    .eq('id', occurrenceId)
    .is('delivered_at', null)
    .lt('delivery_attempts', MAX_DELIVERY_ATTEMPTS)
    .or(deliverableFilter(now))
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function dispatchPendingDeliveries(
  client: ReturnType<typeof createClient>,
): Promise<number> {
  const now = new Date();
  const { data, error } = await client
    .from('occurrences')
    .select('id,reminder_id')
    .is('delivered_at', null)
    .lt('delivery_attempts', MAX_DELIVERY_ATTEMPTS)
    .or(deliverableFilter(now));
  if (error) throw error;
  let delivered = alreadyDelivered.size;
  for (const occurrence of data ?? []) {
    const reminder = await loadActiveReminder(client, occurrence.reminder_id);
    if (!reminder) continue;
    if (!(await claimUndelivered(client, occurrence.id))) continue;
    delivered += await deliverOccurrence(client, reminder, occurrence.id);
  }
  return delivered;
}

async function dispatchPostponed(
  client: ReturnType<typeof createClient>,
  now: Date,
): Promise<number> {
  const { data, error } = await client
    .from('occurrences')
    .select('id,reminder_id')
    .eq('status', 'postponed')
    .lte('snoozed_until', now.toISOString());
  if (error) throw error;
  let delivered = 0;
  for (const occurrence of data ?? []) {
    const reminder = await loadActiveReminder(client, occurrence.reminder_id);
    if (!reminder) continue;
    const { data: claimed, error: claimError } = await client
      .from('occurrences')
      .update({ status: 'delivering', acted_at: now.toISOString() })
      .eq('id', occurrence.id)
      .eq('status', 'postponed')
      .select('id')
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue;
    delivered += await deliverOccurrence(client, reminder, occurrence.id);
  }
  return delivered;
}

async function loadActiveReminder(
  client: ReturnType<typeof createClient>,
  reminderId: string,
): Promise<ReminderRow | null> {
  const { data, error } = await client
    .from('reminders')
    .select('id,owner_id,title,notes,schedule,timezone,sound,created_at')
    .eq('id', reminderId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  return data as ReminderRow | null;
}

async function deliverOccurrence(
  client: ReturnType<typeof createClient>,
  reminder: ReminderRow,
  occurrenceId: string,
): Promise<number> {
  try {
    const result = await deliverToDevices(client, reminder, occurrenceId);
    if (result.retryableFailures > 0) {
      throw new RetryableDeliveryError(result.delivered);
    }
    await recordHistory(client, reminder, occurrenceId);
    const { error } = await client
      .from('occurrences')
      .update({ status: 'triggered', delivered_at: new Date().toISOString() })
      .eq('id', occurrenceId)
      .eq('status', 'delivering');
    if (error) throw error;
    return result.delivered;
  } catch (error) {
    await markDeliveryFailed(client, reminder, occurrenceId);
    return error instanceof RetryableDeliveryError ? error.delivered : 0;
  }
}

async function markDeliveryFailed(
  client: ReturnType<typeof createClient>,
  reminder: ReminderRow,
  occurrenceId: string,
) {
  const { data: occurrence, error: loadError } = await client
    .from('occurrences')
    .select('delivery_attempts')
    .eq('id', occurrenceId)
    .maybeSingle();
  if (loadError) throw loadError;
  const attempts =
    typeof occurrence?.delivery_attempts === 'number'
      ? occurrence.delivery_attempts + 1
      : 1;
  const retryAt =
    attempts >= MAX_DELIVERY_ATTEMPTS
      ? null
      : new Date(Date.now() + retryDelayMs(attempts)).toISOString();
  const { error: updateError } = await client
    .from('occurrences')
    .update({
      status: 'delivery-failed',
      delivery_attempts: attempts,
      next_delivery_attempt_at: retryAt,
    })
    .eq('id', occurrenceId)
    .eq('status', 'delivering');
  if (updateError) throw updateError;
  await recordHistory(client, reminder, occurrenceId, 'delivery-failed');
}

async function deliverToDevices(
  client: ReturnType<typeof createClient>,
  reminder: ReminderRow,
  occurrenceId: string,
): Promise<DeviceDeliveryResult> {
  const { data: devices, error } = await client
    .from('devices')
    .select('id,platform,token')
    .eq('owner_id', reminder.owner_id)
    .eq('enabled', true);
  if (error) throw error;
  const { data: deliveredDevices, error: deliveredDevicesError } = await client
    .from('occurrence_device_deliveries')
    .select('device_id')
    .eq('occurrence_id', occurrenceId)
    .eq('owner_id', reminder.owner_id);
  if (deliveredDevicesError) throw deliveredDevicesError;
  const alreadyDelivered = new Set(
    (deliveredDevices ?? []).map(({ device_id }) => String(device_id)),
  );
  let delivered = 0;
  let retryableFailures = 0;
  for (const device of devices ?? []) {
    if (alreadyDelivered.has(device.id)) continue;
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
      await recordDeviceDelivery(client, occurrenceId, reminder.owner_id, device.id);
      delivered++;
    } catch (error) {
      if (isPermanentDeliveryFailure(error)) {
        await disableDevice(client, device.id);
      } else {
        retryableFailures++;
      }
    }
  }
  return { delivered, retryableFailures };
}

async function recordDeviceDelivery(
  client: ReturnType<typeof createClient>,
  occurrenceId: string,
  ownerId: string,
  deviceId: string,
) {
  const { error } = await client.from('occurrence_device_deliveries').upsert({
    occurrence_id: occurrenceId,
    owner_id: ownerId,
    device_id: deviceId,
    delivered_at: new Date().toISOString(),
  });
  if (error) throw error;
}

function deliveryAttemptDueFilter(now: Date): string {
  return `next_delivery_attempt_at.is.null,next_delivery_attempt_at.lte.${now.toISOString()}`;
}

function deliverableStatusFilter(now: Date): string {
  const staleBefore = new Date(now.getTime() - DELIVERY_LEASE_MS).toISOString();
  return [
    'status.eq.triggered',
    'status.eq.delivery-failed',
    `and(status.eq.delivering,acted_at.lt.${staleBefore})`,
    'and(status.eq.delivering,acted_at.is.null)',
  ].join(',');
}

function deliverableFilter(now: Date): string {
  return `and(or(${deliveryAttemptDueFilter(now)}),or(${deliverableStatusFilter(now)}))`;
}

function retryDelayMs(attempts: number): number {
  return Math.min(
    BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1),
    MAX_RETRY_DELAY_MS,
  );
}

async function disableDevice(
  client: ReturnType<typeof createClient>,
  deviceId: string,
) {
  const { error } = await client
    .from('devices')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('id', deviceId);
  if (error) throw error;
}

function isPermanentDeliveryFailure(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'permanent' in error &&
    (error as { permanent?: unknown }).permanent === true
  ) {
    return true;
  }
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return false;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return (
    typeof statusCode === 'number' &&
    (statusCode === 400 || statusCode === 404 || statusCode === 410)
  );
}

class PermanentDeliveryError extends Error {
  permanent = true;
}

class RetryableDeliveryError extends Error {
  constructor(readonly delivered: number) {
    super('Retryable device deliveries failed');
  }
}

async function recordHistory(
  client: ReturnType<typeof createClient>,
  reminder: ReminderRow,
  occurrenceId: string,
  eventType: 'triggered' | 'delivery-failed' = 'triggered',
) {
  const { error } = await client.from('history').insert({
    reminder_id: reminder.id,
    occurrence_id: occurrenceId,
    owner_id: reminder.owner_id,
    event_type: eventType,
  });
  if (error) throw error;
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
  if (!response.ok) {
    if ([400, 404, 410].includes(response.status)) {
      throw new PermanentDeliveryError('Expo push failed permanently');
    }
    throw new Error('Expo push failed');
  }
  const ticket: unknown = await response.json();
  const data =
    typeof ticket === 'object' && ticket !== null
      ? (ticket as { data?: unknown }).data
      : undefined;
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { status?: unknown }).status === 'error' &&
    (data as { details?: { error?: unknown } }).details?.error ===
      'DeviceNotRegistered'
  ) {
    throw new PermanentDeliveryError('Expo device is not registered');
  }
  if (
    typeof data !== 'object' ||
    data === null ||
    (data as { status?: unknown }).status !== 'ok'
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
