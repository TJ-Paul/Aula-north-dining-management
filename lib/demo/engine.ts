'use client';

import { BASE } from '@/lib/base';

// The whole backend, inside the visitor's browser. The real database (the same SQL migrations the
// live app runs on Supabase) runs in PGlite, Postgres compiled to WebAssembly, loaded from
// public/pglite. Its data is a made-up copy (public/demo/aula-demo.tar.gz, built from anonymised
// data) and is kept in this browser's IndexedDB, so a visitor's changes stay until they reset.
// Nothing is sent anywhere.

/* eslint-disable @typescript-eslint/no-explicit-any */
type PG = {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
};

type Engine = { pg: PG; callable: Map<string, boolean>; queue: Promise<unknown> };

const DB_PREFIX = 'aula-demo-';
const USER_KEY = 'aula-demo-user';
const JOB_INTERVAL_MS = 5000;

let engine: Promise<Engine> | null = null;
let progress: (msg: string) => void = () => undefined;

/** Called by the loading screen to show what is happening on the first visit. */
export function onProgress(fn: (msg: string) => void) { progress = fn; }

// The bundler must leave this import alone: it is a plain file served next to the site.
const importUrl = new Function('u', 'return import(u)') as (u: string) => Promise<any>;

async function idbNames(): Promise<string[]> {
  try { return ((await indexedDB.databases?.()) ?? []).map((d) => d.name ?? ''); } catch { return []; }
}
function deleteIdb(name: string) {
  return new Promise<void>((done) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = r.onerror = r.onblocked = () => done();
  });
}

async function open(): Promise<Engine> {
  progress('Starting the database…');
  const version = (await fetch(`${BASE}/demo/version.txt`, { cache: 'no-cache' }).then((r) => r.text()).catch(() => 'v')).trim();
  const name = `${DB_PREFIX}${version.replace(/[^A-Za-z0-9]/g, '')}`;
  const loadedKey = `aula-demo-loaded:${name}`;
  // Older demo data from an earlier version of the site: drop it.
  for (const n of await idbNames()) if (n.startsWith(`/pglite/${DB_PREFIX}`) && n !== `/pglite/${name}`) await deleteIdb(n);

  const { PGlite } = await importUrl(`${location.origin}${BASE}/pglite/index.js`);
  let fresh = false;
  try { fresh = localStorage.getItem(loadedKey) !== '1'; } catch { fresh = true; }
  let pg: PG | null = null;
  if (!fresh) {
    // Every change is saved to IndexedDB before the call returns (no relaxed durability), so a
    // page load right after a press never loses it.
    pg = await PGlite.create({ dataDir: `idb://${name}` });
    const ok = await pg!.query(`select to_regclass('local.demo_meta') is not null as ok`).then((r) => (r.rows[0] as { ok: boolean }).ok, () => false);
    if (!ok) { await pg!.close().catch(() => undefined); pg = null; }   // an unfinished first load: start again
  }
  if (!pg) {
    await deleteIdb(`/pglite/${name}`);
    progress('Downloading the demo data (about 8 MB, first visit only)…');
    const blob = await (await fetch(`${BASE}/demo/aula-demo.tar.gz`)).blob();
    progress('Opening the demo data…');
    pg = (await PGlite.create({ dataDir: `idb://${name}`, loadDataDir: blob })) as PG;
    await pg.query('select count(*) from local.demo_meta');
    try { localStorage.setItem(loadedKey, '1'); } catch { /* private mode */ }
  }

  // The data was made on one day; move every date so that day is today (meals keep their times).
  const { rows: [{ diff }] } = await pg.query<{ diff: number }>(
    `select (public.dhaka_today() - (select value::date from local.demo_meta where key = 'base_day'))::int as diff`);
  if (diff) {
    progress('Bringing the dates up to today…');
    await pg.query('select local.demo_shift_days($1)', [diff]);
    await pg.query(`update local.demo_meta set value = public.dhaka_today()::text where key = 'base_day'`);
  }

  const { rows } = await pg.query<{ proname: string; proretset: boolean }>(
    `select p.proname, p.proretset from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')`);
  const e: Engine = { pg, callable: new Map(rows.map((r) => [r.proname, r.proretset])), queue: Promise.resolve() };

  // The scheduler (pg_cron in production): closes meals, opens batches when due. No SMS or push here.
  setInterval(() => {
    exclusive(async ({ pg: p }) => {
      await p.query('select public.run_due_jobs()');
      await p.query(`update public.notification_outbox set status = 'SENT', sent_at = now() where status = 'PENDING'`);
    }).catch((err) => console.warn('[demo jobs]', err));
  }, JOB_INTERVAL_MS);
  return e;
}

