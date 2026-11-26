-- The simpler app (2026-11-13): fewer screens, the same rules underneath.
--
-- 1. Notifications that arrived more than once:
--    * the push sender (/api/push) is woken once per inserted statement, so at "gate open" dozens of
--      copies ran at the same moment, each reading the same waiting rows before any marked them sent.
--      claim_push_batch() now hands each waiting row to exactly one sender (FOR UPDATE SKIP LOCKED);
--    * a booked student got both "your batch: gate open" and the general "gate open": the general one
--      now skips the students holding a seat in that batch;
--    * a repeat of the same broadcast (same person, kind and text within 10 minutes, e.g. a double tap
--      on Send, or saving a past meal three times) is dropped before it is stored.
-- 2. An improvement, feast or paron closes by itself 10 hours after its start if nobody closed it
--    (the live batch is closed without recording missed meals).
-- 3. meals_timeline(): the student Meals tab (last 7 days, today, the next 3 weeks), the same for
--    everyone, read through the cached /api/meals-live.
-- 4. Feedback replies: a mess manager answers a feedback; the answer and the message (never who sent
--    it) show to everyone on the Mess tab. Earlier internal notes stay private.
-- 5. Dev (SUPER_ADMIN): edit anyone's name, student ID, room, phone and photo.

-- ---------------------------------------------------------------------------
-- 1. Notifications
-- ---------------------------------------------------------------------------

create function public.claim_push_batch(p_limit integer default 500)
returns table (id uuid, kind text, payload jsonb, created_at timestamptz, recipient_id uuid)
language sql security definer set search_path = public, pg_temp as $$
  update public.notification_outbox o
  set status = 'SENT', sent_at = now(), attempts = o.attempts + 1
  where o.id in (select x.id from public.notification_outbox x
                 where x.status = 'PENDING'
                 order by x.created_at
                 limit least(greatest(coalesce(p_limit, 500), 1), 1000)
                 for update skip locked)
  returning o.id, o.kind, o.payload, o.created_at, o.recipient_id
$$;
revoke all on function public.claim_push_batch(integer) from public, anon, authenticated;
grant execute on function public.claim_push_batch(integer) to service_role;

create function public.outbox_skip_repeats() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.kind in ('MEAL_NEW', 'MEAL_EDITED', 'MEAL_CANCELLED', 'ANNOUNCEMENT', 'ADMIN_MESSAGE', 'BOOKING_OPEN',
                  'GATE_OPEN', 'BATCH_FULL', 'BATCH_STARTED')
     and exists (select 1 from public.notification_outbox o
                 where o.recipient_id = new.recipient_id and o.kind = new.kind
                   and o.created_at > now() - interval '10 minutes'
                   and (o.payload ->> 'message' is not distinct from new.payload ->> 'message'
                        or (new.kind = 'MEAL_EDITED' and o.payload ->> 'url' is not distinct from new.payload ->> 'url'))) then
    return null;
  end if;
  return new;
end $$;
create trigger outbox_skip_repeats before insert on public.notification_outbox
  for each row execute function public.outbox_skip_repeats();

-- Gate open: booked students come now; Lucky? students come and wait outside. Everyone else gets
-- the general notice; a seat holder only gets their own.
create or replace function public.batch_start_notices(p_b public.meal_batches) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.batch_seats;
begin
  for s in select * from public.batch_seats where batch_id = p_b.id and state = 'HOLDING' and user_id is not null loop
    perform public.enqueue_notification(s.user_id, 'BATCH_STARTED', 'batch-start:' || s.id,
      jsonb_build_object('message', case when s.kind = 'LUCKY'
        then 'Batch ' || p_b.number || ' gate is open. You are Lucky?: come and wait outside the gate with coupon '
          || s.coupon_number || '. You go in after the booked students.'
        else 'Batch ' || p_b.number || ' gate is open. Come to the dining hall now and give coupon '
          || s.coupon_number || ' at the door. Your timer has started.' end));
  end loop;
  insert into public.notification_outbox (recipient_id, kind, event_key, payload)
  select p.id, 'GATE_OPEN', 'gate-open:' || p_b.id || ':' || p.id,
         jsonb_build_object('message',
           (select public.meal_notice_label(ms) from public.meal_services ms where ms.id = p_b.meal_service_id)
             || ': batch ' || p_b.number || ' gate is open. Booked students, come now.', 'url', '/me')
  from public.profiles p
  where p.deleted_at is null and p.role::text <> 'VIEWER'
    and not exists (select 1 from public.batch_seats bs
                    where bs.batch_id = p_b.id and bs.user_id = p.id and bs.state = 'HOLDING')
  on conflict (event_key) do nothing;
  update public.meal_batches set start_notified_at = now() where id = p_b.id;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Events close by themselves 10 hours after their start
