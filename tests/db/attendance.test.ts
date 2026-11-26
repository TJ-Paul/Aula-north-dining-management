import { beforeEach, describe, expect, test } from 'vitest';
import { freshDb, type Db } from './harness';

let db: Db;
let admin: string;
let attendant: string;
let meal: string;
let waveA: string;
let waveB: string;
let entry = 0;
let nextCoupon = 1000;

const eid = () => `entry-${String(++entry).padStart(6, '0')}`;

/** Verified students with consecutive coupons; returns [userId, couponNumber][] */
async function students(n: number): Promise<Array<[string, number]>> {
  const out: Array<[string, number]> = [];
  for (let i = 0; i < n; i++) out.push([await db.createUser(), nextCoupon + i]);
  await db.admin(`insert into public.coupons (coupon_number) select g from generate_series($1::int, $2::int) g`,
    [nextCoupon, nextCoupon + n - 1]);
  await db.admin(
    `insert into public.coupon_claims (coupon_id, user_id, status, method, effective_from)
     select c.id, u.id, 'APPROVED', 'STAFF_APPROVAL', now()
     from unnest($1::uuid[]) with ordinality as u(id, ord)
     join public.coupons c on c.coupon_number = $2 + u.ord - 1`, [out.map((s) => s[0]), nextCoupon]);
  nextCoupon += n;
  return out;
}

const record = (wave: string, coupon: number, opts: { by?: string; id?: string; source?: string; observedAt?: string } = {}) =>
  db.call(opts.by ?? attendant, 'record_coupon', wave, coupon, opts.id ?? eid(), opts.source ?? 'LIVE', opts.observedAt ?? null);

const snapshot = (wave: string, headcount: number) =>
  db.call(attendant, 'record_occupancy_snapshot', wave, headcount, null);

async function reservationState(coupon: number) {
  const [r] = await db.admin<{ state: string }>('select state from public.reservations where coupon_number = $1', [coupon]);
  return r?.state;
}

async function board() {
  return (await db.call(attendant, 'attendant_board', meal)) as unknown as Array<Record<string, any>>;
}

beforeEach(async () => {
  db = await freshDb();
  admin = await db.createUser('ADMIN', { name: 'Admin' });
  attendant = await db.createUser('ATTENDANT', { name: 'Attendant' });
  const start = new Date(Date.now() + 10 * 60_000).toISOString();
  meal = (await db.call(admin, 'create_meal_service', '2026-11-04', 'DINNER', start)).meal_service_id as string;
  waveA = ((await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, meal, null)).wave as any).wave_id;
  waveB = ((await db.call(attendant, 'mark_aisle_ready', 'B', true, true, true, meal, null)).wave as any).wave_id;
});

/** Books everyone (A fills first), then opens the gate on both aisles. */
async function bookAndOpen(list: Array<[string, number]>) {
  for (const [id] of list) await db.call(id, 'book_meal', meal, null);
  await db.call(attendant, 'advance_wave_phase', waveA, 'ADMITTING');
  await db.call(attendant, 'advance_wave_phase', waveB, 'ADMITTING');
}

