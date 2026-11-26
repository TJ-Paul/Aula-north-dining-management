import { beforeEach, describe, expect, test } from 'vitest';
import { skipAheadSql } from './time-travel';
import { freshDb, type Db } from './harness';

let db: Db;
let admin: string;
let door: string;
let nextCoupon = 1;
let day = 0;

type Student = { id: string; coupon: number };
type Batch = { number: number; phase: string; capacity: number; taken: number; arrived: number; starts_at: string | null };
type Seat = { state: string; kind: string; deadline: string | null; lapsed: boolean; token: string };

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

/** A dinner starting in `inMinutes` with `seats` per batch (standard timings: booking 15 min before, 10 min to arrive). */
async function meal(inMinutes: number, seats = 3, type = 'DINNER', occasion = 'FEAST') {
  const date = new Date(Date.UTC(2030, 0, 1 + day++)).toISOString().slice(0, 10);
  const id = (await db.call(admin, 'create_meal_event', date, type, at(inMinutes), null, occasion === 'REGULAR' ? null : 'Event',
    occasion, null, null, null)).meal_service_id as string;
  await db.call(admin, 'set_batch_capacity', id, seats);
  return id;
}
const book = (s: Student, m: string) => db.call(s.id, 'book_seat', m);
const seating = async (s: Student | string, m: string) => db.call(typeof s === 'string' ? s : s.id, 'meal_seating', m);
const batch = async (m: string) => (await seating(admin, m)).batch as Batch;
const mine = async (s: Student, m: string) => (await seating(s, m)).mine as Seat;
const checkIn = (m: string, coupon: number) => db.call(door, 'door_check_in', m, coupon);

beforeEach(async () => {
  db = await freshDb();
  admin = await db.createUser('SUPER_ADMIN', { name: 'Hall Office' });
  door = await db.createUser('ATTENDANT', { name: 'Door' });
});

describe('booking a batch', () => {
  test('booking opens 15 minutes before; every booking is a seat until the batch is full; no waiting list', async () => {
    const [a, b, c, d] = await students(4);
    const m = await meal(20);
    expect((await book(a, m)).status).toBe('BOOKING_NOT_OPEN');
    await skip(6);
    expect(await batch(m)).toMatchObject({ number: 1, phase: 'BOOKING', capacity: 3, taken: 0 });
    expect((await book(a, m)).status).toBe('BOOKED');
    expect((await book(a, m)).status).toBe('ALREADY_BOOKED');
    await book(b, m);
    await book(c, m);
    expect(await batch(m)).toMatchObject({ taken: 3 });
    expect((await book(d, m)).status).toBe('FULL');
    expect(await mine(a, m)).toMatchObject({ state: 'HOLDING', kind: 'BOOKED', token: 'B1-001', lapsed: false });
    // Cancelling before the start gives the seat back.
    expect((await db.call(c.id, 'cancel_seat', m)).status).toBe('CANCELLED');
    expect((await book(d, m)).status).toBe('BOOKED');
  });

  test('saying "not coming" blocks booking; booking blocks saying "not coming"', async () => {
    const [a, b] = await students(2);
    const m = await meal(300);
    await db.call(a.id, 'set_not_coming', m, true, null);
    await skip(290);
    expect((await book(a, m)).status).toBe('SAID_NOT_COMING');
    await db.call(admin, 'set_not_coming_deadline', m, 0);
    await book(b, m);
    expect((await db.call(b.id, 'set_not_coming', m, true, null)).status).toBe('CANCEL_BOOKING_FIRST');
  });
});

