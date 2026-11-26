-- Semesters: coupon numbers are re-allotted by the hall office.
-- * Each person's earlier names and student IDs are kept and shown to them and to admins.
-- * Each coupon's earlier holders (name and student ID as they claimed it, and when) are
--   shown to its current holder.
-- * When a new register moves a coupon to another student ID, both the old holder and the
--   student now listed under it are told to update their coupon number; an admin verifies.
-- * Claiming a coupon someone else holds is refused, unless the register lists you under it.

create table public.profile_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id),
  field text not null check (field in ('NAME', 'STUDENT_ID')),
  old_value text,
  new_value text,
  changed_at timestamptz not null default now(),
  changed_by uuid
);
create index profile_history_user on public.profile_history (user_id, changed_at desc);
alter table public.profile_history enable row level security;

create function public.record_profile_history() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.full_name is distinct from old.full_name and coalesce(old.full_name, '') <> '' then
    insert into public.profile_history (user_id, field, old_value, new_value, changed_by)
    values (new.id, 'NAME', old.full_name, new.full_name, auth.uid());
  end if;
  if new.student_id is distinct from old.student_id and old.student_id is not null then
    insert into public.profile_history (user_id, field, old_value, new_value, changed_by)
    values (new.id, 'STUDENT_ID', old.student_id, new.student_id, auth.uid());
  end if;
  return new;
end $$;
create trigger profiles_history after update of full_name, student_id on public.profiles
  for each row execute function public.record_profile_history();

-- A person's earlier names and IDs, and every coupon they have held or asked for.
create function public.history_of(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'changes', coalesce((select jsonb_agg(jsonb_build_object('field', h.field, 'old', h.old_value, 'new', h.new_value,
                                                             'changed_at', h.changed_at) order by h.changed_at desc)
                         from public.profile_history h where h.user_id = p_user_id), '[]'::jsonb),
    'coupons', coalesce((select jsonb_agg(jsonb_build_object('coupon_number', k.coupon_number, 'status', c.status,
                                                             'from', c.effective_from, 'to', c.effective_to,
                                                             'name', c.claimed_name, 'student_id', c.claimed_student_id)
                                          order by coalesce(c.effective_from, c.requested_at) desc)
                         from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
                         where c.user_id = p_user_id and c.status in ('APPROVED', 'REVOKED')), '[]'::jsonb))
$$;

-- Who held a coupon before its current holder: as they claimed it, and for how long.
create function public.earlier_holders(p_coupon_number integer) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(c.claimed_name, p.full_name),
                                               'student_id', coalesce(c.claimed_student_id, p.student_id),
                                               'from', c.effective_from, 'to', c.effective_to)
                            order by c.effective_to desc), '[]'::jsonb)
  from public.coupon_claims c join public.coupons k on k.id = c.coupon_id join public.profiles p on p.id = c.user_id
  where k.coupon_number = p_coupon_number and c.status = 'REVOKED' and c.effective_from is not null
$$;

create function public.my_history() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select public.history_of(u.id)
         || jsonb_build_object('coupon_number', public.coupon_number_of(u.id),
                               'earlier_holders', public.earlier_holders(public.coupon_number_of(u.id)))
  from (select public.require_role('STUDENT') as id) u
$$;

-- After a register upload: whoever's coupon moved to another student ID is asked to update.
create function public.notify_register_changes() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_count integer := 0;
  v_msg text;
