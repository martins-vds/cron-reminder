grant usage on schema public, auth, extensions
  to anon, authenticated, service_role;
grant select, insert, update, delete
  on all tables in schema public to authenticated;
revoke insert(occurrence_count, schedule_revision)
  on public.reminders from authenticated;
revoke update(occurrence_count, schedule_revision)
  on public.reminders from authenticated;
revoke delete on public.reminder_tombstones from authenticated;
grant all privileges
  on all tables in schema public to service_role;
grant usage, select
  on all sequences in schema public to authenticated, service_role;
