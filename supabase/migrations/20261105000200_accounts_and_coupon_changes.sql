-- Student accounts, coupon claims checked by admins, coupon changes and
-- reassignments between semesters, and register-change notices.
--
-- A student is an account (with its own random public id), not a coupon
-- number. They ask for a coupon (1..coupon_number_max, listed in the hall
-- register); an admin compares the claimed name/phone with the register and
-- approves or rejects. Later they can ask to change to a new number. If an
-- admin approves a number that someone else holds, that holder loses it and
-- is told to get their new number from the hall office and request it the
-- same way. History (bookings, no-shows) stays with the student, never with
-- the number.

insert into public.policy_settings (version, settings, is_active, note)
select 4, settings || jsonb_build_object('coupon_number_max', 450), false,
       'Coupon numbers run from 1 to 450'
from public.policy_settings where is_active;
update public.policy_settings set is_active = false where is_active and version <> 4;
update public.policy_settings set is_active = true where version = 4;

-- ---------------------------------------------------------------------------
-- Profiles: public id and the parts students edit themselves
-- ---------------------------------------------------------------------------

create function public.generate_public_id() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- no 0/O, 1/I
  v_id text;
begin
  loop
    v_id := 'AD-' || (select string_agg(substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::integer, 1), '')
                      from generate_series(1, 6));
    exit when not exists (select 1 from public.profiles where public_id = v_id);
  end loop;
  return v_id;
end $$;

alter table public.profiles
  add column public_id text unique,
  add column notify_phone text check (notify_phone is null or notify_phone ~ '^01[3-9][0-9]{8}$'),
  add column avatar_url text check (avatar_url is null or avatar_url ~ '^/api/files/[A-Za-z0-9._-]+$' or avatar_url ~ '^https://'),
  add column room text check (char_length(room) <= 20),
  add column roommates jsonb not null default '[]'::jsonb
    check (jsonb_typeof(roommates) = 'array' and jsonb_array_length(roommates) <= 8);

update public.profiles set public_id = public.generate_public_id() where public_id is null;
alter table public.profiles alter column public_id set not null;

create function public.profiles_public_id() returns trigger
language plpgsql as $$
begin
  new.public_id := coalesce(new.public_id, public.generate_public_id());
  return new;
end $$;

create trigger profiles_public_id before insert on public.profiles
  for each row execute function public.profiles_public_id();

-- The phone a user proved at sign-up is their notification phone.
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles (id, full_name, notify_phone)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 200),
          case when new.phone_confirmed_at is not null and public.is_valid_bd_mobile(new.phone)
               then public.normalize_phone(new.phone) end)
  on conflict (id) do nothing;
  return new;
end $$;

-- A verified name must not change behind the admin's back: students edit
-- their profile only through update_my_profile.
revoke update (full_name) on public.profiles from authenticated;

-- ---------------------------------------------------------------------------
-- Claims: kinds and what the student said
-- ---------------------------------------------------------------------------

alter table public.coupon_claims
  add column kind text not null default 'INITIAL' check (kind in ('INITIAL', 'CHANGE')),
  add column claimed_name text check (char_length(claimed_name) <= 100),
  add column claimed_phone text,
  -- Set on an APPROVED claim when an admin asks the holder to request their new number.
  add column update_requested_at timestamptz,
  add column update_request_message text;

create function public.coupon_number_in_range(p_number integer) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_number between 1 and public.policy_int('coupon_number_max')
$$;

create function public.normalize_name(p_name text) returns text
language sql immutable as $$
  select lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))
$$;

