-- Regular lunch and dinner are menu-only: no booking. An admin ticks who ate
-- afterwards (set_meal_attendance), the traditional way. Booking, batches and
-- the door stay for special events (paron, improvement, feast).
-- Also: a notice on any meal; each student's day-by-day meal history; two-way
-- roommates (request and accept); and a full profile view for admins.

alter table public.meal_services add column notice text check (char_length(notice) <= 1000);

create or replace function public.meal_brief(p_ms public.meal_services) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', p_ms.id, 'service_date', p_ms.service_date, 'meal_type', p_ms.meal_type, 'occasion', p_ms.occasion,
    'name', p_ms.name, 'service_start_at', p_ms.service_start_at, 'service_end_at', p_ms.service_end_at,
    'state', p_ms.state, 'special', public.meal_is_special(p_ms.meal_type, p_ms.occasion),
    'choices_close_at', public.meal_choices_close(p_ms),
    'notice', p_ms.notice,
    'menu', coalesce((select jsonb_agg(case when exists (select 1 from public.menu_alternatives a where a.item_id = i.id)
                                            then i.name || ' (or ' || (select string_agg(a.name, ' / ' order by a.name)
                                                                        from public.menu_alternatives a where a.item_id = i.id) || ')'
                                            else i.name end order by i.position)
                      from public.menu_items i where i.meal_service_id = p_ms.id), '[]'::jsonb))
$$;

create function public.set_meal_notice(p_meal_service_id uuid, p_notice text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
begin
  update public.meal_services set notice = nullif(left(btrim(coalesce(p_notice, '')), 1000), '') where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  perform public.write_audit('MEAL_NOTICE_SET', 'meal_service', p_meal_service_id::text, null, jsonb_build_object('notice', p_notice));
  return jsonb_build_object('status', 'OK');
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
-- Manual attendance for regular meals
-- ---------------------------------------------------------------------------

-- Everyone with a verified coupon, and whether they are marked as having eaten.
create function public.meal_attendance_sheet(p_meal_service_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_ms public.meal_services;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'meal', public.meal_brief(v_ms),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('coupon_number', k.coupon_number, 'user_id', p.id, 'name', p.full_name,
               'avatar_url', p.avatar_url, 'room', p.room,
               'ate', exists (select 1 from public.attendance_records a
                              where a.meal_service_id = v_ms.id and a.coupon_id = k.id and a.status = 'VALID'),
               'not_coming', exists (select 1 from public.meal_rsvps r
                                     where r.meal_service_id = v_ms.id and r.user_id = p.id and r.status = 'NOT_COMING'))
             order by k.coupon_number)
      from public.coupon_claims c join public.coupons k on k.id = c.coupon_id join public.profiles p on p.id = c.user_id
      where c.status = 'APPROVED'), '[]'::jsonb));
end $$;

