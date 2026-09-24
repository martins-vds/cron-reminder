import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS')
    return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST')
    return response({ error: 'Method not allowed' }, 405);

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return response({ error: 'Invalid deregistration payload' }, 400);
  }
  if (!isDeregistration(input))
    return response({ error: 'Invalid deregistration payload' }, 400);

  const client = createClient(
    required('SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
  );
  const { data, error } = await client
    .from('devices')
    .delete()
    .eq('id', input.id)
    .eq('deregistration_token', input.token)
    .select('id')
    .maybeSingle();
  if (error) return response({ error: 'Unable to deregister device' }, 500);
  return response({ deleted: Boolean(data) });
});

function isDeregistration(
  value: unknown,
): value is { id: string; token: string } {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.token === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      item.token,
    )
  );
}

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
