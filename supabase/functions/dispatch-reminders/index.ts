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
  next_due_at: string | null;
}

interface DeviceDeliveryResult {
  delivered: number;
  retryableFailures: number;
}

interface DispatchWorkResult {
  delivered: number;
  processed: number;
}

interface ScheduledOccurrence {
  reminder: ReminderRow;
  due: Date;
  recorded: boolean;
}

type ServiceClient = ReturnType<typeof createClient<any>>;

const DISPATCH_STATE_ID = true;
const MAX_DISPATCH_WORK_PER_RUN = 500;
const DELIVERY_LEASE_MS = 5 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const PUSH_TIMEOUT_MS = 30_000;
const ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];
const REMINDER_SELECT =
  'id,owner_id,title,notes,schedule,timezone,sound,created_at,next_due_at';

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
    .select('last_dispatched_at,last_dispatched_reminder_id')
    .eq('id', DISPATCH_STATE_ID)
    .maybeSingle();
  if (stateError) return json({ error: 'Unable to load dispatch state' }, 500);
  const windowStart = state?.last_dispatched_at
    ? new Date(state.last_dispatched_at)
    : new Date(minuteStart.getTime() - 60_000);
  const windowStartReminderId =
    typeof state?.last_dispatched_reminder_id === 'string'
      ? state.last_dispatched_reminder_id
      : null;
  let remainingWork = MAX_DISPATCH_WORK_PER_RUN;
  const pending = await dispatchPendingDeliveries(client, remainingWork);
  let delivered = pending.delivered;
  remainingWork -= pending.processed;
  const postponed = await dispatchPostponed(client, now, remainingWork);
  delivered += postponed.delivered;
  remainingWork -= postponed.processed;

  let reminders: ReminderRow[] = [];
  let reminderPageTruncated = false;
  let nextReminderCursor: { due: Date; id: string } | null = null;
  if (remainingWork > 0) {
    try {
      const page = await loadReminders(client, windowEnd, remainingWork);
      reminders = page.reminders;
      reminderPageTruncated = page.truncated;
      nextReminderCursor = page.nextCursor;
    } catch {
      return json({ error: 'Unable to load reminders' }, 500);
    }
  }

  const scheduled: ScheduledOccurrence[] = [];
  const exhaustedReminderIds = new Set<string>();
  let candidateGenerationTruncated = false;
  let candidateCapacity = remainingWork + 1;
  for (const reminder of remainingWork > 0 ? reminders : []) {
    if (candidateCapacity <= 0) {
      candidateGenerationTruncated = true;
      break;
    }
    let dueResult: ReturnType<typeof dueOccurrences>;
    try {
      dueResult = dueOccurrences(
        reminder,
        windowStart,
        windowEnd,
        candidateCapacity,
      );
    } catch {
      continue;
    }
    let occurrences = dueResult.occurrences;
    if (!occurrences.length) continue;

    if (
      reminder.schedule.kind === 'cron' &&
      reminder.schedule.occurrenceLimit !== undefined
    ) {
      const recordedIds = await loadRecordedOccurrenceIds(
        client,
        reminder.id,
        occurrences,
      );
      const { count, error: countError } = await client
        .from('occurrences')
        .select('id', { count: 'exact', head: true })
        .eq('reminder_id', reminder.id);
      if (countError) return json({ error: 'Unable to count occurrences' }, 500);
      const remaining = reminder.schedule.occurrenceLimit - (count ?? 0);
      if (remaining <= 0) {
        exhaustedReminderIds.add(reminder.id);
        dueResult.truncated = false;
        continue;
      }
      const unrecorded = occurrences.filter(
        (due) =>
          !recordedIds.has(`${reminder.id}:${due.toISOString()}`),
      );
      if (remaining < unrecorded.length) dueResult.truncated = false;
      const allowedUnrecorded = new Set(
        unrecorded
          .slice(0, remaining)
          .map((due) => `${reminder.id}:${due.toISOString()}`),
      );
      occurrences = occurrences.filter((due) => {
        const id = `${reminder.id}:${due.toISOString()}`;
        return recordedIds.has(id) || allowedUnrecorded.has(id);
      });
      for (const due of occurrences) {
        if (
          nextReminderCursor &&
          (due > nextReminderCursor.due ||
            (due.getTime() === nextReminderCursor.due.getTime() &&
              reminder.id >= nextReminderCursor.id))
        ) {
          candidateGenerationTruncated = true;
          continue;
        }
        if (
          due.getTime() === windowStart.getTime() &&
          windowStartReminderId !== null &&
          reminder.id <= windowStartReminderId
        ) {
          continue;
        }
        scheduled.push({
          reminder,
          due,
          recorded: recordedIds.has(
            `${reminder.id}:${due.toISOString()}`,
          ),
        });
      }
      candidateGenerationTruncated ||= dueResult.truncated;
      candidateCapacity -= occurrences.length;
      continue;
    }
    candidateGenerationTruncated ||= dueResult.truncated;
    for (const due of occurrences) {
      if (
        nextReminderCursor &&
        (due > nextReminderCursor.due ||
          (due.getTime() === nextReminderCursor.due.getTime() &&
            reminder.id >= nextReminderCursor.id))
      ) {
        candidateGenerationTruncated = true;
        continue;
      }
      if (
        due.getTime() === windowStart.getTime() &&
        windowStartReminderId !== null &&
        reminder.id <= windowStartReminderId
      ) {
        continue;
      }
      scheduled.push({ reminder, due, recorded: false });
    }
    candidateCapacity -= occurrences.length;
  }

  scheduled.sort(
    (left, right) =>
      left.due.getTime() - right.due.getTime() ||
      left.reminder.id.localeCompare(right.reminder.id),
  );
  const selected: ScheduledOccurrence[] = [];
  let lastExamined: ScheduledOccurrence | undefined;
  let scheduledIndex = 0;
  for (; scheduledIndex < scheduled.length; scheduledIndex++) {
    const candidate = scheduled[scheduledIndex];
    if (!candidate) continue;
    if (candidate.recorded) {
      lastExamined = candidate;
      continue;
    }
    if (selected.length >= remainingWork) break;
    selected.push(candidate);
    lastExamined = candidate;
  }
  const hasUnprocessedScheduleWork =
    remainingWork === 0 ||
    reminderPageTruncated ||
    candidateGenerationTruncated ||
    scheduledIndex < scheduled.length;

  for (const { reminder, due } of selected) {
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
      let leaseId: string | null;
      try {
        leaseId = await claimUndelivered(client, occurrenceId);
      } catch {
        return json({ error: 'Unable to claim occurrence' }, 500);
      }
      if (leaseId)
        delivered += await deliverOccurrence(
          client,
          reminder,
          occurrenceId,
          leaseId,
        );
      continue;
    }
    if (occurrenceError)
      return json({ error: 'Unable to create occurrence' }, 500);

    const leaseId = await claimUndelivered(client, occurrenceId);
    if (leaseId)
      delivered += await deliverOccurrence(
        client,
        reminder,
        occurrenceId,
        leaseId,
      );
  }

  const lastSelected = lastExamined;
  const nextWindowStart =
    hasUnprocessedScheduleWork && lastSelected
      ? lastSelected.due
      : hasUnprocessedScheduleWork
        ? windowStart
        : windowEnd;
  const nextWindowReminderId =
    hasUnprocessedScheduleWork && lastSelected
      ? lastSelected.reminder.id
      : hasUnprocessedScheduleWork
        ? windowStartReminderId
        : null;
  const nextDueUpdates = reminders.map((reminder) => ({
    id: reminder.id,
    next_due_at: exhaustedReminderIds.has(reminder.id)
      ? null
      : nextDueAtCursor(
          reminder,
          nextWindowStart,
          nextWindowReminderId === null ||
            reminder.id > nextWindowReminderId,
        ),
  }));
  if (nextDueUpdates.length) {
    const { error: nextDueError } = await client.rpc(
      'update_reminder_next_due',
      { p_updates: nextDueUpdates },
    );
    if (nextDueError)
      return json({ error: 'Unable to update reminder due times' }, 500);
  }
  const { error: updateStateError } = await client.rpc('advance_dispatch_state', {
    p_last_dispatched_at: nextWindowStart.toISOString(),
    p_last_dispatched_reminder_id: nextWindowReminderId,
  });
  if (updateStateError)
    return json({ error: 'Unable to update dispatch state' }, 500);
  await client.rpc('delete_expired_history');
  return json({ delivered });
});

