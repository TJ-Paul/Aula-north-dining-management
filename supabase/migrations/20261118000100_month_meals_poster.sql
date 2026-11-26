-- The Mess tab's lists (All meals, Improvements, Feasts, Parons) now show each meal's poster too.
create or replace function public.mess_month_meals(p_mess_month_id uuid, p_kind text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_m public.mess_months;
begin
  select * into v_m from public.mess_months where id = p_mess_month_id;
  if not found then
    raise exception 'mess month not found' using errcode = 'P0002';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', ms.id, 'name', ms.name, 'meal_type', ms.meal_type, 'occasion', ms.occasion, 'state', ms.state,
      'service_start_at', ms.service_start_at, 'service_end_at', ms.service_end_at, 'poster_url', ms.poster_url,
      'ate', (select count(*) from public.attendance_records a where a.meal_service_id = ms.id and a.status = 'VALID'),
      'menu', (public.meal_brief(ms)) -> 'menu') order by ms.service_start_at desc)
    from public.meal_services ms
    where ms.service_date between v_m.starts_on and v_m.ends_on and ms.state <> 'CANCELLED'
      and case p_kind
            when 'MEALS' then true
            when 'IMPROVEMENTS' then ms.occasion = 'IMPROVEMENT'
            when 'FEASTS' then ms.occasion = 'FEAST'
            when 'PARONS' then ms.meal_type = 'PARON'
            else false end), '[]'::jsonb);
end $$;
