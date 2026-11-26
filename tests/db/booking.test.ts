import { beforeEach, describe, expect, test } from 'vitest';
import { freshDb, type Db } from './harness';

let db: Db;
let admin: string;
let attendant: string;
let nextCoupon = 1000;

/** Verified students (coupon claims inserted directly; claim rules are tested elsewhere). */
async function students(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await db.createUser());
  const first = nextCoupon;
  nextCoupon += n;
  await db.admin(`insert into public.coupons (coupon_number) select g from generate_series($1::int, $2::int) g`,
    [first, first + n - 1]);
  await db.admin(
    `insert into public.coupon_claims (coupon_id, user_id, status, method, effective_from)
     select c.id, u.id, 'APPROVED', 'STAFF_APPROVAL', now()
     from unnest($1::uuid[]) with ordinality as u(id, ord)
     join public.coupons c on c.coupon_number = $2 + u.ord - 1`, [ids, first]);
  return ids;
}

/** A dinner whose gate opens `minutesFromNow` minutes from now. */
async function dinner(minutesFromNow: number): Promise<string> {
  const start = new Date(Date.now() + minutesFromNow * 60_000).toISOString();
  const r = await db.call(admin, 'create_meal_service', '2026-11-04', 'DINNER', start);
  return r.meal_service_id as string;
}

async function ready(aisle: 'A' | 'B', meal: string) {
  return db.call(attendant, 'mark_aisle_ready', aisle, true, true, true, meal, null);
}

const book = (student: string, meal: string, key: string | null = null) => db.call(student, 'book_meal', meal, key);
const cancel = (student: string, meal: string) => db.call(student, 'cancel_booking', meal, null);

async function held(meal: string) {
  return db.admin<{ aisle_code: string; held_seats: number; capacity: number }>(
    `select aisle_code, held_seats, capacity from public.aisle_waves
     where meal_service_id = $1 and phase <> 'CLOSED' order by aisle_code`, [meal]);
}

/** Standby user ids in queue order (registrations in the same instant are ordered by the random tiebreak). */
async function queue(meal: string): Promise<string[]> {
  const rows = await db.admin<{ user_id: string }>(
    `select user_id from public.booking_participations where meal_service_id = $1 and status = 'STANDBY'
     order by priority_tier, queued_at, queue_tiebreak`, [meal]);
  return rows.map((r) => r.user_id);
}

async function statusOf(student: string, meal: string) {
  const [row] = await db.admin<{ status: string }>(
    'select status from public.booking_participations where user_id = $1 and meal_service_id = $2', [student, meal]);
  return row?.status;
}

beforeEach(async () => {
  db = await freshDb();
  admin = await db.createUser('ADMIN');
  attendant = await db.createUser('ATTENDANT');
});

describe('initial confirmed allocation', () => {
  test('both aisles ready: exactly 60 confirmed, the rest on standby', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    await ready('B', meal);
    const s = await students(70);
    const results = [];
    for (const id of s) results.push((await book(id, meal)).status);

    expect(results.filter((r) => r === 'CONFIRMED')).toHaveLength(60);
    expect(results.filter((r) => r === 'STANDBY')).toHaveLength(10);
    expect(results.slice(0, 60).every((r) => r === 'CONFIRMED')).toBe(true); // first come, first served
    expect(await held(meal)).toEqual([
      { aisle_code: 'A', held_seats: 30, capacity: 30 },
      { aisle_code: 'B', held_seats: 30, capacity: 30 },
    ]);
  });

  test('one aisle ready: exactly 30 confirmed', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const s = await students(40);
    for (const id of s) await book(id, meal);
    expect(await db.admin(`select count(*)::int as n from public.reservations`)).toEqual([{ n: 30 }]);
    expect(await db.call(admin, 'meal_service_summary', meal))
      .toEqual({ window: 'OPEN', live_wave_capacity: 30, held_seats: 30, standby: 10 });
  });

  test('booking references follow DIN-date-aisle-seq and never encode the coupon', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const [s] = await students(1);
    const r = await book(s, meal);
    expect(r).toMatchObject({ status: 'CONFIRMED', booking_ref: 'DIN-2026-11-04-A-001', aisle: 'A', coupon_number: nextCoupon - 1 });
    const [n] = await db.admin<{ kind: string; payload: { booking_ref: string } }>(
      'select kind, payload from public.notification_outbox where recipient_id = $1', [s]);
    expect(n).toMatchObject({ kind: 'BOOKING_CONFIRMED', payload: { booking_ref: 'DIN-2026-11-04-A-001' } });
  });

  test('confirmed bookings must arrive within the confirmed window (T+10)', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const [s] = await students(1);
    await book(s, meal);
    const [r] = await db.admin<{ gap: number }>(
      `select extract(epoch from (r.arrive_by - m.service_start_at))::int / 60 as gap
       from public.reservations r join public.meal_services m on m.id = r.meal_service_id`);
    expect(r.gap).toBe(10);
  });
});

