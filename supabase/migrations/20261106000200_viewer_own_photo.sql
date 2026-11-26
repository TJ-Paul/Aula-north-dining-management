-- The one thing a view-only account may change: its own profile photo.
--
-- set_my_photo() deliberately does not call require_role(): for a viewer that
-- would make the request read-only (20261106000100). It checks the caller
-- itself and can only ever write avatar_url on the caller's own row. Everyone
-- signed in uses it for their photo (the profile screen calls it).

create function public.set_my_photo(p_avatar_url text default null, p_clear boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_deleted timestamptz;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select deleted_at into v_deleted from public.profiles where id = v_uid;
  if not found or v_deleted is not null then
    raise exception 'this account was deleted' using errcode = '28000';
  end if;
  if not coalesce(p_clear, false)
     and (p_avatar_url is null or char_length(p_avatar_url) > 500 or p_avatar_url !~ '^(https://|/api/files/)') then
    raise exception 'not a photo address' using errcode = '22023';
  end if;

  update public.profiles
  set avatar_url = case when p_clear then null else p_avatar_url end, updated_at = now()
  where id = v_uid;
  return jsonb_build_object('status', 'OK');
end $$;

revoke all on function public.set_my_photo(text, boolean) from public, anon;
grant execute on function public.set_my_photo(text, boolean) to authenticated;

-- Live: viewers may put their photo in the avatars bucket again (their own folder only,
-- as for everyone: avatars_insert_own).
do $$
begin
  if exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'avatars_no_viewers') then
    execute 'drop policy avatars_no_viewers on storage.objects';
  end if;
end $$;
