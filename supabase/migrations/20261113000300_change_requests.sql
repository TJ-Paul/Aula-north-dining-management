-- Name, student ID and coupon number change only after a mess manager or dev verifies it;
-- phone and room change at once (set_my_phone, update_my_profile).
--
-- * Student ID changes get the same request → verify flow as name changes (student_id_requests).
-- * Every change request (name, student ID, coupon number) notifies all mess managers and devs, who
--   verify it on the Claims page (or in the bell).
-- * A mess manager can't verify their own request; a dev can.

create table public.student_id_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  old_student_id text,
  new_student_id text not null check (new_student_id = public.normalize_student_id(new_student_id)),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles (id)
);
create unique index student_id_one_pending on public.student_id_requests (user_id) where status = 'PENDING';
alter table public.student_id_requests enable row level security;

-- One notice to every mess manager and dev (not view-only accounts).
create function public.notify_managers(p_key text, p_message text, p_url text default '/admin/claims') returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.notification_outbox (recipient_id, kind, event_key, payload)
  select p.id, 'CHANGE_REQUEST', p_key || ':' || p.id, jsonb_build_object('message', p_message, 'url', p_url)
  from public.profiles p
  where p.deleted_at is null and p.role::text in ('ADMIN', 'SUPER_ADMIN')
  on conflict (event_key) do nothing
$$;
revoke all on function public.notify_managers(text, text, text) from public, anon, authenticated;

create function public.who_label(p_user_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(nullif(p.full_name, ''), 'A student')
         || coalesce(' (coupon ' || public.coupon_number_of(p.id) || ')', '')
  from public.profiles p where p.id = p_user_id
$$;
revoke all on function public.who_label(uuid) from public, anon, authenticated;

create function public.request_student_id_change(p_student_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_new text := public.normalize_student_id(p_student_id);
  v_old text;
  v_id uuid;
begin
  if v_new is null then
    return jsonb_build_object('status', 'INVALID_STUDENT_ID');
  end if;
  select student_id into v_old from public.profiles where id = v_uid;
  update public.student_id_requests set status = 'WITHDRAWN', decided_at = now()
  where user_id = v_uid and status = 'PENDING';
  if v_old is not null and v_old = v_new then
    return jsonb_build_object('status', 'SAME_STUDENT_ID');
  end if;
  if exists (select 1 from public.profiles where student_id = v_new and id <> v_uid and deleted_at is null) then
    return jsonb_build_object('status', 'STUDENT_ID_TAKEN');
  end if;
  insert into public.student_id_requests (user_id, old_student_id, new_student_id) values (v_uid, v_old, v_new)
  returning id into v_id;
  perform public.write_audit('STUDENT_ID_CHANGE_REQUESTED', 'profile', v_uid::text,
    jsonb_build_object('student_id', v_old), jsonb_build_object('student_id', v_new));
  perform public.notify_managers('sid-request:' || v_id,
    public.who_label(v_uid) || ' asks to change student ID ' || coalesce(v_old, '(none)') || ' → ' || v_new || '. Please verify.');
  return jsonb_build_object('status', 'SENT', 'request_id', v_id);
end $$;

create function public.cancel_student_id_change() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
begin
  update public.student_id_requests set status = 'WITHDRAWN', decided_at = now()
  where user_id = v_uid and status = 'PENDING';
  return jsonb_build_object('status', 'OK');
end $$;

create function public.admin_student_id_requests() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'request_id', r.id, 'user_id', r.user_id, 'name', p.full_name, 'old_student_id', r.old_student_id,
      'new_student_id', r.new_student_id, 'requested_at', r.requested_at, 'coupon_number', public.coupon_number_of(r.user_id),
      'register_student_id', (select public.normalize_student_id(k.hall_record ->> 'student_id')
                              from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
                              where c.user_id = r.user_id and c.status = 'APPROVED'),
      'avatar_url', p.avatar_url) order by r.requested_at)
    from public.student_id_requests r join public.profiles p on p.id = r.user_id
    where r.status = 'PENDING'), '[]'::jsonb);
end $$;

