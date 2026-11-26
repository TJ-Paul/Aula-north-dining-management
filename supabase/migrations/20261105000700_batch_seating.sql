-- Batch seating (replaces aisles, standby and table-to-table coupons in the screens).
--
-- A meal is served in batches of X seats (meal_services.batch_capacity, set by
-- the admins). Batch 1: booking opens 15 minutes before the start; each booking
-- is a seat straight away, never a waiting list; at the start booked students
-- have 10 minutes to arrive, and while seats are free anyone can "join now"
-- with 5 minutes to arrive. A seat whose time runs out goes back to the pool.
-- The door staff types each coupon as the student walks in (that is the
-- attendance record). "Batch loaded" closes the batch, records a missed meal
-- for every booked student who never came, and opens booking for the next
-- batch, which starts when the staff press "Start batch N".
--
-- The older aisle/wave/standby functions stay in the database for now; the
-- screens no longer use them.

alter table public.meal_services
  add column batch_capacity integer not null default 60 check (batch_capacity between 1 and 500);

create table public.meal_batches (
  id uuid primary key default gen_random_uuid(),
  meal_service_id uuid not null references public.meal_services (id),
  number integer not null check (number >= 1),
  capacity integer not null check (capacity between 1 and 500),
  booking_opens_at timestamptz not null,
  starts_at timestamptz,                 -- arrival countdown; batch 1: the meal's start, later: "Start batch N"
  started_by uuid references public.profiles (id),
  start_notified_at timestamptz,
  loaded_at timestamptz,
  loaded_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (meal_service_id, number)
);
create unique index meal_batches_one_live on public.meal_batches (meal_service_id) where loaded_at is null;

create table public.batch_seats (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.meal_batches (id),
  meal_service_id uuid not null references public.meal_services (id),
  seq integer not null,
  user_id uuid references public.profiles (id),
  coupon_id uuid not null references public.coupons (id),
  coupon_number integer not null,
  kind text not null check (kind in ('BOOKED', 'JOIN_NOW', 'WALK_IN')),
  state text not null default 'HOLDING' check (state in ('HOLDING', 'ARRIVED', 'RELEASED', 'CANCELLED', 'MISSED')),
  booked_at timestamptz not null default now(),
  arrive_by timestamptz,                 -- join-now seats; advance bookings follow the batch start
  arrived_at timestamptz,
  arrived_by uuid references public.profiles (id),
  attendance_id uuid references public.attendance_records (id),
  closed_at timestamptz,
  unique (batch_id, seq)
);
create unique index batch_seats_live_coupon on public.batch_seats (meal_service_id, coupon_id)
  where state in ('HOLDING', 'ARRIVED');
create unique index batch_seats_live_user on public.batch_seats (meal_service_id, user_id)
  where state in ('HOLDING', 'ARRIVED');
create index batch_seats_batch on public.batch_seats (batch_id, state);

-- Door check-ins are attendance records without an aisle wave; missed seats
-- are no-show records without one.
alter table public.attendance_records
  alter column wave_id drop not null,
  alter column aisle_code drop not null;
alter table public.no_show_events
  alter column wave_id drop not null,
  alter column aisle_code drop not null,
  add column batch_seat_id uuid unique references public.batch_seats (id),
  drop constraint no_show_one_commitment,
  add constraint no_show_one_commitment check (
    (commitment = 'BOOKING' and offer_id is null and (reservation_id is not null) <> (batch_seat_id is not null))
    or (commitment = 'INVITATION' and offer_id is not null and reservation_id is null and batch_seat_id is null));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function public.batch_phase(p_b public.meal_batches) returns text
language sql stable as $$
  select case
    when p_b.loaded_at is not null then 'LOADED'
    when p_b.starts_at is not null and now() >= p_b.starts_at then 'ARRIVING'
    when now() >= p_b.booking_opens_at then 'BOOKING'
    else 'NOT_OPEN' end
$$;

create function public.join_now_minutes(p_meal_service_id uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.meal_policy_int(p_meal_service_id, 'join_now_minutes'), 5)
$$;

-- When a seat must be filled by: join-now seats carry their own time; advance
-- bookings get the arrival window from the batch start.
create function public.seat_deadline(p_s public.batch_seats, p_b public.meal_batches) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p_s.arrive_by,
    p_b.starts_at + make_interval(mins => public.meal_policy_int(p_b.meal_service_id, 'confirmed_arrival_window_minutes')))
