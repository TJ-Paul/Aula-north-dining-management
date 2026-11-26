import { beforeEach, describe, expect, test } from 'vitest';
import { freshDb, type Db } from './harness';

let db: Db;
let admin: string;
let attendant: string;
let dinner: string;

const ready = (aisle: 'A' | 'B', openFor: string | null = null, key: string | null = null) =>
  db.call(attendant, 'mark_aisle_ready', aisle, true, true, true, openFor, key);

async function capacity(): Promise<number> {
  const [row] = await db.admin<{ live_wave_capacity: number }>(
    'select live_wave_capacity from public.meal_service_capacity where meal_service_id = $1', [dinner]);
  return row.live_wave_capacity;
}

async function aisle(code: 'A' | 'B') {
  const [row] = await db.admin<{ readiness: string; display_state: string; wave_id: string | null; wave_number: number | null; wave_capacity: number | null }>(
    'select readiness, display_state, wave_id, wave_number, wave_capacity from public.aisle_status where aisle_code = $1', [code]);
  return row;
}

beforeEach(async () => {
  db = await freshDb();
  admin = await db.createUser('ADMIN');
  attendant = await db.createUser('ATTENDANT');
  const r = await db.call(admin, 'create_meal_service', '2026-11-04', 'DINNER', '2026-11-04T14:30:00Z');
  dinner = r.meal_service_id as string;
});

describe('physical layout', () => {
  test('there are exactly two 30-seat aisles, A and B', async () => {
    expect(await db.admin('select code, physical_capacity from public.aisles order by code')).toEqual([
      { code: 'A', physical_capacity: 30 },
      { code: 'B', physical_capacity: 30 },
    ]);
    await expect(db.admin(`insert into public.aisles (code) values ('C')`)).rejects.toThrow(/invalid input value/);
    await expect(db.admin(`insert into public.aisles (code) values ('A')`)).rejects.toThrow(/duplicate key/);
    await expect(db.admin(`update public.aisles set physical_capacity = 31`)).rejects.toThrow(/check constraint/);
    await expect(db.admin(`delete from public.aisles`)).rejects.toThrow(/cannot be deleted/);
  });

  test('aisles start RESTORING and cannot host a wave until marked ready', async () => {
    expect((await aisle('A')).readiness).toBe('RESTORING');
    expect((await db.call(attendant, 'open_aisle_wave', dinner, 'A')).status).toBe('AISLE_NOT_READY');
    expect(await capacity()).toBe(0);
  });
});

describe('readiness confirmation', () => {
  test('READY requires the attendant to attest empty, cleaned and food restored', async () => {
    for (const flags of [[false, true, true], [true, false, true], [true, true, false]]) {
      const r = await db.call(attendant, 'mark_aisle_ready', 'A', ...flags, null, null);
      expect(r.status).toBe('ATTESTATION_REQUIRED');
    }
    expect((await ready('A')).status).toBe('READY');
    const [audit] = await db.admin<{ actor_id: string }>(
      `select actor_id from public.audit_log where action = 'AISLE_MARKED_READY'`);
    expect(audit.actor_id).toBe(attendant);
  });

  test('students cannot mark an aisle ready or open waves', async () => {
    const student = await db.createUser();
    await expect(db.call(student, 'mark_aisle_ready', 'A', true, true, true, null, null)).rejects.toThrow(/requires role ATTENDANT/);
    await expect(db.call(student, 'open_aisle_wave', dinner, 'A')).rejects.toThrow(/requires role ATTENDANT/);
    await expect(db.select(student, `update public.aisles set readiness = 'READY'`)).rejects.toThrow(/permission denied/);
  });

  test('a timer or direct write cannot make an aisle READY without a named person', async () => {
    await expect(db.admin(`update public.aisles set readiness = 'READY' where code = 'A'`))
      .rejects.toThrow(/human confirmation/);
  });
});

describe('bookable capacity', () => {
  test('both aisles ready gives exactly 60; one gives exactly 30', async () => {
    await ready('A', dinner);
    expect(await capacity()).toBe(30);
    await ready('B', dinner);
    expect(await capacity()).toBe(60);
  });

  test('pressing ready / +30 twice never makes 60 seats out of one aisle', async () => {
    expect((await ready('A')).status).toBe('READY');
    expect((await ready('A')).status).toBe('ALREADY_READY');
    expect((await db.call(attendant, 'open_aisle_wave', dinner, 'A')).status).toBe('WAVE_OPENED');
    expect((await db.call(attendant, 'open_aisle_wave', dinner, 'A')).status).toBe('AISLE_NOT_READY');
    expect((await ready('A', dinner)).status).toBe('AISLE_IN_USE');
    expect(await capacity()).toBe(30);
  });

  test('a retried request with the same idempotency key replays the original result', async () => {
    const first = await ready('A', dinner, 'tap-0000000001');
    const retry = await ready('A', dinner, 'tap-0000000001');
    expect(retry).toEqual({ ...first, replayed: true });
    expect(await capacity()).toBe(30);
  });

  test('a second live wave for one aisle is impossible at the database level', async () => {
    await ready('A', dinner);
    await expect(db.admin(
      `insert into public.aisle_waves (meal_service_id, aisle_code, wave_number, capacity) values ($1, 'A', 99, 30)`,
      [dinner])).rejects.toThrow(/aisle_waves_one_live_per_aisle/);
  });

  test('wave capacity can never be raised', async () => {
    const r = await ready('A', dinner);
    const waveId = (r.wave as { wave_id: string }).wave_id;
    await expect(db.admin('update public.aisle_waves set capacity = 31 where id = $1', [waveId])).rejects.toThrow();
    await db.call(attendant, 'set_aisle_unusable_seats', 'A', 2, 'broken chairs');
    expect((await aisle('A')).wave_capacity).toBe(28);
    await expect(db.admin('update public.aisle_waves set capacity = 30 where id = $1', [waveId]))
      .rejects.toThrow(/never be increased/);
  });

  test('repairing seats mid-wave only helps the next wave', async () => {
    await db.call(attendant, 'set_aisle_unusable_seats', 'A', 3, 'spill');
    const r = await ready('A', dinner);
    expect((r.wave as { capacity: number }).capacity).toBe(27);
    await db.call(attendant, 'set_aisle_unusable_seats', 'A', 0, 'cleaned up');
    expect((await aisle('A')).wave_capacity).toBe(27);
  });

  test('waves cannot open for a closed or cancelled meal service', async () => {
    await db.call(admin, 'set_meal_service_state', dinner, 'CANCELLED', 'hall closed');
    const r = await ready('A', dinner);
    expect((r.wave as { status: string }).status).toBe('MEAL_SERVICE_NOT_OPEN');
    expect((await aisle('A')).readiness).toBe('READY'); // readiness itself still recorded
  });
});

