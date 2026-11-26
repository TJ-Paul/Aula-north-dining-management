-- The arrival timer only hurries people along: 5 minutes from the gate opening (or from a
-- "join now" booking), counting below zero after that. Nothing happens when it runs out:
-- the seat is kept until the staff press "Filled".
-- Paron: few students join, so instead of "not coming" students say "I'm coming";
-- managers see how many to cook for (0 to begin with).

create or replace function public.seat_deadline(p_s public.batch_seats, p_b public.meal_batches) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p_s.arrive_by, p_b.starts_at + interval '5 minutes')
$$;

create or replace function public.seat_lapsed(p_s public.batch_seats, p_b public.meal_batches) returns boolean
language sql stable as $$
  select p_s.state = 'RELEASED'
$$;

create or replace function public.batch_json(p_b public.meal_batches) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_b.id is null then null else jsonb_build_object(
    'id', p_b.id, 'number', p_b.number, 'phase', public.batch_phase(p_b), 'capacity', p_b.capacity,
    'taken', public.batch_taken(p_b),
    'arrived', (select count(*) from public.batch_seats s where s.batch_id = p_b.id and s.state = 'ARRIVED'),
    'booking_opens_at', p_b.booking_opens_at, 'starts_at', p_b.starts_at, 'loaded_at', p_b.loaded_at,
    'arrival_minutes', 5,
    'join_minutes', public.join_now_minutes(p_b.meal_service_id)) end
$$;

create or replace function public.run_batch_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.meal_batches;
  s record;
  v_started integer := 0;
  v_released integer := 0;
begin
  for b in
    select * from public.meal_batches
    where loaded_at is null and starts_at is not null and starts_at <= now() and start_notified_at is null
    for update skip locked
  loop
    perform public.batch_start_notices(b);
    v_started := v_started + 1;
  end loop;

  return jsonb_build_object('batches_started', v_started, 'seats_released', v_released);
end $$;

create or replace function public.batch_start_notices(p_b public.meal_batches) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.batch_seats;
begin
  for s in select * from public.batch_seats where batch_id = p_b.id and state = 'HOLDING' and user_id is not null loop
    perform public.enqueue_notification(s.user_id, 'BATCH_STARTED', 'batch-start:' || s.id,
      jsonb_build_object('message', 'Batch ' || p_b.number || ' gate is open. Come to the dining hall now and give coupon '
        || s.coupon_number || ' at the door. Your timer has started.'));
  end loop;
  update public.meal_batches set start_notified_at = now() where id = p_b.id;
end $$;

create table public.meal_coming (
  meal_service_id uuid not null references public.meal_services (id),
  user_id uuid not null references public.profiles (id),
  said_at timestamptz not null default now(),
  primary key (meal_service_id, user_id)
);
alter table public.meal_coming enable row level security;

-- "I'm coming" for a paron, until it starts.
create function public.set_coming(p_meal_service_id uuid, p_coming boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_ms public.meal_services;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if v_ms.meal_type <> 'PARON' then
    return jsonb_build_object('status', 'NOT_A_PARON');
  end if;
  if v_ms.state in ('CLOSED', 'CANCELLED') or now() >= v_ms.service_start_at then
    return jsonb_build_object('status', 'TOO_LATE');
  end if;
  if p_coming then
    insert into public.meal_coming (meal_service_id, user_id) values (v_ms.id, v_uid) on conflict do nothing;
  else
    delete from public.meal_coming where meal_service_id = v_ms.id and user_id = v_uid;
  end if;
  return jsonb_build_object('status', 'OK', 'coming', p_coming,
    'count', (select count(*) from public.meal_coming where meal_service_id = v_ms.id));
end $$;

create function public.meal_coming_info(p_meal_service_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'count', (select count(*) from public.meal_coming where meal_service_id = p_meal_service_id),
    'mine', exists (select 1 from public.meal_coming where meal_service_id = p_meal_service_id and user_id = u.id))
  from (select public.require_role('STUDENT') as id) u
$$;

grant execute on function public.set_coming(uuid, boolean), public.meal_coming_info(uuid) to authenticated;
