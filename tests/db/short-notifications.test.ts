import { beforeEach, describe, expect, test } from 'vitest';
import { skipAheadSql } from './time-travel';
import { freshDb, type Db } from './harness';

// Short notifications (supabase/migrations/20261113000400_short_notifications.sql).

let db: Db;
let admin: string;
let nextCoupon = 1;
let day = 0;

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

async function meal(inMinutes: number, seats = 3, type = 'DINNER', occasion = 'FEAST') {
  const date = new Date(Date.UTC(2030, 0, 1 + day++)).toISOString().slice(0, 10);
  const id = (await db.call(admin, 'create_meal_event', date, type, at(inMinutes), null, occasion === 'REGULAR' ? null : 'Event',
    occasion, null, null, null)).meal_service_id as string;
  await db.call(admin, 'set_batch_capacity', id, seats);
  return id;
}
const notes = (uid: string) => db.admin<{ kind: string; title: string | null; message: string; url: string | null }>(
  `select kind, payload ->> 'title' as title, payload ->> 'message' as message, payload ->> 'url' as url
   from public.notification_outbox where recipient_id = $1 order by created_at`, [uid]);
const items = (...names: string[]) => JSON.stringify(names.map((name) => ({ name })));
const DAY = /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}/;

beforeEach(async () => {
  db = await freshDb();
  nextCoupon = 1;
  admin = await db.createUser('SUPER_ADMIN', { name: 'Hall Office' });
});

describe('short notifications', () => {
  test('a new lunch: "Lunch" and the day with a numbered menu; it opens the home screen', async () => {
    const [a] = await students(1);
    const m = await meal(120, 3, 'LUNCH', 'REGULAR');
    await db.call(admin, 'set_meal_details', m, null, 'REGULAR', null, null, items('Gila kolija', 'Chicken'));
    const n = (await notes(a.id)).filter((x) => x.kind === 'MEAL_NEW');
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe('Lunch');
    expect(n[0].message).toMatch(DAY);
    expect(n[0].url).toBe('/');
  });

  test('a regular meal tells everyone once when it starts, with the menu as it is then; edits before stay quiet', async () => {
    const [a] = await students(1);
    const m = await meal(60, 3, 'LUNCH', 'REGULAR');
    const before = (await notes(a.id)).length;
    await db.call(admin, 'set_meal_details', m, null, 'REGULAR', null, null, items('Gila kolija', 'Chicken'));
    expect((await notes(a.id)).length).toBe(before);           // edited before the start: nothing
    await skip(30);
    await jobs();
    expect((await notes(a.id)).some((x) => x.kind === 'MEAL_START')).toBe(false);
    await skip(31);
    await jobs();
    await jobs();
    const start = (await notes(a.id)).filter((x) => x.kind === 'MEAL_START');
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ title: 'Lunch' });
    expect(start[0].message).toMatch(/\. 1\. Gila kolija, 2\. Chicken$/);
    // No batch notices for a regular meal.
    expect((await notes(a.id)).some((x) => ['BOOKING_OPEN', 'GATE_OPEN', 'BATCH_FULL'].includes(x.kind))).toBe(false);

    // Edited after the start: "Lunch updated".
    await db.call(admin, 'set_meal_details', m, null, 'REGULAR', null, null, items('Gila kolija', 'Egg'));
    const edited = (await notes(a.id)).filter((x) => x.kind === 'MEAL_EDITED');
    expect(edited).toHaveLength(1);
    expect(edited[0].title).toBe('Lunch updated');
    expect(edited[0].message).toMatch(/1\. Gila kolija, 2\. Egg$/);
  });

  test('a special meal gets booking and gate notices but no start notice', async () => {
    const [a] = await students(1);
    await meal(20, 2);
    await skip(6);
    await jobs();
    await skip(15);
    await jobs();
    const kinds = (await notes(a.id)).map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(['MEAL_NEW', 'BOOKING_OPEN', 'GATE_OPEN']));
    expect(kinds).not.toContain('MEAL_START');
    expect((await notes(a.id)).find((x) => x.kind === 'BOOKING_OPEN')).toMatchObject({ title: 'Booking open', message: 'Batch 1 · 2 seats' });
  });

  test('a meal created after it started does not announce itself', async () => {
    const [a] = await students(1);
    await meal(-60, 3, 'LUNCH', 'REGULAR');
    await jobs();
    expect((await notes(a.id)).some((x) => x.kind === 'MEAL_START' || x.kind === 'MEAL_NEW')).toBe(false);
  });

  test('dined and announcements are short; an announcement opens the announcements page', async () => {
    const [a] = await students(1);
    const m = await meal(-5, 3, 'LUNCH', 'REGULAR');
    await db.call(admin, 'set_meal_attendance', m, [a.coupon]);
    const dined = (await notes(a.id)).find((x) => x.kind === 'DINED');
    expect(dined?.title).toBe('Dined');
    expect(dined?.message).toMatch(/^Lunch · [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
    await db.call(admin, 'post_announcement', 'Water off at 9');
    expect((await notes(a.id)).at(-1)).toMatchObject({ kind: 'ANNOUNCEMENT', message: 'Water off at 9', url: '/announcements' });
  });

  test('a booked seat is shortened to batch, coupon and gate time', async () => {
    const [a] = await students(1);
    const m = await meal(20, 2);
    await skip(6);
    await jobs();
    await db.call(a.id, 'book_seat', m);
    const seat = (await notes(a.id)).find((x) => x.kind === 'SEAT_BOOKED');
    expect(seat?.title).toBe('Seat booked');
    expect(seat?.message).toMatch(/^Batch 1 · coupon \d+ · gate \d{1,2}:\d{2} [ap]m$/);
  });
});
