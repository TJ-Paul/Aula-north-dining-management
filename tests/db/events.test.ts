import { beforeEach, describe, expect, test } from 'vitest';
import { skipAheadSql } from './time-travel';
import { freshDb, type Db } from './harness';

let db: Db;
let superAdmin: string;
let attendant: string;
let today: string;
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
const menu = JSON.stringify([{ name: 'Khashi (mutton)', alternatives: ['Chicken'] }, { name: 'Polao' }, { name: 'Doi' }]);

/** A special event today in aisle A, starting in 10 minutes. */
async function event(by: string, opts: { type?: string; occasion?: string; name?: string } = {}) {
  const r = await db.call(by, 'create_meal_event', today, opts.type ?? 'DINNER', at(10), at(130),
    opts.name ?? 'Feast night', opts.occasion ?? 'FEAST', 'Alternative to khashi available: chicken.', menu, null);
  const id = r.meal_service_id as string;
  const wave = ((await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, id, null)).wave as { wave_id: string }).wave_id;
  return { id, wave };
}

/** The listed students eat at the event (booked, gate opened, coupon recorded). */
async function eat(ev: { id: string; wave: string }, eaters: Student[]) {
  for (const s of eaters) await db.call(s.id, 'book_meal', ev.id, null);
  await skip(11);
  await jobs();
  for (const s of eaters) {
    await db.call(attendant, 'record_coupon', ev.wave, s.coupon, `entry-${String(++entry).padStart(6, '0')}`, 'LIVE', null);
  }
}

/** Super admin nominates; each nominee accepts (the first creates the month). Returns the month id. */
async function startMonth(managers: Student[], name = 'Kartik 1433', by = superAdmin) {
  let monthId = '';
  for (const [i, m] of managers.entries()) {
    const n = await db.call(by, 'nominate_manager', m.id, null);
    const r = i === 0
      ? await db.call(m.id, 'respond_to_nomination', n.nomination_id, true, name, today, today)
      : await db.call(m.id, 'respond_to_nomination', n.nomination_id, true, null, null, null);
    monthId = r.mess_month_id as string;
  }
  return monthId;
}

beforeEach(async () => {
  db = await freshDb();
  superAdmin = await db.createUser('SUPER_ADMIN', { name: 'Hall Office' });
  attendant = await db.createUser('ATTENDANT');
  today = (await db.admin<{ d: string }>(`select public.dhaka_today()::text as d`))[0].d;
});