$$;

create function public.seat_lapsed(p_s public.batch_seats, p_b public.meal_batches) returns boolean
language sql stable as $$
  select p_s.state = 'RELEASED'
      or (p_s.state = 'HOLDING' and p_b.starts_at is not null and now() > public.seat_deadline(p_s, p_b))
$$;

-- Seats in use: arrived, plus holds whose time has not run out.
create function public.batch_taken(p_b public.meal_batches) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.batch_seats s
  where s.batch_id = p_b.id and (s.state = 'ARRIVED' or (s.state = 'HOLDING' and not public.seat_lapsed(s, p_b)))
$$;

create function public.batch_json(p_b public.meal_batches) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_b.id is null then null else jsonb_build_object(
    'id', p_b.id, 'number', p_b.number, 'phase', public.batch_phase(p_b), 'capacity', p_b.capacity,
    'taken', public.batch_taken(p_b),
    'arrived', (select count(*) from public.batch_seats s where s.batch_id = p_b.id and s.state = 'ARRIVED'),
    'booking_opens_at', p_b.booking_opens_at, 'starts_at', p_b.starts_at, 'loaded_at', p_b.loaded_at,
    'arrival_minutes', public.meal_policy_int(p_b.meal_service_id, 'confirmed_arrival_window_minutes'),
    'join_minutes', public.join_now_minutes(p_b.meal_service_id)) end
$$;

create function public.seat_json(p_s public.batch_seats) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_s.id is null then null else (
    select jsonb_build_object(
      'id', p_s.id, 'batch_number', b.number, 'seq', p_s.seq, 'kind', p_s.kind, 'state', p_s.state,
      'coupon_number', p_s.coupon_number, 'booked_at', p_s.booked_at, 'arrived_at', p_s.arrived_at,
      'deadline', public.seat_deadline(p_s, b), 'lapsed', public.seat_lapsed(p_s, b),
      'token', 'B' || b.number || '-' || lpad(p_s.seq::text, 3, '0'))
    from public.meal_batches b where b.id = p_s.batch_id) end
$$;

-- Minutes between a batch being loaded and the next one starting, from recent
-- meals (25 until there is history).
create function public.typical_turnover_minutes() returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(round(avg(extract(epoch from (b2.starts_at - b1.loaded_at)) / 60))::integer, 25)
  from (select b2.* from public.meal_batches b2 where b2.number > 1 and b2.starts_at is not null
        order by b2.starts_at desc limit 30) b2
  join public.meal_batches b1 on b1.meal_service_id = b2.meal_service_id and b1.number = b2.number - 1
$$;

-- Batch 1 of every new meal: booking opens before the start, arrival at the start.
create function public.meal_first_batch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.meal_batches (meal_service_id, number, capacity, booking_opens_at, starts_at)
  values (new.id, 1, new.batch_capacity,
          new.service_start_at - make_interval(mins => public.meal_policy_int(new.id, 'booking_open_minutes_before_start')),
          new.service_start_at);
  return null;
end $$;
create trigger meal_first_batch after insert on public.meal_services
  for each row execute function public.meal_first_batch();

insert into public.meal_batches (meal_service_id, number, capacity, booking_opens_at, starts_at)
select m.id, 1, m.batch_capacity,
       m.service_start_at - make_interval(mins => public.meal_policy_int(m.id, 'booking_open_minutes_before_start')),
       m.service_start_at
from public.meal_services m
where m.state in ('SCHEDULED', 'IN_SERVICE');

-- Closes a batch: every booked student who never came gets a missed meal.
-- Optionally opens booking for the next batch.
create function public.close_batch(p_b public.meal_batches, p_open_next boolean, p_penalize boolean) returns jsonb
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
    if not p_penalize or s.user_id is null
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

-- A closed or cancelled meal closes its live batch (no penalties when cancelled
-- or when the batch never started).
create function public.meal_closes_batches() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.meal_batches;
begin
  if new.state in ('CLOSED', 'CANCELLED') and old.state is distinct from new.state then
    select * into b from public.meal_batches where meal_service_id = new.id and loaded_at is null for update;
    if b.id is not null then
      perform public.close_batch(b, false, new.state = 'CLOSED' and public.batch_phase(b) = 'ARRIVING');
    end if;
  end if;
  return null;
end $$;
create trigger meal_closes_batches after update of state on public.meal_services
  for each row execute function public.meal_closes_batches();

