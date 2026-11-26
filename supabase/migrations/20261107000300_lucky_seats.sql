-- Spec amendment 1.4 (decided 2026-11-07):
--
-- 1. "Lucky?" places. Once a batch's X confirmed seats are taken, booking stays open for
--    floor(X × 20%) more students (60 → 12). They are marked LUCKY: they come too, but wait
--    outside the gate. Order at the door: confirmed first, then Lucky?, then anyone without a
--    booking. The door screen shows each group; the staff decide when to let a group in.
--    - A Lucky? student who doesn't come is never counted as a missed meal.
--    - If a confirmed student cancels before the gate opens, the first Lucky? (earliest booking)
--      moves up to a confirmed seat and is told so.
-- 2. "Full" is answered without waiting in the booking queue (bookings still take the meal's
--    lock one at a time; only students who might still get a place wait for it).
-- 3. Three missed meals no longer make the next booking wait 5 minutes. Those students are only
--    marked: on the admin lists and on their own home screen.

alter table public.batch_seats drop constraint batch_seats_kind_check;
alter table public.batch_seats add constraint batch_seats_kind_check
  check (kind in ('BOOKED', 'JOIN_NOW', 'WALK_IN', 'LUCKY'));

-- How many Lucky? places a batch has: 20% of its seats, rounded down.
create function public.batch_lucky_capacity(p_b public.meal_batches) returns integer
language sql immutable as $$
  select floor(coalesce(p_b.capacity, 0) * 0.2)::integer
$$;

-- Confirmed seats taken (Lucky? places are counted separately).
create or replace function public.batch_taken(p_b public.meal_batches) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.batch_seats s
  where s.batch_id = p_b.id and s.kind <> 'LUCKY'
    and (s.state = 'ARRIVED' or (s.state = 'HOLDING' and not public.seat_lapsed(s, p_b)))
$$;

create function public.batch_lucky_taken(p_b public.meal_batches) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.batch_seats s
  where s.batch_id = p_b.id and s.kind = 'LUCKY' and s.state in ('HOLDING', 'ARRIVED')
$$;

create or replace function public.batch_json(p_b public.meal_batches) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_b.id is null then null else jsonb_build_object(
    'id', p_b.id, 'number', p_b.number, 'phase', public.batch_phase(p_b), 'capacity', p_b.capacity,
    'taken', public.batch_taken(p_b),
    'lucky_capacity', public.batch_lucky_capacity(p_b),
    'lucky_taken', public.batch_lucky_taken(p_b),
    'arrived', (select count(*) from public.batch_seats s where s.batch_id = p_b.id and s.state = 'ARRIVED'),
    'booking_opens_at', p_b.booking_opens_at, 'starts_at', p_b.starts_at, 'loaded_at', p_b.loaded_at,
    'arrival_minutes', 5,
    'join_minutes', public.join_now_minutes(p_b.meal_service_id)) end
$$;

