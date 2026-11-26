import { beforeEach, describe, expect, test } from 'vitest';
import { freshDb, type Db } from './harness';

let db: Db;
let superAdmin: string;

async function importCoupons(rows: Array<{ coupon_number: number; claim_code?: string; hall_record?: object }>) {
  return db.call(superAdmin, 'import_coupons', JSON.stringify(rows));
}

beforeEach(async () => {
  db = await freshDb();
  superAdmin = await db.createUser('SUPER_ADMIN');
  await importCoupons([
    { coupon_number: 245, claim_code: 'HALL-245-XK9', hall_record: { name: 'Rahim', room: '312' } },
    { coupon_number: 246, claim_code: 'HALL-246-PQ2' },
    { coupon_number: 247 },
  ]);
});

describe('profiles', () => {
  test('a new auth user gets an unverified STUDENT profile', async () => {
    const id = await db.createUser();
    const [p] = await db.admin<{ role: string; is_verified: boolean }>(
      'select role, is_verified from public.profiles where id = $1', [id]);
    expect(p).toEqual({ role: 'STUDENT', is_verified: false });
  });

  test('a student cannot change their own role', async () => {
    const id = await db.createUser();
    await expect(db.select(id, `update public.profiles set role = 'ADMIN' where id = $1`, [id]))
      .rejects.toThrow(/permission denied/);
    // nor their name, which an admin checks against the hall register
    await expect(db.select(id, `update public.profiles set full_name = 'New Name' where id = $1`, [id]))
      .rejects.toThrow(/permission denied/);
  });

  test('the last super admin cannot be demoted', async () => {
    const r = await db.call(superAdmin, 'set_user_role', superAdmin, 'ADMIN', 'testing');
    expect(r.status).toBe('LAST_SUPER_ADMIN');
  });

  test('only a super admin can change roles', async () => {
    const admin = await db.createUser('ADMIN');
    const student = await db.createUser();
    await expect(db.call(admin, 'set_user_role', student, 'ATTENDANT', 'x')).rejects.toThrow(/requires role SUPER_ADMIN/);
    expect((await db.call(superAdmin, 'set_user_role', student, 'ATTENDANT', 'hired')).status).toBe('OK');
  });
});

