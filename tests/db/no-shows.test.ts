import { beforeEach, describe, expect, test } from 'vitest';
import { skipAheadSql } from './time-travel';
import { freshDb, type Db } from './harness';

let db: Db;
let admin: string;
let attendant: string;
let nextCoupon = 1000;
let mealNo = 0;
let entry = 0;

type Student = { id: string; coupon: number };

async function students(n: number): Promise<Student[]> {
  const out: Student[] = [];
  for (let i = 0; i < n; i++) out.push({ id: await db.createUser(), coupon: nextCoupon + i });
  await db.admin(`insert into public.coupons (coupon_number) select g from generate_series($1::int, $2::int) g`,
    [nextCoupon, nextCoupon + n - 1]);
  await db.admin(
    `insert into public.coupon_claims (coupon_id, user_id, status, method, effective_from)
     select c.id, u.id, 'APPROVED', 'STAFF_APPROVAL', now()
     from unnest($1::uuid[]) with ordinality as u(id, ord)
     join public.coupons c on c.coupon_number = $2 + u.ord - 1`, [out.map((s) => s.id), nextCoupon]);
  nextCoupon += n;
  return out;
}

const skip = (minutes: number) => db.pg.exec(skipAheadSql(minutes));
const jobs = async () => (await db.admin<{ r: Record<string, number> }>('select public.run_due_jobs() as r'))[0].r;
const record = (wave: string, coupon: number, source = 'LIVE') =>
  db.call(attendant, 'record_coupon', wave, coupon, `entry-${String(++entry).padStart(6, '0')}`, source, null);

/** A dinner in aisle A: everyone in `book` books, only `come` are recorded. Ends just after the arrival deadline. */
async function dinner(book: Student[], come: Student[] = []) {
  mealNo += 1;
  const start = new Date(Date.now() + 10 * 60_000).toISOString();
  const meal = (await db.call(admin, 'create_meal_service', `2026-12-${String(mealNo).padStart(2, '0')}`, 'DINNER', start))
    .meal_service_id as string;
  const r = await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, meal, null);
  const wave = (r.wave as { wave_id: string }).wave_id;
  for (const s of book) await db.call(s.id, 'book_meal', meal, null);
  await skip(11);
  await jobs();                                  // gate opens
  for (const s of come) await record(wave, s.coupon);
  await skip(10);
  await jobs();                                  // arrival deadline passes
  return { meal, wave };
}

/** The attendant finishes the round and everyone leaves; then the scheduler runs. */
async function endDinner(wave: string) {
  await db.call(attendant, 'finish_collection_round', wave, true, null);
  await db.call(attendant, 'close_aisle_wave', wave, true, null, null);
  return jobs();
}

async function events(where = 'true') {
  return db.admin<{ id: string; user_id: string; status: string; commitment: string }>(
    `select id, user_id, status, commitment from public.no_show_events where ${where} order by detected_at`);
}
async function penalties(userId: string) {
  return db.admin<{ level: string; status: string; count_in_window: number }>(
    `select level, status, count_in_window from public.penalty_events where user_id = $1 order by applied_at`, [userId]);
}
async function notes(userId: string) {
  return (await db.admin<{ kind: string }>(
    `select kind from public.notification_outbox where recipient_id = $1 and kind like any (array['NO_SHOW_%','PENALTY_%'])
     order by created_at`, [userId])).map((n) => n.kind);
}

beforeEach(async () => {
  db = await freshDb();
  admin = await db.createUser('ADMIN', { name: 'Admin Person' });
  attendant = await db.createUser('ATTENDANT');
});