export function ready(): Promise<Engine> {
  if (!engine) {
    engine = open();
    engine.catch(() => { engine = null; });
  }
  return engine;
}

/** Runs `fn` with the database, one caller at a time (PGlite is a single connection). */
async function exclusive<T>(fn: (e: Engine) => Promise<T>): Promise<T> {
  const e = await ready();
  const run = () => fn(e);
  const result = e.queue.then(run, run);
  e.queue = result.catch(() => undefined);
  return result;
}

async function asUser<T>(pg: PG, userId: string, fn: () => Promise<T>): Promise<T> {
  await pg.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
  await pg.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await pg.exec('reset role');
    await pg.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

const argList = (args: Record<string, unknown>) => Object.keys(args).map((n, i) => `${n} => $${i + 1}`).join(', ');

async function call(pg: PG, userId: string, fn: string, args: Record<string, unknown> = {}) {
  return asUser(pg, userId, async () =>
    (await pg.query<{ r: unknown }>(`select public.${fn}(${argList(args)}) as r`, Object.values(args))).rows[0].r);
}

// ---------------------------------------------------------------------------
// Who is "signed in" (the visitor picks Student or Mess manager)
// ---------------------------------------------------------------------------

export function currentUser(): string | null {
  try { return localStorage.getItem(USER_KEY); } catch { return null; }
}
export function setCurrentUser(id: string | null) {
  try { if (id) localStorage.setItem(USER_KEY, id); else localStorage.removeItem(USER_KEY); } catch { /* private mode */ }
}

/** The two accounts a visitor can use. */
export async function demoAccounts() {
  return exclusive(async ({ pg }) => {
    const { rows } = await pg.query<{ key: string; value: string }>(`select key, value from local.demo_meta where key in ('student', 'manager')`);
    const ids = Object.fromEntries(rows.map((r) => [r.key, r.value])) as { student: string; manager: string };
    const { rows: people } = await pg.query<{ id: string; full_name: string }>(
      'select id, full_name from public.profiles where id = any($1::uuid[])', [[ids.student, ids.manager]]);
    const nameOf = (id: string) => people.find((p) => p.id === id)?.full_name ?? '';
    return { student: { id: ids.student, name: nameOf(ids.student) }, manager: { id: ids.manager, name: nameOf(ids.manager) } };
  });
}

// ---------------------------------------------------------------------------
// What the screens call
// ---------------------------------------------------------------------------

/** One SQL function as the signed-in visitor, only if signed-in users may call it (as Supabase does). */
export function demoRpc(userId: string, fn: string, args: Record<string, unknown>) {
  return exclusive(async ({ pg, callable }) => {
    if (!/^[a-z_]+$/.test(fn) || !callable.has(fn)) throw new Error(`permission denied for function ${fn}`);
    if (!callable.get(fn)) return call(pg, userId, fn, args);
    return asUser(pg, userId, async () => (await pg.query(`select * from public.${fn}(${argList(args)})`, Object.values(args))).rows);
  });
}

/** The answers that are the same for everyone (live: cached server routes, service role). */
export function demoShared(fn: 'meal_live_state' | 'meals_timeline', args: Record<string, unknown>) {
  return exclusive(async ({ pg }) => (await pg.query<{ r: unknown }>(`select public.${fn}(${argList(args)}) as r`, Object.values(args))).rows[0].r);
}

/** Forgets everything this visitor changed: the next page load starts from the original demo data. */
export async function resetDemo() {
  const e = await engine?.catch(() => null);
  await e?.queue.catch(() => undefined);
  await e?.pg.close().catch(() => undefined);
  engine = null;
  for (const n of await idbNames()) if (n.startsWith(`/pglite/${DB_PREFIX}`)) await deleteIdb(n);
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('aula-demo-loaded:') || k.startsWith('aula-c:') || k === 'aula-session-v1')) localStorage.removeItem(k);
    }
  } catch { /* private mode */ }
  try { await caches.delete('aula-demo-files'); } catch { /* no Cache API */ }
}