-- ---------------------------------------------------------------------------
-- Students
-- ---------------------------------------------------------------------------

create function public.book_seat(p_meal_service_id uuid) returns jsonb
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
           || to_char(v_b.starts_at at time zone 'Asia/Dhaka', 'HH12:MI am') || ' and give coupon ' || v_number || ' at the door.' end));
  perform public.write_audit('SEAT_BOOKED', 'batch_seat', v_seat.id::text, null,
    jsonb_build_object('batch', v_b.number, 'kind', v_kind, 'coupon_number', v_number));
  return jsonb_build_object('status', v_kind, 'seat', public.seat_json(v_seat));
end $$;

create function public.cancel_seat(p_meal_service_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_seat public.batch_seats;
  v_b public.meal_batches;
begin
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
  return jsonb_build_object('status', 'CANCELLED');
end $$;

-- What a student sees for one meal: the live batch and its bar, their own
-- seat, and when the next batch is likely to start.
create function public.meal_seating(p_meal_service_id uuid) returns jsonb
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
    'previous', case when v_prev.id is null then null else jsonb_build_object(
      'number', v_prev.number, 'starts_at', v_prev.starts_at, 'loaded_at', v_prev.loaded_at,
      'arrived', (select count(*) from public.batch_seats s where s.batch_id = v_prev.id and s.state = 'ARRIVED')) end,
    'estimate_next_start', case when v_b.id is not null and v_b.starts_at is null and v_prev.id is not null
      then v_prev.loaded_at + make_interval(mins => public.typical_turnover_minutes()) end,
    'mine', public.seat_json(v_seat),
    'ate', exists (select 1 from public.attendance_records a
                   where a.meal_service_id = v_ms.id and a.holder_user_id = v_uid and a.status = 'VALID'),
    'said_not_coming', exists (select 1 from public.meal_rsvps r
                               where r.meal_service_id = v_ms.id and r.user_id = v_uid and r.status = 'NOT_COMING'));
end $$;

-- ---------------------------------------------------------------------------
-- Door staff
-- ---------------------------------------------------------------------------

create function public.door_check_in(p_meal_service_id uuid, p_coupon_number integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_ms public.meal_services;
  v_b public.meal_batches;
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
  select * into v_b from public.meal_batches where meal_service_id = v_ms.id and loaded_at is null for update;
  if v_b.id is null or v_ms.state in ('CLOSED', 'CANCELLED') then
    return jsonb_build_object('status', 'NO_OPEN_BATCH');
  end if;
  if public.batch_phase(v_b) <> 'ARRIVING' then
    return jsonb_build_object('status', 'BATCH_NOT_STARTED', 'starts_at', v_b.starts_at);
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

  select * into v_seat from public.batch_seats
  where batch_id = v_b.id and coupon_id = v_coupon.id and state in ('HOLDING', 'RELEASED')
  order by (state = 'HOLDING') desc, booked_at desc limit 1
  for update;

  if v_seat.id is not null and not public.seat_lapsed(v_seat, v_b) then
    v_status := 'ARRIVED';
  else
    -- Late, or no booking: only if a seat is free.
    if public.batch_taken(v_b) >= v_b.capacity then
      return jsonb_build_object('status', 'BATCH_FULL', 'coupon_number', p_coupon_number);
    end if;
    if v_seat.id is null then
      insert into public.batch_seats (batch_id, meal_service_id, seq, user_id, coupon_id, coupon_number, kind, state)
      values (v_b.id, v_ms.id, coalesce((select max(seq) from public.batch_seats where batch_id = v_b.id), 0) + 1,
              v_holder, v_coupon.id, v_coupon.coupon_number, 'WALK_IN', 'HOLDING')
      returning * into v_seat;
      v_status := 'WALK_IN';
    else
      v_status := 'ARRIVED_LATE';
    end if;
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
    'batch', public.batch_json(v_b));
end $$;

