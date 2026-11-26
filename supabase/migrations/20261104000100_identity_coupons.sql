-- Phase 1 — identity, roles, official hall coupons, verified coupon claims,
-- policy settings, append-only audit log, admin alerts, idempotency keys.
--
-- Conventions used by every migration in this project:
--   * Clients never write tables directly. All mutations go through
--     SECURITY DEFINER functions that check the caller's role, lock the rows
--     they touch, and write an audit entry.
--   * Business outcomes ("coupon already claimed", "aisle not ready") are
--     returned as jsonb {status: ...}; exceptions are reserved for
--     authorization failures and malformed input, so that attempt logging
--     and alerts survive (an exception would roll them back).
--   * Timestamps are timestamptz from the server clock (stored UTC,
--     displayed in Asia/Dhaka by the client).

-- Supabase grants anon/authenticated broad default privileges on public
-- objects. Turn that off for everything this project creates; grants below
-- are explicit.
-- The built-in EXECUTE-to-PUBLIC on functions is a global default, which a
-- per-schema statement cannot remove, hence the first line.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- Declaration order is meaningful: role checks use `>=`.
create type public.app_role as enum ('STUDENT', 'ATTENDANT', 'ADMIN', 'SUPER_ADMIN');
create type public.coupon_status as enum ('ACTIVE', 'RETIRED');
create type public.claim_status as enum ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'REVOKED');
create type public.claim_method as enum ('HALL_CODE_MATCH', 'STAFF_APPROVAL');

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 200),
  role public.app_role not null default 'STUDENT',
  contact_preference text not null default 'IN_APP'
    check (contact_preference in ('IN_APP', 'WEB_PUSH', 'EMAIL')),
  -- Maintained by claim approval/revocation: true while the user holds an
  -- APPROVED coupon claim.
  is_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 200))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create function public.current_app_role() returns public.app_role
language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.profiles where id = auth.uid()
$$;

-- Raises unless the caller is signed in with at least p_min. Returns auth.uid().
create function public.require_role(p_min public.app_role) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select role into v_role from public.profiles where id = v_uid;
  if v_role is null or v_role < p_min then
    raise exception 'requires role % or higher', p_min using errcode = '42501';
  end if;
  return v_uid;
end $$;

-- ---------------------------------------------------------------------------
-- Policy settings (versioned, never edited in place)
-- ---------------------------------------------------------------------------

create table public.policy_settings (
  version integer primary key,
  settings jsonb not null,
  is_active boolean not null default false,
  note text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create unique index policy_settings_single_active on public.policy_settings (is_active) where is_active;

create function public.policy_settings_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'policy versions cannot be deleted' using errcode = '42501';
  end if;
  if new.version <> old.version or new.settings <> old.settings or new.created_at <> old.created_at then
    raise exception 'policy versions are immutable; publish a new version' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger policy_settings_guard
  before update or delete on public.policy_settings
  for each row execute function public.policy_settings_guard();

-- Defaults from spec §5 / §9. All of these are pilot values to be validated.
insert into public.policy_settings (version, settings, is_active, note) values (1, jsonb_build_object(
  'booking_lock_minutes_before_start', 30,
  'booking_open_minutes_before_start', 15,
  'cancellation_reminder_minutes_before_start', 3,
  'confirmed_arrival_window_minutes', 10,
  'unrecorded_reminder_minutes_after_start', 5,
  'headcount_grace_minutes', 2,
  'standby_readiness_poll_minutes_after_start', 7,
  'standby_response_seconds', 60,
  'travel_allowance_minutes', 6,
  'arrival_group_size', 5,
  'arrival_group_interval_minutes', 2,
  'admission_close_minutes_after_start', 30,
  'snapshot_validity_minutes', 5,
  'penalty_window_days', 30,
  'penalty_reminder_at', 1,
  'penalty_warning_at', 2,
  'penalty_priority_reduction_at', 3,
  'penalty_review_at', 4,
  'claim_max_failed_attempts_per_user_24h', 5,
  'claim_max_failed_attempts_per_coupon_24h', 10
), true, 'Initial defaults from master spec v1.0');

create function public.policy_int(p_key text) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select (settings ->> p_key)::integer from public.policy_settings where is_active
$$;

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid,                 -- null = system / scheduled job
  actor_role public.app_role,
  action text not null,
  subject_type text not null,
  subject_id text,
  before jsonb,
  after jsonb,
  reason text
);

