grant usage on schema public, auth, extensions
  to anon, authenticated, service_role;
grant select, insert, update, delete
  on all tables in schema public to authenticated;
grant all privileges
  on all tables in schema public to service_role;
grant usage, select
  on all sequences in schema public to authenticated, service_role;