describe('nothing is final while the coupon round is open', () => {
  test('a missing coupon after the deadline is only PENDING, invisible to the student, with no penalty', async () => {
    const [s, other] = await students(2);
    await dinner([s, other], [other]);
    expect(await events()).toEqual([expect.objectContaining({ user_id: s.id, status: 'PENDING', commitment: 'BOOKING' })]);
    expect(await penalties(s.id)).toEqual([]);
    expect(await db.select(s.id, 'select * from public.no_show_events')).toEqual([]);
    const h = await db.call(s.id, 'my_dining_history', 10);
    expect((h.meals as Array<{ outcome: string }>)[0].outcome).toBe('CHECKING');
    await jobs();
    expect(await events()).toHaveLength(1);   // re-running the scheduler adds nothing
  });

  test('a finished round becomes final only after the grace time while the aisle is still in use', async () => {
    const [s] = await students(1);
    const { wave } = await dinner([s]);
    await db.call(attendant, 'finish_collection_round', wave, true, null);
    await jobs();
    expect((await events())[0].status).toBe('PENDING');
    await skip(31);
    await jobs();
    expect((await events())[0].status).toBe('VERIFIED');
  });

  test('closing the aisle after a finished round makes it final at once, with a private reminder', async () => {
    const [s] = await students(1);
    const { wave } = await dinner([s]);
    expect(await endDinner(wave)).toMatchObject({ no_shows_verified: 1 });
    expect(await penalties(s.id)).toEqual([{ level: 'REMINDER', status: 'ACTIVE', count_in_window: 1 }]);
    expect(await notes(s.id)).toEqual(['NO_SHOW_REMINDER']);
    expect(await jobs()).toMatchObject({ no_shows_verified: 0 });
    expect(await penalties(s.id)).toHaveLength(1);
  });

  test('an aisle closed without finishing the round never verifies anyone, and admins are told once', async () => {
    const [s] = await students(1);
    const { wave } = await dinner([s]);
    await db.call(attendant, 'close_aisle_wave', wave, true, null, null);
    await jobs();
    await jobs();
    expect((await events())[0].status).toBe('PENDING');
    expect(await db.admin(`select kind from public.admin_alerts`)).toEqual([{ kind: 'ROUND_NOT_FINISHED' }]);
    // Finishing the round late is still possible and then lets it become final.
    await db.call(attendant, 'finish_collection_round', wave, true, 'finished after closing');
    await jobs();
    expect((await events())[0].status).toBe('VERIFIED');
  });
});

describe('what never counts', () => {
  test('cancelling in time, being on standby without an offer, or ignoring an offer', async () => {
    const list = await students(32);
    const { meal, wave } = await dinner([]);
    // Book into the next dinner instead, with cancellations and standby.
    await db.call(attendant, 'close_aisle_wave', wave, true, null, null);
    const start = new Date(Date.now() + 10 * 60_000).toISOString();
    const next = (await db.call(admin, 'create_meal_service', '2026-12-20', 'DINNER', start)).meal_service_id as string;
    const w = ((await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, next, null)).wave as { wave_id: string }).wave_id;
    for (const s of list) await db.call(s.id, 'book_meal', next, null);   // 30 confirmed, 2 standby
    await db.call(list[0].id, 'cancel_booking', next, null);              // cancelled before the gate: seat goes to standby
    await skip(11);
    await jobs();
    for (const s of list.slice(1)) await record(w, s.coupon).catch(() => undefined);
    await skip(10);
    await jobs();
    await db.call(attendant, 'record_occupancy_snapshot', w, 29, null);
    await jobs();                                                          // one standby student is offered, ignores it
    await skip(1.5);
    await jobs();
    await endDinner(w);
    expect(await events()).toEqual([]);
    expect(meal).toBeTruthy();
  });

  test('a diner found in the wrong aisle did eat: not a no-show', async () => {
    const [s] = await students(1);
    const start = new Date(Date.now() + 10 * 60_000).toISOString();
    const meal = (await db.call(admin, 'create_meal_service', '2026-12-21', 'DINNER', start)).meal_service_id as string;
    const a = ((await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, meal, null)).wave as { wave_id: string }).wave_id;
    const b = ((await db.call(attendant, 'mark_aisle_ready', 'B', true, true, true, meal, null)).wave as { wave_id: string }).wave_id;
    await db.call(s.id, 'book_meal', meal, null);                          // aisle A
    await skip(11);
    await jobs();
    expect((await record(b, s.coupon)).exception).toBe('WRONG_WAVE');
    await skip(10);
    await jobs();
    await endDinner(a);
    expect(await events()).toEqual([]);
  });

  test('an accepted invitation not honoured does count, as an invitation', async () => {
    const list = await students(31);
    const { wave } = await dinner(list, list.slice(0, 29));
    await db.call(attendant, 'record_occupancy_snapshot', wave, 29, null);
    await jobs();
    const [offer] = await db.admin<{ id: string; user_id: string }>(`select id, user_id from public.standby_offers`);
    await db.call(offer.user_id, 'respond_to_offer', offer.id, true, true);
    await skip(10);
    await jobs();
    await endDinner(wave);
    const ev = await events(`user_id = '${offer.user_id}'`);
    expect(ev).toEqual([expect.objectContaining({ status: 'VERIFIED', commitment: 'INVITATION' })]);
  });
});