describe('recording coupons at the tables', () => {
  test('a booked diner is recorded and their booking marked dined', async () => {
    const list = await students(1);
    const coupon = list[0][1];
    await bookAndOpen(list);
    const r = await record(waveA, coupon);
    expect(r).toMatchObject({ status: 'RECORDED', coupon_number: coupon, aisle: 'A', booking_ref: 'DIN-2026-11-04-A-001' });
    expect(r.holder_name).toMatch(/^User/);
    expect(await reservationState(coupon)).toBe('VERIFIED_DINED');
  });

  test('typing the same coupon twice never counts two meals', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    const first = await record(waveA, list[0][1]);
    const again = await record(waveA, list[0][1]);
    expect(again).toMatchObject({ status: 'ALREADY_RECORDED', aisle: 'A', recorded_at: first.recorded_at });
    expect(await db.admin(`select count(*)::int as n from public.attendance_records`)).toEqual([{ n: 1 }]);
  });

  test('a retried request with the same entry id replays instead of duplicating', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    const first = await record(waveA, list[0][1], { id: 'phone-1-entry-42' });
    const retry = await record(waveA, list[0][1], { id: 'phone-1-entry-42' });
    expect(retry).toEqual({ ...first, replayed: true });
  });

  test('two attendants in different aisles cannot both count one coupon', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    expect((await record(waveA, list[0][1])).status).toBe('RECORDED');
    expect(await record(waveB, list[0][1], { by: admin })).toMatchObject({ status: 'ALREADY_RECORDED', aisle: 'A' });
  });

  test('an unissued coupon number is rejected and nothing is stored', async () => {
    await bookAndOpen([]);
    expect(await record(waveA, 9999)).toEqual({ status: 'UNKNOWN_COUPON', coupon_number: 9999 });
    expect(await db.admin('select 1 from public.attendance_records')).toEqual([]);
  });

  test('a diner without a booking is recorded with a visible NOT_INVITED exception', async () => {
    const [booked, walkIn] = await students(2);
    await bookAndOpen([booked]);
    const r = await record(waveA, walkIn[1]);
    expect(r).toMatchObject({ status: 'RECORDED_WITH_EXCEPTION', exception: 'NOT_INVITED' });
    expect((await board())[0].open_exceptions).toBe(1);
  });

  test('a diner booked for aisle A found in aisle B is flagged; A is not silently consumed', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    const r = await record(waveB, list[0][1]);
    expect(r).toMatchObject({ status: 'RECORDED_WITH_EXCEPTION', exception: 'WRONG_WAVE' });
    expect(await reservationState(list[0][1])).toBe('CONFIRMED');
  });

  test('a student who cancelled after the gate opened but did eat is recorded as dined', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    await db.call(list[0][0], 'cancel_booking', meal, null);
    expect(await reservationState(list[0][1])).toBe('CANCELLED_PENDING_VACANCY');
    expect((await record(waveA, list[0][1])).status).toBe('RECORDED');
    expect(await reservationState(list[0][1])).toBe('VERIFIED_DINED');
  });

  test('a closed wave refuses live entries', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    await db.call(attendant, 'close_aisle_wave', waveA, true, null, null);
    expect((await record(waveA, list[0][1])).status).toBe('WAVE_CLOSED');
  });
});

describe('undo and correction', () => {
  test('undo restores the booking so the coupon can be recorded again', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    const r = await record(waveA, list[0][1]);
    await expect(db.call(attendant, 'void_attendance', r.record_id, ' ')).rejects.toThrow(/reason is required/);
    expect((await db.call(attendant, 'void_attendance', r.record_id, 'wrong table')).status).toBe('VOIDED');
    expect(await reservationState(list[0][1])).toBe('CONFIRMED');
    expect((await record(waveA, list[0][1])).status).toBe('RECORDED');
    const audit = await db.admin<{ reason: string }>(`select reason from public.audit_log where action = 'ATTENDANCE_VOIDED'`);
    expect(audit).toEqual([{ reason: 'wrong table' }]);
  });

  test('correcting a misheard coupon moves the meal to the right student', async () => {
    const list = await students(2);
    await bookAndOpen(list);
    const wrong = await record(waveA, list[1][1]);
    const fixed = await db.call(attendant, 'correct_attendance', wrong.record_id, list[0][1], 'misheard', eid());
    expect(fixed).toMatchObject({ status: 'CORRECTED', new_entry: { status: 'RECORDED', coupon_number: list[0][1] } });
    expect(await reservationState(list[0][1])).toBe('VERIFIED_DINED');
    expect(await reservationState(list[1][1])).toBe('CONFIRMED');
  });

  test('a correction to an unknown coupon changes nothing', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    const r = await record(waveA, list[0][1]);
    const res = await db.call(attendant, 'correct_attendance', r.record_id, 9999, 'typo', eid());
    expect(res).toMatchObject({ status: 'CORRECTION_REJECTED', reason: { status: 'UNKNOWN_COUPON' } });
    const [rec] = await db.admin<{ status: string }>('select status from public.attendance_records where id = $1', [r.record_id]);
    expect(rec.status).toBe('VALID');
    expect(await reservationState(list[0][1])).toBe('VERIFIED_DINED');
  });

  test('records cannot be edited or deleted directly, even by the superuser', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    await record(waveA, list[0][1]);
    await expect(db.admin('update public.attendance_records set coupon_number = 1')).rejects.toThrow(/immutable/);
    await expect(db.admin('delete from public.attendance_records')).rejects.toThrow(/never deleted/);
  });

  test('two valid meals for one coupon are impossible at the database level', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    await record(waveA, list[0][1]);
    await expect(db.admin(
      `insert into public.attendance_records (meal_service_id, wave_id, aisle_code, coupon_id, coupon_number,
         source, client_entry_id, recorded_by)
       select meal_service_id, $1, 'B', coupon_id, coupon_number, 'LIVE', 'dup-entry-1', recorded_by
       from public.attendance_records`, [waveB])).rejects.toThrow(/attendance_one_meal_per_coupon/);
  });
});

