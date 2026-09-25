-- Run this in the Supabase SQL Editor after replacing both placeholder values.
-- The pg_cron, pg_net, and Vault extensions must be enabled in the project.

select vault.create_secret(
  'https://YOUR_PROJECT_REF.supabase.co',
  'cron_reminder_project_url',
  'Cron Reminder Edge Function base URL'
);

select vault.create_secret(
  'YOUR_CRON_SECRET',
  'cron_reminder_cron_secret',
  'Cron Reminder dispatcher authentication secret'
);

select cron.schedule(
  'dispatch-cron-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'cron_reminder_project_url'
    ) || '/functions/v1/dispatch-reminders',
    headers := jsonb_build_object(
      'Content-Type',
      'application/json',
      'x-cron-secret',
      (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'cron_reminder_cron_secret'
      )
    ),
    body := jsonb_build_object('scheduled_at', now()),
    timeout_milliseconds := 55000
  ) as request_id;
  $$
);

select cron.schedule(
  'cleanup-cron-job-history',
  '0 0 * * *',
  $$
  delete from cron.job_run_details
  where end_time < now() - interval '7 days';
  $$
);
