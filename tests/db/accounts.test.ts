import { beforeEach, describe, expect, test } from 'vitest';
import { freshDb, type Db } from './harness';

let db: Db;
let superAdmin: string;
let admin: string;

beforeEach(async () => {
  db = await freshDb();
  superAdmin = await db.createUser('SUPER_ADMIN', { name: 'Super' });
  admin = await db.createUser('ADMIN', { name: 'Admin' });
  await db.call(superAdmin, 'import_coupons', JSON.stringify([
    { coupon_number: 24, hall_record: { name: 'Turjjo Paul', room: '312', phone: '01711000024' } },
    { coupon_number: 25, hall_record: { name: 'Rahim Uddin', room: '313', phone: '01711000025' } },
    { coupon_number: 26, hall_record: { name: 'Karim Khan', room: '314' } },
    { coupon_number: 450, hall_record: { name: 'Last Coupon' } },
  ]));
});

/** A signed-up student whose phone was verified at sign-up. */
const student = (name: string, phone: string) =>
  db.createUser('STUDENT', { name, phone: `880${phone.slice(1)}`, phoneConfirmed: true });

const request = (uid: string, n: number, name: string | null = null, note: string | null = null) =>
  db.call(uid, 'request_coupon', n, name, note);

async function claims() {
  return db.admin<{ user_id: string; coupon_number: number; status: string; kind: string; decision_reason: string | null }>(
    `select c.user_id, k.coupon_number, c.status, c.kind, c.decision_reason
     from public.coupon_claims c join public.coupons k on k.id = c.coupon_id order by c.requested_at`);
}
async function notes(uid: string) {
  return (await db.admin<{ kind: string; message: string }>(
    `select kind, payload ->> 'message' as message from public.notification_outbox where recipient_id = $1 order by created_at`, [uid]));
}

describe('accounts', () => {
  test('every account gets its own random public id; the verified phone becomes the notification phone', async () => {
    const a = await student('Turjjo Paul', '01711000024');
    const b = await student('Someone', '01811000001');
    const [pa] = await db.admin<{ public_id: string; notify_phone: string }>('select public_id, notify_phone from public.profiles where id = $1', [a]);
    const [pb] = await db.admin<{ public_id: string }>('select public_id from public.profiles where id = $1', [b]);
    expect(pa.public_id).toMatch(/^AD-[A-HJ-NP-Z2-9]{6}$/);
    expect(pa.public_id).not.toBe(pb.public_id);
    expect(pa.notify_phone).toBe('01711000024');
  });

  test('students edit room, roommates and photo, but not their name', async () => {
    const a = await student('Turjjo Paul', '01711000024');
    await db.call(a, 'update_my_profile', '312', JSON.stringify([{ name: 'Rahim', coupon_number: '25' }, { name: 'Karim' }]),
      '/api/files/abc123.jpg', false);
    const p = await db.call(a, 'my_profile');
    expect(p).toMatchObject({ room: '312', avatar_url: '/api/files/abc123.jpg', roommates: [{ name: 'Rahim' }, { name: 'Karim' }] });
    await expect(db.call(a, 'update_my_profile', null, JSON.stringify([{ name: '' }]), null, false)).rejects.toThrow(/each roommate/);
    await expect(db.call(a, 'update_my_profile', null, null, 'javascript:alert(1)', false)).rejects.toThrow(/check constraint/);
  });
});

describe('claiming a coupon', () => {
  test('only numbers from 1 to 450 are valid', async () => {
    const a = await student('Turjjo Paul', '01711000024');
    for (const n of [0, -5, 451, 9999]) {
      expect((await request(a, n, 'Turjjo Paul')).status).toBe('INVALID_COUPON_NUMBER');
    }
    expect((await request(a, 450, 'Turjjo Paul')).status).toBe('PENDING');
  });

  test('a number missing from the hall register is refused with a clear reason', async () => {
    const a = await student('Turjjo Paul', '01711000024');
    expect((await request(a, 100, 'Turjjo Paul')).status).toBe('NOT_IN_REGISTER');
  });

  test('a claim waits for an admin, who sees the register beside what the student entered', async () => {
    const a = await student('Turjjo Paul', '01711000024');
    expect(await request(a, 24, 'turjjo  paul', 'Room 312')).toMatchObject({ status: 'PENDING', kind: 'INITIAL' });
    expect(await db.call(a, 'my_profile')).toMatchObject({ is_verified: false, coupon_number: null, pending_claim: { coupon_number: 24 } });

    const [c] = (await db.call(admin, 'admin_coupon_claims')) as unknown as Array<Record<string, any>>;
    expect(c).toMatchObject({
      kind: 'INITIAL', coupon_number: 24, claimed_name: 'turjjo  paul', claimed_phone: '01711000024',
      name_matches: true, phone_matches: true, note: 'Room 312', current_holder: null,
      register: { name: 'Turjjo Paul', room: '312' },
    });
  });

  test('asking again for the same number is harmless; a different number replaces the request', async () => {
    const a = await student('Turjjo Paul', '01711000024');
    await request(a, 25, 'Turjjo Paul');
    expect((await request(a, 24)).status).toBe('PENDING');
    expect((await request(a, 24)).status).toBe('PENDING');
    expect((await claims()).map((c) => [c.coupon_number, c.status])).toEqual([[25, 'WITHDRAWN'], [24, 'PENDING']]);
  });

  test('approval verifies the account and tells the student; rejection tells them why', async () => {
    const a = await student('Turjjo Paul', '01711000024');
    const b = await student('Fake Name', '01811000001');
    const ca = await request(a, 24, 'Turjjo Paul');
    const cb = await request(b, 25, 'Fake Name');
    expect((await db.call(admin, 'approve_coupon_claim', ca.claim_id, 'Matches hall sheet', false)).status).toBe('APPROVED');
    expect((await db.call(admin, 'reject_coupon_claim', cb.claim_id, 'Name does not match the hall sheet')).status).toBe('REJECTED');

    expect(await db.call(a, 'my_profile')).toMatchObject({ is_verified: true, coupon_number: 24, pending_claim: null });
    expect((await notes(a)).map((n) => n.kind)).toEqual(['COUPON_APPROVED']);
    expect(await db.call(b, 'my_profile')).toMatchObject({
      is_verified: false, coupon_number: null,
      last_decision: { status: 'REJECTED', coupon_number: 25, reason: 'Name does not match the hall sheet' },
    });
    expect((await notes(b))[0].message).toMatch(/Name does not match/);
  });
});

