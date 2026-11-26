-- The door screen's lookup: every coupon in the register with who holds it
-- (photo, name, student ID, room) and where they stand for this meal, so the
-- staff see matching coupons while typing and can open a small profile card.

create function public.door_directory(p_meal_service_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_b public.meal_batches;
begin
  select * into v_b from public.meal_batches where meal_service_id = p_meal_service_id and loaded_at is null;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'coupon_number', k.coupon_number,
      'name', coalesce(nullif(p.full_name, ''), k.hall_record ->> 'name'),
      'student_id', coalesce(p.student_id, public.normalize_student_id(k.hall_record ->> 'student_id')),
      'room', p.room, 'avatar_url', p.avatar_url, 'has_account', p.id is not null,
      'ate', exists (select 1 from public.attendance_records a
                     where a.meal_service_id = p_meal_service_id and a.coupon_id = k.id and a.status = 'VALID'),
      'said_not_coming', p.id is not null and exists (select 1 from public.meal_rsvps r
                     where r.meal_service_id = p_meal_service_id and r.user_id = p.id and r.status = 'NOT_COMING'),
      'seat', (select jsonb_build_object('state', s.state, 'kind', s.kind, 'batch', b.number,
                                         'deadline', public.seat_deadline(s, b), 'lapsed', public.seat_lapsed(s, b))
               from public.batch_seats s join public.meal_batches b on b.id = s.batch_id
               where s.meal_service_id = p_meal_service_id and s.coupon_id = k.id
               order by (s.state in ('HOLDING', 'ARRIVED')) desc, s.booked_at desc limit 1))
      order by k.coupon_number)
    from public.coupons k
    left join public.coupon_claims c on c.coupon_id = k.id and c.status = 'APPROVED'
    left join public.profiles p on p.id = c.user_id
    where k.status = 'ACTIVE'), '[]'::jsonb);
end $$;

grant execute on function public.door_directory(uuid) to authenticated;