describe('meals and events', () => {
  test('one lunch and one dinner a day; cancelled meals free the slot; parons as often as needed', async () => {
    const make = (type: string, name: string) =>
      db.call(superAdmin, 'create_meal_event', today, type, at(60), null, name, 'REGULAR', null, null, null);
    const first = await make('DINNER', 'Dinner one');
    expect(first.status).toBe('CREATED');
    expect(await make('DINNER', 'Dinner two')).toMatchObject({ status: 'EXISTS', meal_service_id: first.meal_service_id });
    await db.call(superAdmin, 'set_meal_service_state', first.meal_service_id, 'CANCELLED', 'Moved');
    expect((await make('DINNER', 'Dinner two')).status).toBe('CREATED');
    expect((await make('PARON', 'Paron one')).status).toBe('CREATED');
    expect((await make('PARON', 'Paron two')).status).toBe('CREATED');
  });

  test('booking references name the meal: PAR for a paron, a number for the second of a kind that day', async () => {
    const [a, b] = await students(2);
    const p1 = (await db.call(superAdmin, 'create_meal_event', today, 'PARON', at(10), null, 'P1', 'REGULAR', null, null, null)).meal_service_id;
    const p2 = (await db.call(superAdmin, 'create_meal_event', today, 'PARON', at(10), null, 'P2', 'REGULAR', null, null, null)).meal_service_id;
    await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, p1, null);
    await db.call(attendant, 'mark_aisle_ready', 'B', true, true, true, p2, null);
    await db.call(a.id, 'book_meal', p1, null);
    await db.call(b.id, 'book_meal', p2, null);
    const refs = await db.admin<{ booking_ref: string }>('select booking_ref from public.reservations order by booking_ref');
    expect(refs.map((r) => r.booking_ref)).toEqual([`PAR-${today}-A-001`, `PAR2-${today}-B-001`]);
  });

  test('breakfast is not used; paron, improvement and feast are special events with names and times', async () => {
    expect((await db.call(superAdmin, 'create_meal_event', today, 'BREAKFAST', at(60), null, 'x', 'REGULAR', null, null, null)).status)
      .toBe('BREAKFAST_NOT_USED');
    expect((await db.call(superAdmin, 'create_meal_event', today, 'PARON', at(60), at(30), 'Paron', 'REGULAR', null, null, null)).status)
      .toBe('END_BEFORE_START');
    const r = await db.call(superAdmin, 'create_meal_event', today, 'PARON', at(60), at(180), 'Pohela Falgun paron', 'REGULAR',
      'Khichuri and beef', JSON.stringify([{ name: 'Khichuri' }, { name: 'Beef', alternatives: ['Egg', 'Chicken'] }]), null);
    expect(r.status).toBe('CREATED');
    const list = (await db.call(superAdmin, 'admin_meal_services', 10)) as unknown as { meals: Array<Record<string, unknown>> };
    expect(list.meals[0]).toMatchObject({
      name: 'Pohela Falgun paron', meal_type: 'PARON', special: true, description: 'Khichuri and beef',
      items: [{ name: 'Khichuri', alternatives: [] }, { name: 'Beef', alternatives: ['Chicken', 'Egg'] }],
    });
    const regular = await db.call(superAdmin, 'create_meal_event', today, 'LUNCH', at(30), null, null, 'REGULAR', null, null, null);
    const events = (await db.call(superAdmin, 'meal_events', 30)) as unknown as Array<{ id: string }>;
    expect(events.map((e) => e.id)).toEqual([r.meal_service_id]);
    expect(regular.status).toBe('CREATED');
  });

  test('admins close menu choices before the meal (shopping time); later picks are refused', async () => {
    const [a] = await students(1);
    const ev = await event(superAdmin);
    expect((await db.call(a.id, 'set_menu_choice_deadline', ev.id, at(5)).catch((e: Error) => e.message))).toMatch(/requires role/);
    expect((await db.call(superAdmin, 'set_menu_choice_deadline', ev.id, at(60))).status).toBe('CHOICES_AFTER_START');
    expect((await db.call(superAdmin, 'set_menu_choice_deadline', ev.id, at(5))).status).toBe('OK');
    const items = (await db.call(a.id, 'event_detail', ev.id)).items as Array<{ id: string; alternatives: Array<{ id: string }> }>;
    expect((await db.call(a.id, 'choose_alternative', items[0].id, items[0].alternatives[0].id)).status).toBe('OK');
    await skip(6);
    expect((await db.call(a.id, 'choose_alternative', items[0].id, null)).status).toBe('TOO_LATE');
    expect((await db.call(a.id, 'event_detail', ev.id)).choices_close_at).toBeTruthy();
  });

  test('students pick an alternative until the meal starts; admins see the totals', async () => {
    const [a, b, c] = await students(3);
    const ev = await event(superAdmin);
    const d = await db.call(a.id, 'event_detail', ev.id);
    const items = d.items as Array<{ id: string; name: string; alternatives: Array<{ id: string; name: string }> }>;
    const khashi = items[0];
    expect(khashi.alternatives.map((x) => x.name)).toEqual(['Chicken']);
    expect(d).toMatchObject({ description: 'Alternative to khashi available: chicken.', can_choose: true });

    await db.call(a.id, 'choose_alternative', khashi.id, khashi.alternatives[0].id);
    await db.call(b.id, 'choose_alternative', khashi.id, khashi.alternatives[0].id);
    await expect(db.call(c.id, 'choose_alternative', items[1].id, khashi.alternatives[0].id)).rejects.toThrow(/not offered/);
    expect(((await db.call(a.id, 'event_detail', ev.id)).items as Array<{ my_choice: string }>)[0].my_choice).toBe(khashi.alternatives[0].id);

    const admin = await db.call(superAdmin, 'event_detail', ev.id);
    expect((admin.items as Array<{ totals: unknown }>)[0].totals).toEqual([{ alternative: 'Chicken', count: 2 }]);
    expect((await db.call(a.id, 'event_detail', ev.id)).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ totals: null })]));

    await skip(11);
    expect((await db.call(c.id, 'choose_alternative', khashi.id, khashi.alternatives[0].id)).status).toBe('TOO_LATE');
  });

  test('editing the menu keeps picks whose item and alternative still exist', async () => {
    const [a] = await students(1);
    const ev = await event(superAdmin);
    const khashi = ((await db.call(a.id, 'event_detail', ev.id)).items as Array<{ id: string; alternatives: Array<{ id: string }> }>)[0];
    await db.call(a.id, 'choose_alternative', khashi.id, khashi.alternatives[0].id);
    const r = await db.call(superAdmin, 'set_meal_details', ev.id, 'Feast night', 'FEAST', 'Now with fish too', at(130),
      JSON.stringify([{ name: 'Rui fish' }, { name: 'Khashi (mutton)', alternatives: ['Chicken', 'Egg'] }]));
    expect(r).toMatchObject({ status: 'OK', choices_kept: 1 });
    const items = (await db.call(a.id, 'event_detail', ev.id)).items as Array<{ name: string; my_choice: string | null; alternatives: Array<{ id: string; name: string }> }>;
    expect(items[1].name).toBe('Khashi (mutton)');
    expect(items[1].my_choice).toBe(items[1].alternatives.find((x) => x.name === 'Chicken')!.id);
  });

  test('only admins create or edit events', async () => {
    const [a] = await students(1);
    await expect(db.call(a.id, 'create_meal_event', today, 'DINNER', at(10), null, 'x', 'FEAST', null, null, null))
      .rejects.toThrow(/requires role ADMIN/);
  });
});

