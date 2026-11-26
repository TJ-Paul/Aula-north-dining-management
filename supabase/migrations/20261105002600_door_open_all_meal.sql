-- The door takes coupons from the meal's start until an admin closes the meal, in every
-- batch phase (gate open, filled, taking bookings). Someone let in while no batch is
-- open counts in the batch just filled. The door's "just came in" list covers the whole meal.

create or replace function public.door_check_in(p_meal_service_id uuid, p_coupon_number integer) returns jsonb
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
  -- Coupons are taken from the meal's start until an admin closes it, whatever the batch is doing
  -- (gate open, filled, taking bookings): who comes in is the staff's call.
  if v_ms.state in ('CLOSED', 'CANCELLED') then
    return jsonb_build_object('status', 'MEAL_CLOSED');
  end if;
  if now() < v_ms.service_start_at then
    return jsonb_build_object('status', 'BATCH_NOT_STARTED', 'starts_at', v_ms.service_start_at);
  end if;
  -- The batch in progress, or (between "Filled" and the next booking) the one just filled.
  select * into v_b from public.meal_batches where meal_service_id = v_ms.id
  order by (loaded_at is null) desc, number desc limit 1 for update;
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

  select * into v_seat from public.batch_seats
  where batch_id = v_b.id and coupon_id = v_coupon.id and state in ('HOLDING', 'RELEASED')
  order by (state = 'HOLDING') desc, booked_at desc limit 1
  for update;

  if v_seat.id is not null and not public.seat_lapsed(v_seat, v_b) then
    v_status := 'ARRIVED';
  else
    -- Late, or no booking: they still eat (amendment 1.2). A walk-in counts on their record.
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
            where s.meal_service_id = v_ms.id and s.state = 'ARRIVED' order by s.arrived_at desc limit 20) x), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('number', b.number, 'starts_at', b.starts_at, 'loaded_at', b.loaded_at,
               'arrived', (select count(*) from public.batch_seats s where s.batch_id = b.id and s.state = 'ARRIVED'),
               'missed', (select count(*) from public.batch_seats s where s.batch_id = b.id and s.state = 'MISSED'))
             order by b.number)
      from public.meal_batches b where b.meal_service_id = v_ms.id and b.loaded_at is not null), '[]'::jsonb));
end $$;
