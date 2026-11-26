-- The event page shows the meal's notice.
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
    'description', v_ms.description, 'notice', v_ms.notice,
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
