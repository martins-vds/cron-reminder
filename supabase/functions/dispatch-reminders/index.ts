import { createClient } from '@supabase/supabase-js';
import { CronExpressionParser } from 'cron-parser';
import webpush from 'web-push';

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
  revision: number;
  schedule_revision: number;
  created_at: string;
  next_due_at: string | null;
}

interface DeviceDeliveryResult {
  delivered: number;
  retryableFailures: number;
  deferred: boolean;
}

interface DeviceAttemptResult extends DeviceDeliveryResult {}

interface DispatchWorkResult {
  delivered: number;
  processed: number;
}

interface ScheduledOccurrence {
  reminder: ReminderRow;
  due: Date;
  recorded: boolean;
}

interface LimitedReminderCandidates {
  reminder: ReminderRow;
  dueResult: ReturnType<typeof dueOccurrences>;
  occurrences: Date[];
}

// deno-lint-ignore no-explicit-any
type ServiceClient = ReturnType<typeof createClient<any>>;

const DISPATCH_STATE_ID = true;
const MAX_SCHEDULED_OCCURRENCES_PER_RUN = 500;
const MAX_PENDING_DELIVERIES_PER_RUN = 25;
const MAX_POSTPONED_DELIVERIES_PER_RUN = 25;
const DELIVERY_LEASE_MS = 5 * 60_000;
const PUSH_TIMEOUT_MS = 5_000;
const RUN_DEADLINE_MS = 60_000;
const OCCURRENCE_CONCURRENCY = 25;
const DEVICE_SEND_CONCURRENCY = 10;
const MAX_DEVICES_PER_DELIVERY_ATTEMPT = 10;
const EXPO_RECEIPT_BATCH_SIZE = 1_000;
const EXPO_RECEIPT_REQUEST_SIZE = 300;
const RECEIPT_RPC_CONCURRENCY = 25;
const DATABASE_QUERY_CONCURRENCY = 25;
const ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];
const REMINDER_SELECT =
  'id,owner_id,title,notes,schedule,timezone,sound,revision,schedule_revision,created_at,next_due_at';

