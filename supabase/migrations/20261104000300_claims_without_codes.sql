-- Coupon claims when the hall cannot issue verification codes.
--
-- Two routes remain (spec §4.1: "verified binding to the hall's records or
-- admin approval"):
--   1. Contact match: the hall registry row carries the student's email
--      and/or phone, and Supabase Auth has already proven the signed-in user
--      owns that address/number. The claim is approved automatically.
--   2. Admin queue: everything else goes PENDING (request_coupon_claim without
--      a code) and admins work through it with the registry row shown next to
--      the claimant, approving in bulk.
-- The hall-code route from the first migration stays available but dormant.

alter type public.claim_method add value if not exists 'HALL_CONTACT_MATCH';

-- Bangladesh mobiles arrive as +8801XXXXXXXXX, 8801XXXXXXXXX, 01XXXXXXXXX or
-- (spreadsheets dropping the leading zero) 1XXXXXXXXX. All become 01XXXXXXXXX.
create function public.normalize_phone(p_phone text) returns text
language sql immutable as $$
  select nullif(
    case
      when d like '880%' then substr(d, 3)
      when d ~ '^1[0-9]{9}$' then '0' || d
      else d
    end, '')
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) x
$$;

create function public.is_valid_bd_mobile(p_phone text) returns boolean
language sql immutable as $$
  select coalesce(public.normalize_phone(p_phone) ~ '^01[3-9][0-9]{8}$', false)
$$;

create index coupons_hall_email_idx on public.coupons (lower(btrim(hall_record ->> 'email')));
create index coupons_hall_phone_idx on public.coupons (public.normalize_phone(hall_record ->> 'phone'));

-- Student-facing, no arguments: finds the active coupon whose hall record
-- lists the caller's verified email or phone and approves the claim.
create function public.claim_coupon_by_hall_contact() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_user auth.users;
  v_email text;
  v_phone text;
  v_matches uuid[];
  v_coupon public.coupons;
  v_claim public.coupon_claims;
  v_claim_id uuid;
begin
  select * into v_claim from public.coupon_claims where user_id = v_uid and status = 'APPROVED';
  if found then
    return jsonb_build_object('status', 'ALREADY_APPROVED', 'claim_id', v_claim.id);
  end if;

  select * into v_user from auth.users where id = v_uid;
  v_email := case when v_user.email_confirmed_at is not null then lower(btrim(v_user.email)) end;
  v_phone := case when v_user.phone_confirmed_at is not null and public.is_valid_bd_mobile(v_user.phone)
                  then public.normalize_phone(v_user.phone) end;
  if v_email is null and v_phone is null then
    return jsonb_build_object('status', 'NO_VERIFIED_CONTACT');
  end if;

  select array_agg(id order by coupon_number) into v_matches
  from public.coupons
  where status = 'ACTIVE'
    and ((v_email is not null and lower(btrim(hall_record ->> 'email')) = v_email)
      or (v_phone is not null and public.normalize_phone(hall_record ->> 'phone') = v_phone));

  if v_matches is null then
    return jsonb_build_object('status', 'NO_MATCH');
  end if;
  if cardinality(v_matches) > 1 then
    -- Registry data problem: never guess which coupon is theirs.
    perform public.raise_admin_alert(
      'AMBIGUOUS_HALL_CONTACT', 'ambiguous-contact:' || v_uid,
      jsonb_build_object('user_id', v_uid, 'coupon_ids', to_jsonb(v_matches)));
    return jsonb_build_object('status', 'AMBIGUOUS_MATCH');
  end if;

  select * into v_coupon from public.coupons where id = v_matches[1] for update;

  if exists (select 1 from public.coupon_claims where coupon_id = v_coupon.id and status = 'APPROVED') then
    perform public.raise_admin_alert(
      'IDENTITY_CONFLICT', 'claim-conflict:' || v_coupon.id || ':' || v_uid,
      jsonb_build_object('coupon_number', v_coupon.coupon_number, 'claimant_user_id', v_uid,
                         'route', 'HALL_CONTACT_MATCH'));
    return jsonb_build_object('status', 'COUPON_ALREADY_CLAIMED', 'coupon_number', v_coupon.coupon_number);
  end if;

  update public.coupon_claims
  set status = 'WITHDRAWN', decided_at = now(), decision_reason = 'Superseded by hall contact match'
  where user_id = v_uid and status = 'PENDING';

  insert into public.coupon_claims (coupon_id, user_id, status, method, decided_at, effective_from)
  values (v_coupon.id, v_uid, 'APPROVED', 'HALL_CONTACT_MATCH', now(), now())
  returning id into v_claim_id;

  -- Other people's pending requests for this coupon are now moot.
  update public.coupon_claims
  set status = 'REJECTED', decided_at = now(), decision_reason = 'Coupon verified to another holder'
  where coupon_id = v_coupon.id and status = 'PENDING';

  update public.profiles set is_verified = true, updated_at = now() where id = v_uid;

  perform public.write_audit('COUPON_CLAIM_APPROVED', 'coupon_claim', v_claim_id::text, null,
    jsonb_build_object('coupon_number', v_coupon.coupon_number, 'user_id', v_uid,
                       'method', 'HALL_CONTACT_MATCH',
                       'matched_on', case when v_email is not null
                                           and lower(btrim(v_coupon.hall_record ->> 'email')) = v_email
                                          then 'email' else 'phone' end));

  return jsonb_build_object('status', 'APPROVED', 'claim_id', v_claim_id, 'coupon_number', v_coupon.coupon_number);