describe('arriving', () => {
  test('the door marks booked students in', async () => {
    const [a, b] = await students(2);
    const m = await meal(10);
    await book(a, m);
    await book(b, m);
    await skip(11);
    expect(await batch(m)).toMatchObject({ phase: 'ARRIVING' });
    const r = await checkIn(m, a.coupon);
    expect(r).toMatchObject({ status: 'ARRIVED', name: `Student ${a.coupon}` });
    expect((await checkIn(m, a.coupon)).status).toBe('ALREADY_ARRIVED');
    const dir = (await db.call(door, 'door_directory', m)) as unknown as Array<Record<string, unknown>>;
    expect(dir.find((d) => d.coupon_number === a.coupon)).toMatchObject({ name: `Student ${a.coupon}`, ate: true, seat: { state: 'ARRIVED', batch: 1 } });
    expect(dir.find((d) => d.coupon_number === b.coupon)).toMatchObject({ ate: false, seat: { state: 'HOLDING', kind: 'BOOKED' } });
    await expect(db.call(a.id, 'door_directory', m)).rejects.toThrow(/requires role/);
    expect((await checkIn(m, 999)).status).toBe('UNKNOWN_COUPON');
    expect(await batch(m)).toMatchObject({ taken: 2, arrived: 1 });
    // Their attendance counts for ratings and "who ate" like before.
    expect((await seating(a, m)).ate).toBe(true);
  });

  test('coupons from an hour before: no booking means they ate, no seat taken; a booking is marked in', async () => {
    const [a, b, c] = await students(3);
    const m = await meal(70, 2);
    expect((await checkIn(m, a.coupon)).status).toBe('BATCH_NOT_STARTED');
    await skip(11);   // 59 minutes to go
    const r = await checkIn(m, a.coupon);
    expect(r).toMatchObject({ status: 'EARLY', name: `Student ${a.coupon}` });
    expect((await checkIn(m, a.coupon)).status).toBe('ALREADY_ARRIVED');
    expect((await seating(a, m)).ate).toBe(true);
    // Shown in "Just came in", and undone if typed by mistake.
    const arrivals = (await db.call(door, 'door_board', m)).arrivals as Array<Record<string, unknown>>;
    expect(arrivals[0]).toMatchObject({ coupon_number: a.coupon, kind: 'EARLY', seat_id: null });
    expect((await db.call(door, 'undo_early_check_in', r.attendance_id)).status).toBe('UNDONE');
    expect((await seating(a, m)).ate).toBe(false);
    expect((await checkIn(m, a.coupon)).status).toBe('EARLY');
    // Booking opens: every seat is still free, and the one who already ate can't book.
    await skip(45);
    expect(await batch(m)).toMatchObject({ phase: 'BOOKING', taken: 0, arrived: 0 });
    expect((await book(a, m)).status).toBe('ALREADY_ATE');
    expect((await book(b, m)).status).toBe('BOOKED');
    // Booked and early: marked in on their own seat.
    expect((await checkIn(m, b.coupon)).status).toBe('ARRIVED');
    expect(await batch(m)).toMatchObject({ taken: 1, arrived: 1 });
    // After the start, no booking is a walk-in as before.
    await skip(15);
    expect((await checkIn(m, c.coupon)).status).toBe('WALK_IN');
    expect((await db.call(door, 'undo_early_check_in', r.attendance_id)).status).toBe('NOT_ARRIVED');
    await expect(db.call(a.id, 'undo_early_check_in', r.attendance_id)).rejects.toThrow(/requires role/);
  });

  test('the 5-minute timer only hurries: when it runs out the seat is kept until "Filled"', async () => {
    const [a, b, c] = await students(3);
    const m = await meal(10, 2);
    await book(a, m);
    await skip(11);
    expect((await book(b, m)).status).toBe('JOIN_NOW');
    expect((await book(c, m)).status).toBe('FULL');
    await skip(30); // well past everyone's 5 minutes
    await jobs();
    expect(await mine(a, m)).toMatchObject({ state: 'HOLDING', lapsed: false });
    expect(await mine(b, m)).toMatchObject({ state: 'HOLDING', lapsed: false });
    expect((await book(c, m)).status).toBe('FULL');
    expect((await checkIn(m, a.coupon)).status).toBe('ARRIVED');
    expect((await checkIn(m, b.coupon)).status).toBe('ARRIVED');
    expect((await db.call(b.id, 'cancel_seat', m)).status).toBe('ALREADY_ARRIVED');
  });

  test('paron: students say "I\'m coming" and the managers see the count', async () => {
    const [a, b] = await students(2);
    const p = await meal(60, 3, 'PARON', 'FEAST');
    expect((await db.call(a.id, 'meal_coming_info', p)).count).toBe(0);
    expect(await db.call(a.id, 'set_coming', p, true)).toMatchObject({ status: 'OK', count: 1 });
    await db.call(b.id, 'set_coming', p, true);
    await db.call(b.id, 'set_coming', p, false);
    expect(await db.call(admin, 'meal_coming_info', p)).toMatchObject({ count: 1, mine: false });
    expect(await db.call(a.id, 'meal_coming_info', p)).toMatchObject({ count: 1, mine: true });
    await skip(61);
    expect((await db.call(b.id, 'set_coming', p, true)).status).toBe('TOO_LATE');
  });

  test('without a booking they still eat, even with the batch full; only they and admins see the walk-in count', async () => {
    const [a, b] = await students(2);
    const m = await meal(10, 1);
    await book(a, m);
    await skip(11);
    expect((await checkIn(m, b.coupon)).status).toBe('WALK_IN');
    expect((await checkIn(m, a.coupon)).status).toBe('ARRIVED');
    expect((await db.call(b.id, 'my_extras')).walk_ins).toBe(1);
    expect((await db.call(a.id, 'my_extras')).walk_ins).toBe(0);
    expect((await db.call(admin, 'admin_person', b.id)).walk_ins).toBe(1);
  });

  test('a mistyped coupon can be undone', async () => {
    const [a, b] = await students(2);
    const m = await meal(10, 3);
    await book(a, m);
    await skip(11);
    const wrong = await checkIn(m, b.coupon);
    expect(wrong.status).toBe('WALK_IN');
    expect((await db.call(door, 'undo_check_in', (wrong.seat as { id: string }).id)).status).toBe('UNDONE');
    expect((await seating(b, m)).ate).toBe(false);
    expect(await batch(m)).toMatchObject({ arrived: 0, taken: 1 });
    await expect(db.call(a.id, 'undo_check_in', (wrong.seat as { id: string }).id)).rejects.toThrow(/requires role/);
  });
});

