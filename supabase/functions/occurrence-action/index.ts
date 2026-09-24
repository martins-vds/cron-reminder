import { createClient } from 'npm:@supabase/supabase-js@2.117.1';
import { corsHeaders } from '../_shared/cors.ts';

const snoozeOptions = [5, 10, 15, 30, 60];

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const authorization = request.headers.get('Authorization');
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!authorization || !url || !anonKey) return response({ error: 'Unauthorized' }, 401);
  const client = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const input: unknown = await request.json();
  if (!isAction(input)) return response({ error: 'Invalid action payload' }, 400);

  const now = new Date();
  const { data, error } = await client.rpc('act_on_occurrence', {
    p_occurrence_id: input.occurrenceId,
    p_event: input.action === 'dismiss' ? 'dismissed' : 'postponed',
    p_snoozed_until:
      input.action === 'dismiss'
        ? null
        : new Date(now.getTime() + input.minutes * 60_000).toISOString(),
  });
  if (error) return response({ error: 'Unable to record occurrence action' }, 500);
  if (!data) return response({ error: 'Occurrence not found' }, 404);
  return response({ updated: true });
});

function isAction(value: unknown): value is { occurrenceId: string; action: 'dismiss' } | { occurrenceId: string; action: 'snooze'; minutes: number } {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.occurrenceId === 'string' &&
    (item.action === 'dismiss' ||
      (item.action === 'snooze' && typeof item.minutes === 'number' && snoozeOptions.includes(item.minutes)))
  );
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
