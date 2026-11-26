-- A user can delete their own account. It only changes things from now on:
-- everything already recorded (name, student ID, photo, meals, attendance, points,
-- and which coupon they held until today) stays exactly as it was.
-- From now on: the account can't do anything, its coupon is free for the next
-- holder, its future seat bookings and roommate links end, and it leaves the
-- admins' list of people. The app's account route also closes the sign-in.

alter table public.profiles add column deleted_at timestamptz;

-- The same student ID may sign up again later, as a new account.
drop index public.profiles_student_id_unique;
create unique index profiles_student_id_unique on public.profiles (student_id)
  where student_id is not null and deleted_at is null;

-- A deleted account can't call anything, even with a sign-in token still in hand.
create or replace function public.require_role(p_min public.app_role) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role;
  v_deleted timestamptz;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select role, deleted_at into v_role, v_deleted from public.profiles where id = v_uid;
  if v_deleted is not null then
    raise exception 'this account was deleted' using errcode = '28000';
  end if;
  if v_role is null or v_role < p_min then
    raise exception 'requires role % or higher', p_min using errcode = '42501';
  end if;
  return v_uid;
end $$;

create function public.delete_my_account(p_confirm text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_role public.app_role;
  v_coupon integer := public.coupon_number_of(v_uid);
begin
  if upper(btrim(coalesce(p_confirm, ''))) <> 'DELETE' then
    return jsonb_build_object('status', 'NOT_CONFIRMED');
  end if;
  select role into v_role from public.profiles where id = v_uid for update;
  if v_role = 'SUPER_ADMIN' and not exists (select 1 from public.profiles
       where role = 'SUPER_ADMIN' and id <> v_uid and deleted_at is null) then
    return jsonb_build_object('status', 'LAST_SUPER_ADMIN');
  end if;

  -- The coupon is held until now (the record stays) and is free for its next holder.
  update public.coupon_claims
  set status = 'REVOKED', effective_to = now(), decided_by = v_uid, decision_reason = 'Account deleted by its owner'
  where user_id = v_uid and status = 'APPROVED';
  update public.coupon_claims set status = 'WITHDRAWN', decided_by = v_uid, decision_reason = 'Account deleted by its owner'
  where user_id = v_uid and status = 'PENDING';
  -- Nothing ahead of them stays booked or linked.
  update public.batch_seats set state = 'CANCELLED', closed_at = now() where user_id = v_uid and state = 'HOLDING';
  update public.roommate_links set status = 'REMOVED', decided_at = now()
  where v_uid in (requester_id, target_id) and status in ('PENDING', 'ACCEPTED');
  update public.name_change_requests set status = 'WITHDRAWN', decided_at = now() where user_id = v_uid and status = 'PENDING';
  update public.mess_managers set status = 'RETIRED', retired_at = now() where user_id = v_uid and status = 'ACTIVE';

  update public.profiles set is_verified = false, deleted_at = now(), updated_at = now() where id = v_uid;
  perform public.write_audit('ACCOUNT_DELETED', 'profile', v_uid::text,
    jsonb_build_object('role', v_role, 'coupon_number', v_coupon), null);
  return jsonb_build_object('status', 'DELETED');
end $$;

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
                          else 'UNCLAIMED' end)
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

-- ---------------------------------------------------------------------------
-- Past records keep the name the person had that day. A name change (or deleting
-- the account) only affects records made afterwards; old rows change only if an
-- admin edits them in the database on purpose.
-- ---------------------------------------------------------------------------

alter table public.attendance_records add column holder_name text;
alter table public.no_show_events add column holder_name text;

create function public.snapshot_attendance_name() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.holder_name := coalesce(new.holder_name, (select full_name from public.profiles where id = new.holder_user_id));
  return new;
end $$;
create function public.snapshot_no_show_name() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.holder_name := coalesce(new.holder_name, (select full_name from public.profiles where id = new.user_id));
  return new;
end $$;
create trigger attendance_records_holder_name before insert on public.attendance_records
  for each row execute function public.snapshot_attendance_name();
create trigger no_show_events_holder_name before insert on public.no_show_events
  for each row execute function public.snapshot_no_show_name();

-- Fill in the names already on record (as they are today), once.
alter table public.attendance_records disable trigger attendance_records_guard;
update public.attendance_records a set holder_name = p.full_name from public.profiles p where p.id = a.holder_user_id;
alter table public.attendance_records enable trigger attendance_records_guard;
update public.no_show_events e set holder_name = p.full_name from public.profiles p where p.id = e.user_id;