async function loadReminders(
  client: ServiceClient,
  windowEnd: Date,
  limit: number,
): Promise<{
  reminders: ReminderRow[];
  truncated: boolean;
  nextCursor: { due: Date; id: string } | null;
}> {
  const { data, error } = await client
    .from('reminders')
    .select(REMINDER_SELECT)
    .eq('status', 'active')
    .lte('next_due_at', windowEnd.toISOString())
    .order('next_due_at')
    .order('id')
    .limit(limit + 1);
  if (error) throw error;
  const page = (data ?? []) as ReminderRow[];
  const nextReminder = page[limit];
  return {
    reminders: page.slice(0, limit),
    truncated: page.length > limit,
    nextCursor:
      nextReminder?.next_due_at
        ? { due: new Date(nextReminder.next_due_at), id: nextReminder.id }
        : null,
  };
}

async function loadRecordedOccurrenceIds(
  client: ServiceClient,
  reminderId: string,
  occurrences: readonly Date[],
): Promise<Set<string>> {
  const ids = occurrences.map(
    (due) => `${reminderId}:${due.toISOString()}`,
  );
  if (!ids.length) return new Set();
  const { data, error } = await client
    .from('occurrences')
    .select('id')
    .in('id', ids);
  if (error) throw error;
  return new Set((data ?? []).map(({ id }) => String(id)));
}

