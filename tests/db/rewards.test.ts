import { beforeEach, describe, expect, test } from 'vitest';
import { skipAheadSql } from './time-travel';
import { freshDb, type Db } from './harness';

let db: Db;
let admin: string;
let attendant: string;
let nextCoupon = 1;
let entry = 0;

type Student = { id: string; coupon: number };

async function students(n: number): Promise<Student[]> {
  const out: Student[] = [];
  for (let i = 0; i < n; i++) out.push({ id: await db.createUser('STUDENT', { name: `Student ${nextCoupon + i}` }), coupon: nextCoupon + i });
  await db.admin(`insert into public.coupons (coupon_number) select g from generate_series($1::int, $2::int) g`,
    [nextCoupon, nextCoupon + n - 1]);
  await db.admin(
    `insert into public.coupon_claims (coupon_id, user_id, status, method, effective_from)
     select c.id, u.id, 'APPROVED', 'STAFF_APPROVAL', now()
     from unnest($1::uuid[]) with ordinality as u(id, ord)
     join public.coupons c on c.coupon_number = $2 + u.ord - 1`, [out.map((s) => s.id), nextCoupon]);
  await db.admin('update public.profiles set is_verified = true where id = any($1::uuid[])', [out.map((s) => s.id)]);
  nextCoupon += n;
  return out;
}

const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const skip = (min: number) => db.pg.exec(skipAheadSql(min));
const jobs = () => db.admin('select public.run_due_jobs()');
let day = 0;

/** A meal starting `inMinutes` from now (default notice deadline: 4 h before). */
async function meal(inMinutes: number, type = 'DINNER') {
  const date = new Date(Date.UTC(2030, 0, 1 + day++)).toISOString().slice(0, 10);
  const r = await db.call(admin, 'create_meal_event', date, type, at(inMinutes), at(inMinutes + 120), null, 'REGULAR', null, null, null);
  return r.meal_service_id as string;
}
const notComing = (s: Student, m: string, v = true, reason: string | null = null) => db.call(s.id, 'set_not_coming', m, v, reason);
const balance = async (s: Student) => (await db.call(s.id, 'my_points')).balance as number;
const mine = async (s: Student, m: string) => (await db.call(s.id, 'meal_rsvp', m)).mine as Record<string, unknown>;

beforeEach(async () => {
  db = await freshDb();
  admin = await db.createUser('SUPER_ADMIN', { name: 'Hall Office' });
  attendant = await db.createUser('ATTENDANT');
});