// ---------------------------------------------------------------------------
// Demo tools for managers: run a whole feast in a few minutes, simulate a crowd
// ---------------------------------------------------------------------------

async function currentMeal(pg: PG) {
  const { rows } = await pg.query<{ id: string }>(
    `select id from public.meal_services where state in ('SCHEDULED','IN_SERVICE')
     order by policy_version = 100 desc, service_start_at <= now() + interval '30 minutes' desc, state = 'IN_SERVICE' desc, service_start_at limit 1`);
  return rows[0]?.id;
}

const jobs = async (pg: PG) => (await pg.query<{ r: unknown }>('select public.run_due_jobs() as r')).rows[0].r;

async function ensureShortTimings(pg: PG) {
  await pg.query(
    `insert into public.policy_settings (version, settings, is_active, note)
     select 100, settings || $1::jsonb, false, 'Demo: short timings' from public.policy_settings where is_active
     on conflict (version) do nothing`,
    [JSON.stringify({
      booking_lock_minutes_before_start: 6, booking_open_minutes_before_start: 5,
      standby_promotion_cutoff_minutes_before_start: 1, confirmed_arrival_window_minutes: 3,
      standby_response_seconds: 45, travel_allowance_minutes: 1, arrival_group_size: 5,
      arrival_group_interval_minutes: 1, admission_close_minutes_after_start: 20, snapshot_validity_minutes: 3,
      no_show_grace_minutes: 2,
    })]);
}

async function newFeast(pg: PG, actor: string, startInMinutes: number) {
  await ensureShortTimings(pg);
  // Tonight's dinner (and any earlier demo feast) makes way, so the feast shows on today's screens:
  // they move to dates far in the future, where no screen looks.
  await pg.exec(`set session_replication_role = replica;
    do $$ declare r record; k integer; begin
      for r in select id, service_date from public.meal_services
               where (policy_version = 100 and state in ('SCHEDULED','IN_SERVICE'))
                  or (service_date = public.dhaka_today() and meal_type = 'DINNER' and state <> 'CANCELLED')
      loop
        k := ('2099-01-01'::date - r.service_date) + (select count(*)::int from public.meal_services where service_date >= '2099-01-01');
        update public.meal_services set service_date = service_date + k, service_start_at = service_start_at + make_interval(days => k),
          service_end_at = service_end_at + make_interval(days => k), state = case when policy_version = 100 then 'CLOSED' else state end
        where id = r.id;
      end loop;
    end $$;
    set session_replication_role = origin;`);
  const start = new Date(Date.now() + startInMinutes * 60_000);
  const { rows: [{ d }] } = await pg.query<{ d: string }>(`select to_char(public.dhaka_today(), 'YYYY-MM-DD') as d`);
  const r = (await call(pg, actor, 'create_meal_service', {
    p_service_date: d, p_meal_type: 'DINNER', p_service_start_at: start.toISOString(), p_policy_version: 100,
  })) as { meal_service_id: string };
  if (!r.meal_service_id) throw new Error('The demo feast could not be made.');
  await call(pg, actor, 'set_meal_details', {
    p_meal_service_id: r.meal_service_id, p_name: 'Demo feast', p_occasion: 'FEAST',
    p_description: 'Alternative to khashi available: chicken.',
    p_end_at: new Date(start.getTime() + 2 * 3600_000).toISOString(),
    p_items: JSON.stringify([{ name: 'Khashi (mutton)', alternatives: ['Chicken'] }, { name: 'Polao' }, { name: 'Doi' }]),
  });
  return r.meal_service_id;
}

async function simulateBookings(pg: PG, mealId: string, count: number) {
  const { rows } = await pg.query<{ user_id: string }>(
    `select c.user_id from public.coupon_claims c join public.profiles p on p.id = c.user_id
     where c.status = 'APPROVED' and p.role = 'STUDENT' and p.is_verified
       and p.id <> (select value::uuid from local.demo_meta where key = 'student')
       and not exists (select 1 from public.batch_seats b where b.user_id = c.user_id and b.meal_service_id = $1)
     order by random() limit $2`, [mealId, count]);
  let booked = 0;
  for (const s of rows) {
    const r = (await call(pg, s.user_id, 'book_seat', { p_meal_service_id: mealId })) as { status: string };
    if (r.status === 'BOOKED' || r.status === 'JOIN_NOW' || r.status === 'LUCKY') booked++;
  }
  return booked;
}

