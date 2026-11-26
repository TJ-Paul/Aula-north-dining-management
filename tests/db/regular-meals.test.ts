import { beforeEach, describe, expect, test } from 'vitest';
import { skipAheadSql } from './time-travel';
import { freshDb, type Db } from './harness';

let db: Db;
let admin: string;
let today: string;

type Student = { id: string; coupon: number };
async function students(n: number, from = 1): Promise<Student[]> {
  const out: Student[] = [];
  for (let i = 0; i < n; i++) out.push({ id: await db.createUser('STUDENT', { name: `Student ${from + i}` }), coupon: from + i });
  await db.admin(`insert into public.coupons (coupon_number, hall_record)
                  select g, jsonb_build_object('student_id', 'S00' || g) from generate_series($1::int, $2::int) g`, [from, from + n - 1]);
  await db.admin(
    `insert into public.coupon_claims (coupon_id, user_id, status, method, effective_from)
     select c.id, u.id, 'APPROVED', 'STAFF_APPROVAL', now()
     from unnest($1::uuid[]) with ordinality as u(id, ord) join public.coupons c on c.coupon_number = $2 + u.ord - 1`,
    [out.map((s) => s.id), from]);
  await db.admin('update public.profiles set is_verified = true where id = any($1::uuid[])', [out.map((s) => s.id)]);
  return out;
}
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const skip = (min: number) => db.pg.exec(skipAheadSql(min));

beforeEach(async () => {
  db = await freshDb();
  admin = await db.createUser('SUPER_ADMIN', { name: 'Hall Office' });
  today = (await db.admin<{ d: string }>(`select public.dhaka_today()::text as d`))[0].d;
});

describe('regular meals', () => {
  test('lunch and dinner need no booking; menus and notices show for everyone', async () => {
    const [a] = await students(1);
    const lunch = (await db.call(admin, 'create_meal_event', today, 'LUNCH', at(5), null, null, 'REGULAR', null,
      JSON.stringify([{ name: 'Rice' }, { name: 'Fish', alternatives: ['Egg'] }]), null)).meal_service_id as string;
    await db.call(admin, 'set_meal_notice', lunch, 'Gate opens 10 minutes late today.');
    expect((await db.call(a.id, 'book_seat', lunch)).status).toBe('NO_BOOKING_NEEDED');
    const list = (await db.call(a.id, 'active_meal_services')) as unknown as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ notice: 'Gate opens 10 minutes late today.', menu: ['Rice', 'Fish (or Egg)'] });
  });

  test("an admin ticks who ate; the sheet and each student's days follow", async () => {
    const [a, b, c] = await students(3);
    const lunch = (await db.call(admin, 'create_meal_event', today, 'LUNCH', at(5), null, null, 'REGULAR', null, null, null)).meal_service_id as string;
    expect((await db.call(admin, 'set_meal_attendance', lunch, [a.coupon])).status).toBe('NOT_STARTED');
    await skip(10);
    expect(await db.call(admin, 'set_meal_attendance', lunch, [a.coupon, b.coupon])).toMatchObject({ status: 'OK', added: 2, present: 2 });
    expect(await db.call(admin, 'set_meal_attendance', lunch, [a.coupon, c.coupon])).toMatchObject({ added: 1, removed: 1, present: 2 });
    const sheet = await db.call(admin, 'meal_attendance_sheet', lunch);
    expect((sheet.people as Array<{ coupon_number: number; ate: boolean }>).filter((p) => p.ate).map((p) => p.coupon_number)).toEqual([a.coupon, c.coupon]);

    const days = (await db.call(a.id, 'my_meal_days', 30)) as unknown as Array<{ date: string; meals: Array<{ ate: boolean; meal_type: string }> }>;
    expect(days[0]).toMatchObject({ date: today, meals: [{ meal_type: 'LUNCH', ate: true }] });
    expect(((await db.call(b.id, 'my_meal_days', 30)) as unknown as typeof days)[0].meals[0].ate).toBe(false);
    const day = (await db.call(a.id, 'meal_day', today)) as unknown as Array<Record<string, unknown>>;
    expect(day[0]).toMatchObject({ meal_type: 'LUNCH', ate: true });
    await expect(db.call(a.id, 'set_meal_attendance', lunch, [a.coupon])).rejects.toThrow(/requires role/);
  });
});

