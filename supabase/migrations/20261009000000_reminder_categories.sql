create table public.category_initialization (
  owner_id uuid primary key references auth.users(id) on delete cascade
);
create table public.reminder_categories (
  id text collate "C" not null check (id ~ '^[a-z0-9_-]+$' and id not in ('all', 'uncategorized')),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  revision integer not null check (revision > 0),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (id, owner_id),
  check (lower(trim(name)) not in ('all', 'uncategorized', 'todos', 'sem categoria'))
);
create unique index reminder_categories_live_name_idx
  on public.reminder_categories(owner_id, lower(trim(name))) where deleted_at is null;
alter table public.category_initialization enable row level security;
alter table public.reminder_categories enable row level security;
create policy categories_owner_read on public.reminder_categories for select to authenticated
  using (owner_id = auth.uid());
revoke all on public.reminder_categories, public.category_initialization from anon, authenticated;
grant select on public.reminder_categories to authenticated;
grant all on public.reminder_categories, public.category_initialization to service_role;

alter table public.reminders add column category_id text collate "C";
grant insert(category_id), update(category_id) on public.reminders to authenticated;
alter table public.reminders add constraint reminders_category_owner_fk
  foreign key (category_id, owner_id) references public.reminder_categories(id, owner_id);

create function public.check_reminder_category()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.category_id is not null then
    perform 1 from public.reminder_categories
    where id = new.category_id and owner_id = new.owner_id and deleted_at is null
    for share;
    if not found then
      raise exception 'Category no longer exists. Choose another category.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger reminders_check_category before insert or update on public.reminders
  for each row execute function public.check_reminder_category();
revoke all on function public.check_reminder_category() from public, anon, authenticated;

create function public.initialize_categories(p_portuguese boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := auth.uid();
begin
  if owner is null then raise exception 'Sign in to initialize categories'; end if;
  insert into public.category_initialization(owner_id) values (owner) on conflict do nothing;
  if found then
    insert into public.reminder_categories(id, owner_id, name, revision) values
      ('personal', owner, case when p_portuguese then 'Pessoal' else 'Personal' end, 1),
      ('work', owner, case when p_portuguese then 'Trabalho' else 'Work' end, 1)
    on conflict (id, owner_id) do nothing;
  end if;
end;
$$;

create function public.save_category(
  p_id text, p_name text, p_revision integer, p_expected_revision integer, p_deleted boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := auth.uid();
  existing public.reminder_categories%rowtype;
begin
  if owner is null then raise exception 'Sign in to change categories'; end if;
  -- Serialize category operations per owner, including insert/name races.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner::text, 1));
  select * into existing from public.reminder_categories where id = p_id and owner_id = owner for update;
  if found then
    if existing.deleted_at is not null then return p_deleted; end if;
    if existing.revision is distinct from p_expected_revision or p_revision <= existing.revision then return false; end if;
    if p_deleted then
      update public.reminder_categories set deleted_at = now(), updated_at = now(), revision = p_revision
      where id = p_id and owner_id = owner;
      update public.reminders set category_id = null, revision = revision + 1, updated_at = now()
      where category_id = p_id and owner_id = owner;
    else
      update public.reminder_categories set name = trim(p_name), revision = p_revision, updated_at = now()
      where id = p_id and owner_id = owner;
    end if;
  else
    if p_expected_revision is not null then return false; end if;
    insert into public.reminder_categories(id, owner_id, name, revision, deleted_at)
    values (p_id, owner, trim(p_name), p_revision, case when p_deleted then now() end);
  end if;
  return true;
end;
$$;
revoke all on function public.initialize_categories(boolean),
  public.save_category(text, text, integer, integer, boolean) from public, anon;
grant execute on function public.initialize_categories(boolean),
  public.save_category(text, text, integer, integer, boolean) to authenticated;