/**
 * The clock jumps forward `minutes` for the demo feast only: its times (and its batches, seats,
 * coupons taken and notifications) move back, so the scheduler acts as if the time had passed.
 */
function skipAheadSql(minutes: number) {
  const shift = `interval '${Math.round(minutes * 60)} seconds'`;
  const feast = `meal_service_id in (select id from public.meal_services where policy_version = 100)`;
  const move = (cols: string[]) => cols.map((c) => `${c} = ${c} - ${shift}`).join(', ');
  return `set session_replication_role = replica;
    update public.meal_services set ${move(['service_start_at', 'service_end_at', 'choices_close_at', 'state_changed_at', 'created_at', 'rsvp_settled_at', 'start_notified_at'])} where policy_version = 100;
    update public.meal_batches set ${move(['booking_opens_at', 'starts_at', 'start_notified_at', 'loaded_at', 'created_at', 'booking_notified_at', 'full_notified_at'])} where ${feast};
    update public.batch_seats set ${move(['booked_at', 'arrive_by', 'arrived_at', 'closed_at'])} where ${feast};
    update public.attendance_records set ${move(['recorded_at', 'observed_at', 'voided_at'])} where ${feast};
    update public.notification_outbox set ${move(['created_at', 'next_attempt_at'])} where created_at > now() - interval '1 day';
    set session_replication_role = origin;`;
}

export type DemoAction =
  | { action: 'new_dinner'; startInMinutes?: number; prebook?: number }
  | { action: 'simulate_bookings'; count?: number }
  | { action: 'simulate_arrivals'; count?: number }
  | { action: 'load_batch' }
  | { action: 'open_next_booking'; capacity?: number }
  | { action: 'start_next_batch' }
  | { action: 'skip_ahead'; minutes: number }
  | { action: 'run_jobs' }
  | { action: 'end_dinner' };

export function demoTool(actor: string, a: DemoAction): Promise<unknown> {
  return exclusive(async ({ pg }) => {
    if (a.action === 'new_dinner') {
      const meal = await newFeast(pg, actor, a.startInMinutes ?? 6);
      return { status: 'OK', meal, booked: a.prebook ? await simulateBookings(pg, meal, a.prebook) : 0 };
    }
    const meal = await currentMeal(pg);
    if (!meal && a.action !== 'skip_ahead' && a.action !== 'run_jobs') return { status: 'NO_MEAL' };
    switch (a.action) {
      case 'simulate_bookings':
        return { status: 'OK', booked: await simulateBookings(pg, meal!, a.count ?? 20) };
      case 'simulate_arrivals': {
        const { rows } = await pg.query<{ coupon_number: number }>(
          `select s.coupon_number from public.batch_seats s join public.meal_batches b on b.id = s.batch_id
           where s.meal_service_id = $1 and s.state = 'HOLDING' order by random() limit $2`, [meal, a.count ?? 10]);
        let arrived = 0;
        for (const r of rows) {
          const res = (await call(pg, actor, 'door_check_in', { p_meal_service_id: meal, p_coupon_number: r.coupon_number })) as { status: string };
          if (res.status.startsWith('ARRIVED') || res.status === 'WALK_IN' || res.status === 'ATE') arrived++;
        }
        return { status: 'OK', arrived };
      }
      case 'load_batch':
        return call(pg, actor, 'load_batch', { p_meal_service_id: meal });
      case 'open_next_booking':
        return call(pg, actor, 'open_next_booking', { p_meal_service_id: meal, p_capacity: a.capacity ?? null });
      case 'start_next_batch':
        return call(pg, actor, 'start_next_batch', { p_meal_service_id: meal });
      case 'skip_ahead':
        await pg.exec(skipAheadSql(a.minutes));
        return { status: 'OK', jobs: await jobs(pg) };
      case 'run_jobs':
        return { status: 'OK', jobs: await jobs(pg) };
      case 'end_dinner':
        await call(pg, actor, 'set_meal_service_state', { p_meal_service_id: meal, p_target: 'CLOSED', p_reason: 'Demo: end of dinner' });
        return { status: 'OK', jobs: await jobs(pg) };
    }
  });
}
