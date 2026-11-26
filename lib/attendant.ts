// Shapes returned by the attendant SQL functions, and the phone-side queue
// that keeps entries safe while the network is down (spec Case 10).

export type Aisle = 'A' | 'B';

export type AisleCard = {
  aisle: Aisle;
  display_state: string;
  wave_id: string | null;
  wave_number: number | null;
  phase: string | null;
  capacity: number | null;
  held_seats: number | null;
  coupon_entries: number;
  open_exceptions: number;
  snapshot: { snapshot_id: string; headcount: number; observed_at: string; age_seconds: number; stale: boolean } | null;
  physically_vacant: number | null;
  round: 'NOT_STARTED' | 'OPEN' | 'FINISHED';
  /** What the invitation engine is waiting for (see wave_vacancy in the admissions migration). */
  invitations: { status: string; vacancy: number; release_after?: string } | null;
  invitations_out: number;
};

export type MealService = {
  id: string;
  service_date: string;
  meal_type: 'BREAKFAST' | 'LUNCH' | 'DINNER';
  service_start_at: string;
  state: string;
};

export type RecordResult = {
  status: 'RECORDED' | 'RECORDED_WITH_EXCEPTION' | 'ALREADY_RECORDED' | 'UNKNOWN_COUPON' | 'WAVE_CLOSED';
  exception?: 'WRONG_WAVE' | 'NOT_INVITED' | null;
  record_id?: string;
  coupon_number?: number;
  aisle?: Aisle;
  recorded_at?: string;
  holder_name?: string | null;
  booking_ref?: string | null;
  replayed?: boolean;
};

export type PendingEntry = {
  clientEntryId: string;
  waveId: string;
  aisle: Aisle;
  coupon: number;
  observedAt: string;
};

/** The meal people mean by "now": one in service, otherwise the next to start (list is ordered by start time). */
export function currentMeal(meals: MealService[]): MealService | null {
  return meals.find((m) => m.state === 'IN_SERVICE') ?? meals.find((m) => m.state === 'SCHEDULED') ?? null;
}

const PENDING_KEY = 'aula.attendant.pending.v1';

export function loadPending(): PendingEntry[] {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as PendingEntry[];
  } catch {
    return [];
  }
}

export function savePending(list: PendingEntry[]) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable (private mode): the in-memory queue still works for this session.
  }
}

export { ago, dhakaTime } from './format';