describe('changing coupon', () => {
  test('a student with a coupon asks for a new one and keeps the old until it is approved', async () => {
    const a = await student('Turjjo Paul', '01711000024');
    await db.call(admin, 'approve_coupon_claim', (await request(a, 24, 'Turjjo Paul')).claim_id, 'ok', false);
    expect(await request(a, 26, null, 'New semester number')).toMatchObject({ status: 'PENDING', kind: 'CHANGE' });
    expect(await db.call(a, 'my_profile')).toMatchObject({ coupon_number: 24, pending_claim: { coupon_number: 26, kind: 'CHANGE' } });

    const [c] = (await db.call(admin, 'admin_coupon_claims')) as unknown as Array<Record<string, any>>;
    expect(c).toMatchObject({ kind: 'CHANGE', coupon_number: 26, claimant: { current_coupon: 24 }, name_matches: false });

    await db.call(admin, 'approve_coupon_claim', c.claim_id, 'Hall office confirmed', false);
    expect(await db.call(a, 'my_profile')).toMatchObject({ coupon_number: 26, last_decision: null });
    expect((await claims()).map((x) => [x.coupon_number, x.status])).toEqual([[24, 'REVOKED'], [26, 'APPROVED']]);
  });

  test('asking for your own current number is not a change', async () => {
    const a = await student('Turjjo Paul', '01711000024');
    await db.call(admin, 'approve_coupon_claim', (await request(a, 24, 'Turjjo Paul')).claim_id, 'ok', false);
    expect((await request(a, 24)).status).toBe('ALREADY_YOURS');
  });
});

describe('reassigning a number someone else holds', () => {
  async function holderAndNewcomer() {
    const old = await student('Turjjo Paul', '01711000024');
    await db.call(admin, 'approve_coupon_claim', (await request(old, 24, 'Turjjo Paul')).claim_id, 'ok', false);
    const next = await student('Rahim Uddin', '01711000025');
    // The new register lists Rahim under 24, so he may ask for it while Turjjo still holds it.
    await db.admin(`update public.profiles set student_id = 'R025' where id = $1`, [next]);
    await db.admin(`update public.coupons set hall_record = hall_record || '{"student_id": "R025"}' where coupon_number = 24`);
    const claim = await request(next, 24, 'Rahim Uddin');
    return { old, next, claim };
  }

  test('without explicit confirmation the admin is told who holds it, and nothing changes', async () => {
    const { old, claim } = await holderAndNewcomer();
    const [c] = (await db.call(admin, 'admin_coupon_claims')) as unknown as Array<Record<string, any>>;
    expect(c.current_holder).toMatchObject({ name: 'Turjjo Paul' });
    expect(await db.call(admin, 'approve_coupon_claim', claim.claim_id, 'New sheet', false))
      .toMatchObject({ status: 'HELD_BY_OTHER', holder_name: 'Turjjo Paul' });
    expect(await db.call(old, 'my_profile')).toMatchObject({ coupon_number: 24, is_verified: true });
  });

  test('confirmed: the number moves, the old holder is told to contact the hall office and request again', async () => {
    const { old, next, claim } = await holderAndNewcomer();
    expect(await db.call(admin, 'approve_coupon_claim', claim.claim_id, 'Semester 2 sheet', true))
      .toMatchObject({ status: 'APPROVED', reassigned_from: 'Turjjo Paul' });

    expect(await db.call(next, 'my_profile')).toMatchObject({ coupon_number: 24, is_verified: true });
    expect(await db.call(old, 'my_profile')).toMatchObject({
      coupon_number: null, is_verified: false, last_decision: { status: 'REVOKED', coupon_number: 24 },
    });
    const [n] = (await notes(old)).filter((x) => x.kind === 'COUPON_REASSIGNED');
    expect(n.message).toMatch(/contact the hall office for your new coupon number/i);

    // The old holder asks for their new number the same way; it is a change, not a first claim.
    expect(await request(old, 26)).toMatchObject({ status: 'PENDING', kind: 'CHANGE' });
  });

  test('the database never allows two holders of one number', async () => {
    const { claim } = await holderAndNewcomer();
    await expect(db.admin(`update public.coupon_claims set status = 'APPROVED', method = 'STAFF_APPROVAL', effective_from = now()
                           where id = $1`, [claim.claim_id])).rejects.toThrow(/coupon_claims_one_owner_per_coupon/);
  });

  test('missed meals stay with the person, not the number', async () => {
    const { old, next, claim } = await holderAndNewcomer();
    await db.call(admin, 'approve_coupon_claim', claim.claim_id, 'Semester 2 sheet', true);
    expect(await db.call(next, 'my_dining_history', 10)).toMatchObject({ meals: [], missed_in_window: 0 });
    expect(old).not.toBe(next);
  });
});

