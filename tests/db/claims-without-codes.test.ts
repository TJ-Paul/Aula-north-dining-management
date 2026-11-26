import { beforeEach, describe, expect, test } from 'vitest';
import { freshDb, type Db } from './harness';

let db: Db;
let superAdmin: string;
let admin: string;

beforeEach(async () => {
  db = await freshDb();
  superAdmin = await db.createUser('SUPER_ADMIN');
  admin = await db.createUser('ADMIN');
  await db.call(superAdmin, 'import_coupons', JSON.stringify([
    { coupon_number: 245, hall_record: { name: 'Rahim', room: '312', email: 'Rahim@Uni.edu', phone: '+880 1711-000245' } },
    { coupon_number: 246, hall_record: { name: 'Karim', room: '313', email: 'karim@uni.edu' } },
    { coupon_number: 247, hall_record: { name: 'Shared', email: 'dup@uni.edu' } },
    { coupon_number: 248, hall_record: { name: 'Shared too', email: 'dup@uni.edu' } },
    { coupon_number: 249, hall_record: { name: 'No contact' } },
  ]));
});

describe('automatic claim by verified hall contact', () => {
  test('a verified email matching the hall record approves the claim (case-insensitive)', async () => {
    const s = await db.createUser('STUDENT', { email: 'rahim@uni.edu', emailConfirmed: true });
    const r = await db.call(s, 'claim_coupon_by_hall_contact');
    expect(r).toMatchObject({ status: 'APPROVED', coupon_number: 245 });
    expect(await db.select(s, 'select coupon_number from public.coupons')).toEqual([{ coupon_number: 245 }]);
    expect((await db.call(s, 'claim_coupon_by_hall_contact')).status).toBe('ALREADY_APPROVED');
  });

  test('a verified phone matches regardless of formatting', async () => {
    const s = await db.createUser('STUDENT', { phone: '8801711000245', phoneConfirmed: true });
    expect(await db.call(s, 'claim_coupon_by_hall_contact')).toMatchObject({ status: 'APPROVED', coupon_number: 245 });
  });

  test.each([
    ['+880 1711-000245', '01711000245'],
    ['8801711000245', '01711000245'],
    ['01711 000245', '01711000245'],
    ['1711000245', '01711000245'], // leading zero lost in a spreadsheet
  ])('normalises %s to %s', async (raw, expected) => {
    const [r] = await db.admin<{ n: string; ok: boolean }>(
      'select public.normalize_phone($1) as n, public.is_valid_bd_mobile($1) as ok', [raw]);
    expect(r).toEqual({ n: expected, ok: true });
  });

  test.each(['0171100024', '02-9661234', '01211000245', 'n/a'])('rejects %s as a BD mobile', async (raw) => {
    const [r] = await db.admin<{ ok: boolean }>('select public.is_valid_bd_mobile($1) as ok', [raw]);
    expect(r.ok).toBe(false);
  });

  test('a registry number missing its leading zero still matches', async () => {
    await db.call(superAdmin, 'import_coupons', JSON.stringify([
      { coupon_number: 300, hall_record: { name: 'Nadia', phone: '1819000300' } },
    ]));
    const s = await db.createUser('STUDENT', { phone: '8801819000300', phoneConfirmed: true });
    expect(await db.call(s, 'claim_coupon_by_hall_contact')).toMatchObject({ status: 'APPROVED', coupon_number: 300 });
  });

  test('a phone shared by two coupons is never guessed', async () => {
    await db.call(superAdmin, 'import_coupons', JSON.stringify([
      { coupon_number: 301, hall_record: { phone: '01911000301' } },
      { coupon_number: 302, hall_record: { phone: '+8801911000301' } },
    ]));
    const s = await db.createUser('STUDENT', { phone: '8801911000301', phoneConfirmed: true });
    expect((await db.call(s, 'claim_coupon_by_hall_contact')).status).toBe('AMBIGUOUS_MATCH');
  });

  test('an unconfirmed email or phone is not enough', async () => {
    const s = await db.createUser('STUDENT', { email: 'rahim@uni.edu', phone: '01711000245' });
    expect((await db.call(s, 'claim_coupon_by_hall_contact')).status).toBe('NO_VERIFIED_CONTACT');
  });

  test('no matching hall record leaves the student to the admin queue', async () => {
    const s = await db.createUser('STUDENT', { email: 'stranger@uni.edu', emailConfirmed: true });
    expect((await db.call(s, 'claim_coupon_by_hall_contact')).status).toBe('NO_MATCH');
  });

  test('an email listed on two coupons is never guessed; admins are alerted', async () => {
    const s = await db.createUser('STUDENT', { email: 'dup@uni.edu', emailConfirmed: true });
    expect((await db.call(s, 'claim_coupon_by_hall_contact')).status).toBe('AMBIGUOUS_MATCH');
    expect(await db.admin(`select 1 from public.coupon_claims where status = 'APPROVED'`)).toEqual([]);
    expect(await db.admin(`select kind from public.admin_alerts`)).toEqual([{ kind: 'AMBIGUOUS_HALL_CONTACT' }]);
  });

  test('the rightful owner overrides someone else\'s pending guess at their number', async () => {
    const guesser = await db.createUser();
    await db.call(guesser, 'request_coupon_claim', 245);
    const owner = await db.createUser('STUDENT', { email: 'rahim@uni.edu', emailConfirmed: true });
    expect((await db.call(owner, 'claim_coupon_by_hall_contact')).status).toBe('APPROVED');
    const [g] = await db.admin<{ status: string }>('select status from public.coupon_claims where user_id = $1', [guesser]);
    expect(g.status).toBe('REJECTED');
  });

  test('a coupon already verified to someone else raises an identity conflict', async () => {
    const first = await db.createUser();
    const c = await db.call(first, 'request_coupon_claim', 246);
    await db.call(admin, 'approve_coupon_claim', c.claim_id, 'checked ID card');

    const owner = await db.createUser('STUDENT', { email: 'karim@uni.edu', emailConfirmed: true });
    expect((await db.call(owner, 'claim_coupon_by_hall_contact')).status).toBe('COUPON_ALREADY_CLAIMED');
    expect(await db.admin(`select kind from public.admin_alerts`)).toEqual([{ kind: 'IDENTITY_CONFLICT' }]);
  });
});