async function claimUndelivered(
  client: ServiceClient,
  occurrenceId: string,
): Promise<string | null> {
  const now = new Date();
  const leaseId = crypto.randomUUID();
  const { data, error } = await client.rpc('claim_occurrence_delivery', {
    p_occurrence_id: occurrenceId,
    p_lease_id: leaseId,
    p_now: now.toISOString(),
    p_stale_before: new Date(
      now.getTime() - DELIVERY_LEASE_MS,
    ).toISOString(),
  });
  if (error) throw error;
  return data ? leaseId : null;
}

async function dispatchPendingDeliveries(
  client: ServiceClient,
  limit: number,
): Promise<DispatchWorkResult> {
  if (limit <= 0) return { delivered: 0, processed: 0 };
  const now = new Date();
  const { data, error } = await client
    .from('occurrences')
    .select(`id,reminder_id,reminders!inner(${REMINDER_SELECT},status)`)
    .eq('reminders.status', 'active')
    .is('delivered_at', null)
    .lt('delivery_attempts', MAX_DELIVERY_ATTEMPTS)
    .or(deliverableFilter(now))
    .limit(limit);
  if (error) throw error;
  let delivered = 0;
  let processed = 0;
  for (const occurrence of data ?? []) {
    processed++;
    const reminder = embeddedReminder(occurrence.reminders);
    if (!reminder) continue;
    const leaseId = await claimUndelivered(client, occurrence.id);
    if (!leaseId) continue;
    delivered += await deliverOccurrence(
      client,
      reminder,
      occurrence.id,
      leaseId,
    );
  }
  return { delivered, processed };
}

async function dispatchPostponed(
  client: ServiceClient,
  now: Date,
  limit: number,
): Promise<DispatchWorkResult> {
  if (limit <= 0) return { delivered: 0, processed: 0 };
  const { data, error } = await client
    .from('occurrences')
    .select(`id,reminder_id,reminders!inner(${REMINDER_SELECT},status)`)
    .eq('reminders.status', 'active')
    .eq('status', 'postponed')
    .lte('snoozed_until', now.toISOString())
    .limit(limit);
  if (error) throw error;
  let delivered = 0;
  let processed = 0;
  for (const occurrence of data ?? []) {
    processed++;
    const reminder = embeddedReminder(occurrence.reminders);
    if (!reminder) continue;
    const leaseId = await claimUndelivered(client, occurrence.id);
    if (!leaseId) continue;
    delivered += await deliverOccurrence(
      client,
      reminder,
      occurrence.id,
      leaseId,
    );
  }
  return { delivered, processed };
}

function embeddedReminder(value: unknown): ReminderRow | null {
  const reminder = Array.isArray(value) ? value[0] : value;
  return reminder && typeof reminder === 'object'
    ? (reminder as ReminderRow)
    : null;
}

async function deliverOccurrence(
  client: ServiceClient,
  reminder: ReminderRow,
  occurrenceId: string,
  leaseId: string,
): Promise<number> {
  try {
    const result = await deliverToDevices(
      client,
      reminder,
      occurrenceId,
      leaseId,
    );
    if (result.retryableFailures > 0) {
      throw new RetryableDeliveryError(result.delivered);
    }
    const { data, error } = await client.rpc('complete_occurrence_delivery', {
      p_occurrence_id: occurrenceId,
      p_lease_id: leaseId,
      p_delivered_at: new Date().toISOString(),
    });
    if (error) throw error;
    if (!data) return result.delivered;
    return result.delivered;
  } catch (error) {
    if (error instanceof LeaseLostError) return 0;
    const { data, error: failureError } = await client.rpc(
      'fail_occurrence_delivery',
      {
        p_occurrence_id: occurrenceId,
        p_lease_id: leaseId,
        p_now: new Date().toISOString(),
      },
    );
    if (failureError) throw failureError;
    if (!data) return 0;
    return error instanceof RetryableDeliveryError ? error.delivered : 0;
  }
}