begin
  -- 1. Holders whose coupon the register now gives to a different student ID.
  for r in
    select c.id as claim_id, c.user_id, k.coupon_number, public.normalize_student_id(k.hall_record ->> 'student_id') as listed
    from public.coupon_claims c join public.coupons k on k.id = c.coupon_id join public.profiles p on p.id = c.user_id
    where c.status = 'APPROVED' and p.deleted_at is null and p.student_id is not null
      and public.normalize_student_id(k.hall_record ->> 'student_id') is not null
      and public.normalize_student_id(k.hall_record ->> 'student_id') <> p.student_id
  loop
    v_msg := 'The hall register now lists coupon ' || r.coupon_number || ' under another student. '
             || 'Check your new coupon number and update it in Profile → Change coupon number.';
    update public.coupon_claims set update_requested_at = now(), update_request_message = v_msg where id = r.claim_id;
    perform public.enqueue_notification(r.user_id, 'COUPON_UPDATE_REQUESTED',
      'register:' || r.user_id || ':' || r.coupon_number || ':' || r.listed,
      jsonb_build_object('coupon_number', r.coupon_number, 'message', v_msg));
    v_count := v_count + 1;
  end loop;

  -- 2. Students the register lists under a coupon they don't hold or haven't asked for yet.
  for r in
    select p.id as user_id, k.coupon_number, p.student_id,
           (select c.id from public.coupon_claims c where c.user_id = p.id and c.status = 'APPROVED') as claim_id
    from public.profiles p
    join public.coupons k on public.normalize_student_id(k.hall_record ->> 'student_id') = p.student_id and k.status = 'ACTIVE'
    where p.deleted_at is null
      and not exists (select 1 from public.coupon_claims c where c.user_id = p.id and c.coupon_id = k.id
                      and c.status in ('APPROVED', 'PENDING'))
  loop
    v_msg := 'The hall register lists you under coupon ' || r.coupon_number || '. '
             || 'Update your coupon number in Profile → Change coupon number; an admin will verify it.';
    if r.claim_id is not null then
      update public.coupon_claims set update_requested_at = now(), update_request_message = v_msg where id = r.claim_id;
    end if;
    perform public.enqueue_notification(r.user_id, 'COUPON_UPDATE_REQUESTED',
      'register:' || r.user_id || ':' || r.coupon_number || ':' || r.student_id,
      jsonb_build_object('coupon_number', r.coupon_number, 'message', v_msg));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

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
  -- The name is set once, when the account is new; later changes go through an admin (request_name_change).
  if p_full_name is not null and coalesce(btrim(v_profile.full_name), '') = '' then
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

create or replace function public.import_coupons(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('SUPER_ADMIN');
  r record;
  v_coupon public.coupons;
  v_secret public.coupon_claim_secrets;
  v_salt bytea;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_codes integer := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;

  for r in
    select * from jsonb_to_recordset(p_rows)
      as x(coupon_number integer, hall_record jsonb, claim_code text, status public.coupon_status)
  loop
    if r.coupon_number is null then
      raise exception 'every row needs coupon_number' using errcode = '22023';
    end if;

    select * into v_coupon from public.coupons where coupon_number = r.coupon_number for update;
    if not found then
      insert into public.coupons (coupon_number, hall_record, status)
      values (r.coupon_number, coalesce(r.hall_record, '{}'::jsonb), coalesce(r.status, 'ACTIVE'))
      returning * into v_coupon;
      v_inserted := v_inserted + 1;
    elsif (r.hall_record is not null and r.hall_record <> v_coupon.hall_record)
       or (r.status is not null and r.status <> v_coupon.status) then
      if r.status = 'RETIRED' and exists (
        select 1 from public.coupon_claims where coupon_id = v_coupon.id and status = 'APPROVED'
      ) then
        raise exception 'coupon % has a verified holder; revoke the claim before retiring it', r.coupon_number
          using errcode = '22023';
      end if;
      update public.coupons
      set hall_record = coalesce(r.hall_record, hall_record), status = coalesce(r.status, status)
      where id = v_coupon.id;
      v_updated := v_updated + 1;
    end if;

    if r.claim_code is not null then
      if char_length(btrim(r.claim_code)) < 6 then
        raise exception 'claim codes must be at least 6 characters' using errcode = '22023';
      end if;
      select * into v_secret from public.coupon_claim_secrets where coupon_id = v_coupon.id;
      -- Same code as before: leave it (and its consumed state) alone.
      if not found or v_secret.code_hash <> public.hash_claim_code(v_secret.salt, r.claim_code) then
        v_salt := uuid_send(gen_random_uuid());
        insert into public.coupon_claim_secrets (coupon_id, salt, code_hash)
        values (v_coupon.id, v_salt, public.hash_claim_code(v_salt, r.claim_code))
        on conflict (coupon_id) do update
          set salt = excluded.salt, code_hash = excluded.code_hash, issued_at = now(),
              consumed_at = null, consumed_by_claim = null;
        v_codes := v_codes + 1;
      end if;
    end if;
  end loop;

  perform public.write_audit('COUPONS_IMPORTED', 'coupons', null, null,
    jsonb_build_object('rows', jsonb_array_length(p_rows), 'inserted', v_inserted,
                       'updated', v_updated, 'codes_set', v_codes));

  return jsonb_build_object('status', 'OK', 'inserted', v_inserted, 'updated', v_updated, 'codes_set', v_codes,
                            'notified', public.notify_register_changes());
end $$;

create or replace function public.admin_person(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
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
    'earlier_holders', public.earlier_holders(public.coupon_number_of(p_user_id)));
end $$;

grant execute on function public.my_history() to authenticated;