describe('coupon claims with the hall-issued code', () => {
  test('the correct code verifies ownership immediately', async () => {
    const s = await db.createUser();
    const r = await db.call(s, 'request_coupon_claim', 245, 'hall-245-xk9 ');
    expect(r.status).toBe('APPROVED');
    const [p] = await db.admin<{ is_verified: boolean }>('select is_verified from public.profiles where id = $1', [s]);
    expect(p.is_verified).toBe(true);
  });

  test('repeating the claim is idempotent', async () => {
    const s = await db.createUser();
    const first = await db.call(s, 'request_coupon_claim', 245, 'HALL-245-XK9');
    const again = await db.call(s, 'request_coupon_claim', 245, 'HALL-245-XK9');
    expect(again).toEqual({ status: 'ALREADY_APPROVED', claim_id: first.claim_id });
  });

  test('a different student cannot claim 245 once it is verified to its owner', async () => {
    const owner = await db.createUser();
    const other = await db.createUser();
    await db.call(owner, 'request_coupon_claim', 245, 'HALL-245-XK9');

    expect((await db.call(other, 'request_coupon_claim', 245, 'HALL-245-XK9')).status).toBe('COUPON_ALREADY_CLAIMED');
    expect((await db.call(other, 'request_coupon_claim', 245)).status).toBe('COUPON_ALREADY_CLAIMED');

    const alerts = await db.admin<{ kind: string }>(`select kind from public.admin_alerts`);
    expect(alerts.map((a) => a.kind)).toEqual(['IDENTITY_CONFLICT']); // deduplicated per (coupon, claimant)
  });

  test('a wrong code does not grant ownership and is rate limited per user', async () => {
    const s = await db.createUser();
    for (let i = 0; i < 5; i++) {
      expect((await db.call(s, 'request_coupon_claim', 245, `WRONG-${i}00`)).status).toBe('INVALID_CODE');
    }
    // Even the right code is refused once the user is rate limited.
    expect((await db.call(s, 'request_coupon_claim', 245, 'HALL-245-XK9')).status).toBe('RATE_LIMITED');
    const claims = await db.admin(`select 1 from public.coupon_claims where status = 'APPROVED'`);
    expect(claims).toHaveLength(0);
  });

  test('repeated guessing on one coupon from many accounts raises one admin alert', async () => {
    for (let i = 0; i < 10; i++) {
      const s = await db.createUser();
      await db.call(s, 'request_coupon_claim', 245, `GUESS-${i}00`);
    }
    const alerts = await db.admin<{ kind: string }>(`select kind from public.admin_alerts`);
    expect(alerts.map((a) => a.kind)).toEqual(['CLAIM_CODE_GUESSING']);
  });

  test('a code works once: after revocation the old code cannot be reused', async () => {
    const owner = await db.createUser();
    const admin = await db.createUser('ADMIN');
    const r = await db.call(owner, 'request_coupon_claim', 245, 'HALL-245-XK9');
    await db.call(admin, 'revoke_coupon_claim', r.claim_id, 'coupon reissued');

    const next = await db.createUser();
    expect((await db.call(next, 'request_coupon_claim', 245, 'HALL-245-XK9')).status).toBe('INVALID_CODE');

    // The hall issues a new code; re-importing the same code again is a no-op.
    await importCoupons([{ coupon_number: 245, claim_code: 'HALL-245-NEW1' }]);
    expect((await importCoupons([{ coupon_number: 245, claim_code: 'HALL-245-NEW1' }])).codes_set).toBe(0);
    expect((await db.call(next, 'request_coupon_claim', 245, 'HALL-245-NEW1')).status).toBe('APPROVED');
  });

  test('unknown coupon numbers are rejected', async () => {
    const s = await db.createUser();
    expect((await db.call(s, 'request_coupon_claim', 999, 'WHATEVER1')).status).toBe('UNKNOWN_COUPON');
  });
});

describe('coupon claims needing staff approval', () => {
  test('knowing the number alone only creates a PENDING request', async () => {
    const s = await db.createUser();
    const r = await db.call(s, 'request_coupon_claim', 247, null, 'I lost my card');
    expect(r.status).toBe('PENDING');
    expect(await db.select(s, 'select coupon_number from public.coupons')).toEqual([]);
    expect((await db.call(s, 'request_coupon_claim', 247)).status).toBe('PENDING'); // idempotent
    expect((await db.call(s, 'request_coupon_claim', 246)).status).toBe('PENDING_CLAIM_EXISTS');
  });

  test('approving one of two competing claims rejects the other', async () => {
    const a = await db.createUser();
    const b = await db.createUser();
    const admin = await db.createUser('ADMIN');
    const ca = await db.call(a, 'request_coupon_claim', 247);
    const cb = await db.call(b, 'request_coupon_claim', 247);

    expect((await db.call(admin, 'approve_coupon_claim', ca.claim_id, 'checked hall card')).status).toBe('APPROVED');
    expect((await db.call(admin, 'approve_coupon_claim', cb.claim_id, 'oops')).status).toBe('NOT_PENDING');

    const rows = await db.admin<{ user_id: string; status: string }>(
      'select user_id, status from public.coupon_claims order by requested_at');
    expect(rows).toEqual([{ user_id: a, status: 'APPROVED' }, { user_id: b, status: 'REJECTED' }]);
  });

  test('a student with a verified coupon cannot be given a second one', async () => {
    const s = await db.createUser();
    const admin = await db.createUser('ADMIN');
    await db.call(s, 'request_coupon_claim', 245, 'HALL-245-XK9');
    expect((await db.call(s, 'request_coupon_claim', 247)).status).toBe('USER_ALREADY_HAS_COUPON');

    // Even if a pending claim slipped in earlier, approval enforces it.
    const t = await db.createUser();
    const pending = await db.call(t, 'request_coupon_claim', 247);
    await db.call(t, 'request_coupon_claim', 246, 'HALL-246-PQ2');
    const res = await db.call(admin, 'approve_coupon_claim', pending.claim_id, 'x');
    // The hall-code claim withdrew the pending one.
    expect(res.status).toBe('NOT_PENDING');
  });

  test('students and attendants cannot approve claims', async () => {
    const s = await db.createUser();
    const attendant = await db.createUser('ATTENDANT');
    const c = await db.call(s, 'request_coupon_claim', 247);
    await expect(db.call(s, 'approve_coupon_claim', c.claim_id, 'me')).rejects.toThrow(/requires role ADMIN/);
    await expect(db.call(attendant, 'approve_coupon_claim', c.claim_id, 'me')).rejects.toThrow(/requires role ADMIN/);
  });

  test('approval requires a reason', async () => {
    const s = await db.createUser();
    const admin = await db.createUser('ADMIN');
    const c = await db.call(s, 'request_coupon_claim', 247);
    await expect(db.call(admin, 'approve_coupon_claim', c.claim_id, '  ')).rejects.toThrow(/reason is required/);
  });
});