-- A coupon typed by mistake: the seat goes back to waiting (a walk-in is removed).
create function public.undo_check_in(p_seat_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_seat public.batch_seats;
  v_b public.meal_batches;
begin
  select * into v_seat from public.batch_seats where id = p_seat_id;
  if not found then
    raise exception 'seat not found' using errcode = 'P0002';
  end if;
  select * into v_b from public.meal_batches where id = v_seat.batch_id for update;
  select * into v_seat from public.batch_seats where id = p_seat_id for update;
  if v_seat.state <> 'ARRIVED' then
    return jsonb_build_object('status', 'NOT_ARRIVED');
  end if;
  if v_b.loaded_at is not null then
    return jsonb_build_object('status', 'BATCH_LOADED');
  end if;
  update public.attendance_records
  set status = 'VOIDED', voided_at = now(), voided_by = v_uid, void_reason = 'Door check-in undone'
  where id = v_seat.attendance_id and status = 'VALID';
  update public.batch_seats
  set state = case when kind = 'WALK_IN' then 'CANCELLED' else 'HOLDING' end,
      arrived_at = null, arrived_by = null, attendance_id = null,
      closed_at = case when kind = 'WALK_IN' then now() end
  where id = v_seat.id;
  perform public.write_audit('DOOR_CHECK_IN_UNDONE', 'batch_seat', v_seat.id::text, null, null);
  return jsonb_build_object('status', 'UNDONE');
end $$;

-- "Batch N loaded": everyone is in; missed seats are recorded and booking for
-- the next batch opens.
create function public.load_batch(p_meal_service_id uuid) returns jsonb
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
  v_r := public.close_batch(v_b, true, true);
  perform public.write_audit('BATCH_LOADED', 'meal_batch', v_b.id::text, null, v_r);
  return jsonb_build_object('status', 'LOADED') || v_r;
end $$;

-- "Start batch N": the room is clear; booked students' arrival time starts now.
create function public.start_next_batch(p_meal_service_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_b public.meal_batches;
begin
  perform 1 from public.meal_services where id = p_meal_service_id for update;
  select * into v_b from public.meal_batches where meal_service_id = p_meal_service_id and loaded_at is null for update;
  if v_b.id is null then
    return jsonb_build_object('status', 'NO_OPEN_BATCH');
  end if;
  if v_b.starts_at is not null then
    return jsonb_build_object('status', 'ALREADY_STARTED');
  end if;
  update public.meal_batches set starts_at = now(), started_by = v_uid where id = v_b.id returning * into v_b;
  perform public.batch_start_notices(v_b);
  perform public.write_audit('BATCH_STARTED', 'meal_batch', v_b.id::text, null, jsonb_build_object('number', v_b.number));
  return jsonb_build_object('status', 'STARTED', 'batch', public.batch_json(v_b));
end $$;

create function public.batch_start_notices(p_b public.meal_batches) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.batch_seats;
begin
  for s in select * from public.batch_seats where batch_id = p_b.id and state = 'HOLDING' and user_id is not null loop
    perform public.enqueue_notification(s.user_id, 'BATCH_STARTED', 'batch-start:' || s.id,
      jsonb_build_object('message', 'Batch ' || p_b.number || ' is starting. Come to the dining hall and give coupon '
        || s.coupon_number || ' at the door by '
        || to_char(public.seat_deadline(s, p_b) at time zone 'Asia/Dhaka', 'HH12:MI am') || '.'));
  end loop;
  update public.meal_batches set start_notified_at = now() where id = p_b.id;
end $$;

create function public.set_batch_capacity(p_meal_service_id uuid, p_capacity integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
begin
  if p_capacity is null or p_capacity < 1 or p_capacity > 500 then
    return jsonb_build_object('status', 'OUT_OF_RANGE');
  end if;
  update public.meal_services set batch_capacity = p_capacity where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  update public.meal_batches set capacity = p_capacity where meal_service_id = p_meal_service_id and loaded_at is null;
  perform public.write_audit('BATCH_CAPACITY_SET', 'meal_service', p_meal_service_id::text, null,
    jsonb_build_object('capacity', p_capacity));
  return jsonb_build_object('status', 'OK');
end $$;

-- The door screen: today's meals, the live batch, who is still expected, the
-- latest arrivals and earlier batches.
create function public.door_board(p_meal_service_id uuid default null) returns jsonb
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
    order by (state = 'IN_SERVICE') desc, service_start_at limit 1;
  end if;
  select * into v_b from public.meal_batches where meal_service_id = v_ms.id and loaded_at is null;
  return jsonb_build_object(
    'meals', coalesce((select jsonb_agg(public.meal_brief(m) order by m.service_start_at) from public.meal_services m
                       where m.state in ('SCHEDULED', 'IN_SERVICE')
                         and m.service_start_at between now() - interval '18 hours' and now() + interval '18 hours'), '[]'::jsonb),
    'meal', case when v_ms.id is null then null else public.meal_brief(v_ms) end,
    'batch', public.batch_json(v_b),
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

-- ---------------------------------------------------------------------------
-- Scheduler: start notices for batch 1, and seats whose time ran out
-- ---------------------------------------------------------------------------

create function public.run_batch_jobs() returns jsonb
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

  for s in
    select bs.id, bs.user_id, bs.coupon_number, mb.number
    from public.batch_seats bs join public.meal_batches mb on mb.id = bs.batch_id
    where bs.state = 'HOLDING' and mb.loaded_at is null and mb.starts_at is not null
      and now() > public.seat_deadline(bs, mb)
    for update of bs skip locked
  loop
    update public.batch_seats set state = 'RELEASED' where id = s.id;
    if s.user_id is not null then
      perform public.enqueue_notification(s.user_id, 'SEAT_RELEASED', 'seat-released:' || s.id,
        jsonb_build_object('message', 'Your time to arrive ran out, so your seat in batch ' || s.number
          || ' was given back. If a seat is still free, the door staff can let you in.'));
    end if;
    v_released := v_released + 1;
  end loop;
  return jsonb_build_object('batches_started', v_started, 'seats_released', v_released);
end $$;

create or replace function public.run_due_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.run_admission_jobs() || public.process_no_shows()
         || jsonb_build_object('rewards_given', public.settle_rsvps())
         || public.run_batch_jobs();
end $$;

-- ---------------------------------------------------------------------------
-- Row level security and grants
-- ---------------------------------------------------------------------------

alter table public.meal_batches enable row level security;
alter table public.batch_seats enable row level security;
create policy meal_batches_select on public.meal_batches for select to authenticated using (true);
create policy batch_seats_select on public.batch_seats for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() >= 'ATTENDANT');
grant select on public.meal_batches, public.batch_seats to authenticated;

grant execute on function
  public.book_seat(uuid),
  public.cancel_seat(uuid),
  public.meal_seating(uuid),
  public.door_check_in(uuid, integer),
  public.undo_check_in(uuid),
  public.load_batch(uuid),
  public.start_next_batch(uuid),
  public.set_batch_capacity(uuid, integer),
  public.door_board(uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Existing read models and checks, now aware of batch seats
-- ---------------------------------------------------------------------------

create or replace function public.set_not_coming(p_meal_service_id uuid, p_not_coming boolean, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_cfg public.rsvp_settings := public.rsvp_config();
  v_ms public.meal_services;
  v_r public.meal_rsvps;
  v_deadline timestamptz;
  v_free_until timestamptz;
  v_req uuid;
begin
  if public.verified_coupon_id(v_uid) is null then
    return jsonb_build_object('status', 'NOT_VERIFIED');
  end if;
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if v_ms.state <> 'SCHEDULED' or now() >= v_ms.service_start_at then
    return jsonb_build_object('status', 'MEAL_STARTED');
  end if;
  v_deadline := public.rsvp_deadline(v_ms);
  select * into v_r from public.meal_rsvps where meal_service_id = v_ms.id and user_id = v_uid for update;

  if p_not_coming then
    if v_r.status = 'NOT_COMING' then
      return jsonb_build_object('status', 'ALREADY_SET');
    end if;
    if now() >= v_deadline then
      return jsonb_build_object('status', 'PAST_DEADLINE', 'deadline', v_deadline);
    end if;
    if exists (select 1 from public.booking_participations
               where meal_service_id = v_ms.id and user_id = v_uid and status <> 'CANCELLED')
       or exists (select 1 from public.batch_seats
                  where meal_service_id = v_ms.id and user_id = v_uid and state in ('HOLDING', 'ARRIVED')) then
      return jsonb_build_object('status', 'CANCEL_BOOKING_FIRST');
    end if;
    insert into public.meal_rsvps (meal_service_id, user_id, status)
    values (v_ms.id, v_uid, 'NOT_COMING')
    on conflict (meal_service_id, user_id) do update set status = 'NOT_COMING', set_at = now(), changed_at = null;
    perform public.write_audit('NOT_COMING_SET', 'meal_service', v_ms.id::text, null, jsonb_build_object('user', v_uid));
    return jsonb_build_object('status', 'OK',
      'change_until', least(now() + make_interval(mins => v_cfg.change_window_minutes), v_deadline));
  end if;

  if v_r.status is distinct from 'NOT_COMING' then
    return jsonb_build_object('status', 'NOT_SET');
  end if;
  v_free_until := least(v_r.set_at + make_interval(mins => v_cfg.change_window_minutes), v_deadline);
  if now() < v_free_until then
    update public.meal_rsvps set status = 'WITHDRAWN', changed_at = now()
    where meal_service_id = v_ms.id and user_id = v_uid;
    perform public.write_audit('NOT_COMING_WITHDRAWN', 'meal_service', v_ms.id::text, null, jsonb_build_object('user', v_uid));
    return jsonb_build_object('status', 'OK');
  end if;
  if exists (select 1 from public.rsvp_change_requests
             where meal_service_id = v_ms.id and user_id = v_uid and status = 'PENDING') then
    return jsonb_build_object('status', 'REQUEST_PENDING');
  end if;
  insert into public.rsvp_change_requests (meal_service_id, user_id, reason)
  values (v_ms.id, v_uid, nullif(left(btrim(p_reason), 300), ''))
  returning id into v_req;
  perform public.write_audit('NOT_COMING_CHANGE_REQUESTED', 'rsvp_change_request', v_req::text, null,
    jsonb_build_object('user', v_uid, 'meal', v_ms.id));
  return jsonb_build_object('status', 'REQUEST_SENT', 'request_id', v_req);
end $$;
create or replace function public.my_rsvp_json(p_ms public.meal_services, p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'deadline', public.rsvp_deadline(p_ms),
    'open', p_ms.state = 'SCHEDULED' and now() < public.rsvp_deadline(p_ms),
    'started', p_ms.state <> 'SCHEDULED' or now() >= p_ms.service_start_at,
    'not_coming', coalesce(r.status = 'NOT_COMING', false),
    'set_at', r.set_at,
    'change_until', case when r.status = 'NOT_COMING' then least(
      r.set_at + make_interval(mins => (public.rsvp_config()).change_window_minutes), public.rsvp_deadline(p_ms)) end,
    'outcome', r.outcome, 'points_awarded', r.points_awarded, 'penalty_applied', r.penalty_applied,
    'request', (select jsonb_build_object('id', q.id, 'status', q.status, 'admin_note', q.admin_note)
                from public.rsvp_change_requests q
                where q.meal_service_id = p_ms.id and q.user_id = p_user_id order by q.created_at desc limit 1),
    'booked', exists (select 1 from public.booking_participations b
                      where b.meal_service_id = p_ms.id and b.user_id = p_user_id and b.status <> 'CANCELLED')
              or exists (select 1 from public.batch_seats s
                         where s.meal_service_id = p_ms.id and s.user_id = p_user_id and s.state in ('HOLDING', 'ARRIVED')))
  from (select 1) one
  left join public.meal_rsvps r on r.meal_service_id = p_ms.id and r.user_id = p_user_id
$$;
create or replace function public.my_dining_history(p_limit integer default 15) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
begin
  return jsonb_build_object(
    'meals', coalesce((
      select jsonb_agg(x.item order by x.service_start_at desc)
      from (
        select m.service_start_at, jsonb_build_object(
          'meal_service_id', m.id, 'meal_type', m.meal_type, 'service_start_at', m.service_start_at,
          'coupon_number', bp.coupon_number,
          'reduced_priority', bp.priority_tier > 0,
          'outcome', case
            when exists (select 1 from public.attendance_records a
                         where a.meal_service_id = m.id and a.coupon_id = bp.coupon_id and a.status = 'VALID') then 'DINED'
            when ns.status = 'VERIFIED' then 'MISSED'
            when ns.status = 'EXCUSED' then 'EXCUSED'
            when ns.status = 'PENDING' then 'CHECKING'
            when bp.status = 'CANCELLED' then 'CANCELLED'
            when m.state in ('CLOSED', 'CANCELLED') and bp.status in ('STANDBY', 'OFFERED') then 'NO_SEAT'
            when m.state in ('CLOSED', 'CANCELLED') then 'NOT_RECORDED'
            else 'UPCOMING'
          end,
          'no_show', case when ns.id is null or ns.status in ('PENDING', 'REVERSED') then null else jsonb_build_object(
            'id', ns.id, 'status', ns.status, 'commitment', ns.commitment, 'reason', ns.reason,
            'appeal', (select jsonb_build_object('status', ap.status, 'explanation', ap.explanation,
                                                 'decision_reason', ap.decision_reason)
                       from public.no_show_appeals ap where ap.no_show_event_id = ns.id)) end) as item
        from (
          select p.meal_service_id, p.coupon_id, p.coupon_number, p.priority_tier, p.status::text as status
          from public.booking_participations p where p.user_id = v_uid
          union all
          (select distinct on (s.meal_service_id) s.meal_service_id, s.coupon_id, s.coupon_number, 0,
                 case s.state when 'CANCELLED' then 'CANCELLED' else 'CONFIRMED' end
          from public.batch_seats s where s.user_id = v_uid
           order by s.meal_service_id, (s.state = 'ARRIVED') desc, (s.state in ('HOLDING', 'MISSED')) desc, s.booked_at desc)
        ) bp
        join public.meal_services m on m.id = bp.meal_service_id
        left join lateral (
          select * from public.no_show_events e
          where e.meal_service_id = m.id and e.user_id = v_uid
          order by e.detected_at desc limit 1) ns on true
        order by m.service_start_at desc
        limit least(greatest(p_limit, 1), 50)
      ) x), '[]'::jsonb),
    'missed_in_window', public.no_show_count(v_uid, now()),
    'window_days', public.policy_int('penalty_window_days'),
    'reduced_priority_pending', exists (select 1 from public.penalty_events
                                        where user_id = v_uid and level = 'PRIORITY_REDUCTION' and status = 'ACTIVE'));
end $$;
create or replace function public.admin_meal_services(p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return jsonb_build_object(
    'meals', coalesce((
      select jsonb_agg(m.item order by m.service_start_at desc)
      from (
        select ms.service_start_at, jsonb_build_object(
          'id', ms.id, 'service_date', ms.service_date, 'meal_type', ms.meal_type,
          'service_start_at', ms.service_start_at, 'state', ms.state, 'policy_version', ms.policy_version,
          'name', ms.name, 'occasion', ms.occasion, 'service_end_at', ms.service_end_at, 'description', ms.description,
          'special', public.meal_is_special(ms.meal_type, ms.occasion), 'choices_close_at', ms.choices_close_at,
          'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name,
                               'alternatives', coalesce((select jsonb_agg(a.name order by a.name) from public.menu_alternatives a
                                                         where a.item_id = i.id), '[]'::jsonb)) order by i.position)
                             from public.menu_items i where i.meal_service_id = ms.id), '[]'::jsonb),
          'invitations_paused', ms.invitations_paused,
          'live_waves', coalesce((select jsonb_agg(jsonb_build_object('aisle', w.aisle_code, 'wave_number', w.wave_number,
                                                                      'phase', w.phase) order by w.aisle_code)
                                  from public.aisle_waves w where w.meal_service_id = ms.id and w.phase <> 'CLOSED'), '[]'::jsonb),
          'batch_capacity', ms.batch_capacity,
          'batch', (select public.batch_json(b) from public.meal_batches b where b.meal_service_id = ms.id
                    order by (b.loaded_at is null) desc, b.number desc limit 1),
          'batches', (select count(*) from public.meal_batches b where b.meal_service_id = ms.id and b.loaded_at is not null),
          'seats', (select count(*) from public.batch_seats s where s.meal_service_id = ms.id and s.state <> 'CANCELLED'),
          'missed', (select count(*) from public.batch_seats s where s.meal_service_id = ms.id and s.state = 'MISSED'),
          'confirmed', (select count(*) from public.booking_participations p
                        where p.meal_service_id = ms.id and p.status in ('CONFIRMED', 'INVITED')),
          'standby', (select count(*) from public.booking_participations p
                      where p.meal_service_id = ms.id and p.status in ('STANDBY', 'OFFERED')),
          'diners', (select count(*) from public.attendance_records r
                     where r.meal_service_id = ms.id and r.status = 'VALID')) as item
        from public.meal_services ms
        order by ms.service_start_at desc
        limit least(greatest(p_limit, 1), 100)
      ) m), '[]'::jsonb),
    'aisles', (select jsonb_agg(jsonb_build_object('aisle', s.aisle_code, 'readiness', s.readiness,
                                                   'display_state', s.display_state, 'meal_service_id', s.meal_service_id,
                                                   'wave_number', s.wave_number) order by s.aisle_code)
               from public.aisle_status s),
    'policies', (select jsonb_agg(jsonb_build_object('version', version, 'note', note, 'is_active', is_active,
                                                     'settings', settings) order by version)
                 from public.policy_settings));
end $$;
