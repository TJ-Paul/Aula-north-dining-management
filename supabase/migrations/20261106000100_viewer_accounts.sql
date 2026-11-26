-- View-only accounts (for professors and visitors to look around).
--
-- A VIEWER sees every screen a super admin sees, but can change nothing. Rather
-- than editing the hundred-odd functions one by one, the role check itself
-- does it: when the caller is a viewer, require_role() and current_app_role()
-- let them through for reading AND switch the whole request (one transaction)
-- to read-only. Postgres then refuses any insert, update or delete in that
-- request, whichever function tries it. Every callable function either calls
-- require_role() before writing or is STABLE (cannot write at all); a test
-- in tests/db/viewer.test.ts keeps it that way.
--
-- VIEWER sorts below STUDENT, so any plain `role >= ...` comparison on the
-- table never treats a viewer as staff.

alter type public.app_role add value if not exists 'VIEWER' before 'STUDENT';

-- (The new value cannot be used as an enum literal in this same transaction,
-- so the functions below compare it as text.)

create or replace function public.current_app_role() returns public.app_role
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_role public.app_role;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role::text = 'VIEWER' then
    perform set_config('transaction_read_only', 'on', true);
    return 'SUPER_ADMIN';
  end if;
  return v_role;
end $$;

-- As in 20261105002200 (deleted accounts refused), plus viewers.
-- Raises unless the caller is signed in with at least p_min. Returns auth.uid().
-- A viewer passes any check, and the rest of the request becomes read-only.
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
  if v_role::text = 'VIEWER' then
    perform set_config('transaction_read_only', 'on', true);
    return v_uid;
  end if;
  if v_role is null or v_role < p_min then
    raise exception 'requires role % or higher', p_min using errcode = '42501';
  end if;
  return v_uid;
end $$;

-- Live only: a viewer cannot put files in the photo bucket either.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'objects') then
    if not exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'avatars_no_viewers') then
      execute $p$create policy avatars_no_viewers on storage.objects as restrictive for insert to authenticated
        with check (not exists (select 1 from public.profiles where id = auth.uid() and role::text = 'VIEWER'))$p$;
    end if;
  end if;
end $$;