describe('database-level ownership invariants', () => {
  test('two approved claims on one coupon are impossible even for the superuser', async () => {
    const a = await db.createUser();
    const b = await db.createUser();
    const [{ id }] = await db.admin<{ id: string }>('select id from public.coupons where coupon_number = 247');
    const insert = `insert into public.coupon_claims (coupon_id, user_id, status, method, effective_from)
                    values ($1, $2, 'APPROVED', 'STAFF_APPROVAL', now())`;
    await db.admin(insert, [id, a]);
    await expect(db.admin(insert, [id, b])).rejects.toThrow(/coupon_claims_one_owner_per_coupon/);
  });

  test('official coupon numbers are immutable and never deleted', async () => {
    await expect(db.admin('update public.coupons set coupon_number = 999 where coupon_number = 245'))
      .rejects.toThrow(/immutable/);
    await expect(db.admin('delete from public.coupons where coupon_number = 245')).rejects.toThrow(/never deleted/);
  });

  test('the audit log is append-only', async () => {
    expect((await db.admin('select 1 from public.audit_log')).length).toBeGreaterThan(0);
    await expect(db.admin(`update public.audit_log set action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.admin('delete from public.audit_log')).rejects.toThrow(/append-only/);
    await expect(db.admin('truncate public.audit_log')).rejects.toThrow(/append-only/);
  });

  test('policy versions are immutable', async () => {
    await expect(db.admin(`update public.policy_settings set settings = '{}'`)).rejects.toThrow(/immutable/);
  });
});

describe('row level security and privileges', () => {
  test('a student sees only their own profile, coupon and claims', async () => {
    const s = await db.createUser();
    const other = await db.createUser();
    await db.call(s, 'request_coupon_claim', 245, 'HALL-245-XK9');
    await db.call(other, 'request_coupon_claim', 246, 'HALL-246-PQ2');

    expect(await db.select(s, 'select id from public.profiles')).toEqual([{ id: s }]);
    expect(await db.select(s, 'select coupon_number from public.coupons')).toEqual([{ coupon_number: 245 }]);
    expect(await db.select(s, 'select user_id from public.coupon_claims')).toEqual([{ user_id: s }]);
  });

  test('students cannot read audit, alerts, attempts, secrets or idempotency records', async () => {
    const s = await db.createUser();
    await db.call(s, 'request_coupon_claim', 245, 'WRONG-CODE');
    expect(await db.select(s, 'select * from public.audit_log')).toEqual([]);
    expect(await db.select(s, 'select * from public.admin_alerts')).toEqual([]);
    expect(await db.select(s, 'select * from public.coupon_claim_attempts')).toEqual([]);
    await expect(db.select(s, 'select * from public.coupon_claim_secrets')).rejects.toThrow(/permission denied/);
    await expect(db.select(s, 'select * from public.idempotency_keys')).rejects.toThrow(/permission denied/);
  });

  test('students cannot write tables directly', async () => {
    const s = await db.createUser();
    const [{ id }] = await db.admin<{ id: string }>('select id from public.coupons where coupon_number = 247');
    await expect(db.select(s, `insert into public.coupons (coupon_number) values (500)`)).rejects.toThrow(/permission denied/);
    await expect(db.select(s,
      `insert into public.coupon_claims (coupon_id, user_id, status, method, effective_from)
       values ($1, $2, 'APPROVED', 'STAFF_APPROVAL', now())`, [id, s])).rejects.toThrow(/permission denied/);
  });

  test('internal helpers are not callable by clients', async () => {
    const s = await db.createUser();
    await expect(db.select(s, `select public.write_audit('x','y',null,null,null)`)).rejects.toThrow(/permission denied/);
    await expect(db.select(s, `select public.raise_admin_alert('x','y','{}')`)).rejects.toThrow(/permission denied/);
    await expect(db.select(s, `select public.require_role('STUDENT')`)).rejects.toThrow(/permission denied/);
  });

  test('exactly the intended API functions are callable by signed-in users, none by anon', async () => {
    const callable = (role: string) => db.admin<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege($1, p.oid, 'execute')
       order by 1`, [role]);
    expect((await callable('authenticated')).map((r) => r.proname)).toEqual([
      'acknowledge_admin_alert',
      'active_meal_services',
      'admin_coupon',
      'admin_coupon_claims',
      'admin_find_people',
      'admin_meal_services',
      'admin_name_requests',
      'admin_no_shows',
      'admin_overview',
      'admin_people_data',
      'admin_person',
      'admin_rewards',
      'admin_send_message',
      'admin_student_id_requests',
      'advance_wave_phase',
      'approve_coupon_claim',
      'approve_coupon_claims',
      'attendant_board',
      'book_meal',
      'book_seat',
      'cancel_booking',
      'cancel_name_change',
      'cancel_nomination',
      'cancel_seat',
      'cancel_student_id_change',
      'choose_alternative',
      'claim_coupon_by_hall_contact',
      'close_aisle_wave',
      'correct_attendance',
      'correct_occupancy_snapshot',
      'create_meal_event',
      'create_meal_service',
      'current_app_role',
      'decide_name_change',
      'decide_no_show',
      'decide_not_coming_change',
      'decide_student_id_change',
      'delete_meal',
      'delete_my_account',
      'dev_assign_manager',
      'dev_set_photo',
      'dev_update_person',
      'door_board',
      'door_check_in',
      'door_directory',
      'event_detail',
      'feedback_replies',
      'finish_collection_round',
      'give_treat',
      'hall_contact_issues',
      'import_coupons',
      'list_admin_alerts',
      'list_announcements',
      'list_attendance_exceptions',
      'list_feedback',
      'list_pending_coupon_claims',
      'load_batch',
      'mark_aisle_ready',
      'mark_came_anyway',
      'meal_attendance_sheet',
      'meal_coming_info',
      'meal_day',
      'meal_events',
      'meal_rating_info',
      'meal_rsvp',
      'meal_seating',
      'meal_service_summary',
      'mess_dashboard',
      'mess_month_meals',
      'my_booking_status',
      'my_dining_history',
      'my_extras',
      'my_history',
      'my_home',
      'my_meal_days',
      'my_nomination',
      'my_notifications',
      'my_points',
      'my_profile',
      'my_roommates',
      'my_upcoming_meals',
      'nominate_manager',
      'open_aisle_wave',
      'open_next_booking',
      'post_announcement',
      'rate_managers',
      'rate_meal',
      'record_coupon',
      'record_occupancy_snapshot',
      'registry_holder_check',
      'reject_coupon_claim',
      'remind_plates',
      'remove_push_subscription',
      'remove_roommate',
      'reopen_collection_round',
      'reply_feedback',
      'request_coupon',
      'request_coupon_claim',
      'request_coupon_updates',
      'request_name_change',
      'request_roommate',
      'request_student_id_change',
      'resolve_attendance_exception',
      'respond_roommate',
      'respond_to_nomination',
      'respond_to_offer',
      'retire_manager',
      'revoke_coupon_claim',
      'save_push_subscription',
      'set_aisle_unusable_seats',
      'set_batch_capacity',
      'set_coming',
      'set_invitations_paused',
      'set_meal_attendance',
      'set_meal_details',
      'set_meal_notice',
      'set_meal_poster',
      'set_meal_service_state',
      'set_meal_timers',
      'set_menu_choice_deadline',
      'set_mess_month_banner',
      'set_my_name',
      'set_my_phone',
      'set_my_photo',
      'set_not_coming',
      'set_not_coming_deadline',
      'set_plate',
      'set_user_role',
      'start_next_batch',
      'submit_feedback',
      'submit_no_show_appeal',
      'undo_check_in',
      'undo_early_check_in',
      'update_feedback',
      'update_mess_month',
      'update_my_profile',
      'update_rsvp_settings',
      'verified_coupon_id',
      'void_attendance',
      'withdraw_coupon_claim',
    ]);
    expect(await callable('anon')).toEqual([]);
  });

  test('anonymous callers can do nothing', async () => {
    await expect(db.asAnon(() => db.pg.query('select * from public.profiles'))).rejects.toThrow(/permission denied/);
    await expect(db.asAnon(() => db.pg.query('select public.request_coupon_claim(245)'))).rejects.toThrow(/permission denied/);
  });

  test('attendants see coupons but not claims or the audit log', async () => {
    const attendant = await db.createUser('ATTENDANT');
    const s = await db.createUser();
    await db.call(s, 'request_coupon_claim', 245, 'HALL-245-XK9');
    expect((await db.select(attendant, 'select 1 from public.coupons')).length).toBe(3);
    expect(await db.select(attendant, 'select 1 from public.coupon_claims')).toEqual([]);
    expect(await db.select(attendant, 'select 1 from public.audit_log')).toEqual([]);
  });

  test('only super admins can import coupons', async () => {
    const admin = await db.createUser('ADMIN');
    await expect(db.call(admin, 'import_coupons', JSON.stringify([{ coupon_number: 1 }])))
      .rejects.toThrow(/requires role SUPER_ADMIN/);
  });
});

describe('coupon import', () => {
  test('re-running the same import changes nothing', async () => {
    const rows = [{ coupon_number: 245, claim_code: 'HALL-245-XK9', hall_record: { name: 'Rahim', room: '312' } }];
    expect(await importCoupons(rows)).toMatchObject({ inserted: 0, updated: 0, codes_set: 0 });
  });

  test('a coupon with a verified holder cannot be retired', async () => {
    const s = await db.createUser();
    await db.call(s, 'request_coupon_claim', 245, 'HALL-245-XK9');
    await expect(db.call(superAdmin, 'import_coupons', JSON.stringify([{ coupon_number: 245, status: 'RETIRED' }])))
      .rejects.toThrow(/revoke the claim before retiring/);
  });

  test('imports 450 coupons', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ coupon_number: 1000 + i, claim_code: `CODE-${1000 + i}` }));
    expect(await importCoupons(rows)).toMatchObject({ inserted: 450, codes_set: 450 });
  });
});

describe('idempotency keys', () => {
  test('reusing a key for a different action is rejected', async () => {
    const attendant = await db.createUser('ATTENDANT');
    await db.call(attendant, 'mark_aisle_ready', 'A', true, true, true, null, 'key-00000001');
    await expect(db.call(attendant, 'mark_aisle_ready', 'B', true, true, true, null, 'key-00000001'))
      .rejects.toThrow(/different request/);
  });
});
