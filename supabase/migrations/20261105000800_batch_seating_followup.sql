-- Batch seating, follow-up.
--
-- 1. Re-declares the read models and checks that learned about batch seats, for
--    local databases that applied an early draft of 20261105000700 (safe to run
--    again: each is create-or-replace).
-- 2. Loading a batch no longer counts a "join now" seat as missed while its
--    holder still has time to arrive; the seat is released without penalty and
--    they are told. Booked students who never came are counted as before.

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