describe('one entitlement per coupon per meal service', () => {
  test('repeated taps return the same booking', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const [s] = await students(1);
    const first = await book(s, meal);
    const again = await book(s, meal);
    expect(again).toMatchObject({ status: 'ALREADY_REGISTERED', booking_ref: first.booking_ref });
    expect(await book(s, meal, 'tap-00000001')).toMatchObject({ status: 'ALREADY_REGISTERED' });
    expect(await db.admin(`select count(*)::int as n from public.reservations`)).toEqual([{ n: 1 }]);
  });

  test('two accounts can never both book coupon 245; the conflict is logged', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const [owner] = await students(1);
    await book(owner, meal);

    // The coupon is reassigned mid-day to another account.
    const other = await db.createUser();
    await db.admin(`update public.coupon_claims set status = 'REVOKED', effective_to = now() where user_id = $1`, [owner]);
    await db.admin(
      `insert into public.coupon_claims (coupon_id, user_id, status, method, effective_from)
       select coupon_id, $2, 'APPROVED', 'STAFF_APPROVAL', now() from public.coupon_claims where user_id = $1`,
      [owner, other]);

    expect((await book(other, meal)).status).toBe('COUPON_CONFLICT');
    expect(await db.admin('select kind from public.admin_alerts')).toEqual([{ kind: 'IDENTITY_CONFLICT' }]);
  });

  test('two seat holds for one coupon are impossible at the database level', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const [s] = await students(1);
    await book(s, meal);
    await expect(db.admin(
      `insert into public.reservations (booking_ref, participation_id, meal_service_id, wave_id, aisle_code,
         user_id, coupon_id, coupon_number, source, arrive_by, policy_version)
       select 'DUP-1', participation_id, meal_service_id, wave_id, aisle_code, user_id, coupon_id, coupon_number,
              'INITIAL_BOOKING', arrive_by, policy_version from public.reservations`))
      .rejects.toThrow(/reservations_one_hold_per_coupon/);
  });

  test('unverified students cannot book', async () => {
    const meal = await dinner(10);
    const s = await db.createUser();
    expect((await book(s, meal)).status).toBe('NOT_VERIFIED');
  });

  test('a seat hold never moves to another student or coupon', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const [a, b] = await students(2);
    await book(a, meal);
    await expect(db.admin('update public.reservations set user_id = $1', [b])).rejects.toThrow(/immutable/);
    await expect(db.admin('update public.reservations set coupon_number = 1')).rejects.toThrow(/immutable/);
  });
});

describe('capacity holds', () => {
  test('a 31st seat hold in a 30-seat wave is impossible at the database level', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const s = await students(31);
    for (const id of s.slice(0, 30)) await book(id, meal);
    await book(s[30], meal); // standby
    await expect(db.admin(
      `insert into public.reservations (booking_ref, participation_id, meal_service_id, wave_id, aisle_code,
         user_id, coupon_id, coupon_number, source, arrive_by, policy_version)
       select 'OVER-1', p.id, p.meal_service_id, w.id, 'A', p.user_id, p.coupon_id, p.coupon_number,
              'INITIAL_BOOKING', now(), 2
       from public.booking_participations p, public.aisle_waves w where p.status = 'STANDBY'`))
      .rejects.toThrow(/aisle_waves_holds_within_capacity/);
  });

  test('standby registrations never consume seats', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const s = await students(35);
    for (const id of s) await book(id, meal);
    expect((await held(meal))[0].held_seats).toBe(30);
    expect(await db.admin(`select count(*)::int as n from public.reservations`)).toEqual([{ n: 30 }]);
  });

  test('marking seats unusable below current holds is refused', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    for (const id of await students(29)) await book(id, meal);
    expect((await db.call(attendant, 'set_aisle_unusable_seats', 'A', 2, 'broken')).status).toBe('HOLDS_EXCEED_CAPACITY');
    expect((await db.call(attendant, 'set_aisle_unusable_seats', 'A', 1, 'broken')).status).toBe('OK');
  });

  test('no seat can be held in a closed wave', async () => {
    const meal = await dinner(10);
    const r = await ready('A', meal);
    const wave = (r.wave as { wave_id: string }).wave_id;
    const [s] = await students(1);
    await book(s, meal);
    await db.call(attendant, 'close_aisle_wave', wave, true, null, null);
    await expect(db.admin(
      `insert into public.reservations (booking_ref, participation_id, meal_service_id, wave_id, aisle_code,
         user_id, coupon_id, coupon_number, source, arrive_by, policy_version)
       select 'LATE-1', participation_id, meal_service_id, wave_id, aisle_code, user_id, coupon_id, coupon_number,
              'INITIAL_BOOKING', arrive_by, policy_version from public.reservations`))
      .rejects.toThrow(/closed wave/);
  });
});

