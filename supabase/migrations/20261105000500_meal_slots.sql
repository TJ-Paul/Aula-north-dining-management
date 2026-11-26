-- One lunch and one dinner a day still; a cancelled meal no longer holds its
-- slot, and parons can be scheduled as often as the managers like.
-- Booking references name the meal: PAR-… for a paron, and a number after the
-- prefix (DIN2-…, PAR3-…) for a later meal of the same kind on the same date.

alter table public.meal_services drop constraint meal_services_service_date_meal_type_key;

create unique index meal_services_one_per_day on public.meal_services (service_date, meal_type)
  where state <> 'CANCELLED' and meal_type <> 'PARON';

create or replace function public.create_meal_service(
  p_service_date date, p_meal_type public.meal_type, p_service_start_at timestamptz,
  p_policy_version integer default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_version integer;
  v_service public.meal_services;
begin
  v_version := coalesce(p_policy_version, (select version from public.policy_settings where is_active));
  if not exists (select 1 from public.policy_settings where version = v_version) then
    raise exception 'unknown policy version %', v_version using errcode = '22023';
  end if;

  insert into public.meal_services (service_date, meal_type, service_start_at, policy_version, created_by)
  values (p_service_date, p_meal_type, p_service_start_at, v_version, v_uid)
  on conflict (service_date, meal_type) where state <> 'CANCELLED' and meal_type <> 'PARON' do nothing
  returning * into v_service;

  if not found then
    select * into v_service from public.meal_services
    where service_date = p_service_date and meal_type = p_meal_type and state <> 'CANCELLED';
    return jsonb_build_object('status', 'EXISTS', 'meal_service_id', v_service.id);
  end if;

  perform public.write_audit('MEAL_SERVICE_CREATED', 'meal_service', v_service.id::text, null, to_jsonb(v_service));
  return jsonb_build_object('status', 'CREATED', 'meal_service_id', v_service.id);
end $$;

-- Rewrites the prefix the booking functions put on a new reservation's reference.
create function public.reservation_booking_ref() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ms public.meal_services;
  v_nth integer;
begin
  select * into v_ms from public.meal_services where id = new.meal_service_id;
  select count(*) + 1 into v_nth from public.meal_services m
  where m.service_date = v_ms.service_date and m.meal_type = v_ms.meal_type
    and (m.created_at, m.id) < (v_ms.created_at, v_ms.id);
  new.booking_ref := format('%s%s-%s-%s-%s',
    case v_ms.meal_type::text when 'BREAKFAST' then 'BRK' when 'LUNCH' then 'LUN' when 'PARON' then 'PAR' else 'DIN' end,
    case when v_nth > 1 then v_nth::text else '' end,
    to_char(v_ms.service_date, 'YYYY-MM-DD'), new.aisle_code, regexp_replace(new.booking_ref, '^.*-', ''));
  return new;
end $$;

create trigger reservation_booking_ref before insert on public.reservations
  for each row execute function public.reservation_booking_ref();
