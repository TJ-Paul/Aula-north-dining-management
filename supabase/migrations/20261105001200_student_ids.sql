-- Student ID instead of phone as a student's identity (the hall's register
-- now gives name, student ID and coupon). Students claim a coupon with their
-- coupon number, name, student ID and a password, and may sign in with their
-- student ID or coupon number. Staff keep signing in with their phone.
--
-- Also: admin_people_data(), the admins' table of everyone (register coupons,
-- account holders and what each has done).

create function public.normalize_student_id(p_value text) returns text
language sql immutable as $$
  select case when upper(regexp_replace(coalesce(p_value, ''), '\s', '', 'g')) ~ '^[A-Z0-9][A-Z0-9/-]{2,23}$'
              then upper(regexp_replace(p_value, '\s', '', 'g')) end
$$;

alter table public.profiles add column student_id text check (student_id is null or student_id = public.normalize_student_id(student_id));
create unique index profiles_student_id_unique on public.profiles (student_id) where student_id is not null;
alter table public.coupon_claims add column claimed_student_id text;

drop function public.request_coupon(integer, text, text);
create function public.request_coupon(
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
    if exists (select 1 from public.profiles where student_id = public.normalize_student_id(p_student_id) and id <> v_uid) then
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

create or replace function public.admin_coupon_claims() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'claim_id', c.id, 'kind', c.kind, 'requested_at', c.requested_at, 'note', c.evidence,
      'coupon_number', k.coupon_number, 'register', k.hall_record,
      'claimed_name', coalesce(c.claimed_name, p.full_name), 'claimed_phone', coalesce(c.claimed_phone, p.notify_phone),
      'name_matches', public.normalize_name(coalesce(c.claimed_name, p.full_name)) = public.normalize_name(k.hall_record ->> 'name'),
      'phone_matches', public.normalize_phone(coalesce(c.claimed_phone, p.notify_phone)) = public.normalize_phone(k.hall_record ->> 'phone'),
      'claimed_student_id', coalesce(c.claimed_student_id, p.student_id),
      'student_id_matches', public.normalize_student_id(coalesce(c.claimed_student_id, p.student_id))
                            = public.normalize_student_id(k.hall_record ->> 'student_id'),
      'claimant', jsonb_build_object('id', p.id, 'public_id', p.public_id, 'name', p.full_name,
        'current_coupon', (select kk.coupon_number from public.coupon_claims cc join public.coupons kk on kk.id = cc.coupon_id
                           where cc.user_id = p.id and cc.status = 'APPROVED')),
      'current_holder', (select jsonb_build_object('name', hp.full_name, 'public_id', hp.public_id)
                         from public.coupon_claims hc join public.profiles hp on hp.id = hc.user_id
                         where hc.coupon_id = c.coupon_id and hc.status = 'APPROVED' and hc.user_id <> c.user_id),
      'competing_pending_claims', (select count(*) - 1 from public.coupon_claims o
                                   where o.coupon_id = c.coupon_id and o.status = 'PENDING'))
      order by c.requested_at)
    from public.coupon_claims c
    join public.coupons k on k.id = c.coupon_id
    join public.profiles p on p.id = c.user_id
    where c.status = 'PENDING'
  ), '[]'::jsonb);
end $$;

create or replace function public.my_profile() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'public_id', p.public_id, 'name', p.full_name, 'role', p.role, 'is_verified', p.is_verified,
    'phone', p.notify_phone, 'student_id', p.student_id, 'avatar_url', p.avatar_url, 'room', p.room, 'roommates', p.roommates,
    'coupon_number', ac.coupon_number,
    'coupon_since', ac.effective_from,
    'update_requested_at', ac.update_requested_at,
    'update_request_message', ac.update_request_message,
    'pending_claim', (select jsonb_build_object('claim_id', c.id, 'coupon_number', k.coupon_number, 'kind', c.kind,
                                                'requested_at', c.requested_at)
                      from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
                      where c.user_id = p.id and c.status = 'PENDING'),
    -- The latest decision that left the student without the number they asked for or held.
    'last_decision', (select jsonb_build_object('status', c.status, 'coupon_number', k.coupon_number,
                                                'reason', c.decision_reason, 'decided_at', coalesce(c.effective_to, c.decided_at))
                      from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
                      where c.user_id = p.id and c.status in ('REJECTED', 'REVOKED')
                        and coalesce(c.effective_to, c.decided_at) > coalesce(ac.effective_from, '-infinity'::timestamptz)
                        and c.decision_reason not like 'Changed to coupon %'
                      order by coalesce(c.effective_to, c.decided_at) desc limit 1))
  from public.profiles p
  left join lateral (
    select k.coupon_number, c.effective_from, c.update_requested_at, c.update_request_message
    from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
    where c.user_id = p.id and c.status = 'APPROVED') ac on true
  where p.id = auth.uid()
$$;

create or replace function public.registry_holder_check() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return jsonb_build_object(
    'holders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', p.id, 'public_id', p.public_id, 'coupon_number', k.coupon_number,
        'holder_name', p.full_name, 'register_name', k.hall_record ->> 'name',
        'holder_phone', p.notify_phone, 'register_phone', k.hall_record ->> 'phone',
        'name_matches', public.normalize_name(p.full_name) = public.normalize_name(k.hall_record ->> 'name'),
        'phone_matches', public.normalize_phone(p.notify_phone) = public.normalize_phone(k.hall_record ->> 'phone'),
        'holder_student_id', p.student_id, 'register_student_id', k.hall_record ->> 'student_id',
        'student_id_matches', p.student_id = public.normalize_student_id(k.hall_record ->> 'student_id'),
        'coupon_retired', k.status = 'RETIRED',
        'update_requested_at', c.update_requested_at) order by k.coupon_number)
      from public.coupon_claims c
      join public.coupons k on k.id = c.coupon_id
      join public.profiles p on p.id = c.user_id
      where c.status = 'APPROVED'), '[]'::jsonb),
    'register_size', (select count(*) from public.coupons where status = 'ACTIVE'),
    'unclaimed', (select count(*) from public.coupons k where k.status = 'ACTIVE'
                  and not exists (select 1 from public.coupon_claims c where c.coupon_id = k.id and c.status = 'APPROVED')));
end $$;

-- Everyone, for the admins: every coupon in the hall register (with its holder,
-- if any) and every account without a coupon, with what each has done.
create function public.admin_people_data(p_query text default null) returns jsonb
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

create function public.person_stats(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p.id is null then jsonb_build_object('user_id', null) else jsonb_build_object(
    'user_id', p.id, 'public_id', p.public_id, 'name', p.full_name, 'student_id', p.student_id, 'room', p.room,
    'phone', p.notify_phone, 'role', p.role, 'joined_at', p.created_at,
    'meals_eaten', (select count(*) from public.attendance_records a where a.holder_user_id = p.id and a.status = 'VALID'),
    'last_meal_at', (select max(a.recorded_at) from public.attendance_records a where a.holder_user_id = p.id and a.status = 'VALID'),
    'missed', (select count(*) from public.no_show_events e where e.user_id = p.id and e.status = 'VERIFIED'),
    'not_coming_kept', (select count(*) from public.meal_rsvps r where r.user_id = p.id and r.outcome = 'REWARDED'),
    'came_anyway', (select count(*) from public.meal_rsvps r where r.user_id = p.id and r.outcome = 'CAME_ANYWAY'),
    'points', public.points_balance(p.id)) end
  from (select 1) one left join public.profiles p on p.id = p_user_id
$$;

grant execute on function
  public.request_coupon(integer, text, text, text),
  public.admin_people_data(text)
to authenticated;