describe('roommates', () => {
  test('a request by coupon and student ID, accepted by the other student, shows on both sides', async () => {
    const [a, b] = await students(2);
    expect((await db.call(a.id, 'request_roommate', b.coupon, 'wrong')).status).toBe('NOT_FOUND');
    const r = await db.call(a.id, 'request_roommate', b.coupon, `s00${b.coupon}`);
    expect(r).toMatchObject({ status: 'SENT', person: { coupon_number: b.coupon, name: `Student ${b.coupon}` } });
    expect((await db.call(b.id, 'request_roommate', a.coupon, `S00${a.coupon}`)).status).toBe('ALREADY');
    const inc = (await db.call(b.id, 'my_roommates')).incoming as Array<{ link_id: string; coupon_number: number }>;
    expect(inc[0].coupon_number).toBe(a.coupon);
    expect((await db.call(b.id, 'respond_roommate', inc[0].link_id, true)).status).toBe('ACCEPTED');
    expect(((await db.call(a.id, 'my_roommates')).accepted as Array<{ coupon_number: number }>)[0].coupon_number).toBe(b.coupon);
    expect(((await db.call(b.id, 'my_roommates')).accepted as Array<{ coupon_number: number }>)[0].coupon_number).toBe(a.coupon);

    const person = await db.call(admin, 'admin_person', a.id);
    expect(person).toMatchObject({ coupon_number: a.coupon, name: `Student ${a.coupon}`, roommates: { accepted: [{ coupon_number: b.coupon }] } });
    expect((await db.call(a.id, 'remove_roommate', inc[0].link_id)).status).toBe('REMOVED');
    expect((await db.call(b.id, 'my_roommates')).accepted).toEqual([]);
  });
});

describe('names, messages and walk-ins', () => {
  test('a student asks for a new name; it changes only when an admin approves', async () => {
    const [a] = await students(1);
    expect((await db.call(a.id, 'request_name_change', '  Amit   Sarker ')).status).toBe('SENT');
    expect((await db.call(a.id, 'my_extras')).name_request).toMatchObject({ new_name: 'Amit Sarker' });
    const list = (await db.call(admin, 'admin_name_requests')) as unknown as Array<{ request_id: string; old_name: string; coupon_number: number }>;
    expect(list).toMatchObject([{ old_name: 'Student 1', coupon_number: a.coupon }]);
    expect((await db.admin<{ full_name: string }>('select full_name from public.profiles where id = $1', [a.id]))[0].full_name).toBe('Student 1');
    expect((await db.call(admin, 'decide_name_change', list[0].request_id, true)).status).toBe('APPROVED');
    expect((await db.admin<{ full_name: string }>('select full_name from public.profiles where id = $1', [a.id]))[0].full_name).toBe('Amit Sarker');
    expect((await db.call(a.id, 'my_extras')).name_request).toBeNull();
    expect((await db.call(admin, 'decide_name_change', list[0].request_id, false)).status).toBe('ALREADY_DECIDED');
    await expect(db.call(a.id, 'admin_name_requests')).rejects.toThrow(/requires role/);
  });

  test('admins change their own name straight away; students cannot', async () => {
    const [a] = await students(1);
    expect(await db.call(admin, 'set_my_name', '  Turjjo   Paul ')).toMatchObject({ status: 'OK', name: 'Turjjo Paul' });
    expect((await db.admin<{ full_name: string }>('select full_name from public.profiles where id = $1', [admin]))[0].full_name).toBe('Turjjo Paul');
    expect((await db.call(admin, 'set_my_name', 'x')).status).toBe('INVALID_NAME');
    await expect(db.call(a.id, 'set_my_name', 'Someone Else')).rejects.toThrow(/requires role/);
  });

  test('an admin message reaches the coupon holder as a notification', async () => {
    const [a] = await students(1);
    expect((await db.call(admin, 'admin_send_message', a.coupon, 'Please book your slot next time.')).status).toBe('SENT');
    expect((await db.call(admin, 'admin_send_message', 99, 'Hello')).status).toBe('NO_HOLDER');
    const notes = (await db.call(a.id, 'my_notifications', 10)) as unknown as Array<{ kind: string; payload: { message: string } }>;
    expect(notes[0]).toMatchObject({ kind: 'ADMIN_MESSAGE', payload: { message: 'Please book your slot next time.' } });
    await expect(db.call(a.id, 'admin_send_message', a.coupon, 'hi')).rejects.toThrow(/requires role/);
  });
});