create or replace function public.admin_no_shows(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return jsonb_build_object(
    'pending', (select count(*) from public.no_show_events where status = 'PENDING'),
    'pending_unfinished_rounds', (
      select count(*) from public.no_show_events e
      left join public.coupon_collection_rounds c on c.wave_id = e.wave_id
      where e.status = 'PENDING' and coalesce(c.status, 'OPEN') <> 'FINISHED'),
    'window_days', public.policy_int('penalty_window_days'),
    'records', coalesce((
      select jsonb_agg(x.item order by x.sort_at desc)
      from (
        select coalesce(e.verified_at, e.detected_at) as sort_at, jsonb_build_object(
          'id', e.id, 'status', e.status, 'commitment', e.commitment, 'coupon_number', e.coupon_number,
          'name', coalesce(e.holder_name, p.full_name), 'user_id', e.user_id, 'aisle', e.aisle_code,
          'meal_type', m.meal_type, 'service_start_at', m.service_start_at,
          'verified_at', e.verified_at, 'closed_at', e.closed_at, 'reason', e.reason,
          'count_in_window', public.no_show_count(e.user_id, now()),
          'penalty', (select jsonb_build_object('level', pe.level, 'status', pe.status)
                      from public.penalty_events pe where pe.no_show_event_id = e.id),
          'appeal', (select jsonb_build_object('id', ap.id, 'status', ap.status, 'explanation', ap.explanation,
                                               'submitted_at', ap.submitted_at, 'decision_reason', ap.decision_reason)
                     from public.no_show_appeals ap where ap.no_show_event_id = e.id)) as item
        from public.no_show_events e
        join public.profiles p on p.id = e.user_id
        join public.meal_services m on m.id = e.meal_service_id
        where e.status <> 'PENDING'
        order by coalesce(e.verified_at, e.detected_at) desc
        limit least(greatest(p_limit, 1), 200)
      ) x), '[]'::jsonb),
    -- 90-day trend, private to admins (spec §9.2).
    'repeat', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', r.user_id, 'name', r.full_name, 'coupon_number', r.coupon_number,
                                          'in_window', r.in_window, 'in_90_days', r.in_90) order by r.in_window desc, r.in_90 desc)
      from (
        select e.user_id, p.full_name, max(e.coupon_number) as coupon_number,
               public.no_show_count(e.user_id, now()) as in_window, count(*) as in_90
        from public.no_show_events e
        join public.profiles p on p.id = e.user_id
        join public.meal_services m on m.id = e.meal_service_id
        where e.status = 'VERIFIED' and m.service_start_at > now() - interval '90 days'
        group by e.user_id, p.full_name
        having count(*) >= 2
      ) r), '[]'::jsonb));
end $$;

-- A deleted account's student ID can be used by a new account.
create or replace function public.request_coupon(
  p_coupon_number integer, p_full_name text default null, p_note text default null, p_student_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_profile public.profiles;
  v_name text;
  v_coupon public.coupons;
  v_approved public.coupon_claims;
  v_pending public.coupon_claims;
  v_ever_approved boolean;
  v_claim_id uuid;
begin
  if p_coupon_number is null or not public.coupon_number_in_range(p_coupon_number) then
    return jsonb_build_object('status', 'INVALID_COUPON_NUMBER', 'max', public.policy_int('coupon_number_max'));
  end if;

  select * into v_profile from public.profiles where id = v_uid for update;
  v_name := btrim(coalesce(nullif(btrim(p_full_name), ''), v_profile.full_name));
  if char_length(v_name) < 2 or char_length(v_name) > 100 then
    raise exception 'a name of 2 to 100 characters is required' using errcode = '22023';
  end if;
  if p_full_name is not null and v_name <> v_profile.full_name then
    update public.profiles set full_name = v_name, updated_at = now() where id = v_uid;
  end if;
  -- The student ID the hall knows them by; one account per ID.
  if p_student_id is not null then
    if public.normalize_student_id(p_student_id) is null then
      return jsonb_build_object('status', 'INVALID_STUDENT_ID');
    end if;
    if exists (select 1 from public.profiles where student_id = public.normalize_student_id(p_student_id) and id <> v_uid
                 and deleted_at is null) then
      return jsonb_build_object('status', 'STUDENT_ID_TAKEN');
    end if;
    update public.profiles set student_id = public.normalize_student_id(p_student_id), updated_at = now()
    where id = v_uid
    returning * into v_profile;
  end if;

  select * into v_coupon from public.coupons where coupon_number = p_coupon_number for update;
  if not found then
    return jsonb_build_object('status', 'NOT_IN_REGISTER');
  end if;
  if v_coupon.status <> 'ACTIVE' then
    return jsonb_build_object('status', 'COUPON_RETIRED');
  end if;

  select * into v_approved from public.coupon_claims where user_id = v_uid and status = 'APPROVED';
  if v_approved.coupon_id = v_coupon.id then
    return jsonb_build_object('status', 'ALREADY_YOURS');
  end if;

  select * into v_pending from public.coupon_claims where user_id = v_uid and status = 'PENDING' for update;
  if v_pending.id is not null then
    if v_pending.coupon_id = v_coupon.id then
      return jsonb_build_object('status', 'PENDING', 'claim_id', v_pending.id, 'kind', v_pending.kind);
    end if;
    -- A new request replaces an earlier one (e.g. a typo in the number).
    update public.coupon_claims
    set status = 'WITHDRAWN', decided_at = now(), decision_reason = 'Replaced by a request for coupon ' || p_coupon_number
    where id = v_pending.id;
  end if;

  v_ever_approved := exists (select 1 from public.coupon_claims
                             where user_id = v_uid and status in ('APPROVED', 'REVOKED'));

  insert into public.coupon_claims (coupon_id, user_id, status, kind, claimed_name, claimed_phone, claimed_student_id, evidence)
  values (v_coupon.id, v_uid, 'PENDING', case when v_ever_approved then 'CHANGE' else 'INITIAL' end,
          v_name, v_profile.notify_phone, v_profile.student_id, left(nullif(btrim(p_note), ''), 1000))
  returning id into v_claim_id;

  perform public.write_audit('COUPON_REQUESTED', 'coupon_claim', v_claim_id::text, null,
    jsonb_build_object('coupon_number', p_coupon_number, 'user_id', v_uid,
                       'kind', case when v_ever_approved then 'CHANGE' else 'INITIAL' end));

  return jsonb_build_object('status', 'PENDING', 'claim_id', v_claim_id,
                            'kind', case when v_ever_approved then 'CHANGE' else 'INITIAL' end);
end $$;

grant execute on function public.delete_my_account(text) to authenticated;