create function public.decide_student_id_change(p_request_id uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_r public.student_id_requests;
begin
  select * into v_r from public.student_id_requests where id = p_request_id for update;
  if v_r.id is null then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_r.status <> 'PENDING' then
    return jsonb_build_object('status', 'ALREADY_DECIDED');
  end if;
  if v_r.user_id = v_uid and public.current_app_role() <> 'SUPER_ADMIN' then
    return jsonb_build_object('status', 'OWN_REQUEST');
  end if;
  if p_approve and exists (select 1 from public.profiles where student_id = v_r.new_student_id and id <> v_r.user_id and deleted_at is null) then
    return jsonb_build_object('status', 'STUDENT_ID_TAKEN');
  end if;
  update public.student_id_requests
  set status = case when p_approve then 'APPROVED' else 'REJECTED' end, decided_at = now(), decided_by = v_uid
  where id = v_r.id;
  if p_approve then
    update public.profiles set student_id = v_r.new_student_id, updated_at = now() where id = v_r.user_id;
  end if;
  perform public.enqueue_notification(v_r.user_id, 'NAME_CHANGE', 'sid-change:' || v_r.id,
    jsonb_build_object('message', case when p_approve then 'Your student ID is now ' || v_r.new_student_id || '.'
                                       else 'Your student ID change to ' || v_r.new_student_id || ' was not approved.' end,
                       'url', '/me/profile'));
  perform public.write_audit(case when p_approve then 'STUDENT_ID_CHANGE_APPROVED' else 'STUDENT_ID_CHANGE_REJECTED' end,
    'profile', v_r.user_id::text, jsonb_build_object('student_id', v_r.old_student_id), jsonb_build_object('student_id', v_r.new_student_id));
  return jsonb_build_object('status', case when p_approve then 'APPROVED' else 'REJECTED' end);
end $$;

-- A mess manager can't approve their own name change either (a dev can).
create or replace function public.decide_name_change(p_request_id uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_r public.name_change_requests;
begin
  select * into v_r from public.name_change_requests where id = p_request_id for update;
  if v_r.id is null then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_r.status <> 'PENDING' then
    return jsonb_build_object('status', 'ALREADY_DECIDED');
  end if;
  if v_r.user_id = v_uid and public.current_app_role() <> 'SUPER_ADMIN' then
    return jsonb_build_object('status', 'OWN_REQUEST');
  end if;
  update public.name_change_requests
  set status = case when p_approve then 'APPROVED' else 'REJECTED' end, decided_at = now(), decided_by = v_uid
  where id = v_r.id;
  if p_approve then
    update public.profiles set full_name = v_r.new_name, updated_at = now() where id = v_r.user_id;
  end if;
  perform public.enqueue_notification(v_r.user_id, 'NAME_CHANGE', 'name-change:' || v_r.id,
    jsonb_build_object('message', case when p_approve then 'Your name is now ' || v_r.new_name || '.'
                                       else 'Your name change to ' || v_r.new_name || ' was not approved.' end));
  perform public.write_audit(case when p_approve then 'NAME_CHANGE_APPROVED' else 'NAME_CHANGE_REJECTED' end,
    'profile', v_r.user_id::text, jsonb_build_object('name', v_r.old_name), jsonb_build_object('name', v_r.new_name));
  return jsonb_build_object('status', case when p_approve then 'APPROVED' else 'REJECTED' end);
end $$;

-- Managers hear about every name change and coupon change request.
create function public.change_request_notice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'name_change_requests' then
    perform public.notify_managers('name-request:' || new.id,
      public.who_label(new.user_id) || ' asks to change their name to ' || new.new_name || '. Please verify.');
  elsif new.kind::text = 'CHANGE' and new.status::text = 'PENDING' then
    perform public.notify_managers('coupon-request:' || new.id,
      public.who_label(new.user_id) || ' asks to change to coupon '
        || (select coupon_number from public.coupons where id = new.coupon_id) || '. Please verify.');
  end if;
  return null;
end $$;
create trigger name_request_notice after insert on public.name_change_requests
  for each row execute function public.change_request_notice();
create trigger coupon_change_notice after insert on public.coupon_claims
  for each row execute function public.change_request_notice();

-- The student's own extras: walk-in count and any name or student ID change waiting.
create or replace function public.my_extras() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'walk_ins', public.walk_in_count(u.id),
    'name_request', (select jsonb_build_object('id', r.id, 'new_name', r.new_name, 'requested_at', r.requested_at)
                     from public.name_change_requests r where r.user_id = u.id and r.status = 'PENDING'),
    'student_id_request', (select jsonb_build_object('id', r.id, 'new_student_id', r.new_student_id, 'requested_at', r.requested_at)
                           from public.student_id_requests r where r.user_id = u.id and r.status = 'PENDING'))
  from (select public.require_role('STUDENT') as id) u
$$;

revoke all on function public.request_student_id_change(text), public.cancel_student_id_change(),
  public.admin_student_id_requests(), public.decide_student_id_change(uuid, boolean), public.change_request_notice()
  from public, anon;
grant execute on function public.request_student_id_change(text), public.cancel_student_id_change(),
  public.admin_student_id_requests(), public.decide_student_id_change(uuid, boolean) to authenticated;
