-- Coupons from an hour before the start (decided 2026-11-16).
--
-- The gate controls appear an hour before an improvement, feast or paron, and the mess manager may start
-- taking coupons then too. Batch 1 booking only opens 15 minutes before the start, so most students
-- typed early have no booking yet. Their coupon just records that they ate: no seat is taken (every
-- batch 1 seat stays free to book) and it does not count as "joined without booking". Booking then
-- answers ALREADY_ATE for them, so they never take a seat as well.
-- Someone who has already booked and comes before the start is marked in on their own seat as usual.

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
  if now() < v_ms.service_start_at - interval '1 hour' then
    return jsonb_build_object('status', 'BATCH_NOT_STARTED', 'starts_at', v_ms.service_start_at,
      'opens_at', v_ms.service_start_at - interval '1 hour');
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

  if v_seat.id is null and now() < v_ms.service_start_at then
    -- Before the start with no booking: they ate, nothing more. No seat, not a walk-in.
    insert into public.attendance_records (meal_service_id, coupon_id, coupon_number, holder_user_id, source,
                                           client_entry_id, recorded_by)
    values (v_ms.id, v_coupon.id, v_coupon.coupon_number, v_holder, 'LIVE',
            'early-' || v_coupon.id || '-' || gen_random_uuid(), v_uid)
    returning id into v_att;
    return jsonb_build_object('status', 'EARLY', 'coupon_number', p_coupon_number, 'attendance_id', v_att,
      'name', (select full_name from public.profiles where id = v_holder));
  end if;

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

-- An early coupon typed by mistake: its "ate" record is voided. Only coupons taken without a seat;
-- a seat's check-in is undone with undo_check_in.
create function public.undo_early_check_in(p_attendance_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_att public.attendance_records;
begin
  select * into v_att from public.attendance_records where id = p_attendance_id for update;
  if not found then
    raise exception 'attendance not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.batch_seats s where s.attendance_id = v_att.id) then
    return jsonb_build_object('status', 'HAS_SEAT');
  end if;
  if v_att.status <> 'VALID' then
    return jsonb_build_object('status', 'NOT_ARRIVED');
  end if;
  update public.attendance_records
  set status = 'VOIDED', voided_at = now(), voided_by = v_uid, void_reason = 'Early coupon undone'
  where id = v_att.id;
  perform public.write_audit('EARLY_CHECK_IN_UNDONE', 'attendance_record', v_att.id::text, null, null);
  return jsonb_build_object('status', 'UNDONE');
end $$;

revoke all on function public.undo_early_check_in(uuid) from public, anon;
grant execute on function public.undo_early_check_in(uuid) to authenticated;

-- The door's "Just came in" list also shows early coupons (no seat; undone by their attendance id).
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
      from (select * from (
              select s.arrived_at, jsonb_build_object('seat_id', s.id, 'coupon_number', s.coupon_number, 'name', p.full_name,
                       'kind', s.kind, 'arrived_at', s.arrived_at) as item
              from public.batch_seats s left join public.profiles p on p.id = s.user_id
              where s.meal_service_id = v_ms.id and s.state = 'ARRIVED'
              union all
              select a.recorded_at, jsonb_build_object('seat_id', null, 'attendance_id', a.id, 'coupon_number', a.coupon_number,
                       'name', p.full_name, 'kind', 'EARLY', 'arrived_at', a.recorded_at)
              from public.attendance_records a left join public.profiles p on p.id = a.holder_user_id
              where a.meal_service_id = v_ms.id and a.status = 'VALID' and a.client_entry_id like 'early-%'
            ) u order by u.arrived_at desc limit 20) x), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('number', b.number, 'starts_at', b.starts_at, 'loaded_at', b.loaded_at,
               'arrived', (select count(*) from public.batch_seats s where s.batch_id = b.id and s.state = 'ARRIVED'),
               'missed', (select count(*) from public.batch_seats s where s.batch_id = b.id and s.state = 'MISSED'))
             order by b.number)
      from public.meal_batches b where b.meal_service_id = v_ms.id and b.loaded_at is not null), '[]'::jsonb));
end $$;
