create extension if not exists pgcrypto;

create type public.reminder_status as enum ('active', 'disabled', 'archived');
create type public.occurrence_status as enum ('scheduled', 'triggered', 'delivering', 'dismissed', 'postponed', 'missed', 'delivery-failed');

create or replace function public.is_valid_cron_field(
  field text,
  minimum integer,
  maximum integer,
  names text[] default null
)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  part text;
  base text;
  bounds text[];
  value integer;
  lower_value integer;
  upper_value integer;
  step integer;
begin
  if field is null or field = '' then
    return false;
  end if;
  foreach part in array string_to_array(field, ',') loop
    base := split_part(part, '/', 1);
    if strpos(part, '/') > 0 then
      if part !~ '^[^/]+/[0-9]+$' then return false; end if;
      step := split_part(part, '/', 2)::integer;
      if step < 1 then return false; end if;
    end if;
    if base = '*' then continue; end if;
    if base ~ '^[0-9]+$' or upper(base) = any(names) then
      value := case
        when base ~ '^[0-9]+$' then base::integer
        else minimum + array_position(names, upper(base)) - 1
      end;
      if value < minimum or value > maximum then return false; end if;
      continue;
    end if;
    bounds := string_to_array(base, '-');
    if array_length(bounds, 1) <> 2 then return false; end if;
    lower_value := case
      when bounds[1] ~ '^[0-9]+$' then bounds[1]::integer
      when upper(bounds[1]) = any(names)
        then minimum + array_position(names, upper(bounds[1])) - 1
      else null
    end;
    upper_value := case
      when bounds[2] ~ '^[0-9]+$' then bounds[2]::integer
      when upper(bounds[2]) = any(names)
        then minimum + array_position(names, upper(bounds[2])) - 1
      else null
    end;
    if lower_value is null
      or upper_value is null
      or lower_value < minimum
      or upper_value > maximum
      or lower_value > upper_value then
      return false;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public.is_valid_schedule(value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  fields text[];
  starts_at timestamptz;
  ends_at timestamptz;
begin
  if jsonb_typeof(value) <> 'object' then return false; end if;
  if value->>'kind' = 'once' then
    if coalesce(jsonb_typeof(value->'at') = 'string', false) = false then
      return false;
    end if;
    perform (value->>'at')::timestamptz;
    return true;
  end if;
  if value->>'kind' <> 'cron'
    or jsonb_typeof(value->'expression') <> 'string' then
    return false;
  end if;
  fields := regexp_split_to_array(trim(value->>'expression'), '\s+');
  if array_length(fields, 1) <> 5
    or not public.is_valid_cron_field(fields[1], 0, 59)
    or not public.is_valid_cron_field(fields[2], 0, 23)
    or not public.is_valid_cron_field(fields[3], 1, 31)
    or not public.is_valid_cron_field(
      fields[4], 1, 12,
      array['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
    )
    or not public.is_valid_cron_field(
      fields[5], 0, 7,
      array['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
    ) then
    return false;
  end if;
  if value ? 'occurrenceLimit' and (
    jsonb_typeof(value->'occurrenceLimit') <> 'number'
    or (value->>'occurrenceLimit')::numeric < 1
    or (value->>'occurrenceLimit')::numeric % 1 <> 0
  ) then return false; end if;
  if value ? 'startAt' then
    if jsonb_typeof(value->'startAt') <> 'string' then return false; end if;
    starts_at := (value->>'startAt')::timestamptz;
  end if;
  if value ? 'endAt' then
    if jsonb_typeof(value->'endAt') <> 'string' then return false; end if;
    ends_at := (value->>'endAt')::timestamptz;
  end if;
  return starts_at is null or ends_at is null or starts_at <= ends_at;
exception when others then
  return false;
end;
$$;

create or replace function public.is_valid_timezone(value text)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from pg_catalog.pg_timezone_names where lower(name) = lower(value)
  );
$$;

create or replace function public.is_valid_sound(value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(
    jsonb_typeof(value) = 'object'
    and value->>'mode' in ('default', 'silent', 'vibrate'),
    false
  );
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  locale text not null default 'en' check (locale in ('en', 'pt-BR')),
  theme text not null default 'system' check (theme in ('system', 'light', 'dark')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.reminders (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  notes text not null default '',
  tags text[] not null default '{}',
  schedule jsonb not null check (public.is_valid_schedule(schedule)),
  timezone text not null check (public.is_valid_timezone(timezone)),
  sound jsonb not null default '{"mode":"default"}'
    check (public.is_valid_sound(sound)),
  status public.reminder_status not null default 'active',
  revision integer not null default 1 check (revision > 0),
  next_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id)
);
create index reminders_owner_status_idx on public.reminders(owner_id, status);
create index reminders_tags_idx on public.reminders using gin(tags);
create index reminders_due_idx on public.reminders(next_due_at, id)
  where status = 'active' and next_due_at is not null;

create table public.occurrences (
  id text primary key,
  reminder_id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  scheduled_at timestamptz not null,
  status public.occurrence_status not null default 'scheduled',
  acted_at timestamptz,
  snoozed_until timestamptz,
  created_at timestamptz not null default now(),
  unique(reminder_id, scheduled_at),
  unique (id, owner_id),
  foreign key (reminder_id, owner_id) references public.reminders(id, owner_id) on delete cascade
);
create index occurrences_owner_scheduled_idx on public.occurrences(owner_id, scheduled_at desc);

create table public.history (
  id uuid primary key default gen_random_uuid(),
  reminder_id text not null,
  occurrence_id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_type public.occurrence_status not null,
  occurred_at timestamptz not null default now(),
  foreign key (reminder_id, owner_id) references public.reminders(id, owner_id) on delete cascade,
  foreign key (occurrence_id, owner_id) references public.occurrences(id, owner_id) on delete cascade
);
create index history_owner_occurred_idx on public.history(owner_id, occurred_at desc);
create index history_occurred_idx on public.history(occurred_at);

create table public.devices (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('android', 'ios', 'web')),
  token text not null,
  deregistration_token uuid not null default gen_random_uuid(),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index devices_owner_idx on public.devices(owner_id) where enabled;

create table public.sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  reminder_id text not null,
  local_version jsonb not null,
  remote_version jsonb not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.reminder_tombstones (
  id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now(),
  primary key (id, owner_id)
);
create index reminder_tombstones_owner_idx on public.reminder_tombstones(owner_id);

create or replace function public.protect_reminder_tombstones()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    insert into public.reminder_tombstones(id, owner_id)
    values (old.id, old.owner_id)
    on conflict (id, owner_id) do update
      set deleted_at = now();
    return old;
  end if;
  if exists (
    select 1 from public.reminder_tombstones
    where id = new.id and owner_id = new.owner_id
  ) then
    raise exception 'Reminder % has been deleted', new.id using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger reminders_reject_tombstoned_writes
before insert or update on public.reminders
for each row execute procedure public.protect_reminder_tombstones();

create trigger reminders_record_tombstone
before delete on public.reminders
for each row execute procedure public.protect_reminder_tombstones();

create table public.dispatch_state (
  id boolean primary key default true check (id),
  last_dispatched_at timestamptz not null default now(),
  last_dispatched_reminder_id text
);
insert into public.dispatch_state (id, last_dispatched_at) values (true, now());

create or replace function public.advance_dispatch_state(
  p_last_dispatched_at timestamptz,
  p_last_dispatched_reminder_id text
)
returns void language sql security definer set search_path = '' as $$
  update public.dispatch_state
  set last_dispatched_at = p_last_dispatched_at,
      last_dispatched_reminder_id = p_last_dispatched_reminder_id
  where id = true
    and (
      last_dispatched_at < p_last_dispatched_at
      or (
        last_dispatched_at = p_last_dispatched_at
        and coalesce(last_dispatched_reminder_id, '') <
          coalesce(p_last_dispatched_reminder_id, '')
      )
    );
$$;

create or replace function public.update_reminder_next_due(p_updates jsonb)
returns void language sql security definer set search_path = '' as $$
  update public.reminders reminder
  set next_due_at = updates.next_due_at
  from jsonb_to_recordset(p_updates) as updates(
    id text,
    next_due_at timestamptz
  )
  where reminder.id = updates.id;
$$;

alter table public.profiles enable row level security;
alter table public.reminders enable row level security;
alter table public.occurrences enable row level security;
alter table public.history enable row level security;
alter table public.devices enable row level security;
alter table public.sync_conflicts enable row level security;
alter table public.reminder_tombstones enable row level security;
alter table public.dispatch_state enable row level security;

create policy "owners manage profile" on public.profiles for all using (id = auth.uid()) with check (id = auth.uid());
create policy "owners manage reminders" on public.reminders for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owners read occurrences" on public.occurrences for select using (owner_id = auth.uid());
create policy "owners read history" on public.history for select using (owner_id = auth.uid());
create policy "owners register devices" on public.devices for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owners manage conflicts" on public.sync_conflicts for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owners manage tombstones" on public.reminder_tombstones for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create or replace function public.create_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id) values (new.id);
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.create_profile();

create or replace function public.delete_expired_history()
returns integer language plpgsql security definer set search_path = '' as $$
declare deleted integer;
begin
  delete from public.history where occurred_at < now() - interval '30 days';
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function public.delete_expired_history() from public, anon, authenticated;
grant execute on function public.delete_expired_history() to service_role;
revoke all on function public.advance_dispatch_state(timestamptz, text) from public, anon, authenticated;
grant execute on function public.advance_dispatch_state(timestamptz, text) to service_role;
revoke all on function public.update_reminder_next_due(jsonb) from public, anon, authenticated;
grant execute on function public.update_reminder_next_due(jsonb) to service_role;