describe('timers, posters and plates', () => {
  test("a meal's own timers set when booking opens and how long booked students have", async () => {
    const id = (await db.call(admin, 'create_meal_event', today, 'DINNER', at(60), null, 'Feast', 'FEAST', null, null, null)).meal_service_id as string;
    expect((await db.call(admin, 'set_meal_timers', id, 30, 12)).status).toBe('OK');
    expect((await db.call(admin, 'set_meal_timers', id, 0, 12)).status).toBe('INVALID_TIMERS');
    const opens = (await db.admin<{ m: number }>(
      `select extract(epoch from (m.service_start_at - b.booking_opens_at)) / 60 as m
       from public.meal_batches b join public.meal_services m on m.id = b.meal_service_id where b.meal_service_id = $1`, [id]))[0].m;
    expect(Number(opens)).toBe(30);
    const meals = (await db.call(admin, 'admin_meal_services', 5)).meals as Array<Record<string, unknown>>;
    expect(meals.find((m) => m.id === id)).toMatchObject({ booking_open_minutes: 30, arrival_minutes: 12 });
    expect((await db.call(admin, 'set_meal_poster', id, 'https://x/p.jpg')).status).toBe('OK');
    expect(((await db.call(admin, 'admin_meal_services', 5)).meals as Array<Record<string, unknown>>)[0].poster_url).toBe('https://x/p.jpg');
  });

  test('admins mark who has a plate and remind them all', async () => {
    const [a, b] = await students(2);
    expect((await db.call(admin, 'set_plate', a.coupon, true)).status).toBe('OK');
    expect((await db.call(admin, 'set_plate', 99, true)).status).toBe('NO_HOLDER');
    expect((await db.call(admin, 'admin_person', a.id)).has_plate).toBe(true);
    expect((await db.call(admin, 'admin_person', b.id)).has_plate).toBe(false);
    expect(await db.call(admin, 'remind_plates')).toMatchObject({ status: 'SENT', count: 1 });
    const notes = (await db.call(a.id, 'my_notifications', 5)) as unknown as Array<{ kind: string }>;
    expect(notes[0].kind).toBe('ADMIN_MESSAGE');
    await db.call(admin, 'set_plate', a.coupon, false);
    expect((await db.call(admin, 'admin_person', a.id)).has_plate).toBe(false);
    await expect(db.call(a.id, 'set_plate', a.coupon, false)).rejects.toThrow(/requires role/);
  });
});