describe('loading a batch', () => {
  test('"Filled" records no missed meals (amendment 1.7); booking waits for "Start taking bookings" (with a count); then "Gate open"', async () => {
    const [a, b, c] = await students(3);
    const m = await meal(10, 2);
    await book(a, m);
    await book(b, m);
    expect((await db.call(door, 'load_batch', m)).status).toBe('BATCH_NOT_STARTED');
    await skip(11);
    await checkIn(m, a.coupon);
    const r = await db.call(door, 'load_batch', m);
    expect(r).toMatchObject({ status: 'LOADED', batch: 1, arrived: 1, missed: 0, next_batch: null });

    // b's coupon wasn't typed yet: nothing is recorded against them (they may be inside, waiting).
    expect((await db.call(b.id, 'my_dining_history', 10)).missed_in_window).toBe(0);
    expect(await db.admin<{ n: number }>('select count(*)::int as n from public.no_show_events')).toEqual([{ n: 0 }]);

    // Filled: nobody can book until the staff open booking for the next batch.
    const w = await seating(c, m);
    expect(w.batch).toBeNull();
    expect(w.previous).toMatchObject({ number: 1, arrived: 1, missed: 0 });
    expect((await book(c, m)).status).toBe('BOOKING_PAUSED');
    expect((await db.call(door, 'door_board', m)).next_capacity).toBe(2);   // last time's count
    expect(await db.call(door, 'open_next_booking', m, 1)).toMatchObject({ status: 'BOOKING_OPEN', batch: { number: 2, capacity: 1 } });
    expect((await db.call(door, 'open_next_booking', m, 1)).status).toBe('ALREADY_OPEN');
    expect((await db.call(door, 'door_board', m)).next_capacity).toBe(1);   // remembered for next time

    // Batch 2: booking open, gate not open yet; waiting students see an estimate.
    const s = await seating(c, m);
    expect(s.batch).toMatchObject({ number: 2, phase: 'BOOKING', starts_at: null });
    expect(s.previous).toMatchObject({ number: 1, arrived: 1 });
    expect(s.estimate_next_start).toBeTruthy();
    expect((await book(c, m)).status).toBe('BOOKED');
    expect((await book(a, m)).status).toBe('ALREADY_BOOKED'); // a already ate

    expect((await db.call(door, 'start_next_batch', m)).status).toBe('STARTED');
    expect((await db.call(door, 'start_next_batch', m)).status).toBe('ALREADY_STARTED');
    expect((await checkIn(m, c.coupon)).status).toBe('ARRIVED');
    const board = await db.call(door, 'door_board', m);
    expect(board.history).toEqual([expect.objectContaining({ number: 1, arrived: 1, missed: 0 })]);
  });

  test('loading while a "join now" student is still on the way: their seat is released without a missed meal', async () => {
    const [a, b] = await students(2);
    const m = await meal(10, 3);
    await book(a, m);
    await skip(11);
    await checkIn(m, a.coupon);
    expect((await book(b, m)).status).toBe('JOIN_NOW');
    expect(await db.call(door, 'load_batch', m)).toMatchObject({ arrived: 1, missed: 0 });
    expect((await db.call(b.id, 'my_dining_history', 10)).missed_in_window).toBe(0);
    await db.call(door, 'open_next_booking', m, null);
    expect(((await seating(b, m)).batch as Batch)).toMatchObject({ number: 2, capacity: 3 });
  });

  test('closing or cancelling a meal closes its batch and records no missed meals', async () => {
    const [a, b] = await students(2);
    const m1 = await meal(10, 3);
    const m2 = await meal(10, 3, 'LUNCH');
    await book(a, m1);
    await book(b, m2);
    await skip(11);
    await jobs();
    await db.call(admin, 'set_meal_service_state', m1, 'CLOSED', 'done');
    await db.call(admin, 'set_meal_service_state', m2, 'CANCELLED', 'gas');
    expect((await db.call(a.id, 'my_dining_history', 10)).missed_in_window).toBe(0);
    expect((await db.call(b.id, 'my_dining_history', 10)).missed_in_window).toBe(0);
    expect((await book(a, m1)).status).toBe('MEAL_CLOSED');
  });

  test('the door takes coupons from the start until the meal is closed, whatever the batch is doing', async () => {
    const [a, b, c, d] = await students(4);
    const m = await meal(10, 3);
    await book(a, m);
    await skip(11);
    await jobs();   // the meal is now in service
    await checkIn(m, a.coupon);
    await db.call(door, 'load_batch', m);
    // Filled, no booking open yet: still let in (counts in the batch just filled).
    expect((await checkIn(m, b.coupon)).status).toBe('WALK_IN');
    await db.call(door, 'open_next_booking', m, null);
    await book(c, m);
    // Taking bookings, gate not open: a booked student and a walk-in are both let in.
    expect((await checkIn(m, c.coupon)).status).toBe('ARRIVED');
    expect((await checkIn(m, d.coupon)).status).toBe('WALK_IN');
    expect((await checkIn(m, d.coupon)).status).toBe('ALREADY_ARRIVED');
    const board = await db.call(door, 'door_board', m);
    expect((board.arrivals as unknown[]).length).toBe(4);
    expect((await db.call(admin, 'set_meal_service_state', m, 'CLOSED', 'done')).status).toBe('OK');
    const [e] = await students(1);
    expect((await checkIn(m, e.coupon)).status).toBe('MEAL_CLOSED');
  });

  test('a coupon with no account is let in at the door; its walk-in becomes the student\'s once they claim it', async () => {
    const m = await meal(10, 3);
    await db.admin(`insert into public.coupons (coupon_number) values (440)`);
    await skip(11);
    expect((await checkIn(m, 440)).status).toBe('WALK_IN');
    const s = await db.createUser('STUDENT', { name: 'Later' });
    const claim = await db.call(s, 'request_coupon', 440, 'Later', null, 'L440');
    await db.call(admin, 'approve_coupon_claim', claim.claim_id, 'ok', false);
    expect((await db.call(s, 'my_extras')).walk_ins).toBe(1);
    expect((await seating(s, m)).ate).toBe(true);
  });

  test('coupons are taken inside after "Filled": a booked student counts as booked, a walk-in stays in the filled batch', async () => {
    const [a, b, c] = await students(3);
    const m = await meal(10, 3);
    await book(a, m);
    await skip(11);
    await db.call(door, 'load_batch', m);
    // The next batch is already taking bookings when the manager reaches a and b's table.
    await db.call(door, 'open_next_booking', m, 3);
    const ra = await checkIn(m, a.coupon);
    expect(ra.status).toBe('ARRIVED');
    expect(ra.seat).toMatchObject({ kind: 'BOOKED', state: 'ARRIVED', batch_number: 1 });
    const rb = await checkIn(m, b.coupon);
    expect(rb.status).toBe('WALK_IN');
    expect(rb.seat).toMatchObject({ batch_number: 1 });
    // Batch 2's seats are untouched: all 3 are still free for c and the others.
    expect(((await seating(c, m)).batch as Batch)).toMatchObject({ number: 2, taken: 0 });
    expect((await book(a, m)).status).not.toBe('BOOKED');   // a has eaten
    expect((await db.call(a.id, 'my_dining_history', 10)).missed_in_window).toBe(0);
  });
});

