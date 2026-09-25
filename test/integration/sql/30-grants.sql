grant usage on schema public, auth, extensions
  to anon, authenticated, service_role;
grant select, insert, update, delete
  on all tables in schema public to authenticated;
revoke insert, update on public.reminders from authenticated;
grant insert(
  id,
  owner_id,
  title,
  notes,
  tags,
  schedule,
  timezone,
  sound,
  status,
  revision,
  next_due_at,
  created_at,
  updated_at
) on public.reminders to authenticated;
grant update(
  title,
  notes,
  tags,
  schedule,
  timezone,
  sound,
  status,
  revision,
  next_due_at,
  updated_at
) on public.reminders to authenticated;
revoke delete on public.reminder_tombstones from authenticated;
grant all privileges
  on all tables in schema public to service_role;
grant usage, select
  on all sequences in schema public to authenticated, service_role;
