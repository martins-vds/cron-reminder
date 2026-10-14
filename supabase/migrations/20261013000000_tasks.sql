create type public.task_status as enum ('open', 'completed', 'archived');
create type public.task_occurrence_status as enum (
  'scheduled', 'triggered', 'delivering', 'dismissed', 'postponed',
  'completed', 'canceled', 'delivery-failed'
);

create function public.is_valid_task_reminder_policy(
  value jsonb,
  timezone text,
  due_at timestamptz
)
returns boolean language plpgsql stable set search_path = '' as $$
declare
  schedule jsonb;
  overdue_schedule jsonb;
begin
  if jsonb_typeof(value) <> 'object'
    or exists (
      select 1 from jsonb_object_keys(value) key
      where key not in ('primary', 'overdue')
    )
    or coalesce(jsonb_typeof(value->'primary') = 'object', false) = false
    or not public.is_valid_timezone(timezone) then
    return false;
  end if;
  schedule := value->'primary';
  if not public.is_valid_schedule(schedule)
    or schedule ? 'endAt'
    or schedule ? 'occurrenceLimit' then
    return false;
  end if;
  if schedule->>'kind' <> 'once' then
    return not (value ? 'overdue');
  end if;
  if (schedule->>'at')::timestamptz > due_at
    or coalesce(jsonb_typeof(value->'overdue') = 'object', false) = false then
    return false;
  end if;
  overdue_schedule := value->'overdue';
  if not public.is_valid_schedule(overdue_schedule)
    or overdue_schedule->>'kind' = 'once'
    or overdue_schedule ? 'endAt'
    or overdue_schedule ? 'occurrenceLimit' then
    return false;
  end if;
  return not (overdue_schedule ? 'startAt')
    or (overdue_schedule->>'startAt')::timestamptz > due_at;
exception when others then
  return false;
end;
$$;

create table public.tasks (
  id text collate "C" not null check (id ~ '^[a-z0-9_-]+$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  notes text not null default '' check (length(notes) <= 10000),
  tags text[] not null default '{}',
  category_id text collate "C",
  due_at timestamptz not null,
  reminder_policy jsonb not null,
  timezone text not null check (public.is_valid_timezone(timezone)),
  status public.task_status not null default 'open',
  revision integer not null default 1 check (revision > 0),
  schedule_revision integer not null default 1 check (schedule_revision > 0),
  occurrence_count bigint not null default 0 check (occurrence_count >= 0),
  next_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, owner_id),
  foreign key (category_id, owner_id)
    references public.reminder_categories(id, owner_id),
  check (public.is_valid_task_reminder_policy(reminder_policy, timezone, due_at)),
  check (status = 'open' or next_due_at is null)
);
create index tasks_owner_status_idx on public.tasks(owner_id, status);
create index tasks_due_idx on public.tasks(next_due_at, owner_id, id)
  where status = 'open' and next_due_at is not null;

create table public.task_occurrences (
  id text collate "C" not null,
  task_id text collate "C" not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  task_schedule_revision integer not null check (task_schedule_revision > 0),
  scheduled_at timestamptz not null,
  status public.task_occurrence_status not null default 'scheduled',
  acted_at timestamptz,
  source text not null check (source in ('primary', 'overdue')),
  snoozed_until timestamptz,
  delivered_at timestamptz,
  delivery_attempts integer not null default 0 check (delivery_attempts >= 0),
  next_delivery_attempt_at timestamptz,
  delivery_lease_id uuid,
  created_at timestamptz not null default now(),
  primary key (id, owner_id),
  unique(task_id, owner_id, scheduled_at),
  foreign key (task_id, owner_id) references public.tasks(id, owner_id) on delete cascade,
  check (
    (status = 'postponed' and snoozed_until is not null)
    or (status <> 'postponed' and snoozed_until is null)
  )
);
create index task_occurrences_owner_scheduled_idx
  on public.task_occurrences(owner_id, scheduled_at desc);
create index task_occurrences_delivery_idx
  on public.task_occurrences(next_delivery_attempt_at, scheduled_at)
  where delivered_at is null
    and delivery_attempts < 5
    and status in ('triggered', 'delivering', 'postponed', 'delivery-failed');

create table public.task_occurrence_device_deliveries (
  occurrence_id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  primary key (occurrence_id, owner_id, device_id),
  foreign key (occurrence_id, owner_id)
    references public.task_occurrences(id, owner_id) on delete cascade
);

create table public.task_expo_push_tickets (
  ticket_id text primary key,
  occurrence_id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  device_token_hash bytea not null,
  delivery_round_id uuid not null,
  created_at timestamptz not null default now(),
  last_checked_at timestamptz,
  foreign key (occurrence_id, owner_id)
    references public.task_occurrences(id, owner_id) on delete cascade
);
create index task_expo_push_tickets_check_idx
  on public.task_expo_push_tickets(last_checked_at, created_at);

