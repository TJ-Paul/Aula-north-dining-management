import { beforeEach, describe, expect, test } from 'vitest';
import { skipAheadSql } from './time-travel';
import { freshDb, type Db } from './harness';

// The simpler app (supabase/migrations/20261113000100_simpler_app.sql).

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
const notes = (uid: string) => db.admin<{ kind: string; message: string }>(
  `select kind, payload ->> 'message' as message from public.notification_outbox where recipient_id = $1 order by created_at`, [uid]);

beforeEach(async () => {
  db = await freshDb();
  nextCoupon = 1;
  admin = await db.createUser('SUPER_ADMIN', { name: 'Hall Office' });
});

describe('notifications arrive once', () => {
  test('each waiting notification is handed to exactly one push sender', async () => {
    await students(3);
    await db.call(admin, 'post_announcement', 'Hello');
    const waiting = (await db.admin<{ n: number }>(`select count(*)::int n from public.notification_outbox where status = 'PENDING'`))[0].n;
    expect(waiting).toBeGreaterThanOrEqual(4);
    const first = await db.admin<{ id: string }>('select * from public.claim_push_batch(2)');
    const second = await db.admin<{ id: string }>('select * from public.claim_push_batch(500)');
    const third = await db.admin<{ id: string }>('select * from public.claim_push_batch(500)');
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(waiting - 2);
    expect(third).toHaveLength(0);
    expect(new Set([...first, ...second].map((r) => r.id)).size).toBe(waiting);
  });

  test('only the server can claim notifications to send', async () => {
    const [a] = await students(1);
    await expect(db.select(a.id, 'select * from public.claim_push_batch(10)')).rejects.toThrow(/permission denied/);
  });

  test('a booked student gets their own "gate open", not the general one too', async () => {
    const [a, b] = await students(2);
    const m = await meal(20, 2);
    await skip(6);
    await jobs();
    await db.call(a.id, 'book_seat', m);
    await skip(15);
    await jobs();
    const mine = await notes(a.id);
    expect(mine.filter((n) => n.kind === 'BATCH_STARTED')).toHaveLength(1);
    expect(mine.filter((n) => n.kind === 'GATE_OPEN')).toHaveLength(0);
    expect((await notes(b.id)).filter((n) => n.kind === 'GATE_OPEN')).toHaveLength(1);
  });

  test('the same announcement sent twice within 10 minutes reaches people once', async () => {
    const [a] = await students(1);
    await db.call(admin, 'post_announcement', 'Water off at 9');
    await db.call(admin, 'post_announcement', 'Water off at 9');
    expect((await notes(a.id)).filter((n) => n.kind === 'ANNOUNCEMENT')).toHaveLength(1);
    await skip(11);
    await db.call(admin, 'post_announcement', 'Water off at 9');
    expect((await notes(a.id)).filter((n) => n.kind === 'ANNOUNCEMENT')).toHaveLength(2);
  });

  test('"marked as dined" is never held back', async () => {
    const [a] = await students(1);
    const m = await meal(-5, 3, 'LUNCH', 'REGULAR');
    for (const list of [[a.coupon], [], [a.coupon]]) {
      await db.call(admin, 'set_meal_attendance', m, list);
      await new Promise((r) => setTimeout(r, 1100));   // entry ids are per second
    }
    expect((await notes(a.id)).filter((n) => n.kind.startsWith('DINED')).map((n) => n.kind)).toEqual(['DINED', 'DINED_REMOVED', 'DINED']);
  });
});

