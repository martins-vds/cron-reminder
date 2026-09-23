import { createClient } from 'npm:@supabase/supabase-js@2.117.1';
import { CronExpressionParser } from 'npm:cron-parser@5.10.1';
import webpush from 'npm:web-push@3.6.7';

interface ReminderRow {
  id: string;
  owner_id: string;
  title: string;
  notes: string;
  schedule: { kind: 'once'; at: string } | { kind: 'cron'; expression: string; startAt?: string; endAt?: string };
  timezone: string;
}

Deno.serve(async (request) => {
  if (request.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const url = required('SUPABASE_URL');
  const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const client = createClient(url, serviceKey);
  const now = new Date();
  const minuteStart = new Date(now);
  minuteStart.setUTCSeconds(0, 0);
  const { data, error } = await client.from('reminders').select('id,owner_id,title,notes,schedule,timezone').eq('status', 'active');
  if (error) return json({ error: 'Unable to load reminders' }, 500);

  let delivered = 0;
  for (const reminder of (data ?? []) as ReminderRow[]) {
    const due = dueAt(reminder, minuteStart);
    if (!due) continue;
    const occurrenceId = `${reminder.id}:${due.toISOString()}`;
    const { error: occurrenceError } = await client.from('occurrences').insert({
      id: occurrenceId,
      reminder_id: reminder.id,
      owner_id: reminder.owner_id,
      scheduled_at: due.toISOString(),
      status: 'triggered',
    });
    if (occurrenceError?.code === '23505') continue;
    if (occurrenceError) continue;

    const { data: devices } = await client.from('devices').select('platform,token').eq('owner_id', reminder.owner_id).eq('enabled', true);
    for (const device of devices ?? []) {
      const payload = { title: reminder.title, body: reminder.notes, data: { reminderId: reminder.id, occurrenceId } };
      try {
        if (device.platform === 'web') await sendWebPush(device.token, payload);
        else await sendExpoPush(device.token, payload);
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
    await client.from('history').insert({
      reminder_id: reminder.id,
      occurrence_id: occurrenceId,
      owner_id: reminder.owner_id,
      event_type: 'triggered',
    });
  }
  await client.rpc('delete_expired_history');
  return json({ delivered });
});

function dueAt(reminder: ReminderRow, minute: Date): Date | null {
  if (reminder.schedule.kind === 'once') {
    const date = new Date(reminder.schedule.at);
    return date >= minute && date < new Date(minute.getTime() + 60_000) ? date : null;
  }
  const previousMinute = new Date(minute.getTime() - 60_000);
  const next = CronExpressionParser.parse(reminder.schedule.expression, {
    currentDate: previousMinute,
    startDate: reminder.schedule.startAt,
    endDate: reminder.schedule.endAt,
    tz: reminder.timezone,
  }).next().toDate();
  return next >= minute && next < new Date(minute.getTime() + 60_000) ? next : null;
}

async function sendExpoPush(token: string, payload: Record<string, unknown>) {
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: token, ...payload, sound: 'default' }),
  });
  if (!response.ok) throw new Error('Expo push failed');
}

async function sendWebPush(token: string, payload: Record<string, unknown>) {
  webpush.setVapidDetails(required('VAPID_SUBJECT'), required('VAPID_PUBLIC_KEY'), required('VAPID_PRIVATE_KEY'));
  await webpush.sendNotification(JSON.parse(token), JSON.stringify(payload));
}

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
