import { createClient } from 'npm:@supabase/supabase-js@2.117.1';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const authorization = request.headers.get('Authorization');
  if (!authorization) return response({ error: 'Unauthorized' }, 401);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return response({ error: 'Server configuration missing' }, 500);

  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return response({ error: 'Unauthorized' }, 401);

  const admin = createClient(url, serviceKey);
  const result = await admin.auth.admin.deleteUser(data.user.id);
  return result.error ? response({ error: 'Account deletion failed' }, 500) : response({ deleted: true });
});

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