create table public.task_occurrence_failed_delivery_rounds (
  occurrence_id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  delivery_round_id uuid not null,
  failed_at timestamptz not null default now(),
  primary key (occurrence_id, owner_id, delivery_round_id),
  foreign key (occurrence_id, owner_id)
    references public.task_occurrences(id, owner_id) on delete cascade
);

create table public.task_occurrence_action_receipts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  action_id text not null check (length(action_id) between 1 and 200),
  task_id text collate "C" not null,
  request_key text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, action_id),
  foreign key (task_id, owner_id) references public.tasks(id, owner_id) on delete cascade
);

create function public.increment_task_occurrence_count()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.tasks
  set occurrence_count = occurrence_count + 1
  where id = new.task_id
    and owner_id = new.owner_id
    and schedule_revision = new.task_schedule_revision;
  if not found then
    raise exception 'Task schedule changed';
  end if;
  return new;
end;
$$;
create trigger task_occurrences_increment_count
before insert on public.task_occurrences
for each row execute function public.increment_task_occurrence_count();

create function public.cancel_task_occurrences()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.task_occurrences
  set status = 'canceled',
      acted_at = now(),
      snoozed_until = null,
      next_delivery_attempt_at = null,
      delivery_lease_id = null
  where task_id = new.id
    and owner_id = new.owner_id
    and status in ('scheduled', 'triggered', 'delivering', 'postponed', 'delivery-failed')
    and (
      new.status in ('completed', 'archived')
      or task_schedule_revision <> new.schedule_revision
    );
  delete from public.task_expo_push_tickets
  where owner_id = new.owner_id
    and occurrence_id in (
      select id from public.task_occurrences
      where task_id = new.id and owner_id = new.owner_id and status = 'canceled'
    );
  return new;
end;
$$;
create trigger tasks_cancel_obsolete_occurrences
after update of status, due_at, reminder_policy, schedule_revision on public.tasks
for each row
when (
  old.status is distinct from new.status
  or old.schedule_revision is distinct from new.schedule_revision
)
execute function public.cancel_task_occurrences();

create table public.task_tombstones (
  id text collate "C" not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now(),
  primary key (id, owner_id)
);

create function public.manage_task_scheduler_fields()
returns trigger language plpgsql set search_path = '' as $$
declare scheduling_changed boolean;
declare restoring boolean;
begin
  if current_user in ('postgres', 'service_role') then return new; end if;
  if tg_op = 'INSERT' then
    new.schedule_revision := 1;
    new.occurrence_count := 0;
    if new.status <> 'open' then
      new.next_due_at := null;
    elsif new.next_due_at is null or new.next_due_at > new.due_at then
      raise exception 'The first reminder must be on or before the due date';
    end if;
    return new;
  end if;
  new.occurrence_count := old.occurrence_count;
  scheduling_changed := new.due_at is distinct from old.due_at
    or new.reminder_policy is distinct from old.reminder_policy
    or new.timezone is distinct from old.timezone
    or new.status is distinct from old.status;
  restoring := old.status in ('completed', 'archived') and new.status = 'open';
  if scheduling_changed then
    new.schedule_revision := old.schedule_revision + 1;
    if new.status <> 'open' then
      new.next_due_at := null;
    elsif new.next_due_at is null
      or restoring and new.next_due_at <= now() then
      raise exception 'Restoring a task requires a future reminder';
    end if;
  else
    new.schedule_revision := old.schedule_revision;
    new.next_due_at := old.next_due_at;
  end if;
  return new;
end;
$$;
create trigger tasks_manage_scheduler_fields
before insert or update on public.tasks
for each row execute function public.manage_task_scheduler_fields();

create function public.check_task_category()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.category_id is not null and not exists (
    select 1 from public.reminder_categories
    where id = new.category_id
      and owner_id = new.owner_id
      and deleted_at is null
  ) then
    raise exception 'Category no longer exists. Choose another category.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger tasks_check_category before insert or update on public.tasks
for each row execute function public.check_task_category();

create function public.protect_task_tombstones()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if auth.uid() = old.owner_id
      and coalesce(current_setting('app.account_deletion', true), '') <> 'on' then
      insert into public.task_tombstones(id, owner_id)
      values (old.id, old.owner_id)
      on conflict (id, owner_id) do update set deleted_at = now();
    end if;
    return old;
  end if;
  if exists (
    select 1 from public.task_tombstones
    where id = new.id and owner_id = new.owner_id
  ) then
    raise exception 'Task % has been deleted', new.id using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger tasks_reject_tombstoned_writes