-- The admin's ticks: exactly these coupons ate this meal. Others' entries are voided.
create function public.set_meal_attendance(p_meal_service_id uuid, p_coupon_numbers integer[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_ms public.meal_services;
  k record;
  v_added integer := 0;
  v_removed integer;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if v_ms.state = 'CANCELLED' then
    return jsonb_build_object('status', 'MEAL_CANCELLED');
  end if;
  if now() < v_ms.service_start_at then
    return jsonb_build_object('status', 'NOT_STARTED');
  end if;

  update public.attendance_records a
  set status = 'VOIDED', voided_at = now(), voided_by = v_uid, void_reason = 'Unticked on the attendance sheet'
  from public.coupons kk
  where a.meal_service_id = v_ms.id and a.status = 'VALID' and kk.id = a.coupon_id
    and not (kk.coupon_number = any(coalesce(p_coupon_numbers, '{}')));
  get diagnostics v_removed = row_count;

  for k in
    select kk.id, kk.coupon_number, c.user_id
    from public.coupons kk join public.coupon_claims c on c.coupon_id = kk.id and c.status = 'APPROVED'
    where kk.coupon_number = any(coalesce(p_coupon_numbers, '{}'))
      and not exists (select 1 from public.attendance_records a
                      where a.meal_service_id = v_ms.id and a.coupon_id = kk.id and a.status = 'VALID')
  loop
    insert into public.attendance_records (meal_service_id, coupon_id, coupon_number, holder_user_id, source,
                                           client_entry_id, recorded_by)
    values (v_ms.id, k.id, k.coupon_number, k.user_id, 'PAPER_BACKFILL',
            'sheet-' || v_ms.id || '-' || k.coupon_number || '-' || extract(epoch from clock_timestamp())::bigint, v_uid);
    v_added := v_added + 1;
  end loop;

  perform public.write_audit('MEAL_ATTENDANCE_SET', 'meal_service', v_ms.id::text, null,
    jsonb_build_object('added', v_added, 'removed', v_removed, 'present', coalesce(array_length(p_coupon_numbers, 1), 0)));
  return jsonb_build_object('status', 'OK', 'added', v_added, 'removed', v_removed,
    'present', (select count(*) from public.attendance_records a where a.meal_service_id = v_ms.id and a.status = 'VALID'));
end $$;

-- ---------------------------------------------------------------------------
-- A student's meals, day by day
-- ---------------------------------------------------------------------------

create function public.meal_days_for(p_user_id uuid, p_days integer) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(d.day order by d.service_date desc), '[]'::jsonb)
  from (
    select m.service_date, jsonb_build_object('date', m.service_date, 'meals', jsonb_agg(jsonb_build_object(
             'id', m.id, 'meal_type', m.meal_type, 'name', m.name, 'occasion', m.occasion,
             'special', public.meal_is_special(m.meal_type, m.occasion), 'service_start_at', m.service_start_at,
             'ate', exists (select 1 from public.attendance_records a
                            where a.meal_service_id = m.id and a.holder_user_id = p_user_id and a.status = 'VALID'),
             'over', m.state = 'CLOSED' or now() > coalesce(m.service_end_at, m.service_start_at + interval '3 hours'))
           order by m.service_start_at)) as day
    from public.meal_services m
    where m.state <> 'CANCELLED' and m.service_start_at <= now() + interval '1 day'
      and m.service_date >= public.dhaka_today() - least(greatest(p_days, 1), 400)
    group by m.service_date) d
$$;

create function public.my_meal_days(p_days integer default 30) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select public.meal_days_for(public.require_role('STUDENT'), p_days)
$$;

-- One day's meals in full: menu (with the caller's picks), times, notices, whether they ate.
create function public.meal_day(p_date date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(public.meal_brief(m) || jsonb_build_object(
           'description', m.description,
           'ate', exists (select 1 from public.attendance_records a
                          where a.meal_service_id = m.id and a.holder_user_id = auth.uid() and a.status = 'VALID'),
           'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name,
                        'alternatives', coalesce((select jsonb_agg(a.name order by a.name) from public.menu_alternatives a
                                                  where a.item_id = i.id), '[]'::jsonb),
                        'my_choice', (select a.name from public.menu_choices c join public.menu_alternatives a on a.id = c.alternative_id
                                      where c.item_id = i.id and c.user_id = auth.uid())) order by i.position)
                      from public.menu_items i where i.meal_service_id = m.id), '[]'::jsonb))
         order by m.service_start_at), '[]'::jsonb)
  from public.meal_services m
  where public.require_role('STUDENT') is not null and m.service_date = p_date and m.state <> 'CANCELLED'
$$;

-- ---------------------------------------------------------------------------
-- Roommates: a request the other student accepts
-- ---------------------------------------------------------------------------

create table public.roommate_links (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id),
  target_id uuid not null references public.profiles (id),
  status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'DECLINED', 'REMOVED')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check (requester_id <> target_id)
);
create unique index roommate_links_live on public.roommate_links (least(requester_id, target_id), greatest(requester_id, target_id))
  where status in ('PENDING', 'ACCEPTED');