describe('deleting an account', () => {
  test('history stays as it was; from now on the account is gone and its coupon is free', async () => {
    const [a, b] = await students(2);
    await db.admin('update public.profiles set student_id = $1 where id = $2', ['S001', a.id]);
    const lunch = (await db.call(admin, 'create_meal_event', today, 'LUNCH', at(5), null, null, 'REGULAR', null, null, null)).meal_service_id as string;
    await skip(10);
    await db.call(admin, 'set_meal_attendance', lunch, [a.coupon]);
    await db.call(a.id, 'request_roommate', b.coupon, 'S00' + b.coupon);

    expect((await db.call(a.id, 'delete_my_account', 'nope')).status).toBe('NOT_CONFIRMED');
    expect((await db.call(a.id, 'delete_my_account', 'delete')).status).toBe('DELETED');

    // Kept: name, student ID, the meal they ate, and the claim (ended now).
    const [p] = await db.admin<{ full_name: string; student_id: string }>('select full_name, student_id from public.profiles where id = $1', [a.id]);
    expect(p).toMatchObject({ full_name: 'Student 1', student_id: 'S001' });
    expect((await db.admin<{ n: number }>(`select count(*)::int n from public.attendance_records where holder_user_id = $1 and status = 'VALID'`, [a.id]))[0].n).toBe(1);
    expect((await db.admin<{ status: string }>(`select status::text from public.coupon_claims where user_id = $1`, [a.id]))[0].status).toBe('REVOKED');

    // From now on: no calls, coupon free, not in the list, roommate request gone.
    await expect(db.call(a.id, 'my_meal_days', 30)).rejects.toThrow(/deleted/);
    const people = (await db.call(admin, 'admin_people_data', null)) as unknown as Array<{ coupon_number: number | null; account: string; user_id: string | null }>;
    expect(people.find((r) => r.coupon_number === a.coupon)).toMatchObject({ account: 'UNCLAIMED', user_id: null });
    expect(people.some((r) => r.user_id === a.id)).toBe(false);
    expect(((await db.call(b.id, 'my_roommates')).incoming as unknown[]).length).toBe(0);

    // The same student ID can sign up again later, and the coupon can be claimed.
    const again = await db.createUser('STUDENT', { name: 'Student 1 again' });
    await db.admin('update public.profiles set student_id = $1 where id = $2', ['S001', again]);
    expect((await db.call(again, 'request_coupon', a.coupon, 'Student 1', null, 'S001')).status).toBe('PENDING');
  });

  test("past records keep the name they had that day; a later name change applies from then on", async () => {
    const [a] = await students(1);
    const lunch = (await db.call(admin, 'create_meal_event', today, 'LUNCH', at(5), null, null, 'REGULAR', null, null, null)).meal_service_id as string;
    await skip(10);
    await db.call(admin, 'set_meal_attendance', lunch, [a.coupon]);
    const req = await db.call(a.id, 'request_name_change', 'New Name');
    await db.call(admin, 'decide_name_change', req.request_id, true);
    const [r] = await db.admin<{ holder_name: string }>('select holder_name from public.attendance_records where meal_service_id = $1', [lunch]);
    expect(r.holder_name).toBe('Student 1');
  });

  test('the last super admin cannot delete their account', async () => {
    expect((await db.call(admin, 'delete_my_account', 'DELETE')).status).toBe('LAST_SUPER_ADMIN');
  });
});

