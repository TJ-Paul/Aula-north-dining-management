-- Admins see (and edit) each meal's notice in the meals list.
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
          'name', ms.name, 'occasion', ms.occasion, 'service_end_at', ms.service_end_at, 'description', ms.description, 'notice', ms.notice,
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
