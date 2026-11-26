-- Mess months the managers make their own (decided 2026-11-17).
--
-- 1. A month can have a banner picture, shown behind its name on the Mess tab. The month's active
--    managers and devs set, change or remove it, and may rename the month or change its dates.
-- 2. Nominating: a manager chooses whether the nominee joins this month ("add a fellow manager") or
--    takes over a new month (the nominee names it and sets its dates when accepting; banner after).
-- 3. A manager's profile keeps every month they served: an achievement that links to the month.

alter table public.mess_months
  add column banner_url text check (char_length(banner_url) <= 500);

-- Who may change a month: a dev, or one of that month's managers who has not resigned.
create function public.can_edit_mess_month(p_mess_month_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.current_app_role() = 'SUPER_ADMIN'
      or exists (select 1 from public.mess_managers m
                 where m.mess_month_id = p_mess_month_id and m.user_id = auth.uid() and m.status = 'ACTIVE')
$$;

create function public.set_mess_month_banner(p_mess_month_id uuid, p_banner_url text default null, p_clear boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
begin
  if not exists (select 1 from public.mess_months where id = p_mess_month_id) then
    raise exception 'mess month not found' using errcode = 'P0002';
  end if;
  if not public.can_edit_mess_month(p_mess_month_id) then
    return jsonb_build_object('status', 'NOT_YOUR_MONTH');
  end if;
  if not coalesce(p_clear, false)
     and (p_banner_url is null or char_length(p_banner_url) > 500 or p_banner_url !~ '^(https://|/api/files/)') then
    raise exception 'not a picture address' using errcode = '22023';
  end if;
  update public.mess_months set banner_url = case when p_clear then null else p_banner_url end
  where id = p_mess_month_id;
  perform public.write_audit(case when p_clear then 'MESS_MONTH_BANNER_REMOVED' else 'MESS_MONTH_BANNER_SET' end,
    'mess_month', p_mess_month_id::text, null, null);
  return jsonb_build_object('status', 'OK');
end $$;

-- Rename a month or move its dates. Months stay in order: each starts after the one before and
-- before the one after; at most 93 days long.
create function public.update_mess_month(p_mess_month_id uuid, p_name text, p_starts_on date, p_ends_on date)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_m public.mess_months;
  v_name text := btrim(coalesce(p_name, ''));
begin
  perform pg_advisory_xact_lock(hashtextextended('mess-month-handover', 0));
  select * into v_m from public.mess_months where id = p_mess_month_id for update;
  if not found then
    raise exception 'mess month not found' using errcode = 'P0002';
  end if;
  if not public.can_edit_mess_month(p_mess_month_id) then
    return jsonb_build_object('status', 'NOT_YOUR_MONTH');
  end if;
  if char_length(v_name) not between 2 and 60 then
    return jsonb_build_object('status', 'NAME_LENGTH');
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on or p_ends_on - p_starts_on > 92 then
    return jsonb_build_object('status', 'INVALID_DATES');
  end if;
  if exists (select 1 from public.mess_months where serial < v_m.serial and starts_on >= p_starts_on) then
    return jsonb_build_object('status', 'STARTS_BEFORE_PREVIOUS_MONTH');
  end if;
  if exists (select 1 from public.mess_months where serial > v_m.serial and starts_on <= p_starts_on) then
    return jsonb_build_object('status', 'STARTS_AFTER_NEXT_MONTH');
  end if;
  update public.mess_months set name = v_name, starts_on = p_starts_on, ends_on = p_ends_on where id = v_m.id;
  perform public.write_audit('MESS_MONTH_UPDATED', 'mess_month', v_m.id::text,
    jsonb_build_object('name', v_m.name, 'starts_on', v_m.starts_on, 'ends_on', v_m.ends_on),
    jsonb_build_object('name', v_name, 'starts_on', p_starts_on, 'ends_on', p_ends_on));
  return jsonb_build_object('status', 'OK');
end $$;

-- Nominating now says which month: p_next_month false = join this month as a fellow manager,
-- true = take over a new month. Left out, it is as before (a current manager's nominee is for the
-- next month; a dev's joins the running month).
drop function public.nominate_manager(uuid, text);
create function public.nominate_manager(p_user_id uuid, p_note text default null, p_next_month boolean default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_id uuid;
  v_next boolean;
begin
  if public.current_app_role() <> 'SUPER_ADMIN' and not public.is_active_manager(v_uid) then
    raise exception 'only the current mess managers or a super admin can nominate' using errcode = '42501';
  end if;
  if public.verified_coupon_id(p_user_id) is null then
    return jsonb_build_object('status', 'NOT_A_VERIFIED_STUDENT');
  end if;
  if exists (select 1 from public.mess_managers m
             where m.user_id = p_user_id and m.status = 'ACTIVE'
               and m.mess_month_id = (select id from public.latest_mess_month())) then
    return jsonb_build_object('status', 'ALREADY_MANAGER');
  end if;
  if exists (select 1 from public.manager_nominations where nominee_id = p_user_id and status = 'PENDING') then
    return jsonb_build_object('status', 'ALREADY_NOMINATED');
  end if;
  v_next := coalesce(p_next_month, public.is_active_manager(v_uid));
  insert into public.manager_nominations (nominee_id, nominated_by, note, for_next_month)
  values (p_user_id, v_uid, nullif(btrim(p_note), ''), v_next)
  returning id into v_id;
  perform public.enqueue_notification(p_user_id, 'MANAGER_NOMINATED', 'manager-nominated:' || v_id,
    jsonb_build_object('message', (select full_name from public.profiles where id = v_uid)
                                  || case when v_next then ' asked you to take over the next mess month. Open the app to accept or decline.'
                                          else ' asked you to join as a mess manager. Open the app to accept or decline.' end));
  perform public.write_audit('MANAGER_NOMINATED', 'manager_nomination', v_id::text, null,
    jsonb_build_object('nominee', p_user_id, 'next_month', v_next));
  return jsonb_build_object('status', 'NOMINATED', 'nomination_id', v_id, 'next_month', v_next);
end $$;

revoke all on function public.nominate_manager(uuid, text, boolean), public.set_mess_month_banner(uuid, text, boolean),
  public.update_mess_month(uuid, text, date, date), public.can_edit_mess_month(uuid) from public, anon;
grant execute on function public.nominate_manager(uuid, text, boolean), public.set_mess_month_banner(uuid, text, boolean),
  public.update_mess_month(uuid, text, date, date) to authenticated;

-- The Mess tab: now with each month's banner, whether the viewer may change the month, and the
-- kind of each pending nomination.
create or replace function public.mess_dashboard(p_mess_month_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_admin boolean := public.current_app_role() >= 'ADMIN';
  v_month public.mess_months;
  v_over boolean;
begin
  if p_mess_month_id is null then
    v_month := public.latest_mess_month();
  else
    select * into v_month from public.mess_months where id = p_mess_month_id;
  end if;
  v_over := v_month.id is not null and public.mess_month_over(v_month);

  return jsonb_build_object(
    'months', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'serial', serial, 'name', name,
                                                            'starts_on', starts_on, 'ends_on', ends_on, 'banner_url', banner_url,
                                                            'over', public.mess_month_over(mm)) order by serial desc)
                        from public.mess_months mm), '[]'::jsonb),
    'is_admin', v_admin,
    'i_am_active_manager', public.is_active_manager(v_uid),
    'month', case when v_month.id is null then null else jsonb_build_object(
      'id', v_month.id, 'serial', v_month.serial, 'name', v_month.name,
      'starts_on', v_month.starts_on, 'ends_on', v_month.ends_on, 'over', v_over, 'banner_url', v_month.banner_url,
      'can_edit', v_admin and public.can_edit_mess_month(v_month.id),
      'is_latest', v_month.id = (public.latest_mess_month()).id,
      'managers', coalesce((
        select jsonb_agg(jsonb_build_object(
          'user_id', m.user_id, 'name', m.name, 'coupon_number', m.coupon_number, 'room', m.room, 'phone', m.phone,
          'status', m.status, 'joined_at', m.joined_at, 'retired_at', m.retired_at,
          'avatar_url', (select p.avatar_url from public.profiles p where p.id = m.user_id),
          'rated_count', case when v_over then s.rated_count end,
          'total_stars', case when v_over then s.total_stars end,
          'score', case when v_over then s.score end)
          order by case when v_over then s.score end desc nulls last, m.joined_at)
        from public.mess_managers m
        left join public.mess_month_scores(v_month.id) s on s.user_id = m.user_id
        where m.mess_month_id = v_month.id), '[]'::jsonb),
      'counts', (select jsonb_build_object(
          'meals', count(*),
          'improvements', count(*) filter (where ms.occasion = 'IMPROVEMENT'),
          'feasts', count(*) filter (where ms.occasion = 'FEAST'),
          'parons', count(*) filter (where ms.meal_type::text = 'PARON'))
        from public.meal_services ms
        where ms.state <> 'CANCELLED' and ms.service_date between v_month.starts_on and v_month.ends_on),
      'events', coalesce((
        select jsonb_agg(public.meal_brief(ms) || jsonb_build_object(
          'attendance', (select count(*) from public.attendance_records a where a.meal_service_id = ms.id and a.status = 'VALID'),
          'feedback', case when v_admin then (select count(*) from public.feedback f where f.meal_service_id = ms.id) end)
          order by ms.service_start_at)
        from public.meal_services ms
        where ms.state <> 'CANCELLED' and ms.service_date between v_month.starts_on and v_month.ends_on
          and public.meal_is_special(ms.meal_type, ms.occasion)), '[]'::jsonb),
      'feedback', case when v_admin then public.list_feedback(v_month.id, true) end) end,
    'nominations', case when v_admin then coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'nominee', p.full_name, 'nominated_by', b.full_name,
                                          'next_month', n.for_next_month,
                                          'status', n.status, 'created_at', n.created_at) order by n.created_at desc)
      from public.manager_nominations n
      join public.profiles p on p.id = n.nominee_id join public.profiles b on b.id = n.nominated_by
      where n.status = 'PENDING' or n.created_at > now() - interval '30 days'), '[]'::jsonb) end);
end $$;

-- The student's own extras, now with the months they served as a mess manager (newest first).
create or replace function public.my_extras() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'walk_ins', public.walk_in_count(u.id),
    'name_request', (select jsonb_build_object('id', r.id, 'new_name', r.new_name, 'requested_at', r.requested_at)
                     from public.name_change_requests r where r.user_id = u.id and r.status = 'PENDING'),
    'student_id_request', (select jsonb_build_object('id', r.id, 'new_student_id', r.new_student_id, 'requested_at', r.requested_at)
                           from public.student_id_requests r where r.user_id = u.id and r.status = 'PENDING'),
    'managed', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', mo.id, 'serial', mo.serial, 'name', mo.name, 'starts_on', mo.starts_on, 'ends_on', mo.ends_on,
                 'banner_url', mo.banner_url, 'status', m.status, 'joined_at', m.joined_at, 'retired_at', m.retired_at)
                 order by mo.serial desc)
               from public.mess_managers m join public.mess_months mo on mo.id = m.mess_month_id
               where m.user_id = u.id), '[]'::jsonb))
  from (select public.require_role('STUDENT') as id) u
$$;