describe('events close by themselves', () => {
  test('an improvement with no end time closes 12 hours after its start, without missed meals', async () => {
    const [a] = await students(1);
    const m = await meal(20, 2, 'DINNER', 'IMPROVEMENT');
    await skip(6);
    await jobs();
    await db.call(a.id, 'book_seat', m);
    await skip(15);
    await jobs();                                       // gate open, nobody pressed "Filled"
    await skip(11 * 60);
    await jobs();
    expect((await db.admin<{ state: string }>('select state from public.meal_services where id = $1', [m]))[0].state).toBe('IN_SERVICE');
    await skip(61);
    expect((await db.admin<{ r: { events_closed: number } }>('select public.run_due_jobs() r'))[0].r.events_closed).toBe(1);
    expect((await db.admin<{ state: string }>('select state from public.meal_services where id = $1', [m]))[0].state).toBe('CLOSED');
    expect(await db.admin('select 1 from public.no_show_events where meal_service_id = $1', [m])).toHaveLength(0);
    expect(await db.admin('select 1 from public.meal_batches where meal_service_id = $1 and loaded_at is null', [m])).toHaveLength(0);
  });

  test('a lunch closes by itself 12 hours after it ends, not before', async () => {
    const lunch = async (endedMinutesAgo: number) => {
      const date = new Date(Date.UTC(2030, 0, 1 + day++)).toISOString().slice(0, 10);
      return (await db.call(admin, 'create_meal_event', date, 'LUNCH', at(-endedMinutesAgo - 120), at(-endedMinutesAgo),
        null, 'REGULAR', null, null, null)).meal_service_id as string;
    };
    const state = async (id: string) => (await db.admin<{ state: string }>('select state from public.meal_services where id = $1', [id]))[0].state;
    const recent = await lunch(11 * 60);      // ended 11 hours ago
    const old = await lunch(12 * 60 + 5);     // ended 12 hours 5 minutes ago
    await jobs();
    expect(await state(recent)).toBe('IN_SERVICE');
    expect(await state(old)).toBe('CLOSED');
    await skip(61);
    await jobs();
    expect(await state(recent)).toBe('CLOSED');
  });
});

describe('the Meals tab and feedback replies', () => {
  test('the timeline lists last week, today and the next three weeks', async () => {
    const past = await meal(-3 * 24 * 60, 3, 'LUNCH', 'REGULAR');
    const soon = await meal(10 * 24 * 60);
    const far = await meal(30 * 24 * 60);
    const ids = ((await db.admin<{ r: { meals: Array<{ id: string }> } }>('select public.meals_timeline() r'))[0].r.meals).map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([past, soon]));
    expect(ids).not.toContain(far);
  });

  test('a reply shows to everyone, without the sender; private notes stay private', async () => {
    const [a, b] = await students(2);
    await db.call(a.id, 'submit_feedback', 'COMPLAINT', 'Rice was cold', null);
    await db.call(a.id, 'submit_feedback', 'SUGGESTION', 'More salad', null);
    const list = (await db.call(admin, 'list_feedback', null, true)) as unknown as Array<{ id: string; body: string }>;
    const cold = list.find((f) => f.body === 'Rice was cold')!;
    const salad = list.find((f) => f.body === 'More salad')!;
    await db.call(admin, 'update_feedback', salad.id, 'SEEN', 'internal note');
    expect((await db.call(admin, 'reply_feedback', cold.id, '  ')).status).toBe('INVALID_REPLY');
    expect((await db.call(admin, 'reply_feedback', cold.id, 'Fixed the warmer')).status).toBe('OK');
    const seen = (await db.call(b.id, 'feedback_replies', 10)) as unknown as Array<Record<string, unknown>>;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'COMPLAINT', body: 'Rice was cold', reply: 'Fixed the warmer' });
    expect(Object.keys(seen[0])).not.toContain('handled_by');
    await expect(db.call(a.id, 'reply_feedback', cold.id, 'me')).rejects.toThrow(/requires role/);
  });
});

describe('dev edits anyone', () => {
  test('name, student ID, room, phone and photo; mess managers cannot', async () => {
    const [a, b] = await students(2);
    await db.admin(`update public.profiles set student_id = 'S100' where id = $1`, [b.id]);
    expect((await db.call(admin, 'dev_update_person', a.id, 'Rahim Uddin', 's100', '312', '01712345678')).status).toBe('STUDENT_ID_TAKEN');
    expect((await db.call(admin, 'dev_update_person', a.id, 'Rahim Uddin', '2021-331-045', '312', '+8801712345678')).status).toBe('OK');
    expect((await db.admin('select full_name, student_id, room, notify_phone from public.profiles where id = $1', [a.id]))[0])
      .toEqual({ full_name: 'Rahim Uddin', student_id: '2021331045', room: '312', notify_phone: '01712345678' });
    expect((await db.call(admin, 'dev_update_person', a.id, 'R', null, null, null)).status).toBe('INVALID_NAME');
    expect((await db.call(admin, 'dev_update_person', a.id, 'Rahim', null, null, '123')).status).toBe('INVALID_PHONE');
    expect((await db.call(admin, 'dev_set_photo', a.id, 'https://x.test/p.jpg', false)).status).toBe('OK');
    expect((await db.admin('select avatar_url from public.profiles where id = $1', [a.id]))[0].avatar_url).toBe('https://x.test/p.jpg');
    expect((await db.call(admin, 'dev_set_photo', a.id, null, true)).status).toBe('OK');
    const manager = await db.createUser('ADMIN');
    await expect(db.call(manager, 'dev_update_person', a.id, 'X Y', null, null, null)).rejects.toThrow(/requires role SUPER_ADMIN/);
    await expect(db.call(manager, 'dev_set_photo', a.id, null, true)).rejects.toThrow(/requires role SUPER_ADMIN/);
  });
});