before insert or update on public.tasks
for each row execute function public.protect_task_tombstones();
create trigger tasks_record_tombstone
before delete on public.tasks
for each row execute function public.protect_task_tombstones();

create or replace function public.save_category(
  p_id text,
  p_name text,
  p_revision integer,
  p_expected_revision integer,
  p_deleted boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := auth.uid();
  existing public.reminder_categories%rowtype;
begin
  if owner is null then raise exception 'Sign in to change categories'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(owner::text, 1)
  );
  select * into existing from public.reminder_categories
  where id = p_id and owner_id = owner for update;
  if found then
    if existing.deleted_at is not null then return p_deleted; end if;
    if existing.revision is distinct from p_expected_revision
      or p_revision <= existing.revision then
      return false;
    end if;
    if p_deleted then
      update public.reminder_categories
      set deleted_at = now(), updated_at = now(), revision = p_revision
      where id = p_id and owner_id = owner;
      update public.reminders
      set category_id = null, revision = revision + 1, updated_at = now()
      where category_id = p_id and owner_id = owner;
      update public.tasks
      set category_id = null, revision = revision + 1, updated_at = now()
      where category_id = p_id and owner_id = owner;
    else
      update public.reminder_categories
      set name = trim(p_name), revision = p_revision, updated_at = now()
      where id = p_id and owner_id = owner;
    end if;
  else
    if p_expected_revision is not null then return false; end if;
    insert into public.reminder_categories(
      id, owner_id, name, revision, deleted_at
    ) values (
      p_id, owner, trim(p_name), p_revision,
      case when p_deleted then now() end
    );
  end if;
  return true;
end;
$$;