Deno.serve(async (request) => {
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret || request.headers.get('x-cron-secret') !== cronSecret) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const client = createClient(
    required('SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
  );
  const runDeadline = Date.now() + RUN_DEADLINE_MS;
  try {
    await processExpoReceipts(
      client,
      Math.min(runDeadline, Date.now() + 10_000),
    );
  } catch (error) {
    console.error('Unable to process Expo push receipts', error);
  }
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 1);
  const { data: state, error: stateError } = await client
    .from('dispatch_state')
    .select(
      'last_dispatched_at,last_dispatched_owner_id,last_dispatched_reminder_id',
    )
    .eq('id', DISPATCH_STATE_ID)
    .maybeSingle();
  if (stateError) return json({ error: 'Unable to load dispatch state' }, 500);
  const windowStart = state?.last_dispatched_at
    ? new Date(state.last_dispatched_at)
    : new Date(now.getTime() - 60_000);
  const windowStartReminderId =
    typeof state?.last_dispatched_reminder_id === 'string'
      ? state.last_dispatched_reminder_id
      : null;
  const windowStartOwnerId =
    typeof state?.last_dispatched_owner_id === 'string'
      ? state.last_dispatched_owner_id
      : null;
  let delivered = 0;
  const remainingWork = MAX_SCHEDULED_OCCURRENCES_PER_RUN;

  let reminders: ReminderRow[] = [];
  let reminderPageTruncated = false;
  let nextReminderCursor: {
    due: Date;
    ownerId: string;
    id: string;
  } | null = null;
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
  const limitedCandidates: LimitedReminderCandidates[] = [];
  const exhaustedReminderIds = new Set<string>();
  const cursorUpdateReminderIds = new Set<string>();
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
    const occurrences = dueResult.occurrences;
    if (!occurrences.length) {
      exhaustedReminderIds.add(reminderStateKey(reminder));
      continue;
    }

    if (
      reminder.schedule.kind === 'cron' &&
      reminder.schedule.occurrenceLimit !== undefined
    ) {
      limitedCandidates.push({ reminder, dueResult, occurrences });
      candidateCapacity -= occurrences.length;
      continue;
    }
    candidateGenerationTruncated ||= dueResult.truncated;
    for (const due of occurrences) {
      if (
        nextReminderCursor &&
        (due > nextReminderCursor.due ||
          (due.getTime() === nextReminderCursor.due.getTime() &&
            compareReminderIdentity(
              reminder.owner_id,
              reminder.id,
              nextReminderCursor.ownerId,
              nextReminderCursor.id,
            ) >= 0))
      ) {
        candidateGenerationTruncated = true;
        continue;
      }
      if (
        due.getTime() === windowStart.getTime() &&
        windowStartReminderId !== null &&
        windowStartOwnerId !== null &&
        compareReminderIdentity(
          reminder.owner_id,
          reminder.id,
          windowStartOwnerId,
          windowStartReminderId,
        ) <= 0
      ) {
        continue;
      }
      scheduled.push({ reminder, due, recorded: false });
    }
    candidateCapacity -= occurrences.length;
  }

  for (
    let offset = 0;
    offset < limitedCandidates.length;
    offset += DATABASE_QUERY_CONCURRENCY
  ) {
    const chunk = limitedCandidates.slice(
      offset,
      offset + DATABASE_QUERY_CONCURRENCY,
    );
    let states: Array<{ recordedIds: Set<string>; count: number }>;
    try {
      states = await Promise.all(
        chunk.map(async ({ reminder, occurrences }) => {
          const [recordedIds, countResult] = await Promise.all([
            loadRecordedOccurrenceIds(
              client,
              reminder.id,
              reminder.owner_id,
              occurrences,
            ),
            client
              .from('occurrences')
              .select('id', { count: 'exact', head: true })
              .eq('reminder_id', reminder.id)
              .eq('owner_id', reminder.owner_id),
          ]);
          if (countResult.error) throw countResult.error;
          return { recordedIds, count: countResult.count ?? 0 };
        }),
      );
    } catch {
      return json({ error: 'Unable to load occurrence limits' }, 500);
    }
    for (let index = 0; index < chunk.length; index++) {
      const candidate = chunk[index];
      const state = states[index];
      if (!candidate || !state) continue;
      const { reminder, dueResult } = candidate;
      let occurrences = candidate.occurrences;
      const occurrenceLimit =
        reminder.schedule.kind === 'cron'
          ? reminder.schedule.occurrenceLimit
          : undefined;
      if (occurrenceLimit === undefined) continue;
      const remaining = occurrenceLimit - state.count;
      if (remaining <= 0) {
        exhaustedReminderIds.add(reminderStateKey(reminder));
        dueResult.truncated = false;
        continue;
      }
      const unrecorded = occurrences.filter(
        (due) =>
          !state.recordedIds.has(
            `${reminder.id}:${due.toISOString()}`,
          ),
      );
      if (remaining < unrecorded.length) dueResult.truncated = false;
      const allowedUnrecorded = new Set(
        unrecorded
          .slice(0, remaining)
          .map((due) => `${reminder.id}:${due.toISOString()}`),
      );
      occurrences = occurrences.filter((due) => {
        const id = `${reminder.id}:${due.toISOString()}`;
        return state.recordedIds.has(id) || allowedUnrecorded.has(id);
      });
      for (const due of occurrences) {
        if (
          nextReminderCursor &&
          (due > nextReminderCursor.due ||
            (due.getTime() === nextReminderCursor.due.getTime() &&
              compareReminderIdentity(
                reminder.owner_id,
                reminder.id,
                nextReminderCursor.ownerId,
                nextReminderCursor.id,
              ) >= 0))
        ) {
          candidateGenerationTruncated = true;
          continue;
        }
        if (
          due.getTime() === windowStart.getTime() &&
          windowStartReminderId !== null &&
          windowStartOwnerId !== null &&
          compareReminderIdentity(
            reminder.owner_id,
            reminder.id,
            windowStartOwnerId,
            windowStartReminderId,
          ) <= 0
        ) {
          continue;
        }
        scheduled.push({
          reminder,
          due,
          recorded: state.recordedIds.has(
            `${reminder.id}:${due.toISOString()}`,
          ),
        });
      }
      candidateGenerationTruncated ||= dueResult.truncated;
    }
  }

  scheduled.sort(
    (left, right) =>
      left.due.getTime() - right.due.getTime() ||
      compareReminderIdentity(
        left.reminder.owner_id,
        left.reminder.id,
        right.reminder.owner_id,
        right.reminder.id,
      ),
  );
  let lastExamined: ScheduledOccurrence | undefined;
  let scheduledIndex = 0;
  let unrecordedSelected = 0;
  let deadlineTruncated = false;
  let pendingChunk: ScheduledOccurrence[] = [];
  const processPendingChunk = async (): Promise<boolean> => {
    if (!pendingChunk.length) return true;
    if (Date.now() >= runDeadline) {
      deadlineTruncated = true;
      return false;
    }
    const chunk = pendingChunk;
    pendingChunk = [];
    try {
      const results = await Promise.all(
        chunk.map(({ reminder, due }) =>
          processScheduledOccurrence(client, reminder, due, windowStart),
        ),
      );
      delivered += results.reduce((total, value) => total + value, 0);
    } catch {
      throw new Error('Unable to process scheduled occurrence');
    }
    for (const candidate of chunk) {
      cursorUpdateReminderIds.add(reminderStateKey(candidate.reminder));
      lastExamined = candidate;
    }
    return true;
  };
  for (; scheduledIndex < scheduled.length; scheduledIndex++) {
    const candidate = scheduled[scheduledIndex];
    if (!candidate) continue;
    if (candidate.recorded) {
      try {
        if (!(await processPendingChunk())) break;
      } catch {
        return json({ error: 'Unable to process scheduled occurrence' }, 500);
      }
      lastExamined = candidate;
      cursorUpdateReminderIds.add(reminderStateKey(candidate.reminder));
      continue;
    }
    if (unrecordedSelected >= remainingWork) break;
    pendingChunk.push(candidate);
    unrecordedSelected++;
    if (pendingChunk.length >= OCCURRENCE_CONCURRENCY) {
      try {
        if (!(await processPendingChunk())) break;
      } catch {
        return json({ error: 'Unable to process scheduled occurrence' }, 500);
      }
    }
  }
  if (!deadlineTruncated) {
    try {
      await processPendingChunk();
    } catch {
      return json({ error: 'Unable to process scheduled occurrence' }, 500);
    }
  }
  const hasUnprocessedScheduleWork =
    reminderPageTruncated ||
    candidateGenerationTruncated ||
    scheduledIndex < scheduled.length ||
    deadlineTruncated;

  const [pending, postponed] = await Promise.all([
    dispatchPendingDeliveries(
      client,
      MAX_PENDING_DELIVERIES_PER_RUN,
      runDeadline,
    ),
    dispatchPostponed(
      client,
      now,
      MAX_POSTPONED_DELIVERIES_PER_RUN,
      runDeadline,
    ),
  ]);
  delivered += pending.delivered + postponed.delivered;

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
  const nextWindowOwnerId =
    hasUnprocessedScheduleWork && lastSelected
      ? lastSelected.reminder.owner_id
      : hasUnprocessedScheduleWork
        ? windowStartOwnerId
        : null;
  const nextDueUpdates = reminders
    .filter(
      (reminder) =>
        exhaustedReminderIds.has(reminderStateKey(reminder)) ||
        cursorUpdateReminderIds.has(reminderStateKey(reminder)),
    )
    .map((reminder) => ({
      id: reminder.id,
      owner_id: reminder.owner_id,
      revision: reminder.revision,
      next_due_at: exhaustedReminderIds.has(reminderStateKey(reminder))
        ? null
        : nextDueAtCursor(
            reminder,
            nextWindowStart,
            nextWindowReminderId === null ||
              nextWindowOwnerId === null ||
              compareReminderIdentity(
                reminder.owner_id,
                reminder.id,
                nextWindowOwnerId,
                nextWindowReminderId,
              ) > 0,
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
    p_last_dispatched_owner_id: nextWindowOwnerId,
    p_last_dispatched_reminder_id: nextWindowReminderId,
  });
  if (updateStateError)
    return json({ error: 'Unable to update dispatch state' }, 500);
  const { error: cleanupError } = await client.rpc('delete_expired_history');
  if (cleanupError)
    return json({ error: 'Unable to delete expired history' }, 500);
  return json({ delivered });
});

