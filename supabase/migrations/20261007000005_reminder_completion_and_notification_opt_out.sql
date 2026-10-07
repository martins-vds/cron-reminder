create or replace function public.cancel_completed_reminder_occurrences()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.occurrences
  set status = 'dismissed',
      acted_at = now(),
      snoozed_until = null,
      delivery_lease_id = null,
      next_delivery_attempt_at = null
  where reminder_id = new.id
    and owner_id = new.owner_id
    and status in ('scheduled', 'triggered', 'delivering', 'delivery-failed', 'postponed', 'missed');
  return new;
end;
$$;

revoke all on function public.cancel_completed_reminder_occurrences() from public, anon, authenticated;

create trigger reminders_cancel_completed_occurrences
after update of status on public.reminders
for each row
when (new.status = 'completed' and old.status is distinct from new.status)
execute procedure public.cancel_completed_reminder_occurrences();

alter table public.devices add column user_disabled boolean not null default false;

drop function public.claim_device_token(text, text, text, uuid, uuid);

create function public.claim_device_token(
  p_device_id text,
  p_platform text,
  p_token text,
  p_deregistration_token uuid,
  p_existing_deregistration_token uuid,
  p_enable boolean default false
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  requesting_user uuid := auth.uid();
  claimed boolean;
begin
  if requesting_user is null then
    return false;
  end if;
  if p_platform not in ('android', 'ios', 'web') then
    raise exception 'Unsupported device platform %', p_platform;
  end if;
  delete from public.devices
  where (
    platform = p_platform
    and token_hash = extensions.digest(p_token, 'sha256')
    and id <> p_device_id
    and (
      owner_id = requesting_user
      or deregistration_token = p_existing_deregistration_token
    )
  );
  insert into public.devices(
    id, owner_id, platform, token, deregistration_token,
    enabled, user_disabled, updated_at
  )
  values (
    p_device_id, requesting_user, p_platform, p_token, p_deregistration_token,
    true, false, now()
  )
  on conflict (id) do update
    set platform = excluded.platform,
        token = excluded.token,
        deregistration_token = excluded.deregistration_token,
        enabled = p_enable or not public.devices.user_disabled,
        user_disabled = public.devices.user_disabled and not p_enable,
        updated_at = now()
    where public.devices.owner_id = requesting_user
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_device_token(text, text, text, uuid, uuid, boolean) from public, anon;
grant execute on function public.claim_device_token(text, text, text, uuid, uuid, boolean) to authenticated, service_role;
