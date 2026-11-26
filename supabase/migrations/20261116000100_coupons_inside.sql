-- Amendment 1.7 (decided 2026-11-16): coupons are taken inside, nobody is penalised.
--
-- How a batch runs now: at "Gate open" everyone comes; someone at the gate only asks who booked
-- (booked first, then Lucky?, then anyone else while there is room). No coupon at the door. When the
-- room is full the mess manager presses "Filled", then goes table to table and types each coupon.
-- When the room starts to empty they press "Start taking bookings", later "Gate open", and so on.
--
-- So:
-- 1. "Filled" (and closing a meal) never records a missed meal. Seats whose coupon has not been
--    typed yet are RELEASED, not MISSED: the student may well be inside, waiting for the manager.
-- 2. A coupon typed at any time finds the student's own booked or Lucky? seat in this meal (held or
--    released) and marks them in as booked. Someone with no seat counts as "joined without booking"
--    in the batch being served: the one whose gate is open, else the one just filled.

create or replace function public.close_batch(p_b public.meal_batches, p_open_next boolean, p_penalize boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ms public.meal_services;
  v_next public.meal_batches;
begin
  -- p_penalize is kept for the callers' signature; missed meals are no longer recorded.
  select * into v_ms from public.meal_services where id = p_b.meal_service_id;
  update public.meal_batches set loaded_at = now(), loaded_by = auth.uid() where id = p_b.id;
  update public.batch_seats set state = 'RELEASED', closed_at = now()
  where batch_id = p_b.id and state = 'HOLDING';
  if p_open_next then
    insert into public.meal_batches (meal_service_id, number, capacity, booking_opens_at)
    values (p_b.meal_service_id, p_b.number + 1, v_ms.batch_capacity, now())
    returning * into v_next;
  end if;
  return jsonb_build_object('batch', p_b.number, 'missed', 0,
    'arrived', (select count(*) from public.batch_seats where batch_id = p_b.id and state = 'ARRIVED'),
    'next_batch', v_next.number);
end $$;

create or replace function public.door_check_in(p_meal_service_id uuid, p_coupon_number integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_ms public.meal_services;
  v_b public.meal_batches;
  v_open public.meal_batches;
  v_coupon public.coupons;
  v_holder uuid;
  v_seat public.batch_seats;
  v_status text;
  v_att uuid;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if v_ms.state in ('CLOSED', 'CANCELLED') then
    return jsonb_build_object('status', 'MEAL_CLOSED');
  end if;
  if now() < v_ms.service_start_at then
    return jsonb_build_object('status', 'BATCH_NOT_STARTED', 'starts_at', v_ms.service_start_at);
  end if;
  -- The batch being served: the open one once its gate is open, else the one just filled.
  select * into v_open from public.meal_batches where meal_service_id = v_ms.id and loaded_at is null
  order by number desc limit 1 for update;
  if v_open.id is not null and public.batch_phase(v_open) = 'ARRIVING' then
    v_b := v_open;
  else
    select * into v_b from public.meal_batches where meal_service_id = v_ms.id and loaded_at is not null
    order by number desc limit 1 for update;
    if v_b.id is null then
      v_b := v_open;
    end if;
  end if;
  if v_b.id is null then
    return jsonb_build_object('status', 'NO_OPEN_BATCH');
  end if;
  select * into v_coupon from public.coupons where coupon_number = p_coupon_number;
  if v_coupon.id is null then
    return jsonb_build_object('status', 'UNKNOWN_COUPON', 'coupon_number', p_coupon_number);
  end if;
  select c.user_id into v_holder from public.coupon_claims c where c.coupon_id = v_coupon.id and c.status = 'APPROVED';
  if exists (select 1 from public.attendance_records a
             where a.meal_service_id = v_ms.id and a.coupon_id = v_coupon.id and a.status = 'VALID') then
    return jsonb_build_object('status', 'ALREADY_ARRIVED', 'coupon_number', p_coupon_number);
  end if;

  -- Their own seat in this meal, in any batch: still held, or released when the batch was filled.
  select * into v_seat from public.batch_seats
  where meal_service_id = v_ms.id and coupon_id = v_coupon.id and state in ('HOLDING', 'RELEASED')
  order by (state = 'HOLDING') desc, booked_at desc limit 1
  for update;

  if v_seat.id is not null then
    v_status := 'ARRIVED';
  else
    -- No booking: they still eat (amendment 1.2), and it counts as "joined without booking".
    insert into public.batch_seats (batch_id, meal_service_id, seq, user_id, coupon_id, coupon_number, kind, state)
    values (v_b.id, v_ms.id, coalesce((select max(seq) from public.batch_seats where batch_id = v_b.id), 0) + 1,
            v_holder, v_coupon.id, v_coupon.coupon_number, 'WALK_IN', 'HOLDING')
    returning * into v_seat;
    v_status := 'WALK_IN';
  end if;

  insert into public.attendance_records (meal_service_id, coupon_id, coupon_number, holder_user_id, source,
                                         client_entry_id, recorded_by)
  values (v_ms.id, v_coupon.id, v_coupon.coupon_number, v_holder, 'LIVE',
          'door-' || v_seat.id || '-' || extract(epoch from clock_timestamp())::bigint, v_uid)
  returning id into v_att;
  update public.batch_seats
  set state = 'ARRIVED', arrived_at = now(), arrived_by = v_uid, attendance_id = v_att, closed_at = null
  where id = v_seat.id
  returning * into v_seat;

  return jsonb_build_object('status', v_status, 'coupon_number', p_coupon_number, 'seat', public.seat_json(v_seat),
    'name', (select full_name from public.profiles where id = v_holder),
    'said_not_coming', exists (select 1 from public.meal_rsvps r where r.meal_service_id = v_ms.id
                               and r.user_id = v_holder and r.status = 'NOT_COMING'),
    'batch', public.batch_json((select b from public.meal_batches b where b.id = v_seat.batch_id)));
end $$;