function reminderStateKey(reminder: ReminderRow): string {
  return `${reminder.owner_id}\u0000${reminder.id}`;
}

function compareReminderIdentity(
  leftOwnerId: string,
  leftId: string,
  rightOwnerId: string,
  rightId: string,
): number {
  if (leftOwnerId !== rightOwnerId)
    return leftOwnerId < rightOwnerId ? -1 : 1;
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

async function loadReminders(
  client: ServiceClient,
  windowEnd: Date,
  limit: number,
): Promise<{
  reminders: ReminderRow[];
  truncated: boolean;
  nextCursor: { due: Date; ownerId: string; id: string } | null;
}> {
  const { data, error } = await client
    .from('reminders')
    .select(REMINDER_SELECT)
    .eq('status', 'active')
    .lt('next_due_at', windowEnd.toISOString())
    .order('next_due_at')
    .order('owner_id')
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
        ? {
            due: new Date(nextReminder.next_due_at),
            ownerId: nextReminder.owner_id,
            id: nextReminder.id,
          }
        : null,
  };
}

async function loadRecordedOccurrenceIds(
  client: ServiceClient,
  reminderId: string,
  ownerId: string,
  occurrences: readonly Date[],
): Promise<Set<string>> {
  const ids = occurrences.map(
    (due) => `${reminderId}:${due.toISOString()}`,
  );
  if (!ids.length) return new Set();
  const { data, error } = await client.rpc(
    'get_recorded_occurrence_ids',
    {
      p_owner_id: ownerId,
      p_occurrence_ids: ids,
    },
  );
  if (error) throw error;
  return new Set(
    ((data ?? []) as Array<{ id: string }>).map(({ id }) => String(id)),
  );
}