-- ---------------------------------------------------------------------------

create function public.auto_close_events() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ms public.meal_services;
  b public.meal_batches;
  v_n integer := 0;
begin
  for v_ms in
    select * from public.meal_services
    where state in ('SCHEDULED', 'IN_SERVICE') and service_start_at < now() - interval '10 hours'
      and public.meal_is_special(meal_type, occasion)
    for update skip locked
  loop
    -- No missed meals: nobody pressed "Filled" (spec 1.3), so the open batch just ends.
    for b in select * from public.meal_batches where meal_service_id = v_ms.id and loaded_at is null for update loop
      perform public.close_batch(b, false, false);
    end loop;
    update public.meal_services set state = 'CLOSED', state_changed_at = now() where id = v_ms.id;
    perform public.write_audit('MEAL_SERVICE_STATE_CHANGED', 'meal_service', v_ms.id::text,
      jsonb_build_object('state', v_ms.state), jsonb_build_object('state', 'CLOSED'), 'Closed by itself 10 hours after the start');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.auto_close_events() from public, anon, authenticated;

create or replace function public.run_due_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.run_admission_jobs() || public.process_no_shows()
         || jsonb_build_object('rewards_given', public.settle_rsvps())
         || public.run_batch_jobs()
         || jsonb_build_object('events_closed', public.auto_close_events());
end $$;

-- ---------------------------------------------------------------------------
-- 3. The Meals tab
-- ---------------------------------------------------------------------------

create function public.meals_timeline() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'meals', coalesce((select jsonb_agg(public.meal_brief(m) order by m.service_start_at)
                       from public.meal_services m
                       where m.service_start_at between now() - interval '7 days' and now() + interval '21 days'), '[]'::jsonb),
    'as_of', now())
$$;
revoke all on function public.meals_timeline() from public, anon, authenticated;
grant execute on function public.meals_timeline() to service_role;

-- ---------------------------------------------------------------------------
-- 4. Feedback replies
-- ---------------------------------------------------------------------------

alter table public.feedback add column reply_public boolean not null default false;

create function public.reply_feedback(p_feedback_id uuid, p_reply text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_reply text := btrim(coalesce(p_reply, ''));
begin
  if char_length(v_reply) not between 1 and 1000 then
    return jsonb_build_object('status', 'INVALID_REPLY');
  end if;
  update public.feedback
  set admin_note = v_reply, reply_public = true, status = 'RESOLVED', handled_by = v_uid, handled_at = now()
  where id = p_feedback_id;
  if not found then
    raise exception 'feedback not found' using errcode = 'P0002';
  end if;
  perform public.write_audit('FEEDBACK_REPLIED', 'feedback', p_feedback_id::text, null, null);
  return jsonb_build_object('status', 'OK');
end $$;
revoke all on function public.reply_feedback(uuid, text) from public, anon;
grant execute on function public.reply_feedback(uuid, text) to authenticated;

-- The managers' list says which notes are public replies.
create or replace function public.list_feedback(p_mess_month_id uuid default null, p_include_resolved boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', f.id, 'kind', f.kind, 'body', f.body, 'created_on', f.created_on, 'status', f.status,
      'admin_note', f.admin_note, 'reply_public', f.reply_public, 'handled_by', p.full_name, 'handled_at', f.handled_at,
      'event', case when m.id is null then null else jsonb_build_object(
        'id', m.id, 'name', m.name, 'meal_type', m.meal_type, 'occasion', m.occasion, 'service_start_at', m.service_start_at) end)
      order by (f.status = 'RESOLVED'), f.created_on desc, f.id)
    from public.feedback f
    left join public.meal_services m on m.id = f.meal_service_id
    left join public.profiles p on p.id = f.handled_by
    where (p_mess_month_id is null or f.mess_month_id = p_mess_month_id)
      and (p_include_resolved or f.status <> 'RESOLVED')
  ), '[]'::jsonb);
