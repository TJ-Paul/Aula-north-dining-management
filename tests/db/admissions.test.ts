import { beforeEach, describe, expect, test } from 'vitest';
import { skipAheadSql } from './time-travel';
import { freshDb, type Db } from './harness';

let db: Db;
let admin: string;
let attendant: string;
let meal: string;
let waveA: string;
let waveB: string;
let nextCoupon = 1000;
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
const record = (wave: string, coupon: number) =>
  db.call(attendant, 'record_coupon', wave, coupon, `entry-${String(++entry).padStart(6, '0')}`, 'LIVE', null);
const headcount = (wave: string, n: number) => db.call(attendant, 'record_occupancy_snapshot', wave, n, null);

async function offers(where = 'true') {
  return db.admin<{ coupon_number: number; aisle_code: string; state: string; user_id: string; id: string }>(
    `select id, coupon_number, aisle_code, state, user_id from public.standby_offers where ${where} order by offered_at, coupon_number`);
}
async function vacancy(wave: string) {
  const [r] = await db.admin<{ v: { status: string; vacancy: number } }>('select public.wave_vacancy($1) as v', [wave]);
  return r.v;
}

/** 60 booked (A then B) plus `standby` on the waitlist; gate open; arrival deadline passed. */
async function dinnerPastDeadline(standby: number) {
  const list = await students(60 + standby);
  for (const s of list) await db.call(s.id, 'book_meal', meal, null);
  await skip(11);            // T+1: gate opens
  await jobs();
  return { booked: list.slice(0, 60), waiting: list.slice(60) };
}

beforeEach(async () => {
  db = await freshDb();
  admin = await db.createUser('ADMIN');
  attendant = await db.createUser('ATTENDANT');
  const start = new Date(Date.now() + 10 * 60_000).toISOString();
  meal = (await db.call(admin, 'create_meal_service', '2026-11-04', 'DINNER', start)).meal_service_id as string;
  waveA = ((await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, meal, null)).wave as any).wave_id;
  waveB = ((await db.call(attendant, 'mark_aisle_ready', 'B', true, true, true, meal, null)).wave as any).wave_id;
});

describe('the gate and the confirmed window', () => {
  test('at T the service starts and both gates open automatically', async () => {
    await skip(11);
    expect(await jobs()).toMatchObject({ services_started: 1, gates_opened: 2 });
    const phases = await db.admin('select phase from public.aisle_waves order by aisle_code');
    expect(phases).toEqual([{ phase: 'ADMITTING' }, { phase: 'ADMITTING' }]);
  });

  test('a headcount of 20/30 before the deadline invites nobody', async () => {
    const list = await students(70);
    for (const s of list) await db.call(s.id, 'book_meal', meal, null);
    await skip(15);           // T+5, confirmed students may still arrive until T+10
    await jobs();
    await headcount(waveA, 20);
    await jobs();
    expect(await offers()).toEqual([]);
    expect((await vacancy(waveA)).status).toBe('CONFIRMED_WINDOW_OPEN');
  });

  test('after the deadline: bookings expire without penalty, and nothing is offered until a headcount', async () => {
    await dinnerPastDeadline(10);
    await skip(10);           // T+11
    const r = await jobs();
    expect(r.arrivals_missed).toBe(60);
    expect(await offers()).toEqual([]);
    expect((await vacancy(waveA)).status).toBe('HEADCOUNT_NEEDED');
    const states = await db.admin(`select distinct state from public.reservations`);
    expect(states).toEqual([{ state: 'EXPIRED_PENDING_RECONCILIATION' }]); // not NO_SHOW
  });
});