describe('whole-aisle turnover', () => {
  async function openA() {
    const r = await ready('A', dinner);
    return (r.wave as { wave_id: string }).wave_id;
  }

  test('phases only move forward', async () => {
    const wave = await openA();
    expect((await db.call(attendant, 'advance_wave_phase', wave, 'DINING')).status).toBe('OK');
    expect((await db.call(attendant, 'advance_wave_phase', wave, 'ADMITTING')).status).toBe('INVALID_TRANSITION');
    expect((await aisle('A')).display_state).toBe('DINING');
  });

  test('closing a wave needs the all-diners-left attestation and leads to RESTORING, not READY', async () => {
    const wave = await openA();
    await db.call(attendant, 'advance_wave_phase', wave, 'WAITING_FOR_ALL_TO_FINISH');
    expect((await db.call(attendant, 'close_aisle_wave', wave, false, null, null)).status).toBe('ATTESTATION_REQUIRED');
    expect(await capacity()).toBe(30);

    expect((await db.call(attendant, 'close_aisle_wave', wave, true, 'all left', null)).status).toBe('CLOSED');
    expect(await aisle('A')).toMatchObject({ readiness: 'RESTORING', wave_id: null });
    expect(await capacity()).toBe(0);
    // Still unavailable while food is being restored.
    expect((await db.call(attendant, 'open_aisle_wave', dinner, 'A')).status).toBe('AISLE_NOT_READY');
  });

  test('an underfilled aisle turns over once its actual diners leave and it is restored', async () => {
    const wave1 = await openA();
    // Only 24 people ever sat in A; there is no "30 must finish" condition.
    await db.call(attendant, 'close_aisle_wave', wave1, true, '24 diners, all left', null);
    const r = await ready('A', dinner);
    expect(r.wave).toMatchObject({ status: 'WAVE_OPENED', wave_number: 2, capacity: 30 });
    expect(await capacity()).toBe(30);
  });

  test('aisle A turning over does not touch aisle B', async () => {
    const waveA = await openA();
    await ready('B', dinner);
    await db.call(attendant, 'advance_wave_phase', (await aisle('B')).wave_id, 'DINING');

    await db.call(attendant, 'close_aisle_wave', waveA, true, null, null);
    expect(await aisle('B')).toMatchObject({ readiness: 'IN_WAVE', display_state: 'DINING', wave_number: 1 });
    expect(await capacity()).toBe(30);

    await ready('A', dinner);
    expect(await aisle('A')).toMatchObject({ wave_number: 2, wave_capacity: 30 });
    expect(await capacity()).toBe(60);
  });

  test('closed waves are frozen', async () => {
    const wave = await openA();
    await db.call(attendant, 'close_aisle_wave', wave, true, null, null);
    expect((await db.call(attendant, 'close_aisle_wave', wave, true, null, null)).status).toBe('ALREADY_CLOSED');
    await expect(db.admin(`update public.aisle_waves set close_note = 'edit' where id = $1`, [wave]))
      .rejects.toThrow(/closed wave is immutable/);
  });

  test('a meal service cannot close while it still has a live wave', async () => {
    const wave = await openA();
    await db.call(admin, 'set_meal_service_state', dinner, 'IN_SERVICE');
    expect((await db.call(admin, 'set_meal_service_state', dinner, 'CLOSED')).status).toBe('LIVE_WAVES_REMAIN');
    await db.call(attendant, 'close_aisle_wave', wave, true, null, null);
    expect((await db.call(admin, 'set_meal_service_state', dinner, 'CLOSED')).status).toBe('OK');
  });
});

describe('meal services', () => {
  test('creating the same meal service twice returns the existing one', async () => {
    const again = await db.call(admin, 'create_meal_service', '2026-11-04', 'DINNER', '2026-11-04T14:30:00Z');
    expect(again).toEqual({ status: 'EXISTS', meal_service_id: dinner });
  });

  test('everyone signed in can read aisle status; nobody anonymous can', async () => {
    const student = await db.createUser();
    expect((await db.select(student, 'select * from public.aisle_status')).length).toBe(2);
    await expect(db.asAnon(() => db.pg.query('select * from public.aisle_status'))).rejects.toThrow(/permission denied/);
  });
});