describe('with the rest of the system', () => {
  test('"not coming" but came through the door: the mild penalty applies', async () => {
    const [a] = await students(1);
    const m = await meal(300, 3);
    await db.call(a.id, 'set_not_coming', m, true, null);
    await skip(301);
    const r = await checkIn(m, a.coupon);
    expect(r).toMatchObject({ status: 'WALK_IN', said_not_coming: true });
    expect((await db.call(a.id, 'my_points')).balance).toBe(-2);
  });

  test('booked but never typed in, three times: no missed meals, no mark (amendment 1.7)', async () => {
    const [a, b] = await students(2);
    for (let i = 0; i < 3; i++) {
      const m = await meal(10, 3);
      await book(a, m);
      await skip(11);
      await db.call(door, 'load_batch', m);
      await db.call(admin, 'set_meal_service_state', m, 'CLOSED', 'done');
    }
    const m = await meal(15, 3);
    expect((await book(a, m)).status).toBe('BOOKED');
    expect((await book(b, m)).status).toBe('BOOKED');
    const stats = async (id: string) => (await db.admin<{ r: Record<string, unknown> }>('select public.person_stats($1) as r', [id]))[0].r;
    expect(await stats(a.id)).toMatchObject({ missed_recent: 0, missed_marked: false });
    expect(await stats(b.id)).toMatchObject({ missed_recent: 0, missed_marked: false });
  });

  test('admins see each meal\'s batch and seat counts', async () => {
    const [a] = await students(1);
    const m = await meal(10, 5);
    await book(a, m);
    const list = (await db.call(admin, 'admin_meal_services', 10)).meals as Array<Record<string, unknown>>;
    expect(list.find((x) => x.id === m)).toMatchObject({ batch_capacity: 5, seats: 1, batch: { number: 1, taken: 1 } });
  });
});

