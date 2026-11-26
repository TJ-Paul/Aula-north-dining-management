import { beforeEach, describe, expect, test } from 'vitest';
import { freshDb, type Db } from './harness';

let db: Db;
let admin: string;

beforeEach(async () => {
  db = await freshDb();
  admin = await db.createUser('SUPER_ADMIN', { name: 'Hall Office' });
  await db.call(admin, 'import_coupons', JSON.stringify([
    { coupon_number: 24, hall_record: { name: 'Turjjo Paul', student_id: '2021-331-024' } },
    { coupon_number: 25, hall_record: { name: 'Rahim Uddin', student_id: '2021331025' } },
  ]));
});

describe('student IDs', () => {
  test('a claim records the student ID and admins see whether it matches the register', async () => {
    const a = await db.createUser('STUDENT', { name: 'Turjjo Paul' });
    expect((await db.call(a, 'request_coupon', 24, 'Turjjo Paul', null, ' 2021-331-024 ')).status).toBe('PENDING');
    const b = await db.createUser('STUDENT', { name: 'Someone' });
    expect((await db.call(b, 'request_coupon', 25, 'Someone', null, '2021 331 024')).status).toBe('STUDENT_ID_TAKEN');
    expect((await db.call(b, 'request_coupon', 25, 'Someone', null, '!!')).status).toBe('INVALID_STUDENT_ID');
    expect((await db.call(b, 'request_coupon', 25, 'Someone', null, '2021331099')).status).toBe('PENDING');

    const claims = (await db.call(admin, 'admin_coupon_claims')) as unknown as Array<Record<string, unknown>>;
    expect(claims.find((c) => c.coupon_number === 24)).toMatchObject({ claimed_student_id: '2021331024', student_id_matches: true, name_matches: true });
    expect(claims.find((c) => c.coupon_number === 25)).toMatchObject({ claimed_student_id: '2021331099', student_id_matches: false });
    expect(await db.call(a, 'my_profile')).toMatchObject({ student_id: '2021331024' });
  });

  test('admins see everyone: register coupons with or without a holder, and accounts without a coupon', async () => {
    const a = await db.createUser('STUDENT', { name: 'Turjjo Paul' });
    const claim = await db.call(a, 'request_coupon', 24, 'Turjjo Paul', null, '2021-331-024');
    await db.call(admin, 'approve_coupon_claim', claim.claim_id, 'ok', false);
    const rows = (await db.call(admin, 'admin_people_data', null)) as unknown as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.coupon_number === 24)).toMatchObject({ account: 'HOLDER', name: 'Turjjo Paul', student_id: '2021331024', meals_eaten: 0, points: 0 });
    await db.admin(`update public.profiles set avatar_url = 'https://x.supabase.co/a.jpg' where id = $1`, [a]);
    const again = (await db.call(admin, 'admin_people_data', '24')) as unknown as Array<Record<string, unknown>>;
    expect(again[0]).toMatchObject({ avatar_url: 'https://x.supabase.co/a.jpg' });
    expect(rows.find((r) => r.coupon_number === 25)).toMatchObject({ account: 'UNCLAIMED', register_student_id: '2021331025', user_id: null });
    expect(rows.find((r) => r.name === 'Hall Office')).toMatchObject({ account: 'NO_COUPON', role: 'SUPER_ADMIN' });
    expect(((await db.call(admin, 'admin_people_data', '2021331025')) as unknown as unknown[]).length).toBe(1);
    await expect(db.call(a, 'admin_people_data', null)).rejects.toThrow(/requires role/);
  });
});