describe('snapshot-gated invitations', () => {
  test('A full (30) and B half (15): exactly 15 offers, all for B, in queue order', async () => {
    const { booked, waiting } = await dinnerPastDeadline(20);
    // The attendant has typed only 38 coupons; that must not matter.
    for (const s of booked.slice(0, 30)) await record(waveA, s.coupon);
    for (const s of booked.slice(30, 38)) await record(waveB, s.coupon);
    await skip(10);
    await jobs();
    await headcount(waveA, 30);
    await headcount(waveB, 15);
    expect(await jobs()).toMatchObject({ offers_issued: 15 });

    const made = await offers();
    expect(made).toHaveLength(15);
    expect(new Set(made.map((o) => o.aisle_code))).toEqual(new Set(['B']));
    const queue = await db.admin<{ user_id: string }>(
      `select user_id from public.booking_participations where status in ('STANDBY','OFFERED')
       order by priority_tier, queued_at, queue_tiebreak`);
    // The head of the queue, nobody else (offers made in one run share a timestamp, so compare as sets).
    expect(new Set(made.map((o) => o.user_id))).toEqual(new Set(queue.slice(0, 15).map((q) => q.user_id)));
    expect(waiting).toHaveLength(20);
  });

  test('running the job again issues nothing more', async () => {
    await dinnerPastDeadline(20);
    await skip(10);
    await jobs();
    await headcount(waveB, 25);
    await jobs();
    expect(await jobs()).toMatchObject({ offers_issued: 0 });
    expect(await offers()).toHaveLength(5);
  });

  test('the database refuses an offer beyond the verified vacancy', async () => {
    const { waiting } = await dinnerPastDeadline(10);
    await skip(10);
    await jobs();
    await headcount(waveB, 28);
    await jobs();
    expect(await offers()).toHaveLength(2);
    const extra = waiting[5];
    await expect(db.admin(
      `insert into public.standby_offers (meal_service_id, wave_id, aisle_code, participation_id, user_id, coupon_id,
         coupon_number, based_on_snapshot_id, respond_by)
       select p.meal_service_id, $1, 'B', p.id, p.user_id, p.coupon_id, p.coupon_number,
              (select id from public.occupancy_snapshots where wave_id = $1 limit 1), now()
       from public.booking_participations p where p.user_id = $2`, [waveB, extra.id]))
      .rejects.toThrow(/no verified vacancy/);
  });

  test('a stale headcount stops invitations until someone counts again', async () => {
    await dinnerPastDeadline(10);
    await skip(10);
    await jobs();
    await headcount(waveB, 29);
    await skip(6);            // validity is 5 minutes
    await jobs();
    expect(await offers()).toEqual([]);
    expect((await vacancy(waveB)).status).toBe('HEADCOUNT_STALE');
    await headcount(waveB, 29);
    await jobs();
    expect(await offers()).toHaveLength(1);
  });

  test('pausing stops invitations; resuming lets them flow', async () => {
    await dinnerPastDeadline(10);
    await skip(10);
    await jobs();
    expect((await db.call(attendant, 'set_invitations_paused', meal, true, 'count looks wrong')).status).toBe('OK');
    await headcount(waveB, 27);
    await jobs();
    expect(await offers()).toEqual([]);
    await db.call(attendant, 'set_invitations_paused', meal, false, 'recounted');
    await jobs();
    expect(await offers()).toHaveLength(3);
  });

  test('no invitations once it is too late to arrive before admission closes', async () => {
    await dinnerPastDeadline(10);
    await skip(28);           // T+29; admission closes T+30
    await jobs();
    await headcount(waveB, 20);
    await jobs();
    expect(await offers()).toEqual([]);
    expect((await vacancy(waveB)).status).toBe('TOO_LATE');
  });
});

describe('answering an offer', () => {
  async function oneOffer() {
    const { waiting } = await dinnerPastDeadline(10);
    await skip(10);
    await jobs();
    await headcount(waveB, 29);
    await jobs();
    const [o] = await offers();
    const student = waiting.find((s) => s.id === o.user_id)!;
    return { offer: o, student, waiting };
  }

  test('accepting gives an aisle and an entry window; the status shows it', async () => {
    const { offer, student } = await oneOffer();
    const r = await db.call(student.id, 'respond_to_offer', offer.id, true, true);
    expect(r).toMatchObject({ status: 'ACCEPTED', aisle: 'B' });
    expect(await db.call(student.id, 'my_booking_status', meal))
      .toMatchObject({ participation: 'INVITED', aisle: 'B', offer_state: 'ACCEPTED' });
  });

  test('declining frees the place for the next student, with no penalty', async () => {
    const { offer, student } = await oneOffer();
    expect((await db.call(student.id, 'respond_to_offer', offer.id, false, true)).status).toBe('DECLINED');
    await jobs();
    const all = await offers();
    expect(all.map((o) => o.state)).toEqual(['DECLINED', 'OFFERED']);
    expect(all[1].user_id).not.toBe(student.id);
  });

  test('an unanswered offer lapses and the place is offered again (never a no-show)', async () => {
    const { student } = await oneOffer();
    await skip(1.5);          // response timer is 60 s
    await headcount(waveB, 29);
    const r = await jobs();
    expect(r.offers_unanswered).toBe(1);
    const all = await offers();
    expect(all.map((o) => o.state)).toEqual(['EXPIRED_UNACKNOWLEDGED', 'OFFERED']);
    const [p] = await db.admin<{ status: string }>(
      'select status from public.booking_participations where user_id = $1', [student.id]);
    expect(p.status).toBe('STANDBY');
  });

  test('a late answer is refused by server time, whatever the phone says', async () => {
    const { offer, student } = await oneOffer();
    await skip(1.5);
    expect((await db.call(student.id, 'respond_to_offer', offer.id, true, true)).status).toBe('EXPIRED');
  });

  test('an accepted student who misses their window keeps the seat held until a new headcount', async () => {
    const { offer, student } = await oneOffer();
    await db.call(student.id, 'respond_to_offer', offer.id, true, true);
    await skip(10);           // past the entry window (travel 6 + 2-minute group), before admission closes
    await jobs();
    expect((await offers()).map((o) => o.state)).toEqual(['EXPIRED_PENDING_RECONCILIATION']);
    // An older count can't release it: still no new offer.
    expect((await vacancy(waveB)).status).toBe('HEADCOUNT_STALE');
    await headcount(waveB, 29);   // they are not there
    await jobs();
    const all = await offers();
    expect(all.map((o) => o.state)).toEqual(['RELEASED', 'OFFERED']);
  });

  test('an invitee whose coupon is collected is not counted twice', async () => {
    const { offer, student } = await oneOffer();
    await db.call(student.id, 'respond_to_offer', offer.id, true, true);
    expect((await record(waveB, student.coupon)).status).toBe('RECORDED');
    await jobs();
    expect(await vacancy(waveB)).toMatchObject({ status: 'OK', vacancy: 0 }); // 29 counted + 1 arrived after
    await headcount(waveB, 30);
    expect(await vacancy(waveB)).toMatchObject({ vacancy: 0, outstanding: 0 });
  });

  test('entry windows are staggered: at most 5 per 2-minute group', async () => {
    await dinnerPastDeadline(10);
    await skip(10);
    await jobs();
    await headcount(waveB, 23);
    await jobs();
    const made = await offers();
    expect(made).toHaveLength(7);
    for (const o of made) await db.call(o.user_id, 'respond_to_offer', o.id, true, true);
    const windows = await db.admin<{ n: number }>(
      `select count(*)::int as n from public.standby_offers group by entry_window_start order by entry_window_start`);
    expect(windows).toEqual([{ n: 5 }, { n: 2 }]);
  });

  test('cancelling after accepting holds the seat until a headcount confirms it is free', async () => {
    const { offer, student } = await oneOffer();
    await db.call(student.id, 'respond_to_offer', offer.id, true, true);
    expect(await db.call(student.id, 'cancel_booking', meal, null))
      .toMatchObject({ status: 'CANCELLED', seat_released: false });
    await jobs();
    expect(await offers()).toHaveLength(1);
    await headcount(waveB, 29);
    await jobs();
    expect((await offers()).map((o) => o.state)).toEqual(['CANCELLED', 'OFFERED']);
  });

  test('an invited student found in the wrong aisle is flagged', async () => {
    const { offer, student } = await oneOffer();
    await db.call(student.id, 'respond_to_offer', offer.id, true, true);
    expect(await record(waveA, student.coupon)).toMatchObject({ exception: 'WRONG_WAVE' });
  });
});