describe('booking window', () => {
  test('before T−15 booking is not open', async () => {
    const meal = await dinner(20);
    await ready('A', meal);
    const [s] = await students(1);
    expect((await book(s, meal)).status).toBe('BOOKING_NOT_OPEN');
  });

  test('after the gate opens, new registrations join standby even if seats look free', async () => {
    const meal = await dinner(-1);
    await ready('A', meal);
    const [s] = await students(1);
    expect(await book(s, meal)).toMatchObject({ status: 'STANDBY', participation: 'STANDBY' });
    expect((await held(meal))[0].held_seats).toBe(0);
  });

  test('a closed meal service takes no bookings', async () => {
    const meal = await dinner(10);
    await db.call(admin, 'set_meal_service_state', meal, 'CANCELLED');
    const [s] = await students(1);
    expect((await book(s, meal)).status).toBe('BOOKING_CLOSED');
  });
});

describe('standby queue', () => {
  test('standby students see a position band and the do-not-come message', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const s = await students(42);
    for (const id of s) await book(id, meal);
    const order = await queue(meal); // 12 waiting
    expect(await db.call(order[0], 'my_booking_status', meal)).toMatchObject({
      participation: 'STANDBY', standby_band: '1-5',
      message: 'You are on standby. Do not come unless you receive an individual invitation.',
    });
    expect(await db.call(order[11], 'my_booking_status', meal)).toMatchObject({ standby_band: '11-20' });
  });

  test('a cancellation before the gate goes to the head of the queue', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const s = await students(33);
    for (const id of s) await book(id, meal);
    const [head, ...rest] = await queue(meal);

    expect(await cancel(s[5], meal)).toEqual({ status: 'CANCELLED', seat_released: true, promoted: 1 });
    expect(await statusOf(head, meal)).toBe('CONFIRMED');
    expect(await queue(meal)).toEqual(rest);
    expect((await held(meal))[0].held_seats).toBe(30);
    const [n] = await db.admin<{ kind: string }>(
      `select kind from public.notification_outbox where recipient_id = $1 and kind <> 'STANDBY_REGISTERED'`, [head]);
    expect(n.kind).toBe('PROMOTED_FROM_STANDBY');
  });

  test('an aisle readied later in the window pulls from the queue in order', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const s = await students(45);
    for (const id of s) await book(id, meal);
    const order = await queue(meal);
    expect(new Set(order)).toEqual(new Set(s.slice(30, 45)));
    const r = await ready('B', meal);
    expect((r.wave as { promoted_from_standby: number }).promoted_from_standby).toBe(15);
    const rows = await db.admin<{ user_id: string }>(
      `select user_id from public.reservations where aisle_code = 'B' order by booking_ref`);
    expect(rows.map((x) => x.user_id)).toEqual(order);
  });

  test('inside the cutoff (T−5) nobody is promoted; a newcomer cannot jump the queue', async () => {
    const meal = await dinner(3);
    await ready('A', meal);
    const s = await students(32);
    for (const id of s) await book(id, meal);           // 30 confirmed, 2 standby
    expect(await cancel(s[0], meal)).toEqual({ status: 'CANCELLED', seat_released: true, promoted: 0 });
    expect(await statusOf(s[30], meal)).toBe('STANDBY');

    const [late] = await students(1);
    expect((await book(late, meal)).status).toBe('STANDBY'); // two people are queued ahead
  });

  test('inside the cutoff a newcomer still gets a free seat when nobody is waiting', async () => {
    const meal = await dinner(3);
    await ready('A', meal);
    const [s] = await students(1);
    expect((await book(s, meal)).status).toBe('CONFIRMED');
  });

  test('leaving standby and rejoining puts you at the back', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const s = await students(33);
    for (const id of s) await book(id, meal);
    const [first] = await queue(meal);
    expect(await cancel(first, meal)).toEqual({ status: 'LEFT_STANDBY' });
    expect((await book(first, meal)).status).toBe('STANDBY');
    const order = await queue(meal);
    expect(order[order.length - 1]).toBe(first);
    await cancel(s[0], meal);
    expect(await statusOf(order[0], meal)).toBe('CONFIRMED');
    expect(await statusOf(first, meal)).toBe('STANDBY');
  });

  test('a student who lost their coupon is skipped by the queue', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const s = await students(32);
    for (const id of s) await book(id, meal);
    const [head, second] = await queue(meal);
    await db.admin(`update public.coupon_claims set status = 'REVOKED', effective_to = now() where user_id = $1`, [head]);
    await cancel(s[0], meal);
    expect(await statusOf(head, meal)).toBe('STANDBY');
    expect(await statusOf(second, meal)).toBe('CONFIRMED');
  });
});

