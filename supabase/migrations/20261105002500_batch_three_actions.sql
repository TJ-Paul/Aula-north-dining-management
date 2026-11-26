-- Batches, as the hall runs them (user's decision, 2026-11-06). The staff drive each
-- batch with three actions, each starting a stopwatch everyone can see:
--   1. "Filled" (load_batch): everyone is in. Booked students who never came get a
--      missed meal. No booking is open now.
--   2. "Start taking bookings" (open_next_booking): the staff choose how many may book
--      (default: the number they chose last time) and booking opens at once.
--   3. "Gate open" (start_next_batch): booked students come to the door.
-- Then "Filled" again, and so on. Batch 1 still opens 15 minutes before the start
-- and its gate opens at the start time. Who is let in first is the staff's call.

-- The batch filled last, for the "filled … ago" stopwatch.
create function public.last_filled_json(p_meal_service_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('number', b.number, 'starts_at', b.starts_at, 'loaded_at', b.loaded_at, 'capacity', b.capacity,
           'arrived', (select count(*) from public.batch_seats s where s.batch_id = b.id and s.state = 'ARRIVED'),
           'missed', (select count(*) from public.batch_seats s where s.batch_id = b.id and s.state = 'MISSED'))
  from public.meal_batches b where b.meal_service_id = p_meal_service_id and b.loaded_at is not null
  order by b.number desc limit 1
$$;

-- 1. "Filled": closes the batch; booking for the next one waits for the staff.
create or replace function public.load_batch(p_meal_service_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_b public.meal_batches;
  v_r jsonb;
begin
  perform 1 from public.meal_services where id = p_meal_service_id for update;
  select * into v_b from public.meal_batches where meal_service_id = p_meal_service_id and loaded_at is null for update;
  if v_b.id is null then
    return jsonb_build_object('status', 'NO_OPEN_BATCH');
  end if;
  if public.batch_phase(v_b) <> 'ARRIVING' then
    return jsonb_build_object('status', 'BATCH_NOT_STARTED');
  end if;
  v_r := public.close_batch(v_b, false, true);
  perform public.write_audit('BATCH_LOADED', 'meal_batch', v_b.id::text, null, v_r);
  return jsonb_build_object('status', 'LOADED', 'filled_at', now()) || v_r;
end $$;

-- 2. "Start taking bookings": the next batch, for p_capacity people (or as many as last time).
create function public.open_next_booking(p_meal_service_id uuid, p_capacity integer default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_ms public.meal_services;
  v_last public.meal_batches;
  v_b public.meal_batches;
  v_cap integer;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if v_ms.state in ('CLOSED', 'CANCELLED') then
    return jsonb_build_object('status', 'MEAL_CLOSED');
  end if;
  if exists (select 1 from public.meal_batches where meal_service_id = v_ms.id and loaded_at is null) then
    return jsonb_build_object('status', 'ALREADY_OPEN');
  end if;
  select * into v_last from public.meal_batches where meal_service_id = v_ms.id order by number desc limit 1;
  v_cap := coalesce(p_capacity, v_ms.batch_capacity);
  if v_cap < 1 or v_cap > 500 then
    return jsonb_build_object('status', 'OUT_OF_RANGE');
  end if;
  -- Remembered as the default for the next time.
  update public.meal_services set batch_capacity = v_cap where id = v_ms.id;
  insert into public.meal_batches (meal_service_id, number, capacity, booking_opens_at)
  values (v_ms.id, coalesce(v_last.number, 0) + 1, v_cap, now())
  returning * into v_b;
  perform public.write_audit('BATCH_BOOKING_OPENED', 'meal_batch', v_b.id::text, null,
    jsonb_build_object('number', v_b.number, 'capacity', v_cap));
  return jsonb_build_object('status', 'BOOKING_OPEN', 'batch', public.batch_json(v_b));
end $$;

create or replace function public.book_seat(p_meal_service_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_coupon uuid;
  v_number integer;
  v_ms public.meal_services;
  v_b public.meal_batches;
  v_phase text;
  v_pen public.penalty_events;
  v_seat public.batch_seats;
  v_kind text;
begin
  v_coupon := public.verified_coupon_id(v_uid);
  if v_coupon is null then
    return jsonb_build_object('status', 'NOT_VERIFIED');
  end if;
  select coupon_number into v_number from public.coupons where id = v_coupon;
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  -- Regular lunch and dinner need no booking: attendance is ticked by an admin afterwards.
  if not public.meal_is_special(v_ms.meal_type, v_ms.occasion) then
    return jsonb_build_object('status', 'NO_BOOKING_NEEDED');
  end if;
  select * into v_b from public.meal_batches where meal_service_id = v_ms.id and loaded_at is null for update;
  if v_ms.state in ('CLOSED', 'CANCELLED') then
    return jsonb_build_object('status', 'MEAL_CLOSED');
  end if;
  -- The last batch is filled and the staff haven't opened booking for the next one yet.
  if v_b.id is null then
    return jsonb_build_object('status', 'BOOKING_PAUSED');
  end if;
  v_phase := public.batch_phase(v_b);
  if v_phase = 'NOT_OPEN' then
    return jsonb_build_object('status', 'BOOKING_NOT_OPEN', 'opens_at', v_b.booking_opens_at);
  end if;
  if exists (select 1 from public.meal_rsvps where meal_service_id = v_ms.id and user_id = v_uid and status = 'NOT_COMING') then
    return jsonb_build_object('status', 'SAID_NOT_COMING');
  end if;
  select * into v_seat from public.batch_seats
  where meal_service_id = v_ms.id and (user_id = v_uid or coupon_id = v_coupon) and state in ('HOLDING', 'ARRIVED');
  if v_seat.id is not null then
    if v_seat.state = 'ARRIVED' or not public.seat_lapsed(v_seat, (select b from public.meal_batches b where b.id = v_seat.batch_id)) then
      return jsonb_build_object('status', 'ALREADY_BOOKED', 'seat', public.seat_json(v_seat));
    end if;
    -- Their earlier hold ran out: it is released and they may book again like anyone else.
    update public.batch_seats set state = 'RELEASED' where id = v_seat.id;
  end if;
  if exists (select 1 from public.attendance_records a
             where a.meal_service_id = v_ms.id and a.coupon_id = v_coupon and a.status = 'VALID') then
    return jsonb_build_object('status', 'ALREADY_ATE');
  end if;

  -- Third missed meal: this one booking waits the first 5 minutes of booking.
  select * into v_pen from public.penalty_events
  where user_id = v_uid and level = 'PRIORITY_REDUCTION' and status = 'ACTIVE' order by applied_at limit 1 for update;
  if v_pen.id is not null and v_phase = 'BOOKING' and now() < v_b.booking_opens_at + interval '5 minutes' then
    return jsonb_build_object('status', 'PRIORITY_REDUCED', 'opens_at', v_b.booking_opens_at + interval '5 minutes');
  end if;

  if public.batch_taken(v_b) >= v_b.capacity then
    return jsonb_build_object('status', 'FULL', 'batch', public.batch_json(v_b));
  end if;

  v_kind := case when v_phase = 'ARRIVING' then 'JOIN_NOW' else 'BOOKED' end;
  insert into public.batch_seats (batch_id, meal_service_id, seq, user_id, coupon_id, coupon_number, kind, arrive_by)
  values (v_b.id, v_ms.id, coalesce((select max(seq) from public.batch_seats where batch_id = v_b.id), 0) + 1,
          v_uid, v_coupon, v_number, v_kind,
          case when v_kind = 'JOIN_NOW' then now() + make_interval(mins => public.join_now_minutes(v_ms.id)) end)
  returning * into v_seat;
  if v_pen.id is not null then
    update public.penalty_events set status = 'CONSUMED', consumed_at = now(), consumed_meal_service_id = v_ms.id
    where id = v_pen.id;
  end if;

  perform public.enqueue_notification(v_uid, 'SEAT_BOOKED', 'seat:' || v_seat.id,
    jsonb_build_object('message', case when v_kind = 'JOIN_NOW'
      then 'Dining is open: join now. Give coupon ' || v_number || ' at the door within '
           || public.join_now_minutes(v_ms.id) || ' minutes.'
      else 'You have a seat in batch ' || v_b.number || '. Be at the dining hall by '
           || to_char(v_b.starts_at at time zone 'Asia/Dhaka', 'FMHH12:MI am') || ' and give coupon ' || v_number || ' at the door.' end));
  perform public.write_audit('SEAT_BOOKED', 'batch_seat', v_seat.id::text, null,
    jsonb_build_object('batch', v_b.number, 'kind', v_kind, 'coupon_number', v_number));
  return jsonb_build_object('status', v_kind, 'seat', public.seat_json(v_seat));
end $$;

create or replace function public.meal_seating(p_meal_service_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_ms public.meal_services;
  v_b public.meal_batches;
  v_prev public.meal_batches;
  v_seat public.batch_seats;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  select * into v_b from public.meal_batches where meal_service_id = v_ms.id and loaded_at is null;
  select * into v_prev from public.meal_batches where meal_service_id = v_ms.id and loaded_at is not null
  order by number desc limit 1;
  select * into v_seat from public.batch_seats where meal_service_id = v_ms.id and user_id = v_uid
  order by (state in ('HOLDING', 'ARRIVED')) desc, booked_at desc limit 1;
  return jsonb_build_object(
    'meal_state', v_ms.state,
    'batch', public.batch_json(v_b),
    'previous', public.last_filled_json(v_ms.id),
    'estimate_next_start', case when v_b.id is not null and v_b.starts_at is null and v_prev.id is not null
      then v_prev.loaded_at + make_interval(mins => public.typical_turnover_minutes()) end,
    'mine', public.seat_json(v_seat),
    'ate', exists (select 1 from public.attendance_records a
                   where a.meal_service_id = v_ms.id and a.holder_user_id = v_uid and a.status = 'VALID'),
    'said_not_coming', exists (select 1 from public.meal_rsvps r
                               where r.meal_service_id = v_ms.id and r.user_id = v_uid and r.status = 'NOT_COMING'));
end $$;

create or replace function public.door_board(p_meal_service_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_ms public.meal_services;
  v_b public.meal_batches;
begin
  if p_meal_service_id is not null then
    select * into v_ms from public.meal_services where id = p_meal_service_id;
  else
    select * into v_ms from public.meal_services
    where state in ('SCHEDULED', 'IN_SERVICE') and service_start_at between now() - interval '18 hours' and now() + interval '18 hours'
      and public.meal_is_special(meal_type, occasion)
    order by (state = 'IN_SERVICE') desc, service_start_at limit 1;
  end if;
  select * into v_b from public.meal_batches where meal_service_id = v_ms.id and loaded_at is null;
  return jsonb_build_object(
    'meals', coalesce((select jsonb_agg(public.meal_brief(m) order by m.service_start_at) from public.meal_services m
                       where m.state in ('SCHEDULED', 'IN_SERVICE') and public.meal_is_special(m.meal_type, m.occasion)
                         and m.service_start_at between now() - interval '18 hours' and now() + interval '18 hours'), '[]'::jsonb),
    'meal', case when v_ms.id is null then null else public.meal_brief(v_ms) end,
    'batch', public.batch_json(v_b),
    'previous', public.last_filled_json(v_ms.id),
    'next_capacity', v_ms.batch_capacity,
    'turnover_minutes', public.typical_turnover_minutes(),
    'not_coming', (select count(*) from public.meal_rsvps r where r.meal_service_id = v_ms.id and r.status = 'NOT_COMING'),
    'expected', coalesce((
      select jsonb_agg(jsonb_build_object('seat_id', s.id, 'coupon_number', s.coupon_number, 'name', p.full_name,
               'kind', s.kind, 'deadline', public.seat_deadline(s, v_b), 'lapsed', public.seat_lapsed(s, v_b))
             order by s.coupon_number)
      from public.batch_seats s left join public.profiles p on p.id = s.user_id
      where s.batch_id = v_b.id and s.state in ('HOLDING', 'RELEASED')), '[]'::jsonb),
    'arrivals', coalesce((
      select jsonb_agg(x.item order by x.arrived_at desc)
      from (select s.arrived_at, jsonb_build_object('seat_id', s.id, 'coupon_number', s.coupon_number, 'name', p.full_name,
                     'kind', s.kind, 'arrived_at', s.arrived_at) as item
            from public.batch_seats s left join public.profiles p on p.id = s.user_id
            where s.batch_id = v_b.id and s.state = 'ARRIVED' order by s.arrived_at desc limit 20) x), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('number', b.number, 'starts_at', b.starts_at, 'loaded_at', b.loaded_at,
               'arrived', (select count(*) from public.batch_seats s where s.batch_id = b.id and s.state = 'ARRIVED'),
               'missed', (select count(*) from public.batch_seats s where s.batch_id = b.id and s.state = 'MISSED'))
             order by b.number)
      from public.meal_batches b where b.meal_service_id = v_ms.id and b.loaded_at is not null), '[]'::jsonb));
end $$;

grant execute on function public.open_next_booking(uuid, integer) to authenticated;