create function public.person_card(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('user_id', p.id, 'name', p.full_name, 'avatar_url', p.avatar_url, 'room', p.room,
    'student_id', p.student_id, 'coupon_number', public.coupon_number_of(p.id))
  from public.profiles p where p.id = p_user_id
$$;

create function public.request_roommate(p_coupon_number integer, p_student_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_target uuid;
  v_id uuid;
begin
  select c.user_id into v_target
  from public.coupons k join public.coupon_claims c on c.coupon_id = k.id and c.status = 'APPROVED'
  join public.profiles p on p.id = c.user_id
  where k.coupon_number = p_coupon_number
    and public.normalize_student_id(p_student_id) in (p.student_id, public.normalize_student_id(k.hall_record ->> 'student_id'));
  if v_target is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if v_target = v_uid then
    return jsonb_build_object('status', 'THATS_YOU');
  end if;
  if exists (select 1 from public.roommate_links where status in ('PENDING', 'ACCEPTED')
             and least(requester_id, target_id) = least(v_uid, v_target) and greatest(requester_id, target_id) = greatest(v_uid, v_target)) then
    return jsonb_build_object('status', 'ALREADY');
  end if;
  if (select count(*) from public.roommate_links where status in ('PENDING', 'ACCEPTED') and v_uid in (requester_id, target_id)) >= 8 then
    return jsonb_build_object('status', 'TOO_MANY');
  end if;
  insert into public.roommate_links (requester_id, target_id) values (v_uid, v_target) returning id into v_id;
  perform public.enqueue_notification(v_target, 'ROOMMATE_REQUEST', 'roommate:' || v_id,
    jsonb_build_object('message', (select full_name from public.profiles where id = v_uid)
      || ' added you as a roommate. Accept it in your profile.'));
  return jsonb_build_object('status', 'SENT', 'person', public.person_card(v_target));
end $$;

create function public.respond_roommate(p_link_id uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_link public.roommate_links;
begin
  select * into v_link from public.roommate_links where id = p_link_id and target_id = v_uid for update;
  if v_link.id is null or v_link.status <> 'PENDING' then
    return jsonb_build_object('status', 'NOT_PENDING');
  end if;
  update public.roommate_links set status = case when p_accept then 'ACCEPTED' else 'DECLINED' end, decided_at = now()
  where id = p_link_id;
  if p_accept then
    perform public.enqueue_notification(v_link.requester_id, 'ROOMMATE_ACCEPTED', 'roommate-ok:' || p_link_id,
      jsonb_build_object('message', (select full_name from public.profiles where id = v_uid) || ' accepted you as a roommate.'));
  end if;
  return jsonb_build_object('status', case when p_accept then 'ACCEPTED' else 'DECLINED' end);
end $$;

-- Ends a link either side made (also withdraws a request).
create function public.remove_roommate(p_link_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
begin
  update public.roommate_links set status = 'REMOVED', decided_at = now()
  where id = p_link_id and v_uid in (requester_id, target_id) and status in ('PENDING', 'ACCEPTED');
  return jsonb_build_object('status', case when found then 'REMOVED' else 'NOT_FOUND' end);
end $$;

create function public.roommates_of(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'accepted', coalesce((select jsonb_agg(public.person_card(case when l.requester_id = p_user_id then l.target_id else l.requester_id end)
                                           || jsonb_build_object('link_id', l.id))
                          from public.roommate_links l where l.status = 'ACCEPTED' and p_user_id in (l.requester_id, l.target_id)), '[]'::jsonb),
    'incoming', coalesce((select jsonb_agg(public.person_card(l.requester_id) || jsonb_build_object('link_id', l.id))
                          from public.roommate_links l where l.status = 'PENDING' and l.target_id = p_user_id), '[]'::jsonb),
    'outgoing', coalesce((select jsonb_agg(public.person_card(l.target_id) || jsonb_build_object('link_id', l.id))
                          from public.roommate_links l where l.status = 'PENDING' and l.requester_id = p_user_id), '[]'::jsonb))
$$;

create function public.my_roommates() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select public.roommates_of(public.require_role('STUDENT'))
$$;

-- ---------------------------------------------------------------------------
-- Admins: one person in full
-- ---------------------------------------------------------------------------

create function public.admin_person(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'person not found' using errcode = 'P0002';
  end if;
  return public.person_stats(p_user_id) || jsonb_build_object(
    'coupon_number', public.coupon_number_of(p_user_id),
    'register', (select k.hall_record from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
                 where c.user_id = p_user_id and c.status = 'APPROVED'),
    'roommates', public.roommates_of(p_user_id),
    'days', public.meal_days_for(p_user_id, 30));
end $$;

alter table public.roommate_links enable row level security;
create policy roommate_links_select on public.roommate_links for select to authenticated
  using (auth.uid() in (requester_id, target_id) or public.current_app_role() >= 'ADMIN');
grant select on public.roommate_links to authenticated;

grant execute on function
  public.set_meal_notice(uuid, text),
  public.meal_attendance_sheet(uuid),
  public.set_meal_attendance(uuid, integer[]),
  public.my_meal_days(integer),
  public.meal_day(date),
  public.request_roommate(integer, text),
  public.respond_roommate(uuid, boolean),
  public.remove_roommate(uuid),
  public.my_roommates(),
  public.admin_person(uuid)
to authenticated;