create index audit_log_subject_idx on public.audit_log (subject_type, subject_id);
create index audit_log_occurred_idx on public.audit_log (occurred_at);

create function public.audit_log_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end $$;

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function public.audit_log_append_only();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.audit_log_append_only();

create function public.write_audit(
  p_action text, p_subject_type text, p_subject_id text,
  p_before jsonb, p_after jsonb, p_reason text default null
) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_log (actor_id, actor_role, action, subject_type, subject_id, before, after, reason)
  values (auth.uid(), public.current_app_role(), p_action, p_subject_type, p_subject_id, p_before, p_after, p_reason)
$$;

-- ---------------------------------------------------------------------------
-- Admin alerts (deduplicated)
-- ---------------------------------------------------------------------------

create table public.admin_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  dedup_key text not null unique,
  severity text not null default 'WARNING' check (severity in ('INFO', 'WARNING', 'CRITICAL')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'OPEN' check (status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.profiles (id)
);

-- Returns the new alert id, or null when an alert with this key already exists.
create function public.raise_admin_alert(
  p_kind text, p_dedup_key text, p_payload jsonb, p_severity text default 'WARNING'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  insert into public.admin_alerts (kind, dedup_key, payload, severity)
  values (p_kind, p_dedup_key, coalesce(p_payload, '{}'::jsonb), p_severity)
  on conflict (dedup_key) do nothing
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Idempotency keys
-- ---------------------------------------------------------------------------

create table public.idempotency_keys (
  key text primary key check (char_length(key) between 8 and 200),
  actor_id uuid,
  action text not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);

-- Serialises requests sharing a key and returns the stored response of an
-- earlier successful call, or null. Reusing a key for a different
-- action/actor is a client bug and raises.
create function public.idem_lookup(p_key text, p_action text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.idempotency_keys;
begin
  if p_key is null then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('idem:' || p_key, 0));
  select * into v_row from public.idempotency_keys where key = p_key;
  if not found then
    return null;
  end if;
  if v_row.action <> p_action or v_row.actor_id is distinct from auth.uid() then
    raise exception 'idempotency key was already used for a different request' using errcode = '22023';
  end if;
  return v_row.response || jsonb_build_object('replayed', true);
end $$;

create function public.idem_store(p_key text, p_action text, p_response jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_key is not null then
    insert into public.idempotency_keys (key, actor_id, action, response)
    values (p_key, auth.uid(), p_action, p_response);
  end if;
  return p_response;
end $$;

-- ---------------------------------------------------------------------------
-- Coupons and claims
-- ---------------------------------------------------------------------------

create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  coupon_number integer not null unique check (coupon_number between 1 and 999999),
  status public.coupon_status not null default 'ACTIVE',
  hall_record jsonb not null default '{}'::jsonb,   -- name/room etc. from the hall office
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.coupons_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'coupons are never deleted; retire them instead' using errcode = '42501';
  end if;
  if new.coupon_number <> old.coupon_number then
    raise exception 'official coupon numbers are immutable' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger coupons_guard
  before update or delete on public.coupons
  for each row execute function public.coupons_guard();

-- Hall-issued one-time verification code per coupon (e.g. printed on the
-- coupon card or handed out by the hall office). Only a salted hash is kept.
-- No client can read this table.
create table public.coupon_claim_secrets (
  coupon_id uuid primary key references public.coupons (id),
  salt bytea not null,
  code_hash bytea not null,
  issued_at timestamptz not null default now(),
  consumed_at timestamptz,
  consumed_by_claim uuid
);

create function public.hash_claim_code(p_salt bytea, p_code text) returns bytea
language sql immutable as $$
  select sha256(p_salt || convert_to(upper(btrim(p_code)), 'UTF8'))
$$;

create table public.coupon_claims (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons (id),
  user_id uuid not null references public.profiles (id),
  status public.claim_status not null default 'PENDING',
  method public.claim_method,
  evidence text check (char_length(evidence) <= 1000),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles (id),
  decision_reason text,
  effective_from timestamptz,
  effective_to timestamptz,
  constraint coupon_claims_approved_shape check (
    status <> 'APPROVED' or (method is not null and effective_from is not null and effective_to is null)
  ),
  constraint coupon_claims_revoked_shape check (
    status <> 'REVOKED' or (effective_from is not null and effective_to is not null)
  )
);

-- The core ownership invariants (spec §4.1, §12): one verified holder per
-- coupon, one verified coupon per student, one open request per student.
create unique index coupon_claims_one_owner_per_coupon
  on public.coupon_claims (coupon_id) where status = 'APPROVED';
create unique index coupon_claims_one_coupon_per_user
  on public.coupon_claims (user_id) where status = 'APPROVED';
create unique index coupon_claims_one_pending_per_user
  on public.coupon_claims (user_id) where status = 'PENDING';

create function public.coupon_claims_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'coupon claims are never deleted' using errcode = '42501';
  end if;
  if new.coupon_id <> old.coupon_id or new.user_id <> old.user_id or new.requested_at <> old.requested_at then
    raise exception 'claim identity columns are immutable' using errcode = '42501';
  end if;
  if old.status in ('REJECTED', 'WITHDRAWN', 'REVOKED') and new.status <> old.status then
    raise exception 'claim is final in status %', old.status using errcode = '42501';
  end if;
  return new;
end $$;

create trigger coupon_claims_guard
  before update or delete on public.coupon_claims
  for each row execute function public.coupon_claims_guard();

create table public.coupon_claim_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id),
  coupon_number integer,
  outcome text not null,
  failed boolean not null,
  attempted_at timestamptz not null default now()
);

create index coupon_claim_attempts_user_idx on public.coupon_claim_attempts (user_id, attempted_at);
create index coupon_claim_attempts_coupon_idx on public.coupon_claim_attempts (coupon_number, attempted_at);

-- The user's currently verified coupon, if any.
create function public.verified_coupon_id(p_user_id uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coupon_id from public.coupon_claims where user_id = p_user_id and status = 'APPROVED'
$$;

-- Student-facing: claim an official coupon. With the hall-issued code the
-- claim is approved immediately; without it the claim waits for an admin.
-- Knowing the coupon number alone never grants ownership.
create function public.request_coupon_claim(
  p_coupon_number integer, p_hall_code text default null, p_evidence text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_coupon public.coupons;
  v_claim public.coupon_claims;
  v_secret public.coupon_claim_secrets;
  v_claim_id uuid;
  v_failures integer;
begin
  select * into v_claim from public.coupon_claims where user_id = v_uid and status = 'APPROVED';
  if found then
    if v_claim.coupon_id = (select id from public.coupons where coupon_number = p_coupon_number) then
      return jsonb_build_object('status', 'ALREADY_APPROVED', 'claim_id', v_claim.id);
    end if;
    return jsonb_build_object('status', 'USER_ALREADY_HAS_COUPON');
  end if;

  select count(*) into v_failures from public.coupon_claim_attempts
  where user_id = v_uid and failed and attempted_at > now() - interval '24 hours';
  if v_failures >= public.policy_int('claim_max_failed_attempts_per_user_24h') then
    return jsonb_build_object('status', 'RATE_LIMITED');
  end if;

  -- Serialises all claim activity on this coupon.
  select * into v_coupon from public.coupons where coupon_number = p_coupon_number for update;
  if not found or v_coupon.status <> 'ACTIVE' then
    insert into public.coupon_claim_attempts (user_id, coupon_number, outcome, failed)
    values (v_uid, p_coupon_number, 'UNKNOWN_COUPON', true);
    return jsonb_build_object('status', 'UNKNOWN_COUPON');
  end if;

  if exists (select 1 from public.coupon_claims where coupon_id = v_coupon.id and status = 'APPROVED') then
    insert into public.coupon_claim_attempts (user_id, coupon_number, outcome, failed)
    values (v_uid, p_coupon_number, 'COUPON_ALREADY_CLAIMED', true);
    perform public.raise_admin_alert(
      'IDENTITY_CONFLICT',
      'claim-conflict:' || v_coupon.id || ':' || v_uid,
      jsonb_build_object('coupon_number', p_coupon_number, 'claimant_user_id', v_uid)
    );
    return jsonb_build_object('status', 'COUPON_ALREADY_CLAIMED');
  end if;

  if p_hall_code is not null then
    select * into v_secret from public.coupon_claim_secrets
    where coupon_id = v_coupon.id and consumed_at is null;

    if found and v_secret.code_hash = public.hash_claim_code(v_secret.salt, p_hall_code) then
      update public.coupon_claims
      set status = 'WITHDRAWN', decided_at = now(), decision_reason = 'Superseded by verified hall-code claim'
      where user_id = v_uid and status = 'PENDING';

      insert into public.coupon_claims (coupon_id, user_id, status, method, decided_at, effective_from)
      values (v_coupon.id, v_uid, 'APPROVED', 'HALL_CODE_MATCH', now(), now())
      returning id into v_claim_id;

      update public.coupon_claim_secrets
      set consumed_at = now(), consumed_by_claim = v_claim_id
      where coupon_id = v_coupon.id;

      update public.profiles set is_verified = true, updated_at = now() where id = v_uid;

      insert into public.coupon_claim_attempts (user_id, coupon_number, outcome, failed)
      values (v_uid, p_coupon_number, 'APPROVED', false);

      perform public.write_audit('COUPON_CLAIM_APPROVED', 'coupon_claim', v_claim_id::text, null,
        jsonb_build_object('coupon_number', p_coupon_number, 'user_id', v_uid, 'method', 'HALL_CODE_MATCH'));

      return jsonb_build_object('status', 'APPROVED', 'claim_id', v_claim_id, 'coupon_number', p_coupon_number);
    end if;

    insert into public.coupon_claim_attempts (user_id, coupon_number, outcome, failed)
    values (v_uid, p_coupon_number, 'INVALID_CODE', true);

    select count(*) into v_failures from public.coupon_claim_attempts
    where coupon_number = p_coupon_number and failed and attempted_at > now() - interval '24 hours';
    if v_failures >= public.policy_int('claim_max_failed_attempts_per_coupon_24h') then
      perform public.raise_admin_alert(
        'CLAIM_CODE_GUESSING',
        'claim-guessing:' || v_coupon.id || ':' || to_char(now() at time zone 'Asia/Dhaka', 'YYYY-MM-DD'),
        jsonb_build_object('coupon_number', p_coupon_number, 'failed_attempts_24h', v_failures)
      );
    end if;
    return jsonb_build_object('status', 'INVALID_CODE');
  end if;

  -- No code: queue for staff approval (idempotent per coupon).
  select * into v_claim from public.coupon_claims where user_id = v_uid and status = 'PENDING';
  if found then
    if v_claim.coupon_id = v_coupon.id then
      return jsonb_build_object('status', 'PENDING', 'claim_id', v_claim.id);
    end if;
    return jsonb_build_object('status', 'PENDING_CLAIM_EXISTS', 'claim_id', v_claim.id);
  end if;

  insert into public.coupon_claims (coupon_id, user_id, status, evidence)
  values (v_coupon.id, v_uid, 'PENDING', left(p_evidence, 1000))
  returning id into v_claim_id;

  perform public.write_audit('COUPON_CLAIM_REQUESTED', 'coupon_claim', v_claim_id::text, null,
    jsonb_build_object('coupon_number', p_coupon_number, 'user_id', v_uid));

  return jsonb_build_object('status', 'PENDING', 'claim_id', v_claim_id);
end $$;

create function public.withdraw_coupon_claim(p_claim_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_claim public.coupon_claims;
begin
  select * into v_claim from public.coupon_claims where id = p_claim_id and user_id = v_uid for update;
  if not found then
    raise exception 'claim not found' using errcode = 'P0002';
  end if;
  if v_claim.status <> 'PENDING' then
    return jsonb_build_object('status', 'NOT_PENDING', 'claim_status', v_claim.status);
  end if;
  update public.coupon_claims set status = 'WITHDRAWN', decided_at = now() where id = p_claim_id;
  perform public.write_audit('COUPON_CLAIM_WITHDRAWN', 'coupon_claim', p_claim_id::text,
    to_jsonb(v_claim), null);
  return jsonb_build_object('status', 'WITHDRAWN');
end $$;

create function public.approve_coupon_claim(p_claim_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_claim public.coupon_claims;
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

  perform 1 from public.coupons where id = v_claim.coupon_id for update;

  if exists (select 1 from public.coupon_claims where coupon_id = v_claim.coupon_id and status = 'APPROVED') then
    return jsonb_build_object('status', 'COUPON_ALREADY_CLAIMED');
  end if;
  if exists (select 1 from public.coupon_claims where user_id = v_claim.user_id and status = 'APPROVED') then
    return jsonb_build_object('status', 'USER_ALREADY_HAS_COUPON');
  end if;

  update public.coupon_claims
  set status = 'APPROVED', method = 'STAFF_APPROVAL', decided_at = now(), decided_by = v_uid,
      decision_reason = p_reason, effective_from = now()
  where id = p_claim_id;

  update public.coupon_claims
  set status = 'REJECTED', decided_at = now(), decided_by = v_uid,
      decision_reason = 'Coupon verified to another holder'
  where coupon_id = v_claim.coupon_id and status = 'PENDING';

  -- The hall code can no longer be used once ownership is settled.
  update public.coupon_claim_secrets
  set consumed_at = now(), consumed_by_claim = p_claim_id
  where coupon_id = v_claim.coupon_id and consumed_at is null;

  update public.profiles set is_verified = true, updated_at = now() where id = v_claim.user_id;

  perform public.write_audit('COUPON_CLAIM_APPROVED', 'coupon_claim', p_claim_id::text,
    to_jsonb(v_claim), jsonb_build_object('status', 'APPROVED', 'method', 'STAFF_APPROVAL'), p_reason);

  return jsonb_build_object('status', 'APPROVED', 'claim_id', p_claim_id);
end $$;

create function public.reject_coupon_claim(p_claim_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_claim public.coupon_claims;
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
  perform public.write_audit('COUPON_CLAIM_REJECTED', 'coupon_claim', p_claim_id::text,
    to_jsonb(v_claim), jsonb_build_object('status', 'REJECTED'), p_reason);
  return jsonb_build_object('status', 'REJECTED');
end $$;

-- Ends a holder's ownership (coupon reissued, student left the hall, ...).
-- History stays attached to the old claim, so penalties never follow the
-- coupon number to its next holder.
create function public.revoke_coupon_claim(p_claim_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_claim public.coupon_claims;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select * into v_claim from public.coupon_claims where id = p_claim_id for update;
  if not found then
    raise exception 'claim not found' using errcode = 'P0002';
  end if;
  if v_claim.status = 'REVOKED' then
    return jsonb_build_object('status', 'ALREADY_REVOKED');
  end if;
  if v_claim.status <> 'APPROVED' then
    return jsonb_build_object('status', 'NOT_APPROVED', 'claim_status', v_claim.status);
  end if;
  update public.coupon_claims
  set status = 'REVOKED', effective_to = now(), decided_by = v_uid, decision_reason = p_reason
  where id = p_claim_id;
  update public.profiles set is_verified = false, updated_at = now() where id = v_claim.user_id;
  perform public.write_audit('COUPON_CLAIM_REVOKED', 'coupon_claim', p_claim_id::text,
    to_jsonb(v_claim), jsonb_build_object('status', 'REVOKED'), p_reason);
  return jsonb_build_object('status', 'REVOKED');
end $$;

-- Super-admin import of the hall registry. p_rows is a JSON array of
-- {coupon_number, hall_record?, claim_code?, status?}. Re-running the same
-- file is a no-op; coupons are never deleted.
create function public.import_coupons(p_rows jsonb) returns jsonb
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

  return jsonb_build_object('status', 'OK', 'inserted', v_inserted, 'updated', v_updated, 'codes_set', v_codes);
end $$;

create function public.set_user_role(p_user_id uuid, p_role public.app_role, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('SUPER_ADMIN');
  v_profile public.profiles;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('set_user_role', 0));
  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if v_profile.role = p_role then
    return jsonb_build_object('status', 'UNCHANGED');
  end if;
  if v_profile.role = 'SUPER_ADMIN'
     and (select count(*) from public.profiles where role = 'SUPER_ADMIN') = 1 then
    return jsonb_build_object('status', 'LAST_SUPER_ADMIN');
  end if;
  update public.profiles set role = p_role, updated_at = now() where id = p_user_id;
  perform public.write_audit('USER_ROLE_CHANGED', 'profile', p_user_id::text,
    jsonb_build_object('role', v_profile.role), jsonb_build_object('role', p_role), p_reason);
  return jsonb_build_object('status', 'OK', 'role', p_role);
end $$;

create function public.acknowledge_admin_alert(p_alert_id uuid, p_resolve boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_alert public.admin_alerts;
begin
  select * into v_alert from public.admin_alerts where id = p_alert_id for update;
  if not found then
    raise exception 'alert not found' using errcode = 'P0002';
  end if;
  update public.admin_alerts
  set status = case when p_resolve then 'RESOLVED' else 'ACKNOWLEDGED' end,
      acknowledged_at = coalesce(acknowledged_at, now()),
      acknowledged_by = coalesce(acknowledged_by, v_uid)
  where id = p_alert_id;
  perform public.write_audit('ADMIN_ALERT_ACKNOWLEDGED', 'admin_alert', p_alert_id::text,
    jsonb_build_object('status', v_alert.status), jsonb_build_object('resolved', p_resolve));
  return jsonb_build_object('status', 'OK');
end $$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.policy_settings enable row level security;
alter table public.audit_log enable row level security;
alter table public.admin_alerts enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.coupons enable row level security;
alter table public.coupon_claim_secrets enable row level security;
alter table public.coupon_claims enable row level security;
alter table public.coupon_claim_attempts enable row level security;

create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.current_app_role() >= 'ATTENDANT');
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy policy_settings_select on public.policy_settings for select to authenticated using (true);

create policy audit_log_select on public.audit_log for select to authenticated
  using (public.current_app_role() >= 'ADMIN');

create policy admin_alerts_select on public.admin_alerts for select to authenticated
  using (public.current_app_role() >= 'ADMIN');

create policy coupons_select on public.coupons for select to authenticated
  using (
    public.current_app_role() >= 'ATTENDANT'
    or id = public.verified_coupon_id(auth.uid())
  );

create policy coupon_claims_select on public.coupon_claims for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() >= 'ADMIN');

create policy coupon_claim_attempts_select on public.coupon_claim_attempts for select to authenticated
  using (public.current_app_role() >= 'ADMIN');

-- coupon_claim_secrets and idempotency_keys: no policies, no grants.

grant select on public.profiles to authenticated;
grant update (full_name, contact_preference) on public.profiles to authenticated;
grant select on public.policy_settings, public.audit_log, public.admin_alerts,
  public.coupons, public.coupon_claims, public.coupon_claim_attempts to authenticated;

grant execute on function
  public.current_app_role(),
  public.verified_coupon_id(uuid),
  public.request_coupon_claim(integer, text, text),
  public.withdraw_coupon_claim(uuid),
  public.approve_coupon_claim(uuid, text),
  public.reject_coupon_claim(uuid, text),
  public.revoke_coupon_claim(uuid, text),
  public.import_coupons(jsonb),
  public.set_user_role(uuid, public.app_role, text),
  public.acknowledge_admin_alert(uuid, boolean)
to authenticated;
