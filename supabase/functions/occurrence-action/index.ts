import { createClient } from '@supabase/supabase-js';
import { nextPostponementAt, resolvePostponement, type Reminder } from '../../../packages/domain/src/index.ts';
import { corsHeaders } from '../_shared/cors.ts';

type Action = { actionId?: string } & (
  | { occurrenceId: string; action: 'dismiss' | 'complete' }
  | { occurrenceId: string; action: 'snooze'; until: string }
  | { occurrenceId: string; action: 'snooze'; minutes: number });

interface ReminderRow extends Pick<Reminder, 'schedule' | 'timezone' | 'status'> {
  schedule_revision: number;
  occurrence_count: number;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const authorization = request.headers.get('Authorization');
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!authorization || !url || !anonKey) return response({ error: 'Unauthorized' }, 401);
  const client = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return response({ error: 'Invalid action payload' }, 400);
  }
  if (!isAction(input)) return response({ error: 'Invalid action payload' }, 400);
  const requestKey = JSON.stringify([input.occurrenceId, input.action,
    'until' in input ? input.until : 'minutes' in input ? input.minutes : null]);
  if (input.actionId) {
    const { data: receipt, error } = await client.from('occurrence_action_receipts')
      .select('request_key,result').eq('action_id', input.actionId).maybeSingle();
    if (error) return response({ error: 'Unable to verify occurrence action' }, 500);
    if (receipt) {
      if (receipt.request_key !== requestKey) return response({ error: 'Action ID was already used for another request' }, 409);
      return response(receipt.result);
    }
  }
  if (input.action !== 'snooze') {
    const { data, error } = await client.rpc('act_on_occurrence', {
      p_occurrence_id: input.occurrenceId,
      p_event: input.action === 'dismiss' ? 'dismissed' : 'completed',
      p_snooze_minutes: null,
      p_action_id: input.actionId ?? null,
      p_request_key: requestKey,
    });
    if (error) return response({ error: 'Unable to record occurrence action' }, 500);
    if (!data) return response({ error: 'Occurrence not found' }, 404);
    return response({ updated: true });
  }
  // The user's JWT and RLS determine ownership before the service-only mutation.
  const { data: occurrence, error: occurrenceError } = await client
    .from('occurrences').select('reminder_id,owner_id,status').eq('id', input.occurrenceId)
    .maybeSingle<{ reminder_id: string; owner_id: string; status: string }>();
  if (occurrenceError) return response({ error: 'Unable to load occurrence' }, 500);
  if (!occurrence) return response({ error: 'Occurrence not found' }, 404);
  const ownerId = occurrence.owner_id;
  const { data: reminder, error: reminderError } = await client
    .from('reminders').select('schedule,timezone,status,schedule_revision,occurrence_count')
    .eq('id', occurrence.reminder_id).eq('owner_id', ownerId).maybeSingle<ReminderRow>();
  if (reminderError) return response({ error: 'Unable to load reminder schedule' }, 500);
  if (!reminder) return response({ error: 'Reminder not found' }, 404);
  if (reminder.status !== 'active')
    return response({ error: 'Enable this reminder before postponing it' }, 400);
  const now = new Date();
  let nextOccurrenceAt: string | null;
  try {
    nextOccurrenceAt = nextPostponementAt(reminder, now, reminder.occurrence_count);
  } catch (error) {
    console.error('Unable to calculate postponement boundary', error);
    return response({ error: 'Unable to calculate the next occurrence' }, 500);
  }
  let postponement;
  try {
    postponement = resolvePostponement(
      'until' in input ? { until: input.until } : input.minutes,
      now.toISOString(), nextOccurrenceAt,
    );
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : 'Invalid postponement time' }, 400);
  }
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) return response({ error: 'Postponement service is not configured' }, 500);
  const service = createClient(url, serviceKey);
  const { data, error } = await service.rpc('postpone_occurrence', {
    p_occurrence_id: input.occurrenceId,
    p_owner_id: ownerId,
    p_until: postponement.until,
    p_next_occurrence_at: nextOccurrenceAt,
    p_schedule_revision: reminder.schedule_revision,
    p_occurrence_count: reminder.occurrence_count,
    p_action_id: input.actionId ?? null,
    p_request_key: requestKey,
  });
  if (error) {
    console.error('Unable to record postponement', error);
    if (error.code === 'P0001') return response({ error: error.message }, 400);
    return response({ error: 'Unable to record postponement' }, 500);
  }
  if (!data) return response({ error: 'The occurrence or schedule has changed. Refresh and try again.' }, 409);
  return response({ updated: true, until: postponement.until, mergedIntoNext: postponement.mergeIntoNext });
});

function isAction(value: unknown): value is Action {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  if (item.actionId !== undefined && (typeof item.actionId !== 'string' || item.actionId.length === 0 || item.actionId.length > 200)) return false;
  if (typeof item.occurrenceId !== 'string' || item.occurrenceId.length === 0) return false;
  if (item.action === 'dismiss' || item.action === 'complete') return true;
  if (item.action !== 'snooze') return false;
  if (typeof item.until === 'string' && item.minutes === undefined)
    return Number.isFinite(Date.parse(item.until));
  return item.until === undefined && typeof item.minutes === 'number'
    && Number.isSafeInteger(item.minutes) && item.minutes > 0;
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