end $$;

-- Admin review queue: each pending claim beside the hall registry row and
-- the claimant's verified contact details, oldest first.
create function public.list_pending_coupon_claims()
returns table (
  claim_id uuid,
  requested_at timestamptz,
  coupon_number integer,
  hall_record jsonb,
  claimant_id uuid,
  claimant_name text,
  claimant_email text,
  claimant_email_verified boolean,
  claimant_phone text,
  evidence text,
  competing_pending_claims integer
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return query
  select c.id, c.requested_at, k.coupon_number, k.hall_record,
         p.id, p.full_name, u.email, u.email_confirmed_at is not null, u.phone, c.evidence,
         (select count(*)::integer - 1 from public.coupon_claims o
          where o.coupon_id = c.coupon_id and o.status = 'PENDING')
  from public.coupon_claims c
  join public.coupons k on k.id = c.coupon_id
  join public.profiles p on p.id = c.user_id
  join auth.users u on u.id = c.user_id
  where c.status = 'PENDING'
  order by c.requested_at;
end $$;

-- Bulk approval for working through the queue. Each claim is decided
-- independently (same rules as approve_coupon_claim); returns one result per id.
create function public.approve_coupon_claims(p_claim_ids uuid[], p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_results jsonb := '[]'::jsonb;
begin
  perform public.require_role('ADMIN');
  if cardinality(p_claim_ids) > 200 then
    raise exception 'at most 200 claims per batch' using errcode = '22023';
  end if;
  foreach v_id in array p_claim_ids loop
    v_results := v_results || jsonb_build_array(
      jsonb_build_object('claim_id', v_id) || public.approve_coupon_claim(v_id, p_reason));
  end loop;
  return jsonb_build_object('status', 'OK', 'results', v_results);
end $$;

-- Pre-launch registry check. Every row here is a student who will fall back
-- to the admin queue (or be refused as ambiguous) unless the hall fixes it.
create function public.hall_contact_issues()
returns table (coupon_number integer, issue text, phone text, shared_with integer[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return query
  with active as (
    select c.coupon_number, c.hall_record ->> 'phone' as raw_phone,
           public.normalize_phone(c.hall_record ->> 'phone') as norm
    from public.coupons c
    where c.status = 'ACTIVE'
  )
  select a.coupon_number,
         case
           when a.raw_phone is null or btrim(a.raw_phone) = '' then 'MISSING_PHONE'
           when not public.is_valid_bd_mobile(a.raw_phone) then 'INVALID_PHONE'
           else 'SHARED_PHONE'
         end,
         a.raw_phone,
         (select array_agg(o.coupon_number order by o.coupon_number) from active o
          where o.norm = a.norm and o.coupon_number <> a.coupon_number)
  from active a
  where a.raw_phone is null or btrim(a.raw_phone) = ''
     or not public.is_valid_bd_mobile(a.raw_phone)
     or exists (select 1 from active o where o.norm = a.norm and o.coupon_number <> a.coupon_number)
  order by a.coupon_number;
end $$;

grant execute on function
  public.hall_contact_issues(),
  public.claim_coupon_by_hall_contact(),
  public.list_pending_coupon_claims(),
  public.approve_coupon_claims(uuid[], text)
to authenticated;