describe('notifications for everyone', () => {
  const kinds = async (uid: string) => (await db.admin<{ kind: string; message: string }>(
    `select kind, payload ->> 'message' as message from public.notification_outbox where recipient_id = $1 order by created_at`, [uid]));

  test('booking open, batch full, gate open, a new and a cancelled meal, and announcements reach everyone', async () => {
    const [a, b] = await students(2);
    const m = await meal(20, 1);                       // a new special meal
    expect((await kinds(b.id)).map((n) => n.kind)).toContain('MEAL_NEW');
    await skip(6);                                      // booking opens 15 minutes before
    await jobs();
    expect((await kinds(b.id)).find((n) => n.kind === 'BOOKING_OPEN')?.message).toBe('Batch 1 · 1 seats');
    await book(a, m);                                   // the only seat: full
    expect((await kinds(b.id)).map((n) => n.kind)).toContain('BATCH_FULL');
    await skip(15);
    await jobs();                                       // the gate opens at the start
    expect((await kinds(b.id)).find((n) => n.kind === 'GATE_OPEN')?.message).toMatch(/^Batch 1\. Booked students, come now/);
    expect((await kinds(a.id)).some((n) => n.kind === 'BATCH_STARTED' && /^Batch 1 · coupon \d+$/.test(n.message))).toBe(true);

    expect((await db.call(admin, 'post_announcement', 'Water off tomorrow 9–11 am')).status).toBe('SENT');
    expect((await kinds(b.id)).at(-1)).toMatchObject({ kind: 'ANNOUNCEMENT', message: 'Water off tomorrow 9–11 am' });
    expect(((await db.call(b.id, 'list_announcements', 5)) as unknown as unknown[]).length).toBe(1);
    await expect(db.call(a.id, 'post_announcement', 'hi')).rejects.toThrow(/requires role/);

    const later = await meal(300, 3);
    await db.call(admin, 'set_meal_service_state', later, 'CANCELLED', 'gas');
    expect((await kinds(b.id)).at(-1)?.kind).toBe('MEAL_CANCELLED');
    // Editing a meal sends nothing.
    const before = (await kinds(b.id)).length;
    await db.call(admin, 'set_meal_notice', m, 'Bring your coupon');
    expect((await kinds(b.id)).length).toBe(before);
  });

  test('a phone registers for push', async () => {
    const [a] = await students(1);
    expect((await db.call(a.id, 'save_push_subscription', 'https://push.example/abc', 'key', 'auth')).status).toBe('OK');
    expect((await db.call(a.id, 'save_push_subscription', 'http://bad', 'k', 'a')).status).toBe('INVALID');
    expect((await db.admin<{ n: number }>(`select count(*)::int n from public.push_subscriptions`))[0].n).toBe(1);
    await db.call(a.id, 'remove_push_subscription', 'https://push.example/abc');
    expect((await db.admin<{ n: number }>(`select count(*)::int n from public.push_subscriptions`))[0].n).toBe(0);
  });
});