describe('corrections reverse everything that depended on them', () => {
  test('a coupon entered late reverses a verified no-show and its notice; undoing that entry brings it back', async () => {
    const [s] = await students(1);
    const { wave } = await dinner([s]);
    await endDinner(wave);
    const rec = await record(wave, s.coupon, 'PAPER_BACKFILL');
    expect(rec.status).toBe('RECORDED');
    expect((await events())[0].status).toBe('REVERSED');
    expect(await penalties(s.id)).toEqual([expect.objectContaining({ level: 'REMINDER', status: 'REVERSED' })]);
    expect(await notes(s.id)).toEqual(['NO_SHOW_REMINDER', 'PENALTY_LIFTED']);

    await db.call(attendant, 'void_attendance', rec.record_id, 'Wrong coupon typed from the paper list');
    expect((await events())[0].status).toBe('PENDING');
    await jobs();
    expect((await events())[0].status).toBe('VERIFIED');
    expect(await penalties(s.id)).toEqual([expect.objectContaining({ level: 'REMINDER', status: 'ACTIVE' })]);
  });
});

describe('the ladder', () => {
  async function missMeals(s: Student, n: number) {
    for (let i = 0; i < n; i++) {
      const { wave } = await dinner([s]);
      await endDinner(wave);
    }
  }

  test('reminder, warning, one-meal priority reduction with one admin alert, then review', async () => {
    const [s] = await students(1);
    // The 4th dinner is booked under reduced priority: standby, never seated, so nothing to miss.
    // The 5th dinner is the 4th missed meal.
    await missMeals(s, 5);
    expect((await penalties(s.id)).map((p) => [p.level, p.count_in_window])).toEqual([
      ['REMINDER', 1], ['WARNING', 2], ['PRIORITY_REDUCTION', 3], ['REVIEW', 4],
    ]);
    expect(await notes(s.id)).toEqual(['NO_SHOW_REMINDER', 'NO_SHOW_WARNING', 'NO_SHOW_PRIORITY_REDUCTION', 'NO_SHOW_REVIEW']);
    expect((await db.admin<{ kind: string }>('select kind from public.admin_alerts order by created_at')).map((a) => a.kind))
      .toEqual(['REPEATED_NO_SHOWS', 'NO_SHOW_REVIEW']);
    await jobs();
    expect(await penalties(s.id)).toHaveLength(4);
  });

  test('only no-shows inside the 30-day window count', async () => {
    const [s] = await students(1);
    await missMeals(s, 2);
    await skip(31 * 24 * 60);
    await missMeals(s, 1);
    expect((await penalties(s.id)).map((p) => p.level)).toEqual(['REMINDER', 'WARNING', 'REMINDER']);
  });

  test('reduced priority: the next booking goes to standby, but the student can still be invited', async () => {
    const [s] = await students(1);
    await missMeals(s, 3);
    const others = await students(2);
    const start = new Date(Date.now() + 10 * 60_000).toISOString();
    const meal = (await db.call(admin, 'create_meal_service', '2026-12-25', 'DINNER', start)).meal_service_id as string;
    const w = ((await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, meal, null)).wave as { wave_id: string }).wave_id;

    expect((await db.call(s.id, 'book_meal', meal, null)).status).toBe('STANDBY');      // seats are free, still standby
    expect((await db.call(others[0].id, 'book_meal', meal, null)).status).toBe('CONFIRMED');
    expect(await penalties(s.id)).toContainEqual(expect.objectContaining({ level: 'PRIORITY_REDUCTION', status: 'CONSUMED' }));
    const h = await db.call(s.id, 'my_dining_history', 10);
    expect(h).toMatchObject({ missed_in_window: 3, reduced_priority_pending: false });

    await skip(11);
    await jobs();
    await record(w, others[0].coupon);
    await skip(10);
    await jobs();
    await db.call(attendant, 'record_occupancy_snapshot', w, 1, null);
    await jobs();
    const offers = await db.admin<{ user_id: string }>('select user_id from public.standby_offers');
    expect(offers.map((o) => o.user_id)).toEqual([s.id]);
  });

  test('excusing one of three lifts the priority reduction, also from an upcoming meal, and resolves the alert', async () => {
    const [s] = await students(1);
    await missMeals(s, 3);
    const start = new Date(Date.now() + 10 * 60_000).toISOString();
    const meal = (await db.call(admin, 'create_meal_service', '2026-12-26', 'DINNER', start)).meal_service_id as string;
    await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, meal, null);
    await db.call(s.id, 'book_meal', meal, null);
    const [first] = await events(`user_id = '${s.id}'`);

    const r = await db.call(admin, 'decide_no_show', first.id, true, 'Medical certificate shown');
    expect(r).toMatchObject({ status: 'EXCUSED' });
    const [p] = await db.admin<{ priority_tier: number }>(
      'select priority_tier from public.booking_participations where meal_service_id = $1', [meal]);
    expect(p.priority_tier).toBe(0);
    // Two offences remain: they are now the 1st and 2nd.
    expect((await penalties(s.id)).map((x) => [x.level, x.status, x.count_in_window])).toEqual([
      ['REMINDER', 'REVERSED', 1], ['REMINDER', 'ACTIVE', 1], ['WARNING', 'ACTIVE', 2],
    ]);
    expect(await db.admin(`select status from public.admin_alerts where kind = 'REPEATED_NO_SHOWS'`)).toEqual([{ status: 'RESOLVED' }]);
    expect(await db.call(s.id, 'my_dining_history', 10)).toMatchObject({ missed_in_window: 2 });
  });
});