describe('registry phone report', () => {
  test('lists missing, invalid and shared phones for the hall to fix', async () => {
    await db.call(superAdmin, 'import_coupons', JSON.stringify([
      { coupon_number: 301, hall_record: { phone: '01911000301' } },
      { coupon_number: 302, hall_record: { phone: '+8801911000301' } },
      { coupon_number: 303, hall_record: { phone: '02-9661234' } },
    ]));
    const rows = await db.select(admin, 'select * from public.hall_contact_issues()');
    expect(rows).toEqual([
      { coupon_number: 246, issue: 'MISSING_PHONE', phone: null, shared_with: null },
      { coupon_number: 247, issue: 'MISSING_PHONE', phone: null, shared_with: null },
      { coupon_number: 248, issue: 'MISSING_PHONE', phone: null, shared_with: null },
      { coupon_number: 249, issue: 'MISSING_PHONE', phone: null, shared_with: null },
      { coupon_number: 301, issue: 'SHARED_PHONE', phone: '01911000301', shared_with: [302] },
      { coupon_number: 302, issue: 'SHARED_PHONE', phone: '+8801911000301', shared_with: [301] },
      { coupon_number: 303, issue: 'INVALID_PHONE', phone: '02-9661234', shared_with: null },
    ]);
  });

  test('is admin-only', async () => {
    const s = await db.createUser();
    await expect(db.select(s, 'select * from public.hall_contact_issues()')).rejects.toThrow(/requires role ADMIN/);
  });
});

describe('admin review queue', () => {
  test('lists pending claims beside the hall record, flagging competing claims', async () => {
    const a = await db.createUser('STUDENT', { name: 'Rahim', email: 'rahim.alt@gmail.com', emailConfirmed: true });
    const b = await db.createUser('STUDENT', { name: 'Someone' });
    await db.call(a, 'request_coupon_claim', 249, null, 'Room 312, ID 2021-1-60-001');
    await db.call(b, 'request_coupon_claim', 249);

    const rows = await db.select<Record<string, unknown>>(admin, 'select * from public.list_pending_coupon_claims()');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      coupon_number: 249,
      hall_record: { name: 'No contact' },
      claimant_name: 'Rahim',
      claimant_email: 'rahim.alt@gmail.com',
      claimant_email_verified: true,
      evidence: 'Room 312, ID 2021-1-60-001',
      competing_pending_claims: 1,
    });
  });

  test('is admin-only', async () => {
    const attendant = await db.createUser('ATTENDANT');
    await expect(db.select(attendant, 'select * from public.list_pending_coupon_claims()')).rejects.toThrow(/requires role ADMIN/);
  });

  test('bulk approval decides each claim independently', async () => {
    const users = await Promise.all([db.createUser(), db.createUser(), db.createUser()]);
    const ids: string[] = [];
    ids.push((await db.call(users[0], 'request_coupon_claim', 246)).claim_id as string);
    ids.push((await db.call(users[1], 'request_coupon_claim', 249)).claim_id as string);
    ids.push((await db.call(users[2], 'request_coupon_claim', 249)).claim_id as string); // competes with the second

    const r = await db.call(admin, 'approve_coupon_claims', `{${ids.join(',')}}`, 'checked against hall register');
    expect((r.results as Array<{ status: string }>).map((x) => x.status)).toEqual(['APPROVED', 'APPROVED', 'NOT_PENDING']);
    expect(await db.admin(`select count(*)::int as n from public.coupon_claims where status = 'APPROVED'`)).toEqual([{ n: 2 }]);
  });

  test('bulk approval is admin-only', async () => {
    const s = await db.createUser();
    const c = await db.call(s, 'request_coupon_claim', 246);
    await expect(db.call(s, 'approve_coupon_claims', `{${c.claim_id}}`, 'me')).rejects.toThrow(/requires role ADMIN/);
  });
});