-- Student-facing: ask for a coupon number, first time or as a change.
-- The admin decides; nothing is approved automatically here.
create function public.request_coupon(
  p_coupon_number integer, p_full_name text default null, p_note text default null
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

  insert into public.coupon_claims (coupon_id, user_id, status, kind, claimed_name, claimed_phone, evidence)
  values (v_coupon.id, v_uid, 'PENDING', case when v_ever_approved then 'CHANGE' else 'INITIAL' end,
          v_name, v_profile.notify_phone, left(nullif(btrim(p_note), ''), 1000))
  returning id into v_claim_id;

  perform public.write_audit('COUPON_REQUESTED', 'coupon_claim', v_claim_id::text, null,
    jsonb_build_object('coupon_number', p_coupon_number, 'user_id', v_uid,
                       'kind', case when v_ever_approved then 'CHANGE' else 'INITIAL' end));

  return jsonb_build_object('status', 'PENDING', 'claim_id', v_claim_id,
                            'kind', case when v_ever_approved then 'CHANGE' else 'INITIAL' end);
end $$;

-- Admin approval, now handling changes and reassignments.
drop function public.approve_coupon_claim(uuid, text);

create function public.approve_coupon_claim(p_claim_id uuid, p_reason text, p_reassign boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_claim public.coupon_claims;
  v_coupon public.coupons;
  v_holder public.coupon_claims;
  v_holder_name text;
  v_old public.coupon_claims;
  v_lost integer;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  select * into v_claim from public.coupon_claims where id = p_claim_id for update;
  if not found then
    raise exception 'claim not found' using errcode = 'P0002';
  end if;
  if v_claim.status = 'APPROVED' then
    return jsonb_build_object('status', 'ALREADY_APPROVED');
  end if;
  if v_claim.status <> 'PENDING' then
    return jsonb_build_object('status', 'NOT_PENDING', 'claim_status', v_claim.status);
  end if;

  select * into v_coupon from public.coupons where id = v_claim.coupon_id for update;

  -- Someone else holds this number: only with an explicit reassignment.
  select * into v_holder from public.coupon_claims
  where coupon_id = v_claim.coupon_id and status = 'APPROVED' and user_id <> v_claim.user_id
  for update;
  if v_holder.id is not null then
    select full_name into v_holder_name from public.profiles where id = v_holder.user_id;
    if not coalesce(p_reassign, false) then
      return jsonb_build_object('status', 'HELD_BY_OTHER', 'holder_name', v_holder_name,
        'holder_public_id', (select public_id from public.profiles where id = v_holder.user_id));
    end if;
    update public.coupon_claims
    set status = 'REVOKED', effective_to = now(), decided_by = v_uid,
        decision_reason = 'Coupon ' || v_coupon.coupon_number || ' reassigned by the hall office: ' || p_reason
    where id = v_holder.id;
    update public.profiles set is_verified = false, updated_at = now() where id = v_holder.user_id;
    perform public.enqueue_notification(v_holder.user_id, 'COUPON_REASSIGNED', 'coupon-reassigned:' || v_holder.id,
      jsonb_build_object('coupon_number', v_coupon.coupon_number,
        'message', 'Coupon updated: coupon ' || v_coupon.coupon_number || ' is now assigned to another student. '
                   || 'Contact the hall office for your new coupon number, then request it in the app (Profile → Change coupon).'));
    perform public.write_audit('COUPON_CLAIM_REVOKED', 'coupon_claim', v_holder.id::text,
      jsonb_build_object('status', 'APPROVED'), jsonb_build_object('status', 'REVOKED', 'reassigned_to_claim', p_claim_id), p_reason);
  end if;

  -- A change: the student's previous number ends now.
  select * into v_old from public.coupon_claims
  where user_id = v_claim.user_id and status = 'APPROVED' for update;
  if v_old.id is not null then
    update public.coupon_claims
    set status = 'REVOKED', effective_to = now(), decided_by = v_uid,
        decision_reason = 'Changed to coupon ' || v_coupon.coupon_number
    where id = v_old.id;
  end if;

  update public.coupon_claims
  set status = 'APPROVED', method = 'STAFF_APPROVAL', decided_at = now(), decided_by = v_uid,
      decision_reason = p_reason, effective_from = now()
  where id = p_claim_id;

  -- Anyone else waiting for this number is told it went to someone else.
  with lost as (
    update public.coupon_claims
    set status = 'REJECTED', decided_at = now(), decided_by = v_uid, decision_reason = 'Coupon confirmed for another student'
    where coupon_id = v_claim.coupon_id and status = 'PENDING'
    returning id, user_id
  )
  select count(*) from (
    select public.enqueue_notification(l.user_id, 'COUPON_REJECTED', 'coupon-rejected:' || l.id,
      jsonb_build_object('coupon_number', v_coupon.coupon_number,
        'message', 'Your request for coupon ' || v_coupon.coupon_number || ' was not approved: it was confirmed for another student. '
                   || 'Check your number with the hall office and request again.'))
    from lost l
  ) x into v_lost;

  -- The hall code (if any) can no longer be used once ownership is settled.
  update public.coupon_claim_secrets
  set consumed_at = now(), consumed_by_claim = p_claim_id
  where coupon_id = v_claim.coupon_id and consumed_at is null;

  update public.profiles set is_verified = true, updated_at = now() where id = v_claim.user_id;

  perform public.enqueue_notification(v_claim.user_id, 'COUPON_APPROVED', 'coupon-approved:' || p_claim_id,
    jsonb_build_object('coupon_number', v_coupon.coupon_number,
      'message', 'Coupon ' || v_coupon.coupon_number || ' is confirmed for your account. You can now book meals.'));

  perform public.write_audit('COUPON_CLAIM_APPROVED', 'coupon_claim', p_claim_id::text,
    to_jsonb(v_claim),
    jsonb_build_object('status', 'APPROVED', 'method', 'STAFF_APPROVAL', 'kind', v_claim.kind,
                       'reassigned_from', v_holder_name, 'previous_claim', v_old.id), p_reason);

  return jsonb_build_object('status', 'APPROVED', 'claim_id', p_claim_id, 'reassigned_from', v_holder_name);
end $$;

-- Rejection now tells the student why.
create or replace function public.reject_coupon_claim(p_claim_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_claim public.coupon_claims;
  v_number integer;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select * into v_claim from public.coupon_claims where id = p_claim_id for update;
  if not found then
    raise exception 'claim not found' using errcode = 'P0002';
  end if;
  if v_claim.status <> 'PENDING' then
    return jsonb_build_object('status', 'NOT_PENDING', 'claim_status', v_claim.status);
  end if;
  update public.coupon_claims
  set status = 'REJECTED', decided_at = now(), decided_by = v_uid, decision_reason = p_reason
  where id = p_claim_id;
  select coupon_number into v_number from public.coupons where id = v_claim.coupon_id;
  perform public.enqueue_notification(v_claim.user_id, 'COUPON_REJECTED', 'coupon-rejected:' || p_claim_id,
    jsonb_build_object('coupon_number', v_number,
      'message', 'Your request for coupon ' || v_number || ' was not approved: ' || p_reason));
  perform public.write_audit('COUPON_CLAIM_REJECTED', 'coupon_claim', p_claim_id::text,
    to_jsonb(v_claim), jsonb_build_object('status', 'REJECTED'), p_reason);
  return jsonb_build_object('status', 'REJECTED');
end $$;

-- Claims waiting for an admin, with everything needed to decide.
create function public.admin_coupon_claims() returns jsonb
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

-- ---------------------------------------------------------------------------
-- Profile
-- ---------------------------------------------------------------------------

create or replace function public.my_profile() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'public_id', p.public_id, 'name', p.full_name, 'role', p.role, 'is_verified', p.is_verified,
    'phone', p.notify_phone, 'avatar_url', p.avatar_url, 'room', p.room, 'roommates', p.roommates,
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

create function public.update_my_profile(
  p_room text default null, p_roommates jsonb default null, p_avatar_url text default null, p_clear_avatar boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  r jsonb;
begin
  if p_roommates is not null then
    if jsonb_typeof(p_roommates) <> 'array' or jsonb_array_length(p_roommates) > 8 then
      raise exception 'roommates must be a list of at most 8' using errcode = '22023';
    end if;
    for r in select * from jsonb_array_elements(p_roommates) loop
      if jsonb_typeof(r) <> 'object' or char_length(btrim(coalesce(r ->> 'name', ''))) not between 1 and 60
         or (r ? 'coupon_number' and r ->> 'coupon_number' is not null and (r ->> 'coupon_number') !~ '^\d{1,6}$') then
        raise exception 'each roommate needs a name (and optionally a coupon number)' using errcode = '22023';
      end if;
    end loop;
  end if;

  update public.profiles
  set room = case when p_room is null then room else nullif(btrim(p_room), '') end,
      roommates = coalesce(p_roommates, roommates),
      avatar_url = case when p_clear_avatar then null else coalesce(p_avatar_url, avatar_url) end,
      updated_at = now()
  where id = v_uid;
  return jsonb_build_object('status', 'OK');
end $$;

-- ---------------------------------------------------------------------------
-- Register changes: compare the uploaded sheet with current holders
-- ---------------------------------------------------------------------------

create function public.registry_holder_check() returns jsonb
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

-- Ask holders to request their new number (after the hall changed numbers).
-- p_user_ids null = every student who holds a coupon. They keep their current
-- number until an admin approves the new one.
create function public.request_coupon_updates(p_user_ids uuid[], p_message text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  c record;
  v_count integer := 0;
  v_msg text := coalesce(nullif(btrim(p_message), ''),
    'Coupon numbers have been updated by the hall office. Please check your new coupon number with the hall office and request it in the app (Profile → Change coupon).');
begin
  for c in
    select cc.id, cc.user_id, k.coupon_number
    from public.coupon_claims cc join public.coupons k on k.id = cc.coupon_id
    join public.profiles p on p.id = cc.user_id
    where cc.status = 'APPROVED' and p.role = 'STUDENT'
      and (p_user_ids is null or cc.user_id = any (p_user_ids))
    for update of cc
  loop
    update public.coupon_claims set update_requested_at = now(), update_request_message = v_msg where id = c.id;
    perform public.enqueue_notification(c.user_id, 'COUPON_UPDATE_REQUESTED',
      'coupon-update:' || c.id || ':' || extract(epoch from now()),
      jsonb_build_object('coupon_number', c.coupon_number, 'message', v_msg));
    v_count := v_count + 1;
  end loop;
  perform public.write_audit('COUPON_UPDATES_REQUESTED', 'coupon_claims', null, null,
    jsonb_build_object('students', v_count, 'all', p_user_ids is null), v_msg);
  return jsonb_build_object('status', 'OK', 'notified', v_count);
end $$;

grant execute on function
  public.request_coupon(integer, text, text),
  public.approve_coupon_claim(uuid, text, boolean),
  public.admin_coupon_claims(),
  public.update_my_profile(text, jsonb, text, boolean),
  public.registry_holder_check(),
  public.request_coupon_updates(uuid[], text)
to authenticated;