-- The 3-missed mark: missed meals in the policy window (30 days) at or over the third step.
create function public.missed_marked(p_user_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.no_show_count(p_user_id, now()) >= public.penalty_threshold('PRIORITY_REDUCTION')
$$;

create or replace function public.penalty_message(p_level public.penalty_level, p_count integer) returns text
language sql immutable as $$
  select case p_level
    when 'REMINDER' then 'Our records show you had a seat for a meal but your coupon was not taken at the door. If that is wrong, you can explain in your history. Please cancel when you can’t come, so someone else can have the seat.'
    when 'WARNING' then 'This is the second meal in 30 days where you had a seat but did not come. Please cancel in the app whenever you can’t come. If a record is wrong, explain it in your history.'
    when 'PRIORITY_REDUCTION' then 'After ' || p_count || ' missed meals in 30 days, you are marked on the hall office’s list. Please cancel in the app whenever you can’t come. If a record is wrong, explain it in your history.'
    else 'Your missed meals are being reviewed by the hall admin. You can explain any of them in your history.'
  end
$$;

create or replace function public.person_stats(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p.id is null then jsonb_build_object('user_id', null) else jsonb_build_object(
    'user_id', p.id, 'public_id', p.public_id, 'name', p.full_name, 'avatar_url', p.avatar_url, 'student_id', p.student_id, 'room', p.room,
    'phone', p.notify_phone, 'role', p.role, 'joined_at', p.created_at,
    'meals_eaten', (select count(*) from public.attendance_records a where a.holder_user_id = p.id and a.status = 'VALID'),
    'last_meal_at', (select max(a.recorded_at) from public.attendance_records a where a.holder_user_id = p.id and a.status = 'VALID'),
    'missed', (select count(*) from public.no_show_events e where e.user_id = p.id and e.status = 'VERIFIED'),
    'missed_recent', public.no_show_count(p.id, now()),
    'missed_marked', public.missed_marked(p.id),
    'not_coming_kept', (select count(*) from public.meal_rsvps r where r.user_id = p.id and r.outcome = 'REWARDED'),
    'came_anyway', (select count(*) from public.meal_rsvps r where r.user_id = p.id and r.outcome = 'CAME_ANYWAY'),
    'points', public.points_balance(p.id),
    'walk_ins', public.walk_in_count(p.id),
    'has_plate', p.has_plate, 'plate_marked_at', p.plate_marked_at) end
  from (select 1) one left join public.profiles p on p.id = p_user_id
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
  v_seat public.batch_seats;
  v_kind text;
begin
  v_coupon := public.verified_coupon_id(v_uid);
  if v_coupon is null then
    return jsonb_build_object('status', 'NOT_VERIFIED');
  end if;

  -- Quick answer without joining the queue: once every seat and every Lucky? place is taken,
  -- "Full" needs no lock. (A cancellation a moment later is like pressing a moment earlier.)
  select * into v_b from public.meal_batches where meal_service_id = p_meal_service_id and loaded_at is null;
  if v_b.id is not null and public.batch_phase(v_b) in ('BOOKING', 'ARRIVING')
     and public.batch_taken(v_b) >= v_b.capacity
     and public.batch_lucky_taken(v_b) >= public.batch_lucky_capacity(v_b)
     and not exists (select 1 from public.batch_seats s where s.meal_service_id = p_meal_service_id
                     and (s.user_id = v_uid or s.coupon_id = v_coupon) and s.state in ('HOLDING', 'ARRIVED')) then
    return jsonb_build_object('status', 'FULL', 'batch', public.batch_json(v_b));
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

  if public.batch_taken(v_b) < v_b.capacity then
    v_kind := case when v_phase = 'ARRIVING' then 'JOIN_NOW' else 'BOOKED' end;
  elsif public.batch_lucky_taken(v_b) < public.batch_lucky_capacity(v_b) then
    v_kind := 'LUCKY';
  else
    return jsonb_build_object('status', 'FULL', 'batch', public.batch_json(v_b));
  end if;

  insert into public.batch_seats (batch_id, meal_service_id, seq, user_id, coupon_id, coupon_number, kind, arrive_by)
  values (v_b.id, v_ms.id, coalesce((select max(seq) from public.batch_seats where batch_id = v_b.id), 0) + 1,
          v_uid, v_coupon, v_number, v_kind,
          case when v_kind = 'JOIN_NOW' then now() + make_interval(mins => public.join_now_minutes(v_ms.id)) end)
  returning * into v_seat;

  perform public.enqueue_notification(v_uid, 'SEAT_BOOKED', 'seat:' || v_seat.id,
    jsonb_build_object('message', case v_kind
      when 'JOIN_NOW' then 'Dining is open: join now. Give coupon ' || v_number || ' at the door within '
           || public.join_now_minutes(v_ms.id) || ' minutes.'
      when 'LUCKY' then 'Lucky? You got a bonus place in batch ' || v_b.number || '. You can come too: wait outside the gate. '
           || 'Booked students go in first, then Lucky? students. If a booked student cancels before the gate opens, you move up to a seat.'
      else 'You have a seat in batch ' || v_b.number || '. Be at the dining hall by '
           || coalesce(to_char(v_b.starts_at at time zone 'Asia/Dhaka', 'FMHH12:MI am'), 'the time the gate opens')
           || ' and give coupon ' || v_number || ' at the door.' end));
  perform public.write_audit('SEAT_BOOKED', 'batch_seat', v_seat.id::text, null,
    jsonb_build_object('batch', v_b.number, 'kind', v_kind, 'coupon_number', v_number));
  return jsonb_build_object('status', v_kind, 'seat', public.seat_json(v_seat));
end $$;

create or replace function public.cancel_seat(p_meal_service_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_seat public.batch_seats;
  v_b public.meal_batches;
  v_up public.batch_seats;
begin
  -- Same lock as booking, so a cancellation and the Lucky? move-up never race a new booking.
  perform 1 from public.meal_services where id = p_meal_service_id for update;
  select * into v_seat from public.batch_seats
  where meal_service_id = p_meal_service_id and user_id = v_uid and state in ('HOLDING', 'ARRIVED') for update;
  if v_seat.id is null then
    return jsonb_build_object('status', 'NO_SEAT');
  end if;
  if v_seat.state = 'ARRIVED' then
    return jsonb_build_object('status', 'ALREADY_ARRIVED');
  end if;
  select * into v_b from public.meal_batches where id = v_seat.batch_id;
  if public.seat_lapsed(v_seat, v_b) then
    return jsonb_build_object('status', 'TOO_LATE');
  end if;
  update public.batch_seats set state = 'CANCELLED', closed_at = now() where id = v_seat.id;
  perform public.write_audit('SEAT_CANCELLED', 'batch_seat', v_seat.id::text, null, null);

  -- A confirmed seat given back before the gate opens goes to the first Lucky? student.
  if v_seat.kind <> 'LUCKY' and v_b.loaded_at is null and public.batch_phase(v_b) = 'BOOKING' then
    select * into v_up from public.batch_seats
    where batch_id = v_b.id and kind = 'LUCKY' and state = 'HOLDING'
    order by seq limit 1 for update;
    if v_up.id is not null then
      update public.batch_seats set kind = 'BOOKED' where id = v_up.id returning * into v_up;
      if v_up.user_id is not null then
        perform public.enqueue_notification(v_up.user_id, 'SEAT_BOOKED', 'seat-up:' || v_up.id,
          jsonb_build_object('message', 'Good news: you moved up from Lucky? to a confirmed seat in batch ' || v_b.number
            || '. Give coupon ' || v_up.coupon_number || ' at the door when the gate opens.'));
      end if;
      perform public.write_audit('LUCKY_MOVED_UP', 'batch_seat', v_up.id::text, null,
        jsonb_build_object('batch', v_b.number, 'coupon_number', v_up.coupon_number));
    end if;
  end if;
  return jsonb_build_object('status', 'CANCELLED');
end $$;

-- "Filled": as before, except a Lucky? student who didn't come is never a missed meal.
create or replace function public.close_batch(p_b public.meal_batches, p_open_next boolean, p_penalize boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.batch_seats;
  v_missed integer := 0;
  v_event uuid;
  v_ms public.meal_services;
  v_next public.meal_batches;
begin
  select * into v_ms from public.meal_services where id = p_b.meal_service_id;
  update public.meal_batches set loaded_at = now(), loaded_by = auth.uid() where id = p_b.id;
  for s in
    select * from public.batch_seats where batch_id = p_b.id and state in ('HOLDING', 'RELEASED') for update
  loop
    -- A "join now" student still within their minutes is on the way: no penalty; they are told.
    -- (Booked students knew the start time; loading counts them as missed, as before.)
    if s.state = 'HOLDING' and s.kind = 'JOIN_NOW' and not public.seat_lapsed(s, p_b) then
      update public.batch_seats set state = 'CANCELLED', closed_at = now() where id = s.id;
      if s.user_id is not null and p_penalize then
        perform public.enqueue_notification(s.user_id, 'SEAT_RELEASED', 'seat-closed:' || s.id,
          jsonb_build_object('message', 'Batch ' || p_b.number || ' filled up and closed before you arrived. '
            || 'This does not count as a missed meal; book the next batch.'));
      end if;
      continue;
    end if;
    if not p_penalize or s.user_id is null or s.kind = 'LUCKY'
       or exists (select 1 from public.attendance_records a
                  where a.meal_service_id = s.meal_service_id and a.coupon_id = s.coupon_id and a.status = 'VALID')
       or exists (select 1 from public.batch_seats o
                  where o.meal_service_id = s.meal_service_id and o.user_id = s.user_id and o.state = 'ARRIVED') then
      update public.batch_seats set state = 'CANCELLED', closed_at = now() where id = s.id;
      continue;
    end if;
    update public.batch_seats set state = 'MISSED', closed_at = now() where id = s.id;
    insert into public.no_show_events (meal_service_id, user_id, coupon_id, coupon_number, commitment, batch_seat_id,
                                       status, verified_at, policy_version)
    values (s.meal_service_id, s.user_id, s.coupon_id, s.coupon_number, 'BOOKING', s.id,
            'VERIFIED', now(), v_ms.policy_version)
    returning id into v_event;
    perform public.write_audit('NO_SHOW_VERIFIED', 'no_show_event', v_event::text, null, null,
                               'Batch ' || p_b.number || ' loaded without them');
    perform public.apply_penalty_for(v_event);
    v_missed := v_missed + 1;
  end loop;
  if p_open_next then
    insert into public.meal_batches (meal_service_id, number, capacity, booking_opens_at)
    values (p_b.meal_service_id, p_b.number + 1, v_ms.batch_capacity, now())
    returning * into v_next;
  end if;
  return jsonb_build_object('batch', p_b.number, 'missed', v_missed,
    'arrived', (select count(*) from public.batch_seats where batch_id = p_b.id and state = 'ARRIVED'),
    'next_batch', v_next.number);
end $$;

-- Gate open: booked students come now; Lucky? students come and wait outside.
create or replace function public.batch_start_notices(p_b public.meal_batches) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.batch_seats;
begin
  for s in select * from public.batch_seats where batch_id = p_b.id and state = 'HOLDING' and user_id is not null loop
    perform public.enqueue_notification(s.user_id, 'BATCH_STARTED', 'batch-start:' || s.id,
      jsonb_build_object('message', case when s.kind = 'LUCKY'
        then 'Batch ' || p_b.number || ' gate is open. You are Lucky?: come and wait outside the gate with coupon '
          || s.coupon_number || '. You go in after the booked students.'
        else 'Batch ' || p_b.number || ' gate is open. Come to the dining hall now and give coupon '
          || s.coupon_number || ' at the door. Your timer has started.' end));
  end loop;
  perform public.notify_everyone('GATE_OPEN', 'gate-open:' || p_b.id,
    (select public.meal_notice_label(ms) from public.meal_services ms where ms.id = p_b.meal_service_id)
      || ': batch ' || p_b.number || ' gate is open. Booked students, come now.', '/me');
  update public.meal_batches set start_notified_at = now() where id = p_b.id;
end $$;

revoke all on function public.batch_lucky_capacity(public.meal_batches), public.batch_lucky_taken(public.meal_batches),
  public.missed_marked(uuid) from public;