describe('new register: who needs to update', () => {
  test('the check lists holders whose register entry no longer matches; notifying flags and messages them', async () => {
    const a = await student('Turjjo Paul', '01711000024');
    const b = await student('Rahim Uddin', '01711000025');
    await db.call(admin, 'approve_coupon_claim', (await request(a, 24, 'Turjjo Paul')).claim_id, 'ok', false);
    await db.call(admin, 'approve_coupon_claim', (await request(b, 25, 'Rahim Uddin')).claim_id, 'ok', false);

    // The hall office's new sheet gives 24 to someone else.
    await db.call(superAdmin, 'import_coupons', JSON.stringify([{ coupon_number: 24, hall_record: { name: 'Nadia Islam', phone: '01911000024' } }]));
    const check = await db.call(admin, 'registry_holder_check');
    const holders = check.holders as Array<{ coupon_number: number; name_matches: boolean; user_id: string }>;
    expect(holders.map((h) => [h.coupon_number, h.name_matches])).toEqual([[24, false], [25, true]]);

    const mismatched = holders.filter((h) => !h.name_matches).map((h) => h.user_id);
    expect(await db.call(admin, 'request_coupon_updates', `{${mismatched.join(',')}}`, null)).toMatchObject({ notified: 1 });
    expect(await db.call(a, 'my_profile')).toMatchObject({ coupon_number: 24, update_requested_at: expect.any(String) });
    expect((await notes(a)).map((n) => n.kind)).toContain('COUPON_UPDATE_REQUESTED');
    expect(await db.call(b, 'my_profile')).toMatchObject({ update_requested_at: null });
  });

  test('notifying everyone reaches every student holding a coupon', async () => {
    const a = await student('Turjjo Paul', '01711000024');
    const b = await student('Rahim Uddin', '01711000025');
    await db.call(admin, 'approve_coupon_claim', (await request(a, 24, 'Turjjo Paul')).claim_id, 'ok', false);
    await db.call(admin, 'approve_coupon_claim', (await request(b, 25, 'Rahim Uddin')).claim_id, 'ok', false);
    expect(await db.call(admin, 'request_coupon_updates', null, 'New semester: confirm your coupon number')).toMatchObject({ notified: 2 });
  });

  test('only admins run the check or send notices', async () => {
    const a = await student('Turjjo Paul', '01711000024');
    await expect(db.call(a, 'registry_holder_check')).rejects.toThrow(/requires role ADMIN/);
    await expect(db.call(a, 'request_coupon_updates', null, 'x')).rejects.toThrow(/requires role ADMIN/);
    await expect(db.call(a, 'admin_coupon_claims')).rejects.toThrow(/requires role ADMIN/);
  });
});

describe('claiming again after a rejection', () => {
  test('a rejected student claims again with a corrected name and student ID; a verified one cannot rename this way', async () => {
    const a = await student('Turjo Pal', '01711000024');
    const first = await db.call(a, 'request_coupon', 24, 'Turjo Pal', null, '2305064');
    await db.call(admin, 'reject_coupon_claim', first.claim_id, 'Name does not match the register');
    expect((await db.call(a, 'my_profile')).last_decision).toMatchObject({ status: 'REJECTED', coupon_number: 24 });

    const again = await db.call(a, 'request_coupon', 25, 'Turjjo Paul', null, '2305065');
    expect(again.status).toBe('PENDING');
    expect(await db.call(a, 'my_profile')).toMatchObject({ name: 'Turjjo Paul', student_id: '2305065' });
    await db.call(admin, 'approve_coupon_claim', again.claim_id, 'ok', false);

    // Verified now: a later claim no longer changes the name.
    await db.call(a, 'request_coupon', 26, 'Someone Else');
    expect((await db.call(a, 'my_profile')).name).toBe('Turjjo Paul');
  });
});
