-- Supabase-only setup. Each part runs only where its feature exists, so the
-- local database and the tests skip it.
--
-- 1. Storage bucket "avatars" for profile photos: anyone can view; a signed-in
--    user may write only inside their own folder (<user id>/...). 2 MB, images.
-- 2. The scheduler: pg_cron runs run_due_jobs() every 10 seconds (batch start
--    notices, seats whose time ran out, missed meals, rewards). The local app
--    does the same with a 5-second timer.

do $setup$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;

    if not exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'avatars_insert_own') then
      execute $p$create policy avatars_insert_own on storage.objects for insert to authenticated
        with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'avatars_update_own') then
      execute $p$create policy avatars_update_own on storage.objects for update to authenticated
        using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'avatars_delete_own') then
      execute $p$create policy avatars_delete_own on storage.objects for delete to authenticated
        using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    end if;
  end if;

  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron with schema pg_catalog';
    execute $c$select cron.schedule('dining-jobs', '10 seconds', 'select public.run_due_jobs()')$c$;
  end if;
end
$setup$;
