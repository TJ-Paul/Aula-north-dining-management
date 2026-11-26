-- After a rejected first claim the student fills in the whole claim again
-- (coupon number, student ID, full name); the name may be corrected until first verified.

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
  -- Until a first coupon is approved, each claim may correct the name (e.g. after a rejection).
  -- Once verified, name changes go through an admin (request_name_change).
  if p_full_name is not null and v_name <> v_profile.full_name
     and not exists (select 1 from public.coupon_claims where user_id = v_uid and status in ('APPROVED', 'REVOKED')) then
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

  -- Someone else holds (or has claimed) it: refused, unless the hall register now lists this
  -- student under that coupon (a new semester's allotment); an admin then hands it over.
  if exists (select 1 from public.coupon_claims c where c.coupon_id = v_coupon.id and c.user_id <> v_uid
             and c.status in ('APPROVED', 'PENDING'))
     and (v_profile.student_id is null
          or public.normalize_student_id(v_coupon.hall_record ->> 'student_id') is distinct from v_profile.student_id) then
    return jsonb_build_object('status', 'COUPON_TAKEN');
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
