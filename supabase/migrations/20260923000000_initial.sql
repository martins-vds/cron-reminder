create extension if not exists pgcrypto;

create type public.reminder_status as enum ('active', 'disabled', 'archived');
create type public.occurrence_status as enum ('scheduled', 'triggered', 'dismissed', 'postponed', 'missed', 'delivery-failed');

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
  schedule jsonb not null check (
    jsonb_typeof(schedule) = 'object'
    and schedule->>'kind' in ('once', 'cron')
    and (
      (schedule->>'kind' = 'once' and schedule ? 'at')
      or
      (
        schedule->>'kind' = 'cron'
        and schedule->>'expression' ~ '^\S+\s+\S+\s+\S+\s+\S+\s+\S+$'
      )
    )
  ),
  timezone text not null check (length(trim(timezone)) > 0),
  sound jsonb not null default '{"mode":"default"}',
  status public.reminder_status not null default 'active',
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id)
);
create index reminders_owner_status_idx on public.reminders(owner_id, status);
create index reminders_tags_idx on public.reminders using gin(tags);

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

create table public.devices (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('android', 'ios', 'web')),
  token text not null,
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
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now()
);
create index reminder_tombstones_owner_idx on public.reminder_tombstones(owner_id);

create table public.dispatch_state (
  id boolean primary key default true check (id),
  last_dispatched_at timestamptz not null default now()
);
insert into public.dispatch_state (id, last_dispatched_at) values (true, now());

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
create policy "owners manage occurrences" on public.occurrences for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owners read history" on public.history for select using (owner_id = auth.uid());
create policy "owners append history" on public.history for insert with check (owner_id = auth.uid());
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
