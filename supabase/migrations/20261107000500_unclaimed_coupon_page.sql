-- (Renumbered from 20261107000200 so it runs after the lucky-seats updates; safe to run again.)
-- Coupons nobody has claimed yet: the admins' list shows how many meals were eaten on them, and
-- each opens a page with those meals day by day (like a student's page).

create or replace function public.admin_people_data(p_query text default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
begin
  perform public.require_role('ADMIN');
  return coalesce((
    select jsonb_agg(x.row order by x.coupon_number nulls last, x.sort_name)
    from (
      select k.coupon_number, coalesce(p.full_name, k.hall_record ->> 'name', '') as sort_name,
        jsonb_build_object(
          'coupon_number', k.coupon_number, 'coupon_status', k.status,
          'register_name', k.hall_record ->> 'name', 'register_student_id', k.hall_record ->> 'student_id',
          'account', case when p.id is not null then 'HOLDER'
                          when exists (select 1 from public.coupon_claims pc where pc.coupon_id = k.id and pc.status = 'PENDING') then 'PENDING'
                          else 'UNCLAIMED' end,
          -- Meals eaten on this coupon while nobody holds it (they move to the student once they claim it).
          'coupon_meals', case when p.id is null then (select count(*) from public.attendance_records a
                                                       where a.coupon_id = k.id and a.holder_user_id is null and a.status = 'VALID') end)
        || public.person_stats(p.id) as row
      from public.coupons k
      left join public.coupon_claims c on c.coupon_id = k.id and c.status = 'APPROVED'
      left join public.profiles p on p.id = c.user_id
      union all
      select null, p.full_name,
        jsonb_build_object('coupon_number', null, 'coupon_status', null, 'register_name', null, 'register_student_id', null,
          'account', case when exists (select 1 from public.coupon_claims pc where pc.user_id = p.id and pc.status = 'PENDING')
                          then 'PENDING' else 'NO_COUPON' end)
        || public.person_stats(p.id)
      from public.profiles p
      where not exists (select 1 from public.coupon_claims c where c.user_id = p.id and c.status = 'APPROVED')
        and p.deleted_at is null
    ) x
    where v_q is null
       or x.row ->> 'coupon_number' = v_q
       or coalesce(x.row ->> 'name', '') ilike '%' || v_q || '%'
       or coalesce(x.row ->> 'register_name', '') ilike '%' || v_q || '%'
       or coalesce(x.row ->> 'student_id', '') ilike '%' || v_q || '%'
       or coalesce(x.row ->> 'register_student_id', '') ilike '%' || v_q || '%'
       or coalesce(x.row ->> 'room', '') ilike v_q
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_coupon(p_coupon_number integer) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_k public.coupons;
begin
  perform public.require_role('ADMIN');
  select * into v_k from public.coupons where coupon_number = p_coupon_number;
  if not found then
    raise exception 'coupon not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'coupon_number', v_k.coupon_number, 'register', v_k.hall_record, 'status', v_k.status,
    'holder', (select c.user_id from public.coupon_claims c where c.coupon_id = v_k.id and c.status = 'APPROVED'),
    'pending_claim', exists (select 1 from public.coupon_claims c where c.coupon_id = v_k.id and c.status = 'PENDING'),
    'meals_eaten', (select count(*) from public.attendance_records a
                    where a.coupon_id = v_k.id and a.holder_user_id is null and a.status = 'VALID'),
    'last_meal_at', (select max(a.recorded_at) from public.attendance_records a
                     where a.coupon_id = v_k.id and a.holder_user_id is null and a.status = 'VALID'),
    'days', coalesce((
      select jsonb_agg(d.day order by d.service_date desc)
      from (
        select m.service_date, jsonb_build_object('date', m.service_date, 'meals', jsonb_agg(jsonb_build_object(
                 'id', m.id, 'meal_type', m.meal_type, 'name', m.name, 'occasion', m.occasion,
                 'special', public.meal_is_special(m.meal_type, m.occasion), 'service_start_at', m.service_start_at,
                 'ate', true, 'over', true) order by m.service_start_at)) as day
        from public.meal_services m
        where exists (select 1 from public.attendance_records a where a.meal_service_id = m.id and a.coupon_id = v_k.id
                      and a.holder_user_id is null and a.status = 'VALID')
        group by m.service_date) d), '[]'::jsonb));
end $$;

grant execute on function public.admin_coupon(integer) to authenticated;