describe('meal ratings', () => {
  test('students rate an improvement, feast or paron any time and change it; plain lunch is not rated', async () => {
    const [a, b] = await students(2);
    const m = await meal(30, 3, 'DINNER', 'IMPROVEMENT');
    expect(await db.call(a.id, 'rate_meal', m, 4)).toMatchObject({ status: 'OK', count: 1, mine: 4 });
    expect(await db.call(a.id, 'rate_meal', m, 5)).toMatchObject({ count: 1, mine: 5 });
    await db.call(b.id, 'rate_meal', m, 3);
    expect(await db.call(b.id, 'meal_rating_info', m)).toMatchObject({ average: 4, count: 2, mine: 3 });
    expect((await db.call(a.id, 'rate_meal', m, 9)).status).toBe('INVALID_STARS');
    expect(await db.call(a.id, 'rate_meal', m, null)).toMatchObject({ count: 1, mine: null });
    const lunch = await meal(30, 3, 'LUNCH', 'REGULAR');
    expect((await db.call(a.id, 'rate_meal', lunch, 5)).status).toBe('NOT_RATEABLE');
  });
});

describe('shared live state (load fix, 2026-11-07)', () => {
  test('meal_live_state is the shared part of meal_seating, holds nothing personal, and only the server may call it', async () => {
    const [a, b] = await students(2);
    const m = await meal(20);
    await skip(6);
    await book(a, m);
    const live = async () => (await db.admin<{ r: Record<string, unknown> }>('select public.meal_live_state($1) as r', [m]))[0].r;
    const shared = await live();
    for (const s of [a, b]) {
      const full = await seating(s, m);
      for (const k of ['meal_state', 'batch', 'previous', 'estimate_next_start']) expect(shared[k]).toEqual(full[k]);
    }
    expect(Object.keys(shared).sort()).toEqual(['as_of', 'batch', 'estimate_next_start', 'meal_state', 'previous']);
    expect(shared.batch).toMatchObject({ taken: 1, phase: 'BOOKING' });
    await expect(db.call(a.id, 'meal_live_state', m)).rejects.toThrow(/permission denied/);
    expect((await db.admin<{ r: unknown }>('select public.meal_live_state(gen_random_uuid()) as r'))[0].r).toBeNull();
  });
});

