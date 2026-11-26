-- Wording for batch seating: missed-meal notices no longer mention standby,
-- and times in notices read "8:30 pm" rather than "08:30 pm".

create or replace function public.penalty_message(p_level public.penalty_level, p_count integer) returns text
language sql immutable as $$
  select case p_level
    when 'REMINDER' then 'Our records show you had a seat for a meal but your coupon was not taken at the door. If that is wrong, you can explain in your history. Please cancel when you can’t come, so someone else can have the seat.'
    when 'WARNING' then 'This is the second meal in 30 days where you had a seat but did not come. Please cancel in the app whenever you can’t come. If a record is wrong, explain it in your history.'
    when 'PRIORITY_REDUCTION' then 'After ' || p_count || ' missed meals in 30 days, your next booking waits the first 5 minutes after booking opens. If a record is wrong, explain it in your history.'
    else 'Your missed meals are being reviewed by the hall admin. You can explain any of them in your history.'
  end
$$;

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
  select * into v_b from public.meal_batches where meal_service_id = v_ms.id and loaded_at is null for update;
  if v_ms.state in ('CLOSED', 'CANCELLED') or v_b.id is null then
    return jsonb_build_object('status', 'MEAL_CLOSED');
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

create or replace function public.batch_start_notices(p_b public.meal_batches) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.batch_seats;
begin
  for s in select * from public.batch_seats where batch_id = p_b.id and state = 'HOLDING' and user_id is not null loop
    perform public.enqueue_notification(s.user_id, 'BATCH_STARTED', 'batch-start:' || s.id,
      jsonb_build_object('message', 'Batch ' || p_b.number || ' is starting. Come to the dining hall and give coupon '
        || s.coupon_number || ' at the door by '
        || to_char(public.seat_deadline(s, p_b) at time zone 'Asia/Dhaka', 'FMHH12:MI am') || '.'));
  end loop;
  update public.meal_batches set start_notified_at = now() where id = p_b.id;
end $$;
