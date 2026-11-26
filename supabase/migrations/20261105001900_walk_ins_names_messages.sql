-- Amendment 1.2 (user's decisions, 2026-11-05):
-- * Someone who comes to a booked meal without a booking still eats, even when the batch is full.
--   Each such walk-in is counted on their record; only admins and the student see the count.
-- * Students ask to change their name; an admin approves it.
-- * Admins send a one-way message to a coupon holder, shown as a notification.

create function public.walk_in_count(p_user_id uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.batch_seats s
  where s.user_id = p_user_id and s.kind = 'WALK_IN' and s.state = 'ARRIVED'
$$;

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

create or replace function public.person_stats(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p.id is null then jsonb_build_object('user_id', null) else jsonb_build_object(
    'user_id', p.id, 'public_id', p.public_id, 'name', p.full_name, 'avatar_url', p.avatar_url, 'student_id', p.student_id, 'room', p.room,
    'phone', p.notify_phone, 'role', p.role, 'joined_at', p.created_at,
    'meals_eaten', (select count(*) from public.attendance_records a where a.holder_user_id = p.id and a.status = 'VALID'),
    'last_meal_at', (select max(a.recorded_at) from public.attendance_records a where a.holder_user_id = p.id and a.status = 'VALID'),
    'missed', (select count(*) from public.no_show_events e where e.user_id = p.id and e.status = 'VERIFIED'),
    'not_coming_kept', (select count(*) from public.meal_rsvps r where r.user_id = p.id and r.outcome = 'REWARDED'),
    'came_anyway', (select count(*) from public.meal_rsvps r where r.user_id = p.id and r.outcome = 'CAME_ANYWAY'),
    'points', public.points_balance(p.id),
    'walk_ins', public.walk_in_count(p.id)) end
  from (select 1) one left join public.profiles p on p.id = p_user_id
$$;

-- ---------------------------------------------------------------------------
-- Name changes, approved by an admin
-- ---------------------------------------------------------------------------

create table public.name_change_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  old_name text,
  new_name text not null check (char_length(new_name) between 2 and 80),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles (id)
);
create unique index name_change_one_pending on public.name_change_requests (user_id) where status = 'PENDING';
alter table public.name_change_requests enable row level security;

create function public.request_name_change(p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_old text;
  v_id uuid;
begin
  if char_length(v_name) not between 2 and 80 then
    return jsonb_build_object('status', 'INVALID_NAME');
  end if;
  select full_name into v_old from public.profiles where id = v_uid;
  update public.name_change_requests set status = 'WITHDRAWN', decided_at = now()
  where user_id = v_uid and status = 'PENDING';
  if v_old is not null and v_old = v_name then
    return jsonb_build_object('status', 'SAME_NAME');
  end if;
  insert into public.name_change_requests (user_id, old_name, new_name) values (v_uid, v_old, v_name) returning id into v_id;
  perform public.write_audit('NAME_CHANGE_REQUESTED', 'profile', v_uid::text,
    jsonb_build_object('name', v_old), jsonb_build_object('name', v_name));
  return jsonb_build_object('status', 'SENT', 'request_id', v_id);
end $$;

create function public.cancel_name_change() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
begin
  update public.name_change_requests set status = 'WITHDRAWN', decided_at = now()
  where user_id = v_uid and status = 'PENDING';
  return jsonb_build_object('status', 'OK');
end $$;

-- The student's own extras: walk-in count and any name change waiting.
create function public.my_extras() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'walk_ins', public.walk_in_count(u.id),
    'name_request', (select jsonb_build_object('id', r.id, 'new_name', r.new_name, 'requested_at', r.requested_at)
                     from public.name_change_requests r where r.user_id = u.id and r.status = 'PENDING'))
  from (select public.require_role('STUDENT') as id) u
$$;

create function public.admin_name_requests() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'request_id', r.id, 'user_id', r.user_id, 'old_name', r.old_name, 'new_name', r.new_name,
      'requested_at', r.requested_at, 'coupon_number', public.coupon_number_of(r.user_id),
      'register_name', (select k.hall_record ->> 'name' from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
                        where c.user_id = r.user_id and c.status = 'APPROVED'),
      'avatar_url', p.avatar_url) order by r.requested_at)
    from public.name_change_requests r join public.profiles p on p.id = r.user_id
    where r.status = 'PENDING'), '[]'::jsonb);
end $$;

create function public.decide_name_change(p_request_id uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_r public.name_change_requests;
begin
  select * into v_r from public.name_change_requests where id = p_request_id for update;
  if v_r.id is null then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_r.status <> 'PENDING' then
    return jsonb_build_object('status', 'ALREADY_DECIDED');
  end if;
  update public.name_change_requests
  set status = case when p_approve then 'APPROVED' else 'REJECTED' end, decided_at = now(), decided_by = v_uid
  where id = v_r.id;
  if p_approve then
    update public.profiles set full_name = v_r.new_name, updated_at = now() where id = v_r.user_id;
  end if;
  perform public.enqueue_notification(v_r.user_id, 'NAME_CHANGE', 'name-change:' || v_r.id,
    jsonb_build_object('message', case when p_approve then 'Your name is now ' || v_r.new_name || '.'
                                       else 'Your name change to ' || v_r.new_name || ' was not approved.' end));
  perform public.write_audit(case when p_approve then 'NAME_CHANGE_APPROVED' else 'NAME_CHANGE_REJECTED' end,
    'profile', v_r.user_id::text, jsonb_build_object('name', v_r.old_name), jsonb_build_object('name', v_r.new_name));
  return jsonb_build_object('status', case when p_approve then 'APPROVED' else 'REJECTED' end);
end $$;

-- ---------------------------------------------------------------------------
-- One-way messages from admins to a coupon holder
-- ---------------------------------------------------------------------------

create function public.admin_send_message(p_coupon_number integer, p_message text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_text text := btrim(coalesce(p_message, ''));
  v_holder uuid;
  v_id uuid := gen_random_uuid();
begin
  if char_length(v_text) not between 1 and 1000 then
    return jsonb_build_object('status', 'INVALID_MESSAGE');
  end if;
  select c.user_id into v_holder from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
  where k.coupon_number = p_coupon_number and c.status = 'APPROVED';
  if v_holder is null then
    return jsonb_build_object('status', 'NO_HOLDER');
  end if;
  perform public.enqueue_notification(v_holder, 'ADMIN_MESSAGE', 'admin-message:' || v_id,
    jsonb_build_object('message', v_text, 'from', (select full_name from public.profiles where id = v_uid)));
  perform public.write_audit('ADMIN_MESSAGE_SENT', 'profile', v_holder::text, null,
    jsonb_build_object('coupon_number', p_coupon_number, 'message', v_text));
  return jsonb_build_object('status', 'SENT', 'person', public.person_card(v_holder));
end $$;

grant execute on function
  public.request_name_change(text),
  public.cancel_name_change(),
  public.my_extras(),
  public.admin_name_requests(),
  public.decide_name_change(uuid, boolean),
  public.admin_send_message(integer, text)
to authenticated;