describe('a new semester', () => {
  const register = (rows: Array<[number, string]>) => db.call(admin, 'import_coupons',
    JSON.stringify(rows.map(([n, sid]) => ({ coupon_number: n, hall_record: { student_id: sid, name: 'x' } }))));

  test('when coupon 1 moves to another student ID, both are told to update; the old holder keeps a record', async () => {
    const [x, y] = await students(2);   // x holds 1 (S001), y holds 2 (S002)
    await db.admin(`update public.profiles set student_id = 'S00' || (select coupon_number from public.coupon_claims c
      join public.coupons k on k.id = c.coupon_id where c.user_id = profiles.id and c.status = 'APPROVED') where id = any($1::uuid[])`, [[x.id, y.id]]);
    // New register: coupon 1 is now y's, coupon 2 is x's.
    const r = await register([[1, 'S002'], [2, 'S001']]);
    expect(r.notified).toBeGreaterThanOrEqual(2);
    const kinds = async (id: string) => ((await db.call(id, 'my_notifications', 10)) as unknown as Array<{ kind: string; payload: { message: string } }>)
      .filter((n) => n.kind === 'COUPON_UPDATE_REQUESTED').map((n) => n.payload.message);
    expect((await kinds(x.id)).some((m) => m.includes('coupon 2'))).toBe(true);
    expect((await kinds(y.id)).some((m) => m.includes('coupon 1'))).toBe(true);
    // Uploading the same register again doesn't repeat the notices.
    const before = (await kinds(x.id)).length;
    await register([[1, 'S002'], [2, 'S001']]);
    expect((await kinds(x.id)).length).toBe(before);

    // y asks for coupon 1 (allowed: the register lists them), the admin hands it over.
    const req = await db.call(y.id, 'request_coupon', 1);
    expect(req.status).toBe('PENDING');
    expect((await db.call(admin, 'approve_coupon_claim', req.claim_id, 'New semester', true)).status).toBe('APPROVED');
    // y sees x as coupon 1's earlier holder.
    const h = await db.call(y.id, 'my_history');
    expect(h.coupon_number).toBe(1);
    expect((h.earlier_holders as Array<{ student_id: string }>)[0].student_id).toBe('S001');
    // A third student the register doesn't list can't claim coupon 1.
    const [z] = await students(1, 3);
    await db.admin(`update public.profiles set student_id = 'S003' where id = $1`, [z.id]);
    expect((await db.call(z.id, 'request_coupon', 1)).status).toBe('COUPON_TAKEN');
  });

  test('earlier names and student IDs are kept and shown', async () => {
    const [a] = await students(1);
    await db.admin(`update public.profiles set student_id = 'S001' where id = $1`, [a.id]);
    const req = await db.call(a.id, 'request_name_change', 'Amit Sarker');
    await db.call(admin, 'decide_name_change', req.request_id, true);
    const h = await db.call(a.id, 'my_history');
    expect((h.changes as Array<{ field: string; old: string; new: string }>)[0]).toMatchObject({ field: 'NAME', old: 'Student 1', new: 'Amit Sarker' });
    expect(((await db.call(admin, 'admin_person', a.id)).history as { changes: unknown[] }).changes.length).toBe(1);
  });
});

describe('coupons without an account yet', () => {
  test('an admin ticks a coupon with no account; when its student claims it, the meal is theirs', async () => {
    await db.admin(`insert into public.coupons (coupon_number, hall_record) values (9, '{"name": "Nadia Islam", "student_id": "S009"}')`);
    const lunch = (await db.call(admin, 'create_meal_event', today, 'LUNCH', at(5), null, null, 'REGULAR', null, null, null)).meal_service_id as string;
    await skip(10);
    const sheet = (await db.call(admin, 'meal_attendance_sheet', lunch)).people as Array<{ coupon_number: number; has_account: boolean; name: string }>;
    expect(sheet.find((p) => p.coupon_number === 9)).toMatchObject({ has_account: false, name: 'Nadia Islam' });
    expect(await db.call(admin, 'set_meal_attendance', lunch, [9])).toMatchObject({ status: 'OK', added: 1, present: 1 });
    const people = (await db.call(admin, 'admin_people_data', null)) as unknown as Array<{ coupon_number: number; coupon_meals: number | null }>;
    expect(people.find((p) => p.coupon_number === 9)?.coupon_meals).toBe(1);
    const page = await db.call(admin, 'admin_coupon', 9);
    expect(page).toMatchObject({ meals_eaten: 1, holder: null });
    expect((page.days as unknown[]).length).toBe(1);
    const after = (await db.call(admin, 'meal_attendance_sheet', lunch)).people as Array<{ coupon_number: number; ate: boolean }>;
    expect(after.find((p) => p.coupon_number === 9)?.ate).toBe(true);

    // Later she signs up and claims coupon 9; once approved, the lunch shows in her history.
    const nadia = await db.createUser('STUDENT', { name: 'Nadia Islam' });
    const claim = await db.call(nadia, 'request_coupon', 9, 'Nadia Islam', null, 'S009');
    await db.call(admin, 'approve_coupon_claim', claim.claim_id, 'ok', false);
    const days = (await db.call(nadia, 'my_meal_days', 30)) as unknown as Array<{ meals: Array<{ ate: boolean }> }>;
    expect(days[0].meals[0].ate).toBe(true);
    expect((await db.call(admin, 'admin_person', nadia)).meals_eaten).toBe(1);
    // The record is now hers and can't be handed to anyone else.
    await expect(db.admin(`update public.attendance_records set holder_user_id = $1 where meal_service_id = $2`, [admin, lunch]))
      .rejects.toThrow(/immutable/);
  });
});