async function deliverToDevices(
  client: ServiceClient,
  reminder: ReminderRow,
  occurrenceId: string,
  leaseId: string,
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
  let delivered = alreadyDelivered.size;
  let retryableFailures = 0;
  for (const device of devices ?? []) {
    if (alreadyDelivered.has(device.id)) continue;
    if (!(await renewActiveLease(client, occurrenceId, leaseId))) {
      throw new LeaseLostError();
    }
    const payload = {
      title: reminder.title,
      body: reminder.notes,
      data: {
        reminderId: reminder.id,
        occurrenceId,
        soundMode: reminder.sound.mode,
      },
    };
    try {
      if (device.platform === 'web') {
        await sendWebPush(device.token, payload);
      } else {
        await sendExpoPush(device.token, payload, reminder.sound);
      }
      const recorded = await recordDeviceDelivery(
        client,
        occurrenceId,
        reminder.owner_id,
        device.id,
        leaseId,
      );
      if (!recorded) throw new LeaseLostError();
      delivered++;
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
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
  client: ServiceClient,
  occurrenceId: string,
  ownerId: string,
  deviceId: string,
  leaseId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc(
    'record_occurrence_device_delivery',
    {
      p_occurrence_id: occurrenceId,
      p_owner_id: ownerId,
      p_device_id: deviceId,
      p_lease_id: leaseId,
    },
  );
  if (error) throw error;
  return Boolean(data);
}

async function renewActiveLease(
  client: ServiceClient,
  occurrenceId: string,
  leaseId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc(
    'renew_occurrence_delivery_lease',
    {
      p_occurrence_id: occurrenceId,
      p_lease_id: leaseId,
      p_now: new Date().toISOString(),
    },
  );
  if (error) throw error;
  return Boolean(data);
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

async function disableDevice(
  client: ServiceClient,
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

class LeaseLostError extends Error {}

function nextDueAtCursor(
  reminder: ReminderRow,
  boundary: Date,
  inclusive: boolean,
): string | null {
  if (reminder.schedule.kind === 'once') {
    const due = new Date(reminder.schedule.at);
    const allowed = inclusive ? due >= boundary : due > boundary;
    return allowed ? due.toISOString() : null;
  }
  try {
    const interval = CronExpressionParser.parse(reminder.schedule.expression, {
      currentDate: new Date(boundary.getTime() - (inclusive ? 1 : 0)),
      startDate: reminder.schedule.startAt,
      endDate: reminder.schedule.endAt,
      tz: reminder.timezone,
    });
    return interval.next().toDate().toISOString();
  } catch {
    return null;
  }
}

function dueOccurrences(
  reminder: ReminderRow,
  windowStart: Date,
  windowEnd: Date,
  limit: number,
): { occurrences: Date[]; truncated: boolean } {
  const reminderCreatedAt = new Date(reminder.created_at);
  const lowerBound =
    reminderCreatedAt > windowStart ? reminderCreatedAt : windowStart;
  if (reminder.schedule.kind === 'once') {
    const date = new Date(reminder.schedule.at);
    return {
      occurrences:
        date >= lowerBound && date < windowEnd ? [date] : [],
      truncated: false,
    };
  }
  const results: Date[] = [];
  const interval = CronExpressionParser.parse(reminder.schedule.expression, {
    currentDate: new Date(lowerBound.getTime() - 1),
    startDate: reminder.schedule.startAt,
    endDate: reminder.schedule.endAt,
    tz: reminder.timezone,
  });
  for (let i = 0; i <= limit; i++) {
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
  if (results.length > limit) {
    return {
      occurrences: results.slice(0, limit),
      truncated: true,
    };
  }
  return { occurrences: results, truncated: false };
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
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: token,
      ...payload,
      sound: nativeSound,
      channelId:
        sound.mode === 'silent'
          ? 'reminders-silent'
          : sound.mode === 'vibrate'
            ? 'reminders-vibrate'
            : 'reminders-default',
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
    { timeout: PUSH_TIMEOUT_MS },
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
    throw new PermanentDeliveryError(
      'Web push subscription is not valid JSON',
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PermanentDeliveryError(
      'Web push subscription is not an object',
    );
  }
  const { endpoint, keys } = parsed as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  if (typeof endpoint !== 'string') {
    throw new PermanentDeliveryError(
      'Web push subscription has no endpoint',
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PermanentDeliveryError(
      'Web push endpoint is not a valid URL',
    );
  }
  if (url.protocol !== 'https:' || !isAllowedPushHost(url.hostname)) {
    throw new PermanentDeliveryError(
      'Web push endpoint host is not allowed',
    );
  }
  if (typeof keys?.p256dh !== 'string' || typeof keys.auth !== 'string') {
    throw new PermanentDeliveryError(
      'Web push subscription has no keys',
    );
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