create function public.save_task(
  p_id text,
  p_title text,
  p_notes text,
  p_tags text[],
  p_category_id text,
  p_due_at timestamptz,
  p_reminder_policy jsonb,
  p_timezone text,
  p_status public.task_status,
  p_revision integer,
  p_expected_revision integer,
  p_next_due_at timestamptz,
  p_created_at timestamptz,
  p_updated_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := auth.uid();
  existing public.tasks%rowtype;
  schedule_changed boolean;
  restoring boolean;
begin
  if owner is null then return false; end if;
  if p_id is null or p_id !~ '^[a-z0-9_-]+$'
    or length(trim(coalesce(p_title, ''))) not between 1 and 200
    or length(coalesce(p_notes, '')) > 10000
    or p_due_at is null or not isfinite(p_due_at)
    or p_revision is null or p_revision <= 0
    or p_status is null
    or not public.is_valid_task_reminder_policy(
      p_reminder_policy, p_timezone, p_due_at
    )
    or (p_status <> 'open' and p_next_due_at is not null) then
    raise exception 'Invalid task' using errcode = '23514';
  end if;
  select * into existing from public.tasks
  where id = p_id and owner_id = owner for update;
  if not found then
    if p_expected_revision is not null
      or p_status = 'open' and (
        p_next_due_at is null
        or not isfinite(p_next_due_at)
        or p_next_due_at > p_due_at
      ) then
      return false;
    end if;
    insert into public.tasks(
      id, owner_id, title, notes, tags, category_id, due_at,
      reminder_policy, timezone, status,
      revision, schedule_revision, occurrence_count, next_due_at,
      created_at, updated_at
    ) values (
      p_id, owner, trim(p_title), coalesce(p_notes, ''),
      coalesce(p_tags, '{}'), p_category_id, p_due_at,
      p_reminder_policy, p_timezone, p_status, p_revision, 1, 0, p_next_due_at,
      coalesce(p_created_at, now()), coalesce(p_updated_at, now())
    );
    return true;
  end if;
  if existing.revision is distinct from p_expected_revision
    or p_revision <= existing.revision then
    return false;
  end if;
  schedule_changed := existing.due_at is distinct from p_due_at
    or existing.reminder_policy is distinct from p_reminder_policy
    or existing.timezone is distinct from p_timezone
    or existing.status is distinct from p_status;
  restoring := existing.status in ('completed', 'archived') and p_status = 'open';
  if restoring and (
    p_next_due_at is null
    or not isfinite(p_next_due_at)
    or p_next_due_at <= now()
  ) then
    raise exception 'Restoring a task requires a future reminder';
  end if;
  if schedule_changed and p_status = 'open' and not restoring and (
    p_next_due_at is null
    or not isfinite(p_next_due_at)
    or p_next_due_at > p_due_at
  ) then
    raise exception 'The first reminder must be on or before the due date';
  end if;
  update public.tasks
  set title = trim(p_title),
      notes = coalesce(p_notes, ''),
      tags = coalesce(p_tags, '{}'),
      category_id = p_category_id,
      due_at = p_due_at,
      reminder_policy = p_reminder_policy,
      timezone = p_timezone,
      status = p_status,
      revision = p_revision,
      schedule_revision = case
        when schedule_changed then existing.schedule_revision + 1
        else existing.schedule_revision
      end,
      next_due_at = case
        when p_status <> 'open' then null
        when schedule_changed then p_next_due_at
        else existing.next_due_at
      end,
      updated_at = coalesce(p_updated_at, now())
  where id = p_id and owner_id = owner;
  return true;
end;
$$;

create function public.restore_task(
  p_task_id text,
  p_revision integer,
  p_expected_revision integer,
  p_next_due_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare restored boolean;
begin
  if auth.uid() is null
    or p_next_due_at is null
    or not isfinite(p_next_due_at)
    or p_next_due_at <= now() then
    return false;
  end if;
  update public.tasks
  set status = 'open',
      revision = p_revision,
      schedule_revision = schedule_revision + 1,
      next_due_at = p_next_due_at,
      updated_at = now()
  where id = p_task_id
    and owner_id = auth.uid()
    and status in ('completed', 'archived')
    and revision = p_expected_revision
    and p_revision > revision
  returning true into restored;
  return coalesce(restored, false);
end;
$$;

create function public.update_task_next_due(p_updates jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare updated integer;
begin
  update public.tasks task
  set next_due_at = updates.next_due_at
  from jsonb_to_recordset(p_updates) as updates(
    id text,
    owner_id uuid,
    revision integer,
    schedule_revision integer,
    occurrence_count bigint,
    next_due_at timestamptz
  )
  where task.id = updates.id
    and task.owner_id = updates.owner_id
    and task.status = 'open'
    and task.revision = updates.revision
    and task.schedule_revision = updates.schedule_revision
    and task.occurrence_count = updates.occurrence_count;
  get diagnostics updated = row_count;
  return updated;
end;
$$;

create function public.claim_task_occurrence_delivery(
  p_occurrence_id text,
  p_owner_id uuid,
  p_task_id text,
  p_schedule_revision integer,
  p_lease_id uuid,
  p_now timestamptz,
  p_stale_before timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare claimed boolean;
begin
  update public.task_occurrences occurrence
  set status = 'delivering',
      acted_at = p_now,
      delivery_lease_id = p_lease_id,
      task_schedule_revision = case
        when status = 'postponed' then p_schedule_revision
        else task_schedule_revision
      end
  where occurrence.id = p_occurrence_id
    and occurrence.owner_id = p_owner_id
    and occurrence.task_id = p_task_id
    and occurrence.delivered_at is null
    and occurrence.delivery_attempts < 5
    and (
      occurrence.status in ('triggered', 'delivery-failed')
      or occurrence.status = 'postponed' and occurrence.snoozed_until <= p_now
      or occurrence.status = 'delivering' and occurrence.acted_at < p_stale_before
    )
    and (
      occurrence.next_delivery_attempt_at is null
      or occurrence.next_delivery_attempt_at <= p_now
    )
    and exists (
      select 1 from public.tasks task
      where task.id = p_task_id
        and task.owner_id = p_owner_id
        and task.status = 'open'
        and (
          occurrence.status = 'postponed'
          or task.schedule_revision = p_schedule_revision
            and occurrence.task_schedule_revision = p_schedule_revision
        )
    )
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create function public.prepare_task_occurrence_delivery(
  p_occurrence_id text,
  p_task_id text,
  p_owner_id uuid,
  p_schedule_revision integer,
  p_scheduled_at timestamptz,
  p_source text,
  p_lease_id uuid,
  p_now timestamptz,
  p_stale_before timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_source not in ('primary', 'overdue') then
    raise exception 'Unsupported task occurrence source';
  end if;
  perform 1 from public.tasks
  where id = p_task_id
    and owner_id = p_owner_id
    and status = 'open'
    and schedule_revision = p_schedule_revision
  for update;
  if not found then return false; end if;
  insert into public.task_occurrences(
    id, task_id, owner_id, task_schedule_revision,
    scheduled_at, source, status
  ) values (
    p_occurrence_id, p_task_id, p_owner_id, p_schedule_revision,
    p_scheduled_at, p_source, 'triggered'
  ) on conflict (id, owner_id) do nothing;
  return public.claim_task_occurrence_delivery(
    p_occurrence_id, p_owner_id, p_task_id, p_schedule_revision,
    p_lease_id, p_now, p_stale_before
  );
end;
$$;

create function public.list_deliverable_task_occurrences(
  p_now timestamptz,
  p_stale_before timestamptz,
  p_limit integer
)
returns table(occurrence_id text, task jsonb)
language sql security definer set search_path = '' as $$
  select occurrence.id, to_jsonb(task)
  from public.task_occurrences occurrence
  join public.tasks task
    on task.id = occurrence.task_id and task.owner_id = occurrence.owner_id
  where task.status = 'open'
    and occurrence.delivered_at is null
    and occurrence.delivery_attempts < 5
    and (
      occurrence.status in ('triggered', 'delivery-failed')
      and occurrence.task_schedule_revision = task.schedule_revision
      or occurrence.status = 'postponed' and occurrence.snoozed_until <= p_now
      or occurrence.status = 'delivering' and occurrence.acted_at < p_stale_before
    )
    and (
      occurrence.next_delivery_attempt_at is null
      or occurrence.next_delivery_attempt_at <= p_now
    )
  order by coalesce(
    occurrence.snoozed_until,
    occurrence.next_delivery_attempt_at,
    occurrence.scheduled_at
  ), occurrence.owner_id, occurrence.id
  limit greatest(p_limit, 0);
$$;

create function public.renew_task_occurrence_delivery_lease(
  p_occurrence_id text, p_owner_id uuid, p_lease_id uuid, p_now timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare renewed boolean;
begin
  update public.task_occurrences
  set acted_at = p_now
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and status = 'delivering'
    and delivery_lease_id = p_lease_id
  returning true into renewed;
  return coalesce(renewed, false);
end;
$$;

create function public.complete_task_occurrence_delivery(
  p_occurrence_id text, p_owner_id uuid, p_lease_id uuid, p_delivered_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare completed boolean;
begin
  update public.task_occurrences
  set status = 'triggered',
      delivered_at = p_delivered_at,
      next_delivery_attempt_at = null,
      delivery_lease_id = null
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and status = 'delivering'
    and delivery_lease_id = p_lease_id
  returning true into completed;
  return coalesce(completed, false);
end;
$$;

create function public.fail_task_occurrence_delivery(
  p_occurrence_id text, p_owner_id uuid, p_lease_id uuid, p_now timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare failed boolean;
begin
  update public.task_occurrences
  set status = 'delivery-failed',
      delivery_attempts = delivery_attempts + 1,
      next_delivery_attempt_at = case
        when delivery_attempts + 1 >= 5 then null
        else p_now + make_interval(mins => least(60, power(2, delivery_attempts)::integer))
      end,
      delivery_lease_id = null
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and status = 'delivering'
    and delivery_lease_id = p_lease_id
  returning true into failed;
  if coalesce(failed, false) then
    insert into public.task_occurrence_failed_delivery_rounds(
      occurrence_id, owner_id, delivery_round_id
    ) values (p_occurrence_id, p_owner_id, p_lease_id)
    on conflict do nothing;
  end if;
  return coalesce(failed, false);
end;
$$;

create function public.defer_task_occurrence_delivery(
  p_occurrence_id text,
  p_owner_id uuid,
  p_lease_id uuid,
  p_now timestamptz,
  p_delay_minutes integer
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare deferred boolean;
begin
  if p_delay_minutes not in (1, 15) then
    raise exception 'Unsupported delivery deferral';
  end if;
  update public.task_occurrences
  set status = 'delivery-failed',
      next_delivery_attempt_at = p_now + make_interval(mins => p_delay_minutes),
      delivery_lease_id = null
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and status = 'delivering'
    and delivery_lease_id = p_lease_id
  returning true into deferred;
  return coalesce(deferred, false);
end;
$$;

create function public.record_task_occurrence_device_delivery(
  p_occurrence_id text, p_owner_id uuid, p_device_id text, p_lease_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.task_occurrences
    where id = p_occurrence_id
      and owner_id = p_owner_id
      and status = 'delivering'
      and delivery_lease_id = p_lease_id
  ) then return false; end if;
  insert into public.task_occurrence_device_deliveries(
    occurrence_id, owner_id, device_id
  ) values (p_occurrence_id, p_owner_id, p_device_id)
  on conflict (occurrence_id, owner_id, device_id) do update
    set delivered_at = excluded.delivered_at;
  return true;
end;
$$;

create function public.record_task_expo_push_ticket(
  p_ticket_id text,
  p_occurrence_id text,
  p_owner_id uuid,
  p_device_id text,
  p_lease_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare recorded boolean;
begin
  if not exists (
    select 1 from public.task_occurrences
    where id = p_occurrence_id
      and owner_id = p_owner_id
      and status = 'delivering'
      and delivery_lease_id = p_lease_id
  ) then return false; end if;
  insert into public.task_expo_push_tickets(
    ticket_id, occurrence_id, owner_id, device_id,
    device_token_hash, delivery_round_id
  )
  select p_ticket_id, p_occurrence_id, p_owner_id, p_device_id,
    token_hash, p_lease_id
  from public.devices
  where id = p_device_id and owner_id = p_owner_id
  on conflict (ticket_id) do nothing
  returning true into recorded;
  return coalesce(recorded, exists (
    select 1 from public.task_expo_push_tickets
    where ticket_id = p_ticket_id
      and occurrence_id = p_occurrence_id
      and owner_id = p_owner_id
      and device_id = p_device_id
      and delivery_round_id = p_lease_id
  ));
end;
$$;

create function public.complete_task_expo_push_ticket(p_ticket_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare ticket public.task_expo_push_tickets%rowtype;
begin
  delete from public.task_expo_push_tickets
  where ticket_id = p_ticket_id returning * into ticket;
  if not found then return false; end if;
  insert into public.task_occurrence_device_deliveries(
    occurrence_id, owner_id, device_id
  ) values (ticket.occurrence_id, ticket.owner_id, ticket.device_id)
  on conflict (occurrence_id, owner_id, device_id) do update
    set delivered_at = excluded.delivered_at;
  return true;
end;
$$;

create function public.fail_task_expo_push_ticket(
  p_ticket_id text, p_disable_device boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare ticket public.task_expo_push_tickets%rowtype;
declare occurrence public.task_occurrences%rowtype;
declare new_failed_round boolean;
begin
  select * into ticket from public.task_expo_push_tickets
  where ticket_id = p_ticket_id;
  if not found then return false; end if;
  select * into occurrence from public.task_occurrences
  where id = ticket.occurrence_id and owner_id = ticket.owner_id
  for update;
  if not found then return false; end if;
  select * into ticket from public.task_expo_push_tickets
  where ticket_id = p_ticket_id
    and occurrence_id = occurrence.id
    and owner_id = occurrence.owner_id
  for update;
  if not found then return false; end if;
  if p_disable_device then
    delete from public.task_expo_push_tickets
    where ticket_id = p_ticket_id;
    update public.devices set enabled = false, updated_at = now()
    where id = ticket.device_id
      and owner_id = ticket.owner_id
      and token_hash = ticket.device_token_hash;
  else
    if occurrence.status = 'delivering' then return false; end if;
    delete from public.task_expo_push_tickets
    where ticket_id = p_ticket_id;
    if occurrence.status <> 'delivery-failed'
      or occurrence.delivered_at is not null then
      return true;
    end if;
    insert into public.task_occurrence_failed_delivery_rounds(
      occurrence_id, owner_id, delivery_round_id
    ) values (
      ticket.occurrence_id, ticket.owner_id, ticket.delivery_round_id
    )
    on conflict do nothing
    returning true into new_failed_round;
    if not coalesce(new_failed_round, false) then return true; end if;
    update public.task_occurrences
    set status = 'delivery-failed',
        delivery_attempts = least(delivery_attempts + 1, 5),
        next_delivery_attempt_at = case
          when delivery_attempts + 1 >= 5 then null
          else now() + make_interval(mins => least(60, power(2, delivery_attempts)::integer))
        end
    where id = ticket.occurrence_id
      and owner_id = ticket.owner_id
      and status <> 'delivering'
      and delivered_at is null;
  end if;
  return true;
end;
$$;

create function public.dismiss_task_occurrence(
  p_occurrence_id text, p_action_id text default null, p_request_key text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := auth.uid();
  acted public.task_occurrences%rowtype;
  receipt public.task_occurrence_action_receipts%rowtype;
begin
  if owner is null then return false; end if;
  if p_action_id is not null then
    if p_request_key is null then raise exception 'Action identity is required'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner::text || ':' || p_action_id, 3));
    select * into receipt from public.task_occurrence_action_receipts
    where owner_id = owner and action_id = p_action_id;
    if found then
      if receipt.request_key <> p_request_key then
        raise exception 'Action ID was already used for another request';
      end if;
      return true;
    end if;
  end if;
  update public.task_occurrences
  set status = 'dismissed', acted_at = now(), snoozed_until = null,
      next_delivery_attempt_at = null, delivery_lease_id = null
  where id = p_occurrence_id
    and owner_id = owner
    and status in ('scheduled', 'triggered', 'delivering', 'postponed', 'delivery-failed')
  returning * into acted;
  if not found then return false; end if;
  delete from public.task_expo_push_tickets
  where occurrence_id = acted.id and owner_id = acted.owner_id;
  if p_action_id is not null then
    insert into public.task_occurrence_action_receipts(
      owner_id, action_id, task_id, request_key, result
    ) values (owner, p_action_id, acted.task_id, p_request_key, '{"updated":true}');
  end if;
  return true;
end;
$$;

create function public.postpone_task_occurrence(
  p_occurrence_id text,
  p_until timestamptz,
  p_action_id text default null,
  p_request_key text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := auth.uid();
  acted public.task_occurrences%rowtype;
  receipt public.task_occurrence_action_receipts%rowtype;
begin
  if owner is null then return false; end if;
  if p_until is null or not isfinite(p_until) or p_until <= now() then
    raise exception 'Choose a future postponement time';
  end if;
  if p_action_id is not null then
    if p_request_key is null then raise exception 'Action identity is required'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner::text || ':' || p_action_id, 3));
    select * into receipt from public.task_occurrence_action_receipts
    where owner_id = owner and action_id = p_action_id;
    if found then
      if receipt.request_key <> p_request_key then
        raise exception 'Action ID was already used for another request';
      end if;
      return true;
    end if;
  end if;
  update public.task_occurrences occurrence
  set status = 'postponed',
      acted_at = now(),
      snoozed_until = p_until,
      delivered_at = null,
      delivery_attempts = 0,
      next_delivery_attempt_at = null,
      delivery_lease_id = null
  where occurrence.id = p_occurrence_id
    and occurrence.owner_id = owner
    and occurrence.status in ('triggered', 'delivering', 'postponed', 'delivery-failed')
    and exists (
      select 1 from public.tasks
      where id = occurrence.task_id
        and owner_id = occurrence.owner_id
        and status = 'open'
    )
  returning * into acted;
  if not found then return false; end if;
  delete from public.task_expo_push_tickets
  where occurrence_id = acted.id and owner_id = acted.owner_id;
  delete from public.task_occurrence_device_deliveries
  where occurrence_id = acted.id and owner_id = acted.owner_id;
  if p_action_id is not null then
    insert into public.task_occurrence_action_receipts(
      owner_id, action_id, task_id, request_key, result
    ) values (
      owner, p_action_id, acted.task_id, p_request_key,
      jsonb_build_object('updated', true, 'until', p_until)
    );
  end if;
  return true;
end;
$$;

create function public.complete_task_from_occurrence(
  p_occurrence_id text, p_action_id text default null, p_request_key text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := auth.uid();
  acted public.task_occurrences%rowtype;
  receipt public.task_occurrence_action_receipts%rowtype;
begin
  if owner is null then return false; end if;
  if p_action_id is not null then
    if p_request_key is null then raise exception 'Action identity is required'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner::text || ':' || p_action_id, 3));
    select * into receipt from public.task_occurrence_action_receipts
    where owner_id = owner and action_id = p_action_id;
    if found then
      if receipt.request_key <> p_request_key then
        raise exception 'Action ID was already used for another request';
      end if;
      return true;
    end if;
  end if;
  select * into acted from public.task_occurrences
  where id = p_occurrence_id and owner_id = owner for update;
  if not found or acted.status not in (
    'scheduled', 'triggered', 'delivering', 'postponed', 'delivery-failed'
  ) then return false; end if;
  perform 1 from public.tasks
  where id = acted.task_id and owner_id = owner and status = 'open' for update;
  if not found then return false; end if;
  update public.task_occurrences
  set status = 'completed', acted_at = now(), snoozed_until = null,
      next_delivery_attempt_at = null, delivery_lease_id = null
  where id = acted.id and owner_id = owner;
  update public.tasks
  set status = 'completed',
      revision = revision + 1,
      schedule_revision = schedule_revision + 1,
      next_due_at = null,
      updated_at = now()
  where id = acted.task_id and owner_id = owner;
  delete from public.task_expo_push_tickets
  where occurrence_id = acted.id and owner_id = owner;
  if p_action_id is not null then
    insert into public.task_occurrence_action_receipts(
      owner_id, action_id, task_id, request_key, result
    ) values (owner, p_action_id, acted.task_id, p_request_key, '{"updated":true}');
  end if;
  return true;
end;
$$;

alter table public.tasks enable row level security;
alter table public.task_occurrences enable row level security;
alter table public.task_occurrence_device_deliveries enable row level security;
alter table public.task_expo_push_tickets enable row level security;
alter table public.task_occurrence_failed_delivery_rounds enable row level security;
alter table public.task_occurrence_action_receipts enable row level security;
alter table public.task_tombstones enable row level security;

create policy tasks_owner_read on public.tasks for select to authenticated
  using (owner_id = auth.uid());
create policy tasks_owner_create on public.tasks for insert to authenticated
  with check (owner_id = auth.uid());
create policy tasks_owner_update on public.tasks for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy tasks_owner_delete on public.tasks for delete to authenticated
  using (owner_id = auth.uid());
create policy task_occurrences_owner_read on public.task_occurrences
  for select to authenticated using (owner_id = auth.uid());
create policy task_deliveries_owner_read on public.task_occurrence_device_deliveries
  for select to authenticated using (owner_id = auth.uid());
create policy task_action_receipts_owner_read on public.task_occurrence_action_receipts
  for select to authenticated using (owner_id = auth.uid());
create policy task_tombstones_owner_read on public.task_tombstones
  for select to authenticated using (owner_id = auth.uid());
create policy task_tombstones_owner_create on public.task_tombstones
  for insert to authenticated with check (owner_id = auth.uid());
create policy task_tombstones_owner_update on public.task_tombstones
  for update to authenticated using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

revoke all on public.tasks, public.task_occurrences,
  public.task_occurrence_device_deliveries, public.task_expo_push_tickets,
  public.task_occurrence_failed_delivery_rounds,
  public.task_occurrence_action_receipts, public.task_tombstones
from anon, authenticated;
grant select, delete on public.tasks to authenticated;
grant insert(
  id, owner_id, title, notes, tags, category_id, due_at, reminder_policy,
  timezone, status, revision, next_due_at, created_at, updated_at
) on public.tasks to authenticated;
grant update(
  title, notes, tags, category_id, due_at, reminder_policy, timezone,
  status, revision, next_due_at, updated_at
) on public.tasks to authenticated;
grant select on public.task_occurrences,
  public.task_occurrence_device_deliveries,
  public.task_occurrence_action_receipts to authenticated;
grant select, insert, update on public.task_tombstones to authenticated;
grant all on public.tasks, public.task_occurrences,
  public.task_occurrence_device_deliveries, public.task_expo_push_tickets,
  public.task_occurrence_failed_delivery_rounds,
  public.task_occurrence_action_receipts, public.task_tombstones
to service_role;

revoke all on function public.is_valid_task_reminder_policy(jsonb, text, timestamptz),
  public.increment_task_occurrence_count(),
  public.cancel_task_occurrences(),
  public.manage_task_scheduler_fields(),
  public.check_task_category(),
  public.protect_task_tombstones(),
  public.save_task(text, text, text, text[], text, timestamptz, jsonb, text, public.task_status, integer, integer, timestamptz, timestamptz, timestamptz),
  public.restore_task(text, integer, integer, timestamptz),
  public.update_task_next_due(jsonb),
  public.claim_task_occurrence_delivery(text, uuid, text, integer, uuid, timestamptz, timestamptz),
  public.prepare_task_occurrence_delivery(text, text, uuid, integer, timestamptz, text, uuid, timestamptz, timestamptz),
  public.list_deliverable_task_occurrences(timestamptz, timestamptz, integer),
  public.renew_task_occurrence_delivery_lease(text, uuid, uuid, timestamptz),
  public.complete_task_occurrence_delivery(text, uuid, uuid, timestamptz),
  public.fail_task_occurrence_delivery(text, uuid, uuid, timestamptz),
  public.defer_task_occurrence_delivery(text, uuid, uuid, timestamptz, integer),
  public.record_task_occurrence_device_delivery(text, uuid, text, uuid),
  public.record_task_expo_push_ticket(text, text, uuid, text, uuid),
  public.complete_task_expo_push_ticket(text),
  public.fail_task_expo_push_ticket(text, boolean),
  public.dismiss_task_occurrence(text, text, text),
  public.postpone_task_occurrence(text, timestamptz, text, text),
  public.complete_task_from_occurrence(text, text, text)
from public, anon, authenticated;

grant execute on function
  public.is_valid_task_reminder_policy(jsonb, text, timestamptz),
  public.save_task(text, text, text, text[], text, timestamptz, jsonb, text, public.task_status, integer, integer, timestamptz, timestamptz, timestamptz),
  public.restore_task(text, integer, integer, timestamptz),
  public.dismiss_task_occurrence(text, text, text),
  public.postpone_task_occurrence(text, timestamptz, text, text),
  public.complete_task_from_occurrence(text, text, text)
to authenticated;

grant execute on function
  public.update_task_next_due(jsonb),
  public.is_valid_task_reminder_policy(jsonb, text, timestamptz),
  public.claim_task_occurrence_delivery(text, uuid, text, integer, uuid, timestamptz, timestamptz),
  public.prepare_task_occurrence_delivery(text, text, uuid, integer, timestamptz, text, uuid, timestamptz, timestamptz),
  public.list_deliverable_task_occurrences(timestamptz, timestamptz, integer),
  public.renew_task_occurrence_delivery_lease(text, uuid, uuid, timestamptz),
  public.complete_task_occurrence_delivery(text, uuid, uuid, timestamptz),
  public.fail_task_occurrence_delivery(text, uuid, uuid, timestamptz),
  public.defer_task_occurrence_delivery(text, uuid, uuid, timestamptz, integer),
  public.record_task_occurrence_device_delivery(text, uuid, text, uuid),
  public.record_task_expo_push_ticket(text, text, uuid, text, uuid),
  public.complete_task_expo_push_ticket(text),
  public.fail_task_expo_push_ticket(text, boolean)
to service_role;