describe('late and paper entries (spec Case 7)', () => {
  test('a diner seen before the deadline but typed after the wave closed is still marked dined', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    await db.call(attendant, 'close_aisle_wave', waveA, true, null, null);
    expect(await reservationState(list[0][1])).toBe('EXPIRED_PENDING_RECONCILIATION');

    const seen = new Date(Date.now() - 5 * 60_000).toISOString();
    const r = await record(waveA, list[0][1], { source: 'PAPER_BACKFILL', observedAt: seen });
    expect(r.status).toBe('RECORDED');
    expect(await reservationState(list[0][1])).toBe('VERIFIED_DINED');
    const [rec] = await db.admin<{ observed_at: Date; recorded_at: Date }>(
      'select observed_at, recorded_at from public.attendance_records');
    expect(rec.observed_at.getTime()).toBeLessThan(rec.recorded_at.getTime());
  });

  test('an observed time in the future is refused', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    await expect(record(waveA, list[0][1], { source: 'OFFLINE_SYNC', observedAt: future })).rejects.toThrow(/future/);
  });
});

describe('the two counters', () => {
  test('45 seated but only 38 coupons typed: 15 seats are vacant, not 22', async () => {
    const list = await students(60);
    await bookAndOpen(list);                       // 30 in A, 30 in B
    for (const [, c] of list.slice(0, 30)) await record(waveA, c);
    for (const [, c] of list.slice(30, 38)) await record(waveB, c);   // attendant still walking B
    await snapshot(waveA, 30);
    await snapshot(waveB, 15);

    const [a, b] = await board();
    expect(a).toMatchObject({ aisle: 'A', capacity: 30, coupon_entries: 30, snapshot: { headcount: 30, stale: false }, physically_vacant: 0 });
    expect(b).toMatchObject({ aisle: 'B', capacity: 30, coupon_entries: 8, snapshot: { headcount: 15 }, physically_vacant: 15 });
    expect(a.physically_vacant + b.physically_vacant).toBe(15);
    // Nobody was marked absent: the 22 untyped bookings are all still CONFIRMED.
    expect(await db.admin(`select count(*)::int as n from public.reservations where state = 'CONFIRMED'`)).toEqual([{ n: 22 }]);
  });

  test('without a headcount there is no vacancy figure at all', async () => {
    const list = await students(5);
    await bookAndOpen(list);
    for (const [, c] of list) await record(waveA, c);
    const [a] = await board();
    expect(a).toMatchObject({ coupon_entries: 5, snapshot: null, physically_vacant: null });
  });

  test('a headcount cannot be taken before the gate opens', async () => {
    expect((await snapshot(waveA, 0)).status).toBe('GATE_NOT_OPEN');
  });

  test('more people than seats raises an admin alert', async () => {
    await bookAndOpen([]);
    await db.call(attendant, 'set_aisle_unusable_seats', 'A', 2, 'broken chairs');
    expect((await snapshot(waveA, 29)).status).toBe('RECORDED');
    expect(await db.admin('select kind from public.admin_alerts')).toEqual([{ kind: 'OCCUPANCY_OVER_CAPACITY' }]);
    await expect(snapshot(waveA, 31)).rejects.toThrow(/check constraint/);
  });

  test('a corrected headcount replaces the old one without erasing it', async () => {
    await bookAndOpen([]);
    const s = await snapshot(waveB, 15);
    await db.call(attendant, 'correct_occupancy_snapshot', s.snapshot_id, 17, 'missed two at the back');
    expect((await board())[1]).toMatchObject({ snapshot: { headcount: 17 }, physically_vacant: 13 });
    expect(await db.admin('select headcount from public.occupancy_snapshots order by recorded_at')).toEqual([
      { headcount: 15 }, { headcount: 17 },
    ]);
    await expect(db.admin('update public.occupancy_snapshots set headcount = 1')).rejects.toThrow(/append-only/);
  });

  test('an old headcount is reported as stale', async () => {
    await bookAndOpen([]);
    await db.admin(
      `insert into public.occupancy_snapshots (wave_id, meal_service_id, aisle_code, headcount, observed_at, taken_by)
       values ($1, $2, 'A', 20, now() - interval '6 minutes', $3)`, [waveA, meal, attendant]);
    expect((await board())[0].snapshot).toMatchObject({ headcount: 20, stale: true });
  });
});