describe('coupon reissue', () => {
  test('a new holder of the coupon inherits nothing', async () => {
    const [s] = await students(1);
    const { wave } = await dinner([s]);
    await endDinner(wave);
    const next = await db.createUser();
    await db.admin(`update public.coupon_claims set status = 'REVOKED', effective_to = now() where user_id = $1`, [s.id]);
    await db.admin(
      `insert into public.coupon_claims (coupon_id, user_id, status, method, effective_from)
       select coupon_id, $2, 'APPROVED', 'STAFF_APPROVAL', now() from public.coupon_claims where user_id = $1`, [s.id, next]);
    expect(await db.call(next, 'my_dining_history', 10)).toMatchObject({ meals: [], missed_in_window: 0 });
    expect(await penalties(next)).toEqual([]);
  });
});

describe('appeals and privacy', () => {
  test('a student explains; an admin upholds or excuses with a reason', async () => {
    const [s, t] = await students(2);
    const { wave } = await dinner([s, t]);
    await endDinner(wave);
    const [es] = await events(`user_id = '${s.id}'`);
    const [et] = await events(`user_id = '${t.id}'`);

    expect((await db.call(s.id, 'submit_no_show_appeal', es.id, 'I was seated, the attendant skipped our table')).status).toBe('SUBMITTED');
    expect((await db.call(s.id, 'submit_no_show_appeal', es.id, 'again')).status).toBe('ALREADY_SUBMITTED');
    await expect(db.call(t.id, 'submit_no_show_appeal', es.id, 'not mine')).rejects.toThrow(/record not found/);
    await expect(db.call(admin, 'decide_no_show', es.id, false, ' ')).rejects.toThrow(/reason is required/);

    expect((await db.call(admin, 'decide_no_show', es.id, false, 'No one at that table matched')).status).toBe('UPHELD');
    expect((await events(`id = '${es.id}'`))[0].status).toBe('VERIFIED');
    expect(await db.admin(`select status from public.no_show_appeals`)).toEqual([{ status: 'UPHELD' }]);

    await db.call(t.id, 'submit_no_show_appeal', et.id, 'Family emergency');
    expect((await db.call(admin, 'decide_no_show', et.id, true, 'Confirmed with the provost')).status).toBe('EXCUSED');
    const h = await db.call(t.id, 'my_dining_history', 10);
    expect((h.meals as Array<{ outcome: string; no_show: { appeal: { status: string } } }>)[0])
      .toMatchObject({ outcome: 'EXCUSED', no_show: { appeal: { status: 'EXCUSED' } } });
  });

  test('students see only their own records; attendants see none; only admins decide', async () => {
    const [s, t] = await students(2);
    const { wave } = await dinner([s, t]);
    await endDinner(wave);
    expect((await db.select<{ user_id: string }>(s.id, 'select user_id from public.no_show_events')).map((r) => r.user_id)).toEqual([s.id]);
    expect(await db.select(attendant, 'select * from public.no_show_events')).toEqual([]);
    const [e] = await events(`user_id = '${s.id}'`);
    await expect(db.call(attendant, 'decide_no_show', e.id, true, 'x')).rejects.toThrow(/requires role ADMIN/);
    await expect(db.call(s.id, 'admin_no_shows', 10)).rejects.toThrow(/requires role ADMIN/);
    const overview = await db.call(admin, 'admin_no_shows', 10);
    expect((overview.records as unknown[]).length).toBe(2);
  });
});