describe('not coming', () => {
  test('no answer means coming; "not coming" counts for the cook and blocks booking', async () => {
    const [a, b, c] = await students(3);
    const m = await meal(600);
    expect(await mine(a, m)).toMatchObject({ not_coming: false, open: true });
    expect((await notComing(a, m)).status).toBe('OK');
    expect((await notComing(a, m)).status).toBe('ALREADY_SET');
    expect(await mine(a, m)).toMatchObject({ not_coming: true });

    // Booked students cancel first; a "not coming" student cannot book (booking opens later, so rows go in directly).
    const join = (s: Student) => db.admin(
      `insert into public.booking_participations (meal_service_id, user_id, coupon_id, coupon_number, status)
       select $1, $2, id, coupon_number, 'STANDBY' from public.coupons where coupon_number = $3`, [m, s.id, s.coupon]);
    await join(b);
    expect((await notComing(b, m)).status).toBe('CANCEL_BOOKING_FIRST');
    await expect(join(a)).rejects.toThrow(/not coming/);

    const view = (await db.call(admin, 'meal_rsvp', m)).admin as Record<string, unknown>;
    expect(view).toMatchObject({ eligible: 3, not_coming: 1, expected: 2 });
    expect((view.people as Array<{ coupon_number: number }>).map((p) => p.coupon_number)).toEqual([a.coupon]);
    expect((await db.call(c.id, 'meal_rsvp', m)).admin).toBeUndefined();
  });

  test('the notice closes at the deadline, which admins can move per meal', async () => {
    const [a] = await students(1);
    const m = await meal(200); // default 4 h notice: already closed
    expect((await notComing(a, m)).status).toBe('PAST_DEADLINE');
    await expect(db.call(a.id, 'set_not_coming_deadline', m, 60)).rejects.toThrow(/requires role/);
    expect((await db.call(admin, 'set_not_coming_deadline', m, 60)).status).toBe('OK');
    expect((await notComing(a, m)).status).toBe('OK');
  });

  test('taken back freely for 8 hours; after that an admin approves', async () => {
    const [a, b] = await students(2);
    const m = await meal(24 * 60);
    await notComing(a, m);
    expect((await notComing(a, m, false)).status).toBe('OK');
    expect(await mine(a, m)).toMatchObject({ not_coming: false });

    await notComing(a, m);
    await notComing(b, m);
    await skip(8 * 60 + 1);
    expect((await notComing(a, m, false, 'Exam got moved')).status).toBe('REQUEST_SENT');
    expect((await notComing(a, m, false)).status).toBe('REQUEST_PENDING');
    expect((await notComing(b, m, false)).status).toBe('REQUEST_SENT');

    const reqs = ((await db.call(admin, 'meal_rsvp', m)).admin as { requests: Array<{ id: string; reason: string | null }> }).requests;
    expect(reqs.map((r) => r.reason)).toEqual(['Exam got moved', null]);
    expect((await db.call(admin, 'decide_not_coming_change', reqs[0].id, true, null)).status).toBe('APPROVED');
    expect((await db.call(admin, 'decide_not_coming_change', reqs[1].id, false, 'Cooking is planned')).status).toBe('REJECTED');
    expect((await db.call(admin, 'decide_not_coming_change', reqs[1].id, true, null)).status).toBe('ALREADY_DECIDED');
    expect(await mine(a, m)).toMatchObject({ not_coming: false, request: { status: 'APPROVED' } });
    expect(await mine(b, m)).toMatchObject({ not_coming: true, request: { status: 'REJECTED', admin_note: 'Cooking is planned' } });
  });

  test('the free change window also ends at the deadline', async () => {
    const [a] = await students(1);
    const m = await meal(5 * 60); // deadline in 1 h
    await notComing(a, m);
    await skip(61);
    expect((await notComing(a, m, false)).status).toBe('REQUEST_SENT');
  });
});

