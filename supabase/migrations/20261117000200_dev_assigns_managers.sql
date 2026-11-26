-- A dev makes anyone a mess manager of any mess month, from that person's page (decided 2026-11-17).
-- No nomination and no acceptance: they are a manager at once (a student becomes a mess manager;
-- other roles keep theirs). Any pending nomination of theirs is withdrawn, and they get a notice.

create function public.dev_assign_manager(p_user_id uuid, p_mess_month_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('SUPER_ADMIN');
  v_p public.profiles;
  v_m public.mess_months;
begin
  select * into v_p from public.profiles where id = p_user_id and deleted_at is null;
  if not found then
    raise exception 'person not found' using errcode = 'P0002';
  end if;
  select * into v_m from public.mess_months where id = p_mess_month_id;
  if not found then
    raise exception 'mess month not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.mess_managers
             where mess_month_id = v_m.id and user_id = p_user_id and status = 'ACTIVE') then
    return jsonb_build_object('status', 'ALREADY_MANAGER');
  end if;

  insert into public.mess_managers (mess_month_id, user_id, name, coupon_number, room, phone)
  values (v_m.id, p_user_id, coalesce(nullif(btrim(v_p.full_name), ''), 'Mess manager'), public.coupon_number_of(p_user_id),
          v_p.room, v_p.notify_phone)
  on conflict (mess_month_id, user_id) do update set status = 'ACTIVE', retired_at = null;

  update public.profiles set role = 'ADMIN', updated_at = now() where id = p_user_id and role = 'STUDENT';
  update public.manager_nominations set status = 'CANCELLED', decided_at = now()
  where nominee_id = p_user_id and status = 'PENDING';

  perform public.enqueue_notification(p_user_id, 'MANAGER_ASSIGNED', 'manager-assigned:' || v_m.id || ':' || p_user_id,
    jsonb_build_object('title', 'You’re a mess manager',
                       'message', 'Mess month ' || v_m.serial || ' · ' || v_m.name));
  perform public.write_audit('MANAGER_ASSIGNED_BY_DEV', 'mess_month', v_m.id::text, null,
    jsonb_build_object('user_id', p_user_id, 'serial', v_m.serial));
  return jsonb_build_object('status', 'ASSIGNED', 'serial', v_m.serial, 'name', v_m.name);
end $$;

revoke all on function public.dev_assign_manager(uuid, uuid) from public, anon;
grant execute on function public.dev_assign_manager(uuid, uuid) to authenticated;

-- A person's page: for a dev, also the mess months (to pick from) and the months this person manages.
create or replace function public.admin_person(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_dev boolean := public.current_app_role() = 'SUPER_ADMIN';
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'person not found' using errcode = 'P0002';
  end if;
  return public.person_stats(p_user_id) || jsonb_build_object(
    'coupon_number', public.coupon_number_of(p_user_id),
    'register', (select k.hall_record from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
                 where c.user_id = p_user_id and c.status = 'APPROVED'),
    'roommates', public.roommates_of(p_user_id),
    'days', public.meal_days_for(p_user_id, 30),
    'history', public.history_of(p_user_id),
    'earlier_holders', public.earlier_holders(public.coupon_number_of(p_user_id)),
    'managed', coalesce((select jsonb_agg(jsonb_build_object('id', mo.id, 'serial', mo.serial, 'name', mo.name,
                                                             'status', m.status) order by mo.serial desc)
                         from public.mess_managers m join public.mess_months mo on mo.id = m.mess_month_id
                         where m.user_id = p_user_id), '[]'::jsonb),
    'mess_months', case when v_dev then coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'serial', serial, 'name', name, 'starts_on', starts_on,
                                          'ends_on', ends_on) order by serial desc)
      from public.mess_months), '[]'::jsonb) end);
end $$;
