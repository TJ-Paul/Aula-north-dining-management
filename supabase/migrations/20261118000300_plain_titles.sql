-- Plain notification titles (2026-11-18): no emoji at the start of a title ("🚪 Gate open" -> "Gate open").
-- One trigger instead of re-declaring every function that writes a title, so new notices are covered too.
-- BEFORE triggers run in name order: outbox_shorten (adds some titles) -> outbox_simple_title (this one)
-- -> outbox_skip_repeats (compares payloads, so it must see the cleaned title).

create or replace function public.outbox_simple_title() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.payload ? 'title' then
    new.payload := jsonb_set(new.payload, '{title}', to_jsonb(
      regexp_replace(new.payload ->> 'title', '^[←-⯿️‍\U0001F000-\U0001FAFF[:space:]]+', '')));
  end if;
  return new;
end $$;
revoke all on function public.outbox_simple_title() from public, anon, authenticated;

drop trigger if exists outbox_simple_title on public.notification_outbox;
create trigger outbox_simple_title before insert on public.notification_outbox
  for each row execute function public.outbox_simple_title();
