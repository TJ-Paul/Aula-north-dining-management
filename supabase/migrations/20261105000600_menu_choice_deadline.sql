-- Menu choices close when the managers go shopping, not when the meal starts.
-- Each meal may set choices_close_at (at or before its start); null keeps the
-- old rule (choices close at the start).

alter table public.meal_services add column choices_close_at timestamptz;

create or replace function public.meal_choices_close(p_ms public.meal_services) returns timestamptz
language sql stable as $$
  select least(coalesce(p_ms.choices_close_at, p_ms.service_start_at), p_ms.service_start_at)
$$;

create or replace function public.meal_brief(p_ms public.meal_services) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', p_ms.id, 'service_date', p_ms.service_date, 'meal_type', p_ms.meal_type, 'occasion', p_ms.occasion,
    'name', p_ms.name, 'service_start_at', p_ms.service_start_at, 'service_end_at', p_ms.service_end_at,
    'state', p_ms.state, 'special', public.meal_is_special(p_ms.meal_type, p_ms.occasion),
    'choices_close_at', public.meal_choices_close(p_ms))
$$;

create or replace function public.choose_alternative(p_item_id uuid, p_alternative_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_ms public.meal_services;
begin
  select m.* into v_ms
  from public.menu_items i join public.meal_services m on m.id = i.meal_service_id
  where i.id = p_item_id;
  if v_ms.id is null then
    raise exception 'item not found' using errcode = 'P0002';
  end if;
  if now() >= public.meal_choices_close(v_ms) then
    return jsonb_build_object('status', 'TOO_LATE', 'closed_at', public.meal_choices_close(v_ms));
  end if;
  if not (select is_verified from public.profiles where id = v_uid) then
    return jsonb_build_object('status', 'NOT_VERIFIED');
  end if;
  if p_alternative_id is null then
    delete from public.menu_choices where item_id = p_item_id and user_id = v_uid;
    return jsonb_build_object('status', 'OK');
  end if;
  if not exists (select 1 from public.menu_alternatives where id = p_alternative_id and item_id = p_item_id) then
    raise exception 'that alternative is not offered for this item' using errcode = '22023';
  end if;
  insert into public.menu_choices (item_id, user_id, alternative_id) values (p_item_id, v_uid, p_alternative_id)
  on conflict (item_id, user_id) do update set alternative_id = excluded.alternative_id, chosen_at = now();
  return jsonb_build_object('status', 'OK');
end $$;

-- p_close_at null = choices stay open until the meal starts.
create function public.set_menu_choice_deadline(p_meal_service_id uuid, p_close_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_ms public.meal_services;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if v_ms.state in ('CLOSED', 'CANCELLED') then
    return jsonb_build_object('status', 'MEAL_CLOSED');
  end if;
  if p_close_at is not null and p_close_at > v_ms.service_start_at then
    return jsonb_build_object('status', 'CHOICES_AFTER_START');
  end if;
  update public.meal_services set choices_close_at = p_close_at where id = p_meal_service_id;
  perform public.write_audit('MENU_CHOICE_DEADLINE_SET', 'meal_service', p_meal_service_id::text,
    jsonb_build_object('choices_close_at', v_ms.choices_close_at), jsonb_build_object('choices_close_at', p_close_at));
  return jsonb_build_object('status', 'OK');
end $$;

grant execute on function public.set_menu_choice_deadline(uuid, timestamptz) to authenticated;

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
