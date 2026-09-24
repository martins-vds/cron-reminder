import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const authorization = request.headers.get('Authorization');
  if (!authorization) return response({ error: 'Unauthorized' }, 401);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anonKey)
    return response({ error: 'Server configuration missing' }, 500);

  const client = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data, error } = await client.rpc('delete_current_user');
  if (error) return response({ error: 'Account deletion failed' }, 500);
  return data
    ? response({ deleted: true })
    : response({ error: 'Unauthorized' }, 401);
});

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