describe('fixing past meals', () => {
  const notes = async (uid: string) => (await db.admin<{ kind: string; message: string }>(
    `select kind, payload ->> 'message' as message from public.notification_outbox where recipient_id = $1 order by created_at`, [uid]));

  test('a closed meal can be renamed and its menu fixed; everyone is told; ticking someone tells only them', async () => {
    const [a, b] = await students(2);
    const lunch = (await db.call(admin, 'create_meal_event', today, 'LUNCH', at(5), null, null, 'REGULAR', null,
      JSON.stringify([{ name: 'Rcie' }]), null)).meal_service_id as string;
    await skip(10);
    await db.admin('select public.run_due_jobs()');
    await db.call(admin, 'set_meal_service_state', lunch, 'CLOSED', 'done');
    expect((await db.call(admin, 'set_meal_details', lunch, 'Friday lunch', 'REGULAR', null, null, JSON.stringify([{ name: 'Rice' }, { name: 'Dal' }]))).status).toBe('OK');
    expect((await notes(b.id)).at(-1)).toMatchObject({ kind: 'MEAL_EDITED' });
    expect((await notes(b.id)).at(-1)?.message).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}\. 1\. Rice, 2\. Dal$/);
    // Saving with nothing changed sends nothing.
    const before = (await notes(b.id)).length;
    await db.call(admin, 'set_meal_details', lunch, 'Friday lunch', 'REGULAR', null, null, JSON.stringify([{ name: 'Rice' }, { name: 'Dal' }]));
    expect((await notes(b.id)).length).toBe(before);

    // A forgotten student is ticked later: only they hear about it; unticking tells them too.
    await db.call(admin, 'set_meal_attendance', lunch, [a.coupon]);
    expect((await notes(a.id)).at(-1)).toMatchObject({ kind: 'DINED' });
    expect((await notes(b.id)).some((n) => n.kind === 'DINED')).toBe(false);
    await db.call(admin, 'set_meal_attendance', lunch, []);
    expect((await notes(a.id)).at(-1)).toMatchObject({ kind: 'DINED_REMOVED' });
  });

  test('an admin deletes a meal, records and all, after confirming', async () => {
    const [a] = await students(1);
    const lunch = (await db.call(admin, 'create_meal_event', today, 'LUNCH', at(5), null, null, 'REGULAR', null, null, null)).meal_service_id as string;
    await skip(10);
    await db.call(admin, 'set_meal_attendance', lunch, [a.coupon]);
    expect((await db.call(admin, 'delete_meal', lunch, 'nope')).status).toBe('NOT_CONFIRMED');
    expect((await db.call(admin, 'delete_meal', lunch, 'delete')).status).toBe('DELETED');
    expect((await db.admin<{ n: number }>('select count(*)::int n from public.meal_services where id = $1', [lunch]))[0].n).toBe(0);
    expect((await db.call(admin, 'admin_person', a.id)).meals_eaten).toBe(0);
    await expect(db.admin('delete from public.attendance_records')).resolves.toBeDefined();
    await expect(db.call(a.id, 'delete_meal', lunch, 'DELETE')).rejects.toThrow(/requires role/);
  });
});
