-- Admin screens: read models for meals, flagged entries, alerts and people,
-- and a timing profile choice when creating a meal service. All writes keep
-- going through the existing audited functions.

-- create_meal_service gains an optional policy version (timing profile).
drop function public.create_meal_service(date, public.meal_type, timestamptz);

create function public.create_meal_service(
  p_service_date date, p_meal_type public.meal_type, p_service_start_at timestamptz,
  p_policy_version integer default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_version integer;
  v_service public.meal_services;
begin
  v_version := coalesce(p_policy_version, (select version from public.policy_settings where is_active));
  if not exists (select 1 from public.policy_settings where version = v_version) then
    raise exception 'unknown policy version %', v_version using errcode = '22023';
  end if;

  insert into public.meal_services (service_date, meal_type, service_start_at, policy_version, created_by)
  values (p_service_date, p_meal_type, p_service_start_at, v_version, v_uid)
  on conflict (service_date, meal_type) do nothing
  returning * into v_service;

  if not found then
    select * into v_service from public.meal_services
    where service_date = p_service_date and meal_type = p_meal_type;
    return jsonb_build_object('status', 'EXISTS', 'meal_service_id', v_service.id);
  end if;

  perform public.write_audit('MEAL_SERVICE_CREATED', 'meal_service', v_service.id::text, null, to_jsonb(v_service));
  return jsonb_build_object('status', 'CREATED', 'meal_service_id', v_service.id);
end $$;

-- Recent and upcoming meal services with headline numbers, plus the aisles.
create function public.admin_meal_services(p_limit integer default 20) returns jsonb
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
          'invitations_paused', ms.invitations_paused,
          'live_waves', coalesce((select jsonb_agg(jsonb_build_object('aisle', w.aisle_code, 'wave_number', w.wave_number,
                                                                      'phase', w.phase) order by w.aisle_code)
                                  from public.aisle_waves w where w.meal_service_id = ms.id and w.phase <> 'CLOSED'), '[]'::jsonb),
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

-- Flagged coupon entries (no booking / wrong aisle) for a meal service.
create function public.list_attendance_exceptions(
  p_meal_service_id uuid, p_include_resolved boolean default false
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ATTENDANT');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'record_id', r.id, 'coupon_number', r.coupon_number, 'holder_name', hp.full_name,
      'aisle', r.aisle_code, 'wave_number', w.wave_number, 'exception', r.exception,
      'booked_aisle', coalesce(res.aisle_code, o.aisle_code),
      'recorded_at', r.recorded_at, 'recorded_by', rp.full_name,
      'resolved_at', r.exception_resolved_at, 'resolution', r.exception_resolution, 'resolved_by', xp.full_name)
      order by r.exception_resolved_at nulls first, r.recorded_at desc)
    from public.attendance_records r
    join public.aisle_waves w on w.id = r.wave_id
    join public.profiles rp on rp.id = r.recorded_by
    left join public.profiles hp on hp.id = r.holder_user_id
    left join public.profiles xp on xp.id = r.exception_resolved_by
    left join public.reservations res on res.id = r.reservation_id
    left join public.standby_offers o on o.id = r.offer_id
    where r.meal_service_id = p_meal_service_id and r.status = 'VALID' and r.exception is not null
      and (p_include_resolved or r.exception_resolved_at is null)
  ), '[]'::jsonb);
end $$;

create function public.list_admin_alerts(p_include_resolved boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'kind', a.kind, 'severity', a.severity, 'payload', a.payload, 'status', a.status,
      'created_at', a.created_at, 'acknowledged_at', a.acknowledged_at, 'acknowledged_by', p.full_name)
      order by (a.status = 'RESOLVED'), a.created_at desc)
    from (select * from public.admin_alerts
          where p_include_resolved or status <> 'RESOLVED'
          order by created_at desc limit 200) a
    left join public.profiles p on p.id = a.acknowledged_by
  ), '[]'::jsonb);
end $$;

-- Find people by name or coupon number; with an empty query, lists staff.
create function public.admin_find_people(p_query text default '') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_q text := btrim(coalesce(p_query, ''));
begin
  perform public.require_role('ADMIN');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', x.id, 'name', x.full_name, 'role', x.role, 'is_verified', x.is_verified,
      'coupon_number', x.coupon_number, 'phone', x.phone) order by x.role desc, x.full_name)
    from (
      select p.id, p.full_name, p.role, p.is_verified, u.phone, k.coupon_number
      from public.profiles p
      join auth.users u on u.id = p.id
      left join public.coupon_claims c on c.user_id = p.id and c.status = 'APPROVED'
      left join public.coupons k on k.id = c.coupon_id
      where case
        when v_q = '' then p.role <> 'STUDENT'
        when v_q ~ '^\d{1,6}$' then k.coupon_number = v_q::integer
        else p.full_name ilike '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      end
      order by p.full_name
      limit 25
    ) x
  ), '[]'::jsonb);
end $$;

grant execute on function
  public.create_meal_service(date, public.meal_type, timestamptz, integer),
  public.admin_meal_services(integer),
  public.list_attendance_exceptions(uuid, boolean),
  public.list_admin_alerts(boolean),
  public.admin_find_people(text)
to authenticated;
