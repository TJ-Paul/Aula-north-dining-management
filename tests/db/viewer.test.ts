import { beforeEach, describe, expect, test } from 'vitest';
import { freshDb, type Db } from './harness';

// View-only accounts (migration 20261106000100): professors and visitors see
// every screen but can change nothing.

let db: Db;
let admin: string;
let viewer: string;
let today: string;
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

beforeEach(async () => {
  db = await freshDb();
  admin = await db.createUser('SUPER_ADMIN', { name: 'Hall Office' });
  viewer = await db.createUser('VIEWER', { name: 'Professor' });
  today = (await db.admin<{ d: string }>(`select public.dhaka_today()::text as d`))[0].d;
});

const readOnly = /read-only transaction/;

describe('viewer accounts', () => {
  test('a viewer can read what admins read', async () => {
    const people = (await db.call(viewer, 'admin_find_people', '')) as unknown as Array<{ name: string }>;
    expect(people.map((p) => p.name)).toContain('Hall Office');
    expect((await db.call(viewer, 'my_profile')).role).toBe('VIEWER');
    // Table reads guarded by role (row-level security) work too.
    const rows = await db.select<{ id: string }>(viewer, 'select id from public.profiles');
    expect(rows.length).toBe(2);
  });

  test('every change a viewer tries is refused and nothing is saved', async () => {
    const meal = (await db.call(admin, 'create_meal_event', today, 'LUNCH', at(5), null, null, 'REGULAR', null,
      JSON.stringify([{ name: 'Rice' }]), null)).meal_service_id as string;

    await expect(db.call(viewer, 'create_meal_event', today, 'DINNER', at(300), null, null, 'REGULAR', null, '[]', null))
      .rejects.toThrow(readOnly);
    await expect(db.call(viewer, 'set_meal_notice', meal, 'Hello')).rejects.toThrow(readOnly);
    await expect(db.call(viewer, 'set_user_role', viewer, 'SUPER_ADMIN', 'please')).rejects.toThrow(readOnly);
    await expect(db.call(viewer, 'door_check_in', meal, 1)).rejects.toThrow(readOnly);
    // Student actions answer as for someone without a coupon.
    expect((await db.call(viewer, 'book_seat', meal)).status).toBe('NOT_VERIFIED');

    const [m] = await db.admin<{ n: number; notice: string | null }>(
      `select (select count(*)::int from public.meal_services) as n, (select notice from public.meal_services where id = $1) as notice`, [meal]);
    expect(m).toEqual({ n: 1, notice: null });
    const [p] = await db.admin<{ role: string }>(`select role::text as role from public.profiles where id = $1`, [viewer]);
    expect(p.role).toBe('VIEWER');

    // The read-only switch lasts for that one request only: staff keep working afterwards.
    expect((await db.call(admin, 'set_meal_notice', meal, 'Gate opens late')).status).toBe('OK');
  });

  test('a viewer may change their own photo, and nothing else', async () => {
    expect((await db.call(viewer, 'set_my_photo', '/api/files/0123456789abcdef01234567.jpg', false)).status).toBe('OK');
    expect((await db.call(viewer, 'my_profile')).avatar_url).toBe('/api/files/0123456789abcdef01234567.jpg');
    // Room and roommates still go through update_my_profile, which stays refused.
    await expect(db.call(viewer, 'update_my_profile', '12B', null, null, false)).rejects.toThrow(readOnly);
    // Only a photo address is accepted, and only on their own row.
    await expect(db.call(viewer, 'set_my_photo', 'javascript:alert(1)', false)).rejects.toThrow(/photo address/);
    expect((await db.call(viewer, 'set_my_photo', null, true)).status).toBe('OK');
    const rows = await db.admin<{ id: string; avatar_url: string | null; room: string | null }>(
      'select id, avatar_url, room from public.profiles order by id');
    expect(rows.every((r) => r.avatar_url === null && r.room === null)).toBe(true);
    // Students use it for their photo too.
    expect((await db.call(admin, 'set_my_photo', 'https://x.supabase.co/storage/v1/object/public/avatars/a.jpg', false)).status).toBe('OK');
  });

  test('a super admin can make someone a viewer; viewers are never counted as staff', async () => {
    const someone = await db.createUser('ATTENDANT', { name: 'Ex attendant' });
    expect((await db.call(admin, 'set_user_role', someone, 'VIEWER', 'Visiting professor')).status).toBe('OK');
    const [r] = await db.admin<{ staff: boolean }>(`select role >= 'ATTENDANT' as staff from public.profiles where id = $1`, [someone]);
    expect(r.staff).toBe(false);
  });

  test('every callable function checks the role before writing, or cannot write at all', async () => {
    // The viewer guarantee depends on this: a function that wrote before calling
    // require_role() would let a viewer change data.
    const fns = await db.admin<{ proname: string; src: string; volatile: boolean }>(
      `select p.proname, p.prosrc as src, p.provolatile = 'v' as volatile
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')`);
    // set_my_photo (20261106000200) is the one exception: it checks the caller itself and
    // only ever writes that caller's own photo, which a viewer may change.
    const allowed = new Set(['set_my_photo']);
    const unsafe = fns.filter((f) => {
      if (!f.volatile || allowed.has(f.proname)) return false;
      const check = f.src.search(/require_role\(/);
      const write = f.src.search(/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i);
      return check < 0 || (write >= 0 && write < check);
    }).map((f) => f.proname);
    expect(unsafe).toEqual([]);
  });
});