describe('rewards', () => {
  test('keeping your word earns a point after the meal, capped at the maximum', async () => {
    const [a] = await students(1);
    const meals = [];
    for (let i = 0; i < 5; i++) meals.push(await meal(600));
    for (const m of meals) await notComing(a, m);
    await jobs();
    expect(await balance(a)).toBe(0); // not before the meal is over
    await skip(600 + 120 + 61);
    expect((await db.admin<{ r: { rewards_given: number } }>('select public.run_due_jobs() as r'))[0].r.rewards_given).toBe(5);
    expect(await balance(a)).toBe(3);
    const pts = await db.call(a.id, 'my_points');
    expect((pts.history as Array<{ kind: string }>).map((h) => h.kind)).toEqual(['REWARD', 'REWARD', 'REWARD']);
    expect(await mine(a, meals[4])).toMatchObject({ outcome: 'REWARDED', points_awarded: 0 });
  });

  test('saying "not coming" and eating anyway costs a little; a voided coupon entry undoes it', async () => {
    const [a, b] = await students(2);
    const m = await meal(300);
    await notComing(a, m);
    await notComing(b, m);
    await skip(290);
    const wave = ((await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, m, null)).wave as { wave_id: string }).wave_id;
    await skip(11);
    await jobs();
    const rec = await db.call(attendant, 'record_coupon', wave, a.coupon, `entry-${String(++entry).padStart(6, '0')}`, 'LIVE', null);
    expect(await balance(a)).toBe(-2);
    expect(await mine(a, m)).toMatchObject({ outcome: 'CAME_ANYWAY', penalty_applied: 2 });

    // Wrong coupon typed: voiding it gives the points back.
    await db.call(attendant, 'void_attendance', rec.record_id, 'Typed the wrong coupon');
    expect(await balance(a)).toBe(0);
    expect(await mine(a, m)).toMatchObject({ outcome: null });

    // An admin saw b eat (no coupon typed).
    expect((await db.call(admin, 'mark_came_anyway', m, b.id, 'At table 4')).status).toBe('OK');
    expect((await db.call(admin, 'mark_came_anyway', m, b.id, null)).status).toBe('ALREADY_MARKED');
    await skip(120 + 61);
    await jobs();
    expect(await balance(a)).toBe(1);
    expect(await balance(b)).toBe(-2);
    const list = (await db.call(admin, 'admin_rewards')).balances as Array<{ coupon_number: number; kept: number; came_anyway: number }>;
    expect(list.find((x) => x.coupon_number === b.coupon)).toMatchObject({ came_anyway: 1, kept: 0 });
  });

  test('a reward given at settlement is taken back if the coupon turns up later', async () => {
    const [a] = await students(1);
    const m = await meal(300);
    await notComing(a, m);
    await skip(290);
    const wave = ((await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, m, null)).wave as { wave_id: string }).wave_id;
    await skip(11);
    await jobs();
    await skip(120 + 61); // an hour past the end: settled, though the aisle is still open
    await jobs();
    expect(await balance(a)).toBe(1);
    await db.call(attendant, 'record_coupon', wave, a.coupon, `entry-${String(++entry).padStart(6, '0')}`, 'LIVE', null);
    expect(await mine(a, m)).toMatchObject({ outcome: 'CAME_ANYWAY', points_awarded: 0, penalty_applied: 2 });
    expect(await balance(a)).toBe(-2);
  });

  test('admins give treats from points; never more than the balance', async () => {
    const [a, b] = await students(2);
    const m = await meal(600);
    await notComing(a, m);
    await skip(600 + 120 + 61);
    await jobs();
    expect((await db.call(admin, 'give_treat', a.id, 2, 'Extra payesh', null)).status).toBe('NOT_ENOUGH_POINTS');
    expect((await db.call(admin, 'give_treat', a.id, 1, '  ', null)).status).toBe('NOTE_REQUIRED');
    await expect(db.call(b.id, 'give_treat', a.id, 1, 'Extra payesh', null)).rejects.toThrow(/requires role/);
    expect((await db.call(admin, 'give_treat', a.id, 1, 'Extra payesh', null))).toMatchObject({ status: 'OK', balance: 0 });
    const hist = (await db.call(a.id, 'my_points')).history as Array<{ kind: string; points: number; note: string }>;
    expect(hist[0]).toMatchObject({ kind: 'TREAT', points: -1, note: 'Extra payesh' });
    await expect(db.admin(`delete from public.points_ledger`)).rejects.toThrow(/append-only/);
  });

  test('settings change the notice period, window, points and cap', async () => {
    const [a] = await students(1);
    await expect(db.call(a.id, 'update_rsvp_settings', 120, 60, 2, 1, 4)).rejects.toThrow(/requires role/);
    expect((await db.call(admin, 'update_rsvp_settings', 120, 60, 2, 1, 50)).status).toBe('OUT_OF_RANGE');
    expect((await db.call(admin, 'update_rsvp_settings', 120, 60, 2, 1, 4)).status).toBe('OK');
    const m = await meal(200); // 2 h notice now: still open
    expect((await notComing(a, m)).status).toBe('OK');
    await skip(61);
    expect((await notComing(a, m, false)).status).toBe('REQUEST_SENT');
    await skip(400);
    await jobs();
    expect(await balance(a)).toBe(2);
    expect(((await db.call(admin, 'admin_rewards')).settings as Record<string, number>).max_points).toBe(4);
  });

  test('cancelled meals settle with no points and close open requests', async () => {
    const [a] = await students(1);
    const m = await meal(24 * 60);
    await notComing(a, m);
    await skip(8 * 60 + 1);
    await notComing(a, m, false);
    await db.call(admin, 'set_meal_service_state', m, 'CANCELLED', 'Gas shortage');
    await jobs();
    expect(await balance(a)).toBe(0);
    expect(await mine(a, m)).toMatchObject({ request: { status: 'REJECTED', admin_note: 'The meal is over' } });
  });
});
