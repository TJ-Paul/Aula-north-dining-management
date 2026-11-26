-- Per-meal booking/arrival timers (replacing timing profiles on screen), event posters,
-- and plates taken from the dining hall that admins track until they come back.

alter table public.meal_services
  add column booking_open_minutes integer check (booking_open_minutes between 1 and 180),
  add column arrival_minutes integer check (arrival_minutes between 1 and 120),
  add column poster_url text check (char_length(poster_url) <= 1000);

alter table public.profiles
  add column has_plate boolean not null default false,
  add column plate_marked_at timestamptz;

-- A meal's own timers win over its policy.
create or replace function public.meal_policy_int(p_meal_service_id uuid, p_key text) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case p_key when 'booking_open_minutes_before_start' then ms.booking_open_minutes
                       when 'confirmed_arrival_window_minutes' then ms.arrival_minutes end
     from public.meal_services ms where ms.id = p_meal_service_id),
    (select (ps.settings ->> p_key)::integer
     from public.meal_services ms join public.policy_settings ps on ps.version = ms.policy_version
     where ms.id = p_meal_service_id),
    public.policy_int(p_key))
$$;

create function public.set_meal_timers(p_meal_service_id uuid, p_booking_open_minutes integer, p_arrival_minutes integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_ms public.meal_services;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if p_booking_open_minutes not between 1 and 180 or p_arrival_minutes not between 1 and 120 then
    return jsonb_build_object('status', 'INVALID_TIMERS');
  end if;
  update public.meal_services set booking_open_minutes = p_booking_open_minutes, arrival_minutes = p_arrival_minutes
  where id = v_ms.id;
  -- Batch 1 opens for booking at the new time, unless it already started.
  update public.meal_batches
  set booking_opens_at = v_ms.service_start_at - make_interval(mins => p_booking_open_minutes)
  where meal_service_id = v_ms.id and number = 1 and loaded_at is null and now() < v_ms.service_start_at;
  perform public.write_audit('MEAL_TIMERS_SET', 'meal_service', v_ms.id::text, null,
    jsonb_build_object('booking_open_minutes', p_booking_open_minutes, 'arrival_minutes', p_arrival_minutes));
  return jsonb_build_object('status', 'OK');
end $$;

create function public.set_meal_poster(p_meal_service_id uuid, p_poster_url text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
begin
  update public.meal_services set poster_url = nullif(btrim(coalesce(p_poster_url, '')), '') where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  perform public.write_audit('MEAL_POSTER_SET', 'meal_service', p_meal_service_id::text, null,
    jsonb_build_object('poster_url', p_poster_url));
  return jsonb_build_object('status', 'OK');
end $$;

create or replace function public.meal_brief(p_ms public.meal_services) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', p_ms.id, 'service_date', p_ms.service_date, 'meal_type', p_ms.meal_type, 'occasion', p_ms.occasion,
    'name', p_ms.name, 'service_start_at', p_ms.service_start_at, 'service_end_at', p_ms.service_end_at,
    'state', p_ms.state, 'special', public.meal_is_special(p_ms.meal_type, p_ms.occasion),
    'choices_close_at', public.meal_choices_close(p_ms),
    'notice', p_ms.notice, 'poster_url', p_ms.poster_url,
    'menu', coalesce((select jsonb_agg(case when exists (select 1 from public.menu_alternatives a where a.item_id = i.id)
                                            then i.name || ' (or ' || (select string_agg(a.name, ' / ' order by a.name)
                                                                        from public.menu_alternatives a where a.item_id = i.id) || ')'
                                            else i.name end order by i.position)
                      from public.menu_items i where i.meal_service_id = p_ms.id), '[]'::jsonb))
$$;

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
          'name', ms.name, 'occasion', ms.occasion, 'service_end_at', ms.service_end_at, 'description', ms.description, 'notice', ms.notice, 'poster_url', ms.poster_url,
          'booking_open_minutes', public.meal_policy_int(ms.id, 'booking_open_minutes_before_start'),
          'arrival_minutes', public.meal_policy_int(ms.id, 'confirmed_arrival_window_minutes'),
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

create or replace function public.event_detail(p_meal_service_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_admin boolean := public.current_app_role() >= 'ADMIN';
  v_ms public.meal_services;
  v_month public.mess_months;
  v_attended boolean;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  select * into v_month from public.mess_months where id = public.mess_month_of(v_ms.service_date);
  v_attended := exists (select 1 from public.attendance_records a
                        where a.meal_service_id = v_ms.id and a.holder_user_id = v_uid and a.status = 'VALID');

  return public.meal_brief(v_ms) || jsonb_build_object(
    'description', v_ms.description, 'notice', v_ms.notice, 'poster_url', v_ms.poster_url,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.name,
        'alternatives', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) order by a.name)
                                  from public.menu_alternatives a where a.item_id = i.id), '[]'::jsonb),
        'my_choice', (select c.alternative_id from public.menu_choices c where c.item_id = i.id and c.user_id = v_uid),
        'totals', case when v_admin then (
          select jsonb_agg(jsonb_build_object('alternative', a.name,
                   'count', (select count(*) from public.menu_choices c where c.alternative_id = a.id)) order by a.name)
          from public.menu_alternatives a where a.item_id = i.id) end)
        order by i.position)
      from public.menu_items i where i.meal_service_id = v_ms.id), '[]'::jsonb),
    'can_choose', now() < v_ms.service_start_at,
    'attended', v_attended,
    'mess_month', case when v_month.id is null then null else jsonb_build_object(
      'id', v_month.id, 'serial', v_month.serial, 'name', v_month.name, 'over', public.mess_month_over(v_month)) end,
    'managers', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', mm.user_id, 'name', mm.name, 'status', mm.status,
                                          'my_stars', (select r.stars from public.manager_ratings r
                                                       where r.meal_service_id = v_ms.id and r.rater_id = v_uid
                                                         and r.manager_id = mm.user_id)) order by mm.name)
      from public.mess_managers mm where mm.mess_month_id = v_month.id), '[]'::jsonb),
    'can_rate', public.meal_is_special(v_ms.meal_type, v_ms.occasion) and v_attended
                and v_month.id is not null and not public.mess_month_over(v_month),
    'can_send_feedback', public.meal_is_special(v_ms.meal_type, v_ms.occasion),
    'attendance', case when v_admin then (select count(*) from public.attendance_records a
                                          where a.meal_service_id = v_ms.id and a.status = 'VALID') end);
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
    'walk_ins', public.walk_in_count(p.id),
    'has_plate', p.has_plate, 'plate_marked_at', p.plate_marked_at) end
  from (select 1) one left join public.profiles p on p.id = p_user_id