describe('Lucky? places (amendments 1.4, 1.6)', () => {
  test('after X seats, 10% more book as LUCKY; then Full straight away', async () => {
    const ss = await students(24);
    const m = await meal(20, 20);          // 20 seats 2 Lucky? places
    await skip(6);
    for (const s of ss.slice(0, 20)) expect((await book(s, m)).status).toBe('BOOKED');
    expect((await book(ss[20], m)).status).toBe('LUCKY');
    expect((await book(ss[21], m)).status).toBe('LUCKY');
    expect((await book(ss[22], m)).status).toBe('FULL');
    expect(await batch(m)).toMatchObject({ taken: 20, capacity: 20, lucky_taken: 2, lucky_capacity: 2 });
    expect(await mine(ss[20], m)).toMatchObject({ kind: 'LUCKY', state: 'HOLDING' });
    // A Lucky? student cancelling frees a Lucky? place, not a seat.
    expect((await db.call(ss[21].id, 'cancel_seat', m)).status).toBe('CANCELLED');
    expect((await book(ss[23], m)).status).toBe('LUCKY');
  });

  test('a confirmed seat cancelled before the gate goes to the first Lucky?; after the gate it does not', async () => {
    const ss = await students(23);
    const m = await meal(20, 20);
    await skip(6);
    for (const s of ss.slice(0, 23)) await book(s, m);
    expect((await db.call(ss[3].id, 'cancel_seat', m)).status).toBe('CANCELLED');
    expect(await mine(ss[20], m)).toMatchObject({ kind: 'BOOKED', state: 'HOLDING' });   // first Lucky? moved up
    expect(await mine(ss[21], m)).toMatchObject({ kind: 'LUCKY' });
    expect(await batch(m)).toMatchObject({ taken: 20, lucky_taken: 1 });
    const notes = await db.admin<{ n: number }>(
      `select count(*)::int as n from public.notification_outbox where recipient_id = $1 and payload->>'title' = 'Moved up to a seat'`, [ss[20].id]);
    expect(notes[0].n).toBe(1);
    await skip(15);                          // the gate opens
    expect((await db.call(ss[4].id, 'cancel_seat', m)).status).toBe('CANCELLED');
    expect(await mine(ss[21], m)).toMatchObject({ kind: 'LUCKY' });
  });

  test('door: Lucky? students check in as Lucky?; "Filled" records no missed meals', async () => {
    const ss = await students(23);
    const m = await meal(20, 20);
    await skip(6);
    for (const s of ss.slice(0, 22)) await book(s, m);
    await skip(15);
    expect((await checkIn(m, ss[0].coupon)).seat).toMatchObject({ kind: 'BOOKED', state: 'ARRIVED' });
    expect((await checkIn(m, ss[20].coupon)).seat).toMatchObject({ kind: 'LUCKY', state: 'ARRIVED' });
    expect((await checkIn(m, ss[22].coupon)).status).toBe('WALK_IN');
    const r = await db.call(door, 'load_batch', m);
    expect(r).toMatchObject({ status: 'LOADED', missed: 0 });
    // Coupons typed inside after Filled still count as booked / Lucky?.
    expect((await checkIn(m, ss[1].coupon)).seat).toMatchObject({ kind: 'BOOKED', state: 'ARRIVED' });
    expect((await checkIn(m, ss[21].coupon)).seat).toMatchObject({ kind: 'LUCKY', state: 'ARRIVED' });
    const missed = await db.admin<{ n: number }>('select count(*)::int as n from public.no_show_events');
    expect(missed[0].n).toBe(0);
  });

  test('small batches have no Lucky? places (9 seats 0)', async () => {
    const ss = await students(10);
    const m = await meal(20, 9);
    await skip(6);
    for (const s of ss.slice(0, 9)) await book(s, m);
    expect((await book(ss[9], m)).status).toBe('FULL');
  });
});

describe('home screen in one call (load fix)', () => {
  test('my_home has the profile, booking cards and mark; meals_board is the shared list, server only', async () => {
    const [a] = await students(1);
    const m = await meal(20, 10);
    await skip(6);
    await book(a, m);
    const home = await db.call(a.id, 'my_home') as unknown as Record<string, any>;
    expect(home.profile).toMatchObject({ id: a.id, coupon_number: a.coupon });
    expect(home.seating[m]).toMatchObject({ mine: { kind: 'BOOKED', state: 'HOLDING' }, batch: { taken: 1 } });
    expect(home.rsvps[m]).toMatchObject({ booked: true });
    expect(home.missed).toMatchObject({ count: 0, marked: false });
    const board = (await db.admin<{ r: { meals: Array<{ id: string; special: boolean }> } }>('select public.meals_board() as r'))[0].r;
    expect(board.meals.find((x) => x.id === m)).toMatchObject({ special: true });
    await expect(db.call(a.id, 'meals_board')).rejects.toThrow(/permission denied/);
  });
});
