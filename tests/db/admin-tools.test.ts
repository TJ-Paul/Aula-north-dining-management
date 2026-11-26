import { beforeEach, describe, expect, test } from 'vitest';
import { freshDb, type Db } from './harness';

let db: Db;
let superAdmin: string;
let admin: string;
let attendant: string;

beforeEach(async () => {
  db = await freshDb();
  superAdmin = await db.createUser('SUPER_ADMIN', { name: 'Super' });
  admin = await db.createUser('ADMIN', { name: 'Admin Person' });
  attendant = await db.createUser('ATTENDANT', { name: 'Attendant Person' });
});

const start = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

describe('meal services', () => {
  test('can be created with a chosen timing profile, or the active one by default', async () => {
    const a = await db.call(admin, 'create_meal_service', '2026-11-05', 'LUNCH', start(60));
    const b = await db.call(admin, 'create_meal_service', '2026-11-05', 'DINNER', start(300), 1);
    const list = (await db.call(admin, 'admin_meal_services', 10)) as unknown as {
      meals: Array<{ id: string; policy_version: number; meal_type: string }>; aisles: unknown[]; policies: unknown[];
    };
    expect(list.meals.map((m) => [m.meal_type, m.policy_version])).toEqual([['DINNER', 1], ['LUNCH', 4]]);
    expect(list.meals.map((m) => m.id)).toEqual([b.meal_service_id, a.meal_service_id]);
    expect(list.aisles).toHaveLength(2);
    expect(list.policies).toHaveLength(4);
  });

  test('an unknown timing profile is refused', async () => {
    await expect(db.call(admin, 'create_meal_service', '2026-11-05', 'LUNCH', start(60), 99))
      .rejects.toThrow(/unknown policy version/);
  });

  test('the list shows bookings and diners per meal', async () => {
    const meal = (await db.call(admin, 'create_meal_service', '2026-11-04', 'DINNER', start(10))).meal_service_id;
    await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, meal, null);
    const s = await db.createUser();
    await db.admin(`insert into public.coupons (coupon_number) values (500)`);
    await db.admin(`insert into public.coupon_claims (coupon_id, user_id, status, method, effective_from)
                    select id, $1, 'APPROVED', 'STAFF_APPROVAL', now() from public.coupons where coupon_number = 500`, [s]);
    await db.call(s, 'book_meal', meal, null);
    const list = (await db.call(admin, 'admin_meal_services', 10)) as unknown as { meals: Array<Record<string, unknown>> };
    expect(list.meals[0]).toMatchObject({ confirmed: 1, standby: 0, diners: 0, live_waves: [{ aisle: 'A', wave_number: 1 }] });
  });

  test('only admins see the meal list', async () => {
    await expect(db.call(attendant, 'admin_meal_services', 10)).rejects.toThrow(/requires role ADMIN/);
  });
});

describe('flagged coupon entries', () => {
  test('lists unresolved exceptions with who recorded them, and hides them once resolved', async () => {
    const meal = (await db.call(admin, 'create_meal_service', '2026-11-04', 'DINNER', start(10))).meal_service_id;
    const r = await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, meal, null);
    const wave = (r.wave as { wave_id: string }).wave_id;
    await db.call(attendant, 'advance_wave_phase', wave, 'ADMITTING');
    await db.admin(`insert into public.coupons (coupon_number) values (777)`);
    const rec = await db.call(attendant, 'record_coupon', wave, 777, 'entry-00000001', 'LIVE', null);

    const open = (await db.call(attendant, 'list_attendance_exceptions', meal, false)) as unknown as Array<Record<string, unknown>>;
    expect(open).toEqual([expect.objectContaining({
      record_id: rec.record_id, coupon_number: 777, exception: 'NOT_INVITED', aisle: 'A', recorded_by: 'Attendant Person',
    })]);

    await db.call(admin, 'resolve_attendance_exception', rec.record_id, 'Guest approved by provost');
    expect(await db.call(attendant, 'list_attendance_exceptions', meal, false)).toEqual([]);
    const all = (await db.call(attendant, 'list_attendance_exceptions', meal, true)) as unknown as Array<Record<string, unknown>>;
    expect(all[0]).toMatchObject({ resolution: 'Guest approved by provost', resolved_by: 'Admin Person' });
  });

  test('students cannot list flagged entries', async () => {
    const s = await db.createUser();
    const meal = (await db.call(admin, 'create_meal_service', '2026-11-04', 'DINNER', start(10))).meal_service_id;
    await expect(db.call(s, 'list_attendance_exceptions', meal, false)).rejects.toThrow(/requires role ATTENDANT/);
  });
});

describe('alerts', () => {
  test('open alerts are listed; resolved ones only on request', async () => {
    await db.admin(`select public.raise_admin_alert('IDENTITY_CONFLICT', 'k1', '{"coupon_number": 245}')`);
    await db.admin(`select public.raise_admin_alert('OCCUPANCY_OVER_CAPACITY', 'k2', '{}')`);
    const [first] = (await db.call(admin, 'list_admin_alerts', false)) as unknown as Array<{ id: string }>;
    await db.call(admin, 'acknowledge_admin_alert', first.id, true);
    expect((await db.call(admin, 'list_admin_alerts', false)) as unknown as unknown[]).toHaveLength(1);
    const all = (await db.call(admin, 'list_admin_alerts', true)) as unknown as Array<{ status: string; acknowledged_by: string }>;
    expect(all.map((a) => a.status)).toEqual(['OPEN', 'RESOLVED']);
    expect(all[1].acknowledged_by).toBe('Admin Person');
  });

  test('attendants cannot see alerts', async () => {
    await expect(db.call(attendant, 'list_admin_alerts', false)).rejects.toThrow(/requires role ADMIN/);
  });
});

describe('finding people', () => {
  beforeEach(async () => {
    await db.call(superAdmin, 'import_coupons', JSON.stringify([
      { coupon_number: 245, hall_record: { name: 'Rahim', phone: '01711000245' } },
    ]));
    const s = await db.createUser('STUDENT', { name: 'Rahim Uddin', phone: '8801711000245', phoneConfirmed: true });
    await db.call(s, 'claim_coupon_by_hall_contact');
  });

  test('by coupon number', async () => {
    const r = (await db.call(admin, 'admin_find_people', '245')) as unknown as Array<Record<string, unknown>>;
    expect(r).toEqual([expect.objectContaining({ name: 'Rahim Uddin', coupon_number: 245, role: 'STUDENT', phone: '8801711000245' })]);
  });

  test('by part of a name, case-insensitively, treating % and _ literally', async () => {
    expect(((await db.call(admin, 'admin_find_people', 'rahim')) as unknown as unknown[])).toHaveLength(1);
    expect(((await db.call(admin, 'admin_find_people', '%')) as unknown as unknown[])).toHaveLength(0);
  });

  test('an empty search lists staff', async () => {
    const r = (await db.call(admin, 'admin_find_people', '')) as unknown as Array<{ role: string }>;
    expect(r.map((p) => p.role).sort()).toEqual(['ADMIN', 'ATTENDANT', 'SUPER_ADMIN']);
  });

  test('only admins can search people', async () => {
    await expect(db.call(attendant, 'admin_find_people', '245')).rejects.toThrow(/requires role ADMIN/);
  });
});