describe('cancellation after the gate opens', () => {
  test('keeps holding the seat until physical vacancy is verified', async () => {
    const meal = await dinner(10);
    const r = await ready('A', meal);
    const wave = (r.wave as { wave_id: string }).wave_id;
    const s = await students(2);
    for (const id of s) await book(id, meal);
    await db.call(attendant, 'advance_wave_phase', wave, 'ADMITTING'); // gate open

    expect(await cancel(s[0], meal)).toEqual({ status: 'CANCELLED', seat_released: false, promoted: 0 });
    const [res] = await db.admin<{ state: string }>('select state from public.reservations where user_id = $1', [s[0]]);
    expect(res.state).toBe('CANCELLED_PENDING_VACANCY');
    expect((await held(meal))[0].held_seats).toBe(2);
  });

  test('closing the wave: unrecorded bookings await reconciliation, they are not no-shows', async () => {
    const meal = await dinner(10);
    const r = await ready('A', meal);
    const wave = (r.wave as { wave_id: string }).wave_id;
    const s = await students(3);
    for (const id of s) await book(id, meal);
    await db.call(attendant, 'advance_wave_phase', wave, 'ADMITTING');
    await cancel(s[0], meal);

    const closed = await db.call(attendant, 'close_aisle_wave', wave, true, null, null);
    expect(closed).toMatchObject({ status: 'CLOSED', pending_reconciliation: 2 });
    const states = await db.admin<{ state: string }>('select state from public.reservations order by booking_ref');
    expect(states.map((x) => x.state)).toEqual(['CANCELLED', 'EXPIRED_PENDING_RECONCILIATION', 'EXPIRED_PENDING_RECONCILIATION']);
  });
});

describe('privacy', () => {
  test('students see only their own bookings and notifications; attendants see all bookings', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    const [a, b] = await students(2);
    await book(a, meal);
    await book(b, meal);
    expect((await db.select(a, 'select user_id from public.reservations')).map((r) => r.user_id)).toEqual([a]);
    expect((await db.select(a, 'select user_id from public.booking_participations')).map((r) => r.user_id)).toEqual([a]);
    expect((await db.select(a, 'select recipient_id from public.notification_outbox')).every((r) => r.recipient_id === a)).toBe(true);
    expect(await db.select(attendant, 'select 1 from public.reservations')).toHaveLength(2);
    expect(await db.select(attendant, 'select 1 from public.notification_outbox')).toHaveLength(0);
  });

  test('students cannot write bookings directly', async () => {
    const meal = await dinner(10);
    const [s] = await students(1);
    await expect(db.select(s, `update public.aisle_waves set held_seats = 0`)).rejects.toThrow(/permission denied/);
    await expect(db.select(s,
      `insert into public.booking_participations (meal_service_id, user_id, coupon_id, coupon_number, status)
       values ($1, $2, gen_random_uuid(), 1, 'CONFIRMED')`, [meal, s])).rejects.toThrow(/permission denied/);
  });
});

describe('burst of requests', () => {
  test('300 students tapping in random order, many twice, never exceed 60 seats or double-book', async () => {
    const meal = await dinner(10);
    await ready('A', meal);
    await ready('B', meal);
    const s = await students(300);
    const taps = [...s, ...s.slice(0, 150)].sort(() => Math.random() - 0.5);
    for (const id of taps) await book(id, meal);

    const [counts] = await db.admin<{ holds: number; parts: number; coupons: number }>(
      `select (select count(*) from public.reservations where state = 'CONFIRMED')::int as holds,
              (select count(*) from public.booking_participations)::int as parts,
              (select count(distinct coupon_id) from public.booking_participations)::int as coupons`);
    expect(counts).toEqual({ holds: 60, parts: 300, coupons: 300 });
    expect((await held(meal)).map((w) => w.held_seats)).toEqual([30, 30]);
  }, 120_000);
});