describe('late coupons and released seats', () => {
  test('a booker released by the headcount but typed later is recorded as dined and still counted', async () => {
    const { booked } = await dinnerPastDeadline(10);
    await skip(10);
    await jobs();
    await headcount(waveA, 29);   // one booker in A not seen
    await jobs();
    const [r] = await db.admin<{ state: string }>(
      `select state from public.reservations where coupon_number = $1`, [booked[0].coupon]);
    expect(r.state).toBe('RELEASED');
    expect((await record(waveA, booked[0].coupon)).status).toBe('RECORDED');
    // They arrived after the count: the seat the count freed is theirs again.
    expect(await vacancy(waveA)).toMatchObject({ vacancy: 0 });
  });
});

describe('aisle turnover during service', () => {
  test('a re-readied aisle opens admitting, with an attested empty count, and fills from the queue', async () => {
    await dinnerPastDeadline(40);
    await db.call(attendant, 'close_aisle_wave', waveA, true, 'everyone left', null);
    const r = await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, meal, null);
    expect(r.wave).toMatchObject({ status: 'WAVE_OPENED', wave_number: 2, admitting: true });
    expect(await jobs()).toMatchObject({ offers_issued: 30 });
    expect(new Set((await offers()).map((o) => o.aisle_code))).toEqual(new Set(['A']));
  });
});

describe('who can do what', () => {
  test('students cannot run the scheduler or see the admin overview', async () => {
    const [s] = await students(1);
    await expect(db.select(s.id, 'select public.run_due_jobs()')).rejects.toThrow(/permission denied/);
    await expect(db.call(s.id, 'admin_overview', meal)).rejects.toThrow(/requires role ADMIN/);
  });

  test('a student cannot answer someone else\'s offer', async () => {
    const { waiting } = await dinnerPastDeadline(10);
    await skip(10);
    await jobs();
    await headcount(waveB, 29);
    await jobs();
    const [o] = await offers();
    const other = waiting.find((s) => s.id !== o.user_id)!;
    await expect(db.call(other.id, 'respond_to_offer', o.id, true, true)).rejects.toThrow(/offer not found/);
  });

  test('admin overview summarises the dinner', async () => {
    await dinnerPastDeadline(5);
    const o = await db.call(admin, 'admin_overview', meal);
    expect(o).toMatchObject({ window: 'STANDBY_ONLY', participants: { CONFIRMED: 60, STANDBY: 5 } });
    expect((o.aisles as unknown[]).length).toBe(2);
  });
});