describe('collection round', () => {
  test('starts with the first coupon and finishes only on attestation', async () => {
    const list = await students(3);
    await bookAndOpen(list);
    expect((await board())[0].round).toBe('NOT_STARTED');
    await record(waveA, list[0][1]);
    expect((await board())[0].round).toBe('OPEN');

    expect((await db.call(attendant, 'finish_collection_round', waveA, false, null)).status).toBe('ATTESTATION_REQUIRED');
    expect(await db.call(attendant, 'finish_collection_round', waveA, true, 'all tables visited'))
      .toEqual({ status: 'FINISHED', entries: 1, exceptions: 0 });
    expect((await db.call(attendant, 'finish_collection_round', waveA, true, null)).status).toBe('ALREADY_FINISHED');
    expect((await board())[0].round).toBe('FINISHED');
  });

  test('can be finished for an aisle where nobody turned up', async () => {
    await bookAndOpen([]);
    expect(await db.call(attendant, 'finish_collection_round', waveB, true, null))
      .toEqual({ status: 'FINISHED', entries: 0, exceptions: 0 });
  });

  test('can be reopened with a reason', async () => {
    await bookAndOpen([]);
    await db.call(attendant, 'finish_collection_round', waveA, true, null);
    expect((await db.call(attendant, 'reopen_collection_round', waveA, 'missed the corner table')).status).toBe('REOPENED');
    expect((await board())[0].round).toBe('OPEN');
  });

  test('exceptions can be resolved with a note', async () => {
    const [walkIn] = await students(1);
    await bookAndOpen([]);
    const r = await record(waveA, walkIn[1]);
    expect((await db.call(attendant, 'resolve_attendance_exception', r.record_id, 'guest of hall, approved by provost')).status)
      .toBe('RESOLVED');
    expect((await board())[0].open_exceptions).toBe(0);
  });
});

describe('who can do what', () => {
  test('admins can run the numpad themselves', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    expect((await record(waveA, list[0][1], { by: admin })).status).toBe('RECORDED');
    expect((await db.call(admin, 'record_occupancy_snapshot', waveA, 1, null)).status).toBe('RECORDED');
  });

  test('students cannot record attendance or headcounts, or see the board', async () => {
    const list = await students(1);
    await bookAndOpen(list);
    const s = list[0][0];
    await expect(record(waveA, list[0][1], { by: s })).rejects.toThrow(/requires role ATTENDANT/);
    await expect(db.call(s, 'record_occupancy_snapshot', waveA, 1, null)).rejects.toThrow(/requires role ATTENDANT/);
    await expect(db.call(s, 'attendant_board', meal)).rejects.toThrow(/requires role ATTENDANT/);
  });

  test('students see only their own attendance and no headcounts', async () => {
    const list = await students(2);
    await bookAndOpen(list);
    await record(waveA, list[0][1]);
    await record(waveA, list[1][1]);
    await snapshot(waveA, 2);
    expect(await db.select(list[0][0], 'select coupon_number from public.attendance_records'))
      .toEqual([{ coupon_number: list[0][1] }]);
    expect(await db.select(list[0][0], 'select 1 from public.occupancy_snapshots')).toEqual([]);
  });
});
