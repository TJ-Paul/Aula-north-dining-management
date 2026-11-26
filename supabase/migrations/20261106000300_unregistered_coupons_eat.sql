-- Coupons whose student hasn't made an account yet can still be marked as having eaten
-- (lunch/dinner ticks; the door already let them in). The record is kept on the coupon,
-- and when the student later claims that coupon and an admin approves it, those meals
-- (and walk-ins) become theirs, so their history continues from there.

-- An attendance record stays as it was, except that a record kept on a coupon with no
-- account yet may be given to the coupon's new holder (once).
create or replace function public.attendance_records_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'attendance records are never deleted; void them' using errcode = '42501';
  end if;
  if old.status = 'VOIDED' then
    raise exception 'a voided attendance record is final' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'voided_at', 'voided_by', 'void_reason',
                            'exception_resolved_at', 'exception_resolved_by', 'exception_resolution',
                            'holder_user_id', 'holder_name'])
     <> (to_jsonb(old) - array['status', 'voided_at', 'voided_by', 'void_reason',
                               'exception_resolved_at', 'exception_resolved_by', 'exception_resolution',
                               'holder_user_id', 'holder_name'])
     or (new.holder_user_id is distinct from old.holder_user_id and old.holder_user_id is not null)
     or (new.holder_name is distinct from old.holder_name and old.holder_user_id is not null) then
    raise exception 'attendance records are immutable; void and re-record instead' using errcode = '42501';
  end if;
  return new;
end $$;

-- When a coupon gets its (new) holder, meals recorded on it without an account become theirs.
create function public.claim_adopts_coupon_meals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text;
begin
  if new.status <> 'APPROVED' or (tg_op = 'UPDATE' and old.status = 'APPROVED') then
    return null;
  end if;
  select full_name into v_name from public.profiles where id = new.user_id;
  update public.attendance_records set holder_user_id = new.user_id, holder_name = v_name
  where coupon_id = new.coupon_id and holder_user_id is null and status = 'VALID';
  update public.batch_seats set user_id = new.user_id
  where coupon_id = new.coupon_id and user_id is null
    and not exists (select 1 from public.batch_seats o where o.meal_service_id = batch_seats.meal_service_id
                    and o.user_id = new.user_id and o.state in ('HOLDING', 'ARRIVED'));
  return null;
end $$;
create trigger coupon_claims_adopt_meals after insert or update of status on public.coupon_claims
  for each row execute function public.claim_adopts_coupon_meals();

create or replace function public.meal_attendance_sheet(p_meal_service_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_ms public.meal_services;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'meal', public.meal_brief(v_ms),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('coupon_number', k.coupon_number, 'user_id', p.id,
               'name', coalesce(p.full_name, k.hall_record ->> 'name'), 'has_account', p.id is not null,
               'avatar_url', p.avatar_url, 'room', p.room,
               'ate', exists (select 1 from public.attendance_records a
                              where a.meal_service_id = v_ms.id and a.coupon_id = k.id and a.status = 'VALID'),
               'not_coming', exists (select 1 from public.meal_rsvps r
                                     where r.meal_service_id = v_ms.id and r.user_id = p.id and r.status = 'NOT_COMING'))
             order by k.coupon_number)
      from public.coupons k
      left join public.coupon_claims c on c.coupon_id = k.id and c.status = 'APPROVED'
      left join public.profiles p on p.id = c.user_id
      where k.status = 'ACTIVE'), '[]'::jsonb));
end $$;

create or replace function public.set_meal_attendance(p_meal_service_id uuid, p_coupon_numbers integer[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_ms public.meal_services;
  k record;
  v_added integer := 0;
  v_removed integer;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if v_ms.state = 'CANCELLED' then
    return jsonb_build_object('status', 'MEAL_CANCELLED');
  end if;
  if now() < v_ms.service_start_at then
    return jsonb_build_object('status', 'NOT_STARTED');
  end if;

  update public.attendance_records a
  set status = 'VOIDED', voided_at = now(), voided_by = v_uid, void_reason = 'Unticked on the attendance sheet'
  from public.coupons kk
  where a.meal_service_id = v_ms.id and a.status = 'VALID' and kk.id = a.coupon_id
    and not (kk.coupon_number = any(coalesce(p_coupon_numbers, '{}')));
  get diagnostics v_removed = row_count;

  for k in
    select kk.id, kk.coupon_number, c.user_id
    from public.coupons kk left join public.coupon_claims c on c.coupon_id = kk.id and c.status = 'APPROVED'
    where kk.coupon_number = any(coalesce(p_coupon_numbers, '{}')) and kk.status = 'ACTIVE'
      and not exists (select 1 from public.attendance_records a
                      where a.meal_service_id = v_ms.id and a.coupon_id = kk.id and a.status = 'VALID')
  loop
    insert into public.attendance_records (meal_service_id, coupon_id, coupon_number, holder_user_id, source,
                                           client_entry_id, recorded_by)
    values (v_ms.id, k.id, k.coupon_number, k.user_id, 'PAPER_BACKFILL',
            'sheet-' || v_ms.id || '-' || k.coupon_number || '-' || extract(epoch from clock_timestamp())::bigint, v_uid);
    v_added := v_added + 1;
  end loop;

  perform public.write_audit('MEAL_ATTENDANCE_SET', 'meal_service', v_ms.id::text, null,
    jsonb_build_object('added', v_added, 'removed', v_removed, 'present', coalesce(array_length(p_coupon_numbers, 1), 0)));
  return jsonb_build_object('status', 'OK', 'added', v_added, 'removed', v_removed,
    'present', (select count(*) from public.attendance_records a where a.meal_service_id = v_ms.id and a.status = 'VALID'));
end $$;