describe('phone numbers', () => {
  test('anyone signed in sets, changes or removes their own phone', async () => {
    const [a] = await students(1);
    const manager = await db.createUser('ADMIN');
    expect((await db.call(a.id, 'set_my_phone', '+880 1712-345678')).status).toBe('OK');
    expect((await db.admin('select notify_phone from public.profiles where id = $1', [a.id]))[0].notify_phone).toBe('01712345678');
    expect((await db.call(a.id, 'set_my_phone', '12345')).status).toBe('INVALID_PHONE');
    expect((await db.call(manager, 'set_my_phone', '01812345678')).status).toBe('OK');
    expect((await db.call(a.id, 'set_my_phone', '')).status).toBe('OK');
    expect((await db.admin('select notify_phone from public.profiles where id = $1', [a.id]))[0].notify_phone).toBeNull();
  });
});

describe('changes that need verifying', () => {
  const managerNotes = (uid: string) => db.admin<{ message: string }>(
    `select payload ->> 'message' as message from public.notification_outbox where recipient_id = $1 and kind = 'CHANGE_REQUEST'`, [uid]);

  test('a student ID change waits for a mess manager; managers and devs are told', async () => {
    const [a, b] = await students(2);
    const manager = await db.createUser('ADMIN', { name: 'Manager' });
    await db.admin(`update public.profiles set student_id = 'S100' where id = $1`, [a.id]);
    await db.admin(`update public.profiles set student_id = 'S200' where id = $1`, [b.id]);
    expect((await db.call(a.id, 'request_student_id_change', 's200')).status).toBe('STUDENT_ID_TAKEN');
    expect((await db.call(a.id, 'request_student_id_change', 'S100')).status).toBe('SAME_STUDENT_ID');
    const r = await db.call(a.id, 'request_student_id_change', '2021-331-001');
    expect(r.status).toBe('SENT');
    // Not changed yet; the student sees it waiting.
    expect((await db.admin('select student_id from public.profiles where id = $1', [a.id]))[0].student_id).toBe('S100');
    expect((await db.call(a.id, 'my_extras')).student_id_request).toMatchObject({ new_student_id: '2021331001' });
    expect((await managerNotes(manager))[0].message).toMatch(/student ID S100 → 2021331001/);
    expect(await managerNotes(admin)).toHaveLength(1);
    expect(await managerNotes(b.id)).toHaveLength(0);
    const list = (await db.call(manager, 'admin_student_id_requests')) as unknown as Array<{ request_id: string }>;
    expect(list).toHaveLength(1);
    expect((await db.call(manager, 'decide_student_id_change', list[0].request_id, true)).status).toBe('APPROVED');
    expect((await db.admin('select student_id from public.profiles where id = $1', [a.id]))[0].student_id).toBe('2021331001');
    await expect(db.call(a.id, 'decide_student_id_change', list[0].request_id, true)).rejects.toThrow(/requires role/);
  });

  test('a mess manager cannot verify their own change; a dev can', async () => {
    const manager = await db.createUser('ADMIN');
    const own = await db.call(manager, 'request_student_id_change', 'M12345');
    expect((await db.call(manager, 'decide_student_id_change', own.request_id, true)).status).toBe('OWN_REQUEST');
    expect((await db.call(admin, 'decide_student_id_change', own.request_id, true)).status).toBe('APPROVED');
  });

  test('name change requests notify the managers too', async () => {
    const [a] = await students(1);
    const manager = await db.createUser('ADMIN');
    expect((await db.call(a.id, 'request_name_change', 'Rahim Uddin')).status).toBe('SENT');
    expect((await managerNotes(manager))[0].message).toMatch(/change their name to Rahim Uddin/);
  });

  test('a coupon change request notifies the managers', async () => {
    const [a] = await students(1);
    const manager = await db.createUser('ADMIN');
    await db.admin(`update public.profiles set student_id = 'S300' where id = $1`, [a.id]);
    await db.admin(`insert into public.coupons (coupon_number) values (400)`);
    const r = await db.call(a.id, 'request_coupon', 400, 'Student 1', 'S300');
    expect(r.status).toBe('PENDING');
    expect((await managerNotes(manager))[0].message).toMatch(/change to coupon 400/);
  });
});