describe('anonymous feedback', () => {
  test('is stored without any sender, readable only by admins, and limited to 10 a day', async () => {
    const [a, b] = await students(2);
    const ev = await event(superAdmin);
    expect((await db.call(a.id, 'submit_feedback', 'COMPLAINT', 'The khashi was cold', ev.id)).status).toBe('SENT');
    expect((await db.call(b.id, 'submit_feedback', 'SUGGESTION', 'More fans in aisle B please', null)).status).toBe('SENT');

    const cols = await db.admin<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'feedback'`);
    expect(cols.map((c) => c.column_name)).not.toEqual(expect.arrayContaining(['user_id']));

    const list = (await db.call(superAdmin, 'list_feedback', null, false)) as unknown as Array<{ kind: string; body: string; event: unknown }>;
    expect(list.map((f) => f.body).sort()).toEqual(['More fans in aisle B please', 'The khashi was cold']);
    expect(await db.select(a.id, 'select * from public.feedback')).toEqual([]);
    await expect(db.call(a.id, 'list_feedback', null, false)).rejects.toThrow(/requires role ADMIN/);

    for (let i = 0; i < 9; i++) await db.call(a.id, 'submit_feedback', 'FEEDBACK', `note ${i}`, null);
    expect((await db.call(a.id, 'submit_feedback', 'FEEDBACK', 'one too many', null)).status).toBe('DAILY_LIMIT');
  });

  test('event feedback is for special events only; unverified accounts cannot send', async () => {
    const [a] = await students(1);
    const lunch = await db.call(superAdmin, 'create_meal_event', today, 'LUNCH', at(30), null, null, 'REGULAR', null, null, null);
    expect((await db.call(a.id, 'submit_feedback', 'FEEDBACK', 'Nice lunch', lunch.meal_service_id)).status).toBe('NOT_AN_EVENT');
    const stranger = await db.createUser();
    expect((await db.call(stranger, 'submit_feedback', 'FEEDBACK', 'hello', null)).status).toBe('NOT_VERIFIED');
  });

  test('admins mark feedback seen or resolved with a note', async () => {
    const [a] = await students(1);
    await db.call(a.id, 'submit_feedback', 'COMPLAINT', 'Water filter broken', null);
    const [f] = (await db.call(superAdmin, 'list_feedback', null, false)) as unknown as Array<{ id: string }>;
    await db.call(superAdmin, 'update_feedback', f.id, 'RESOLVED', 'Filter replaced');
    expect(await db.call(superAdmin, 'list_feedback', null, false)).toEqual([]);
    expect(((await db.call(superAdmin, 'list_feedback', null, true)) as unknown as Array<Record<string, unknown>>)[0])
      .toMatchObject({ status: 'RESOLVED', admin_note: 'Filter replaced', handled_by: 'Hall Office' });
  });
});

describe('mess months and handover', () => {
  test('the super admin starts month 1: the first nominee creates it, the next joins it', async () => {
    const [a, b] = await students(2);
    const na = await db.call(superAdmin, 'nominate_manager', a.id, 'Please lead this month');
    const nb = await db.call(superAdmin, 'nominate_manager', b.id, null);
    expect(await db.call(a.id, 'my_nomination')).toMatchObject({ nominated_by: 'Hall Office', join_month: null, next_serial: 1 });

    expect((await db.call(a.id, 'respond_to_nomination', na.nomination_id, true, null, null, null)).status).toBe('MONTH_DETAILS_REQUIRED');
    expect(await db.call(a.id, 'respond_to_nomination', na.nomination_id, true, 'Kartik 1433', today, today))
      .toMatchObject({ status: 'ACCEPTED', serial: 1, created_month: true });
    expect(await db.call(b.id, 'my_nomination')).toMatchObject({ join_month: { serial: 1, name: 'Kartik 1433' } });
    expect(await db.call(b.id, 'respond_to_nomination', nb.nomination_id, true, null, null, null))
      .toMatchObject({ status: 'ACCEPTED', serial: 1, created_month: false });

    const dash = await db.call(a.id, 'mess_dashboard', null);
    const month = dash.month as { serial: number; managers: Array<{ name: string; coupon_number: number; status: string }> };
    expect(month.serial).toBe(1);
    expect(month.managers.map((m) => [m.name, m.coupon_number, m.status]).sort())
      .toEqual([[`Student ${a.coupon}`, a.coupon, 'ACTIVE'], [`Student ${b.coupon}`, b.coupon, 'ACTIVE']]);
    expect((await db.admin<{ role: string }>('select role from public.profiles where id = $1', [a.id]))[0].role).toBe('ADMIN');
  });

  test('a nominee can decline; only active managers or the super admin can nominate; only verified students can be nominated', async () => {
    const [a, b, c] = await students(3);
    const n = await db.call(superAdmin, 'nominate_manager', a.id, null);
    expect((await db.call(a.id, 'respond_to_nomination', n.nomination_id, false, null, null, null)).status).toBe('REJECTED');
    await expect(db.call(b.id, 'nominate_manager', c.id, null)).rejects.toThrow(/requires role ADMIN/);
    const outsider = await db.createUser();
    expect((await db.call(superAdmin, 'nominate_manager', outsider, null)).status).toBe('NOT_A_VERIFIED_STUDENT');
  });

  test('managers hand over: they cannot retire before a successor accepts; afterwards they retire to student', async () => {
    const [a, b, c] = await students(3);
    await startMonth([a, b]);
    expect((await db.call(a.id, 'retire_manager', null)).status).toBe('NO_SUCCESSOR');

    const n = await db.call(a.id, 'nominate_manager', c.id, null);
    const tomorrow = (await db.admin<{ d: string }>(`select (public.dhaka_today() + 1)::text as d`))[0].d;
    expect(await db.call(c.id, 'respond_to_nomination', n.nomination_id, true, 'Agrahayan 1433', tomorrow, tomorrow))
      .toMatchObject({ serial: 2, created_month: true });

    expect((await db.call(a.id, 'retire_manager', null)).status).toBe('RETIRED');
    expect((await db.admin<{ role: string }>('select role from public.profiles where id = $1', [a.id]))[0].role).toBe('STUDENT');
    const months = (await db.call(c.id, 'mess_dashboard', null)).months as Array<{ serial: number; id: string }>;
    expect(months.map((m) => m.serial)).toEqual([2, 1]);
    const first = (await db.call(c.id, 'mess_dashboard', months[1].id)).month as { managers: Array<{ name: string; status: string }> };
    expect(first.managers.find((m) => m.name === `Student ${a.coupon}`)!.status).toBe('RETIRED');
    expect(first.managers.find((m) => m.name === `Student ${b.coupon}`)!.status).toBe('ACTIVE');
    // A retired manager can no longer nominate.
    await expect(db.call(a.id, 'nominate_manager', b.id, null)).rejects.toThrow(/requires role ADMIN/);
  });

  test('managers add a fellow manager to this month, or hand over to a new month the nominee designs', async () => {
    const [a, b, c, d] = await students(4);
    const one = await startMonth([a]);
    // A fellow manager joins this month.
    const n = await db.call(a.id, 'nominate_manager', b.id, null, false);
    expect(n).toMatchObject({ status: 'NOMINATED', next_month: false });
    expect(await db.call(b.id, 'respond_to_nomination', n.nomination_id, true, null, null, null))
      .toMatchObject({ mess_month_id: one, created_month: false });
    expect((await db.call(a.id, 'nominate_manager', b.id, null, false)).status).toBe('ALREADY_MANAGER');
    // A new month: the nominee names it and sets its dates.
    const h = await db.call(b.id, 'nominate_manager', c.id, null, true);
    const later = (await db.admin<{ s: string; e: string }>(`select (public.dhaka_today() + 2)::text as s, (public.dhaka_today() + 30)::text as e`))[0];
    const r = await db.call(c.id, 'respond_to_nomination', h.nomination_id, true, 'Poush 1433', later.s, later.e);
    expect(r).toMatchObject({ serial: 2, created_month: true });
    // Its managers (and devs) change it; others can't.
    const two = r.mess_month_id as string;
    expect((await db.call(c.id, 'set_mess_month_banner', two, 'https://x.example/banner.jpg', false)).status).toBe('OK');
    expect((await db.call(a.id, 'set_mess_month_banner', two, 'https://x.example/b.jpg', false)).status).toBe('NOT_YOUR_MONTH');
    await expect(db.call(d.id, 'set_mess_month_banner', two, null, true)).rejects.toThrow(/requires role ADMIN/);
    await expect(db.call(c.id, 'set_mess_month_banner', two, 'javascript:alert(1)', false)).rejects.toThrow(/not a picture/);
    expect((await db.call(c.id, 'update_mess_month', two, 'Poush', later.s, later.e)).status).toBe('OK');
    expect((await db.call(c.id, 'update_mess_month', two, 'Poush', today, later.e)).status).toBe('STARTS_BEFORE_PREVIOUS_MONTH');
    expect((await db.call(superAdmin, 'update_mess_month', one, 'Kartik', later.e, later.e)).status).toBe('STARTS_AFTER_NEXT_MONTH');
    expect((await db.call(superAdmin, 'set_mess_month_banner', two, null, true)).status).toBe('OK');
    const dash = await db.call(c.id, 'mess_dashboard', two);
    expect(dash.month).toMatchObject({ name: 'Poush', banner_url: null, can_edit: true });
    expect((await db.call(a.id, 'mess_dashboard', two)).month).toMatchObject({ can_edit: false });
    await db.call(c.id, 'set_mess_month_banner', two, 'https://x.example/banner.jpg', false);
    // Their profile keeps every month they served, retired or not.
    expect((await db.call(a.id, 'retire_manager', null)).status).toBe('RETIRED');
    expect((await db.call(a.id, 'my_extras')).managed).toMatchObject([{ serial: 1, name: 'Kartik 1433', status: 'RETIRED' }]);
    expect((await db.call(c.id, 'my_extras')).managed).toMatchObject([{ serial: 2, name: 'Poush', banner_url: 'https://x.example/banner.jpg', status: 'ACTIVE' }]);
    expect((await db.call(d.id, 'my_extras')).managed).toEqual([]);
  });

  test('a dev makes anyone a mess manager of any month at once, no acceptance', async () => {
    const [a, b, c] = await students(3);
    const one = await startMonth([a]);
    await db.call(a.id, 'nominate_manager', c.id, null, false);   // pending: withdrawn by the dev's assignment
    expect(await db.call(superAdmin, 'dev_assign_manager', c.id, one)).toMatchObject({ status: 'ASSIGNED', serial: 1 });
    expect(await db.call(c.id, 'my_nomination')).toBeNull();
    expect((await db.admin<{ role: string }>('select role from public.profiles where id = $1', [c.id]))[0].role).toBe('ADMIN');
    expect((await db.call(superAdmin, 'dev_assign_manager', c.id, one)).status).toBe('ALREADY_MANAGER');
    const person = await db.call(superAdmin, 'admin_person', c.id);
    expect(person.managed).toMatchObject([{ serial: 1, status: 'ACTIVE' }]);
    expect(person.mess_months).toMatchObject([{ id: one, serial: 1 }]);
    expect((await db.call(a.id, 'admin_person', c.id)).mess_months).toBeNull();
    // A retired manager comes back the same way; only a dev can do it.
    await db.call(superAdmin, 'retire_manager', c.id);
    expect((await db.call(superAdmin, 'dev_assign_manager', c.id, one)).status).toBe('ASSIGNED');
    await expect(db.call(a.id, 'dev_assign_manager', b.id, one)).rejects.toThrow(/requires role SUPER_ADMIN/);
    const managers = ((await db.call(b.id, 'mess_dashboard', one)).month as { managers: Array<{ name: string; status: string }> }).managers;
    expect(managers.map((m) => m.status)).toEqual(['ACTIVE', 'ACTIVE']);
  });

  test('the super admin can step in and retire anyone', async () => {
    const [a] = await students(1);
    await startMonth([a]);
    expect((await db.call(superAdmin, 'retire_manager', a.id)).status).toBe('RETIRED');
  });
});

describe('manager ratings', () => {
  async function setup() {
    const [ma, mb, ...diners] = await students(6);
    const month = await startMonth([ma, mb]);
    const ev = await event(ma.id);
    await eat(ev, diners.slice(0, 3));
    return { ma, mb, diners, month, ev };
  }

  test('only students who ate at a special event can rate, 1–5 whole stars, never themselves', async () => {
    const { ma, mb, diners, ev } = await setup();
    const [d1, , , absent] = diners;
    expect((await db.call(d1.id, 'event_detail', ev.id))).toMatchObject({ attended: true, can_rate: true });
    expect((await db.call(absent.id, 'rate_managers', ev.id, JSON.stringify([{ manager_id: ma.id, stars: 5 }]))).status).toBe('NOT_ATTENDED');
    await expect(db.call(d1.id, 'rate_managers', ev.id, JSON.stringify([{ manager_id: ma.id, stars: 4.5 }]))).rejects.toThrow(/whole number/);
    await expect(db.call(d1.id, 'rate_managers', ev.id, JSON.stringify([{ manager_id: d1.id, stars: 5 }]))).rejects.toThrow(/not a mess manager/);
    expect(await db.call(d1.id, 'rate_managers', ev.id, JSON.stringify([{ manager_id: ma.id, stars: 5 }, { manager_id: mb.id, stars: 3 }])))
      .toMatchObject({ status: 'OK', rated: 2 });
    // Rating again replaces the earlier rating (here: only manager A, 4 stars).
    await db.call(d1.id, 'rate_managers', ev.id, JSON.stringify([{ manager_id: ma.id, stars: 4 }]));
    expect(await db.admin('select stars from public.manager_ratings')).toEqual([{ stars: 4 }]);
  });

  test('regular meals are not rateable', async () => {
    const [ma, d] = await students(2);
    await startMonth([ma]);
    const r = await db.call(ma.id, 'create_meal_event', today, 'LUNCH', at(10), null, null, 'REGULAR', null, null, null);
    const wave = ((await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, r.meal_service_id, null)).wave as { wave_id: string }).wave_id;
    await eat({ id: r.meal_service_id as string, wave }, [d]);
    expect((await db.call(d.id, 'rate_managers', r.meal_service_id, JSON.stringify([{ manager_id: ma.id, stars: 5 }]))).status).toBe('NOT_RATEABLE');
  });

  test('scores stay hidden until the month is over; then total stars ÷ the highest rating count', async () => {
    const { ma, mb, diners, month, ev } = await setup();
    const [d1, d2, d3] = diners;
    await db.call(d1.id, 'rate_managers', ev.id, JSON.stringify([{ manager_id: ma.id, stars: 4 }, { manager_id: mb.id, stars: 5 }]));
    await db.call(d2.id, 'rate_managers', ev.id, JSON.stringify([{ manager_id: ma.id, stars: 4 }, { manager_id: mb.id, stars: 5 }]));
    await db.call(d3.id, 'rate_managers', ev.id, JSON.stringify([{ manager_id: ma.id, stars: 4 }]));

    const before = (await db.call(d1.id, 'mess_dashboard', month)).month as { managers: Array<{ score: unknown; rated_count: unknown }> };
    expect(before.managers.every((m) => m.score === null && m.rated_count === null)).toBe(true);
    expect(await db.select(d1.id, 'select count(*)::int as n from public.manager_ratings')).toEqual([{ n: 2 }]); // only their own

    // The month (and the event in it) are now in the past.
    await db.admin(`update public.mess_months set starts_on = starts_on - 30, ends_on = public.dhaka_today() - 1 where id = $1`, [month]);
    await db.admin(`update public.meal_services set service_date = public.dhaka_today() - 1 where id = $1`, [ev.id]);
    expect((await db.call(d1.id, 'rate_managers', ev.id, JSON.stringify([{ manager_id: ma.id, stars: 1 }]))).status).toBe('RATING_CLOSED');

    const after = (await db.call(d1.id, 'mess_dashboard', month)).month as {
      over: boolean; managers: Array<{ name: string; rated_count: number; total_stars: number; score: string }>;
    };
    expect(after.over).toBe(true);
    // A: 3 ratings, 12 stars → 12/3 = 4.00. B: 2 ratings, 10 stars → 10/3 = 3.33 (divided by the top count, 3).
    expect(after.managers.map((m) => [m.name, m.rated_count, m.total_stars, Number(m.score)])).toEqual([
      [`Student ${ma.coupon}`, 3, 12, 4],
      [`Student ${mb.coupon}`, 2, 10, 3.33],
    ]);
  });

  test('the month dashboard counts events and attendance; feedback only for admins', async () => {
    const { ma, diners, month, ev } = await setup();
    await db.call(diners[0].id, 'submit_feedback', 'FEEDBACK', 'Great feast', ev.id);
    const asAdmin = (await db.call(ma.id, 'mess_dashboard', month)).month as Record<string, any>;
    expect(asAdmin.counts).toMatchObject({ feasts: 1, improvements: 0 });
    expect(asAdmin.events[0]).toMatchObject({ name: 'Feast night', attendance: 3, feedback: 1 });
    expect(asAdmin.feedback).toHaveLength(1);
    const asStudent = (await db.call(diners[0].id, 'mess_dashboard', month)).month as Record<string, any>;
    expect(asStudent.feedback).toBeNull();
    expect(asStudent.events[0].feedback).toBeNull();
  });
});