end $$;

-- Answered feedback, for everyone: the message and the answer, never the sender.
create function public.feedback_replies(p_limit integer default 20) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'body', f.body, 'reply', f.admin_note,
                                               'created_on', f.created_on, 'replied_at', f.handled_at)
                            order by f.handled_at desc), '[]'::jsonb)
  from (select * from public.feedback where reply_public and admin_note is not null
        order by handled_at desc limit least(greatest(coalesce(p_limit, 20), 1), 100)) f,
       (select public.require_role('VIEWER')) u
$$;
revoke all on function public.feedback_replies(integer) from public, anon;
grant execute on function public.feedback_replies(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Dev (SUPER_ADMIN) edits anyone's details
-- ---------------------------------------------------------------------------

create function public.dev_update_person(
  p_user_id uuid, p_name text, p_student_id text, p_room text, p_phone text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('SUPER_ADMIN');
  v_old public.profiles;
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_sid text := nullif(btrim(coalesce(p_student_id, '')), '');
  v_room text := nullif(btrim(coalesce(p_room, '')), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
begin
  select * into v_old from public.profiles where id = p_user_id and deleted_at is null for update;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  if char_length(v_name) not between 2 and 80 then
    return jsonb_build_object('status', 'INVALID_NAME');
  end if;
  if v_sid is not null then
    v_sid := public.normalize_student_id(v_sid);
    if v_sid is null then
      return jsonb_build_object('status', 'INVALID_STUDENT_ID');
    end if;
    if exists (select 1 from public.profiles where student_id = v_sid and id <> p_user_id) then
      return jsonb_build_object('status', 'STUDENT_ID_TAKEN');
    end if;
  end if;
  if v_room is not null and char_length(v_room) > 20 then
    return jsonb_build_object('status', 'INVALID_ROOM');
  end if;
  if v_phone is not null then
    if v_phone ~ '^8801' then v_phone := substr(v_phone, 3); end if;
    if v_phone !~ '^01[3-9][0-9]{8}$' then
      return jsonb_build_object('status', 'INVALID_PHONE');
    end if;
  end if;

  update public.profiles
  set full_name = v_name, student_id = v_sid, room = v_room, notify_phone = v_phone, updated_at = now()
  where id = p_user_id;
  update public.name_change_requests set status = 'WITHDRAWN', decided_at = now()
  where user_id = p_user_id and status = 'PENDING' and v_name is distinct from v_old.full_name;
  perform public.write_audit('DEV_PROFILE_EDITED', 'profile', p_user_id::text,
    jsonb_build_object('name', v_old.full_name, 'student_id', v_old.student_id, 'room', v_old.room, 'phone', v_old.notify_phone),
    jsonb_build_object('name', v_name, 'student_id', v_sid, 'room', v_room, 'phone', v_phone));
  return jsonb_build_object('status', 'OK');
end $$;
revoke all on function public.dev_update_person(uuid, text, text, text, text) from public, anon;
grant execute on function public.dev_update_person(uuid, text, text, text, text) to authenticated;

create function public.dev_set_photo(p_user_id uuid, p_avatar_url text default null, p_clear boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('SUPER_ADMIN');
begin
  if not coalesce(p_clear, false)
     and (p_avatar_url is null or char_length(p_avatar_url) > 500 or p_avatar_url !~ '^(https://|/api/files/)') then
    raise exception 'not a photo address' using errcode = '22023';
  end if;
  update public.profiles set avatar_url = case when p_clear then null else p_avatar_url end, updated_at = now()
  where id = p_user_id and deleted_at is null;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;
  perform public.write_audit('DEV_PHOTO_SET', 'profile', p_user_id::text, null, jsonb_build_object('cleared', coalesce(p_clear, false)));
  return jsonb_build_object('status', 'OK');
end $$;
revoke all on function public.dev_set_photo(uuid, text, boolean) from public, anon;
grant execute on function public.dev_set_photo(uuid, text, boolean) to authenticated;