async function processScheduledOccurrence(
  client: ServiceClient,
  reminder: ReminderRow,
  due: Date,
  missedBefore: Date,
): Promise<number> {
  const occurrenceId = `${reminder.id}:${due.toISOString()}`;
  if (due < missedBefore) {
    const { error } = await client.rpc('record_missed_occurrence', {
      p_occurrence_id: occurrenceId,
      p_reminder_id: reminder.id,
      p_owner_id: reminder.owner_id,
      p_reminder_revision: reminder.schedule_revision,
      p_scheduled_at: due.toISOString(),
    });
    if (error) throw error;
    return 0;
  }
  const now = new Date();
  const leaseId = crypto.randomUUID();
  const { data, error } = await client.rpc('prepare_occurrence_delivery', {
    p_occurrence_id: occurrenceId,
    p_reminder_id: reminder.id,
    p_owner_id: reminder.owner_id,
    p_reminder_revision: reminder.schedule_revision,
    p_scheduled_at: due.toISOString(),
    p_lease_id: leaseId,
    p_now: now.toISOString(),
    p_stale_before: new Date(
      now.getTime() - DELIVERY_LEASE_MS,
    ).toISOString(),
  });
  if (error) throw error;
  return data
    ? deliverOccurrence(client, reminder, occurrenceId, leaseId)
    : 0;
}