$$;

-- ---------------------------------------------------------------------------
-- Plates: an admin marks a coupon holder who took a plate; unticks it when it's back.
-- ---------------------------------------------------------------------------

create function public.set_plate(p_coupon_number integer, p_has_plate boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_holder uuid;
begin
  select c.user_id into v_holder from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
  where k.coupon_number = p_coupon_number and c.status = 'APPROVED';
  if v_holder is null then
    return jsonb_build_object('status', 'NO_HOLDER');
  end if;
  update public.profiles
  set has_plate = p_has_plate, plate_marked_at = case when p_has_plate then coalesce(plate_marked_at, now()) end
  where id = v_holder;
  perform public.write_audit(case when p_has_plate then 'PLATE_TAKEN' else 'PLATE_RETURNED' end, 'profile', v_holder::text,
    null, jsonb_build_object('coupon_number', p_coupon_number));
  return jsonb_build_object('status', 'OK', 'person', public.person_card(v_holder));
end $$;

-- Everyone who still has a plate gets a reminder.
create function public.remind_plates() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_count integer := 0;
  p record;
  v_key text := 'plates:' || to_char(now(), 'YYYYMMDDHH24MISS');
begin
  for p in select id from public.profiles where has_plate loop
    perform public.enqueue_notification(p.id, 'ADMIN_MESSAGE', v_key || ':' || p.id,
      jsonb_build_object('message', 'Please return the plate you took from the dining hall.'));
    v_count := v_count + 1;
  end loop;
  perform public.write_audit('PLATE_REMINDERS_SENT', 'profile', 'all', null, jsonb_build_object('count', v_count));
  return jsonb_build_object('status', 'SENT', 'count', v_count);
end $$;

-- Photos and posters stay small: at most 750 KB each.
do $limit$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'storage' and c.relname = 'buckets') then
    update storage.buckets set file_size_limit = 768000 where id = 'avatars';
  end if;
end $limit$;

grant execute on function
  public.set_meal_timers(uuid, integer, integer),
  public.set_meal_poster(uuid, text),
  public.set_plate(integer, boolean),
  public.remind_plates()
to authenticated;