async function claimUndelivered(
  client: ServiceClient,
  occurrenceId: string,
  reminder: ReminderRow,
): Promise<string | null> {
  const now = new Date();
  const leaseId = crypto.randomUUID();
  const { data, error } = await client.rpc('claim_occurrence_delivery', {
    p_occurrence_id: occurrenceId,
    p_owner_id: reminder.owner_id,
    p_reminder_id: reminder.id,
    p_reminder_revision: reminder.schedule_revision,
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
  deadline: number,
): Promise<DispatchWorkResult> {
  if (limit <= 0) return { delivered: 0, processed: 0 };
  const now = new Date();
  const { data, error } = await client.rpc(
    'list_deliverable_occurrences',
    {
      p_now: now.toISOString(),
      p_stale_before: new Date(
        now.getTime() - DELIVERY_LEASE_MS,
      ).toISOString(),
      p_limit: limit,
      p_postponed: false,
    },
  );
  if (error) throw error;
  let delivered = 0;
  let processed = 0;
  const rows = (data ?? []) as Array<{
    occurrence_id: string;
    reminder: unknown;
  }>;
  for (
    let offset = 0;
    offset < rows.length;
    offset += OCCURRENCE_CONCURRENCY
  ) {
    if (Date.now() >= deadline) break;
    const chunk = rows.slice(offset, offset + OCCURRENCE_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((occurrence) =>
        processRetryOccurrence(client, occurrence),
      ),
    );
    processed += chunk.length;
    delivered += results.reduce((total, value) => total + value, 0);
  }
  return { delivered, processed };
}

async function dispatchPostponed(
  client: ServiceClient,
  now: Date,
  limit: number,
  deadline: number,
): Promise<DispatchWorkResult> {
  if (limit <= 0) return { delivered: 0, processed: 0 };
  const { data, error } = await client.rpc(
    'list_deliverable_occurrences',
    {
      p_now: now.toISOString(),
      p_stale_before: new Date(
        now.getTime() - DELIVERY_LEASE_MS,
      ).toISOString(),
      p_limit: limit,
      p_postponed: true,
    },
  );
  if (error) throw error;
  let delivered = 0;
  let processed = 0;
  const rows = (data ?? []) as Array<{
    occurrence_id: string;
    reminder: unknown;
  }>;
  for (
    let offset = 0;
    offset < rows.length;
    offset += OCCURRENCE_CONCURRENCY
  ) {
    if (Date.now() >= deadline) break;
    const chunk = rows.slice(offset, offset + OCCURRENCE_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((occurrence) =>
        processRetryOccurrence(client, occurrence),
      ),
    );
    processed += chunk.length;
    delivered += results.reduce((total, value) => total + value, 0);
  }
  return { delivered, processed };
}

async function processRetryOccurrence(
  client: ServiceClient,
  occurrence: { occurrence_id: string; reminder: unknown },
): Promise<number> {
  const reminder = embeddedReminder(occurrence.reminder);
  if (!reminder) return 0;
  const leaseId = await claimUndelivered(
    client,
    occurrence.occurrence_id,
    reminder,
  );
  return leaseId
    ? deliverOccurrence(
        client,
        reminder,
        occurrence.occurrence_id,
        leaseId,
      )
    : 0;
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
    if (result.deferred) {
      const { error } = await client.rpc('defer_occurrence_delivery', {
        p_occurrence_id: occurrenceId,
        p_owner_id: reminder.owner_id,
        p_lease_id: leaseId,
        p_now: new Date().toISOString(),
      });
      if (error) throw error;
      return result.delivered;
    }
    const { data, error } = await client.rpc('complete_occurrence_delivery', {
      p_occurrence_id: occurrenceId,
      p_owner_id: reminder.owner_id,
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
        p_owner_id: reminder.owner_id,
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
  const { data: pendingTickets, error: pendingTicketsError } = await client
    .from('expo_push_tickets')
    .select('device_id')
    .eq('occurrence_id', occurrenceId)
    .eq('owner_id', reminder.owner_id);
  if (pendingTicketsError) throw pendingTicketsError;
  const alreadyDelivered = new Set(
    (deliveredDevices ?? []).map(({ device_id }) => String(device_id)),
  );
  const awaitingReceipt = new Set(
    (pendingTickets ?? []).map(({ device_id }) => String(device_id)),
  );
  let delivered = 0;
  let retryableFailures = 0;
  let deferred = awaitingReceipt.size > 0;
  const pendingDevices = (devices ?? []).filter(
    (device) =>
      !alreadyDelivered.has(device.id) && !awaitingReceipt.has(device.id),
  );
  if (pendingDevices.length > MAX_DEVICES_PER_DELIVERY_ATTEMPT) deferred = true;
  const attemptedDevices = pendingDevices.slice(
    0,
    MAX_DEVICES_PER_DELIVERY_ATTEMPT,
  );
  for (
    let offset = 0;
    offset < attemptedDevices.length;
    offset += DEVICE_SEND_CONCURRENCY
  ) {
    const outcomes = await Promise.allSettled(
      attemptedDevices
        .slice(offset, offset + DEVICE_SEND_CONCURRENCY)
        .map((device) =>
          deliverToDevice(client, reminder, occurrenceId, leaseId, device),
        ),
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        if (outcome.reason instanceof LeaseLostError) throw outcome.reason;
        retryableFailures++;
        continue;
      }
      delivered += outcome.value.delivered;
      retryableFailures += outcome.value.retryableFailures;
      deferred ||= outcome.value.deferred;
    }
  }
  return { delivered, retryableFailures, deferred };
}

async function deliverToDevice(
  client: ServiceClient,
  reminder: ReminderRow,
  occurrenceId: string,
  leaseId: string,
  device: { id: string; platform: string; token: string },
): Promise<DeviceAttemptResult> {
  if (
    !(await renewActiveLease(
      client,
      occurrenceId,
      reminder.owner_id,
      leaseId,
    ))
  ) {
    throw new LeaseLostError();
  }
  const payload = {
    title: truncateUtf8(reminder.title, 200),
    body: truncateUtf8(reminder.notes, 2_000),
    data: {
      reminderId: reminder.id,
      occurrenceId,
      soundMode: reminder.sound.mode,
    },
  };
  try {
    if (device.platform === 'web') {
      await sendWebPush(device.token, payload);
      const recorded = await recordDeviceDelivery(
        client,
        occurrenceId,
        reminder.owner_id,
        device.id,
        leaseId,
      );
      if (!recorded) throw new LeaseLostError();
      return { delivered: 1, retryableFailures: 0, deferred: false };
    }
    const ticketId = await sendExpoPush(
      device.token,
      payload,
      reminder.sound,
    );
    const recorded = await recordExpoPushTicket(
      client,
      ticketId,
      occurrenceId,
      reminder.owner_id,
      device.id,
      leaseId,
    );
    if (!recorded) throw new LeaseLostError();
    return { delivered: 0, retryableFailures: 0, deferred: true };
  } catch (error) {
    if (error instanceof LeaseLostError) throw error;
    if (isPermanentDeliveryFailure(error)) {
      await disableDevice(client, device.id);
      return { delivered: 0, retryableFailures: 0, deferred: false };
    }
    return { delivered: 0, retryableFailures: 1, deferred: false };
  }
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

async function recordExpoPushTicket(
  client: ServiceClient,
  ticketId: string,
  occurrenceId: string,
  ownerId: string,
  deviceId: string,
  leaseId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc('record_expo_push_ticket', {
    p_ticket_id: ticketId,
    p_occurrence_id: occurrenceId,
    p_owner_id: ownerId,
    p_device_id: deviceId,
    p_lease_id: leaseId,
  });
  if (error) throw error;
  return Boolean(data);
}

async function renewActiveLease(
  client: ServiceClient,
  occurrenceId: string,
  ownerId: string,
  leaseId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc(
    'renew_occurrence_delivery_lease',
    {
      p_occurrence_id: occurrenceId,
      p_owner_id: ownerId,
      p_lease_id: leaseId,
      p_now: new Date().toISOString(),
    },
  );
  if (error) throw error;
  return Boolean(data);
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
    (statusCode === 404 || statusCode === 410)
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
      startDate: inclusiveStartDate(reminder.schedule.startAt),
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
  const persistedNextDue = reminder.next_due_at
    ? new Date(reminder.next_due_at)
    : windowStart;
  const reminderCursor =
    persistedNextDue < windowStart ? persistedNextDue : windowStart;
  const lowerBound =
    reminderCreatedAt > reminderCursor ? reminderCreatedAt : reminderCursor;
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
    startDate: inclusiveStartDate(reminder.schedule.startAt),
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

function inclusiveStartDate(value: string | undefined): Date | undefined {
  return value ? new Date(Date.parse(value) - 1) : undefined;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maximumBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).length;
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

async function sendExpoPush(
  token: string,
  payload: Record<string, unknown>,
  sound: ReminderRow['sound'],
): Promise<string> {
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
    if (response.status === 410) {
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
  const ticketId = (data as { id?: unknown }).id;
  if (typeof ticketId !== 'string' || !ticketId) {
    throw new Error('Expo response did not include a ticket ID');
  }
  return ticketId;
}

async function processExpoReceipts(
  client: ServiceClient,
  deadline: number,
): Promise<void> {
  const now = new Date();
  const receiptReadyBefore = new Date(
    now.getTime() - 15 * 60_000,
  ).toISOString();
  const { data: newTickets, error: newTicketsError } = await client
    .from('expo_push_tickets')
    .select('ticket_id,created_at,last_checked_at')
    .is('last_checked_at', null)
    .lte('created_at', receiptReadyBefore)
    .order('created_at')
    .limit(EXPO_RECEIPT_BATCH_SIZE);
  if (newTicketsError) throw newTicketsError;
  const { data: retryTickets, error: retryTicketsError } = await client
    .from('expo_push_tickets')
    .select('ticket_id,created_at,last_checked_at')
    .lte(
      'last_checked_at',
      receiptReadyBefore,
    )
    .order('last_checked_at')
    .order('created_at')
    .limit(EXPO_RECEIPT_BATCH_SIZE);
  if (retryTicketsError) throw retryTicketsError;
  await processExpoReceiptBatch(client, newTickets ?? [], now, deadline);
  if (Date.now() < deadline)
    await processExpoReceiptBatch(client, retryTickets ?? [], now, deadline);
}

async function processExpoReceiptBatch(
  client: ServiceClient,
  tickets: Array<{ ticket_id: string; created_at: string }>,
  now: Date,
  deadline: number,
): Promise<void> {
  if (!tickets?.length) return;
  for (
    let offset = 0;
    offset < tickets.length;
    offset += EXPO_RECEIPT_REQUEST_SIZE
  ) {
    if (Date.now() >= deadline) break;
    await processExpoReceiptRequest(
      client,
      tickets.slice(offset, offset + EXPO_RECEIPT_REQUEST_SIZE),
      now,
    );
  }
}

async function processExpoReceiptRequest(
  client: ServiceClient,
  tickets: Array<{ ticket_id: string; created_at: string }>,
  now: Date,
): Promise<void> {
  const response = await fetch(
    'https://exp.host/--/api/v2/push/getReceipts',
    {
      method: 'POST',
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: tickets.map(({ ticket_id }) => ticket_id),
      }),
    },
  );
  if (!response.ok) throw new Error('Expo receipt request failed');
  const payload: unknown = await response.json();
  const receipts =
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { data?: unknown }).data === 'object' &&
    (payload as { data?: unknown }).data !== null
      ? ((payload as { data: Record<string, unknown> }).data ?? {})
      : {};
  const unresolvedTicketIds: string[] = [];
  for (
    let offset = 0;
    offset < tickets.length;
    offset += RECEIPT_RPC_CONCURRENCY
  ) {
    const chunk = tickets.slice(offset, offset + RECEIPT_RPC_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((ticket) =>
        processExpoReceipt(
          client,
          ticket,
          receipts[ticket.ticket_id],
          now,
        ),
      ),
    );
    for (let index = 0; index < chunk.length; index++) {
      if (results[index]) {
        const ticket = chunk[index];
        if (ticket) unresolvedTicketIds.push(ticket.ticket_id);
      }
    }
  }
  if (unresolvedTicketIds.length) {
    const { error: updateError } = await client
      .from('expo_push_tickets')
      .update({ last_checked_at: now.toISOString() })
      .in('ticket_id', unresolvedTicketIds);
    if (updateError) throw updateError;
  }

  async function processExpoReceipt(
    client: ServiceClient,
    ticket: { ticket_id: string; created_at: string },
    receipt: unknown,
    now: Date,
  ): Promise<boolean> {
    if (typeof receipt !== 'object' || receipt === null) {
      if (now.getTime() - Date.parse(ticket.created_at) > 24 * 60 * 60_000) {
        await failExpoPushTicket(client, ticket.ticket_id, false);
        return false;
      }
      return true;
    }
    const status = (receipt as { status?: unknown }).status;
    if (status === 'ok') {
      const { error } = await client.rpc('complete_expo_push_ticket', {
        p_ticket_id: ticket.ticket_id,
      });
      if (error) throw error;
      return false;
    }
    if (status === 'error') {
      const providerError = (
        receipt as { details?: { error?: unknown } }
      ).details?.error;
      await failExpoPushTicket(
        client,
        ticket.ticket_id,
        providerError === 'DeviceNotRegistered',
      );
      return false;
    }
    if (now.getTime() - Date.parse(ticket.created_at) > 24 * 60 * 60_000) {
      await failExpoPushTicket(client, ticket.ticket_id, false);
      return false;
    }
    return true;
  }
}

async function failExpoPushTicket(
  client: ServiceClient,
  ticketId: string,
  disableDevice: boolean,
): Promise<void> {
  const { data, error } = await client.rpc('fail_expo_push_ticket', {
    p_ticket_id: ticketId,
    p_disable_device: disableDevice,
  });
  if (error) throw error;
  if (!data) throw new Error('Expo push ticket failure is still in use');
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
