// Moving every stored timestamp back by N minutes is equivalent to the clock
// jumping forward N minutes. Used by tests and by the demo's "skip ahead"
// control. Bypasses the immutability triggers (session_replication_role), so
// it must only ever run against a test or demo database as superuser.

const COLUMNS: Record<string, string[]> = {
  meal_services: ['service_start_at', 'service_end_at', 'choices_close_at', 'state_changed_at', 'created_at', 'rsvp_settled_at'],
  aisle_waves: ['opened_at', 'admitting_at', 'dining_at', 'finishing_at', 'closed_at', 'ready_confirmed_at'],
  aisles: ['ready_confirmed_at'],
  booking_participations: ['queued_at', 'registered_at'],
  reservations: ['arrive_by', 'created_at', 'state_changed_at'],
  standby_offers: ['offered_at', 'respond_by', 'accepted_at', 'entry_window_start', 'entry_window_end', 'dined_at', 'state_changed_at'],
  occupancy_snapshots: ['observed_at', 'recorded_at'],
  attendance_records: ['recorded_at', 'observed_at', 'voided_at'],
  coupon_collection_rounds: ['started_at', 'finished_at'],
  notification_outbox: ['created_at', 'next_attempt_at'],
  no_show_events: ['detected_at', 'verified_at', 'closed_at'],
  penalty_events: ['applied_at', 'consumed_at', 'reversed_at'],
  no_show_appeals: ['submitted_at', 'decided_at'],
  admin_alerts: ['created_at', 'acknowledged_at'],
  meal_rsvps: ['set_at', 'changed_at', 'settled_at'],
  rsvp_change_requests: ['created_at', 'decided_at'],
  points_ledger: ['created_at'],
  meal_batches: ['booking_opens_at', 'starts_at', 'start_notified_at', 'loaded_at', 'created_at'],
  batch_seats: ['booked_at', 'arrive_by', 'arrived_at', 'closed_at'],
};

const PAYLOAD_TIMES = ['arrive_by', 'respond_by', 'entry_window_start', 'entry_window_end'];

export function skipAheadSql(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60 * 24 * 60) throw new Error('minutes out of range');
  const shift = `interval '${Math.round(minutes * 60)} seconds'`;
  const updates = Object.entries(COLUMNS).map(([table, cols]) =>
    `update public.${table} set ${cols.map((c) => `${c} = ${c} - ${shift}`).join(', ')};`);
  // Times quoted inside notifications ("arrive by 20:40") move too.
  const quoted = PAYLOAD_TIMES.map((k) =>
    `update public.notification_outbox set payload = jsonb_set(payload, '{${k}}', to_jsonb((payload ->> '${k}')::timestamptz - ${shift})) where payload ->> '${k}' is not null;`);
  return ['set session_replication_role = replica;', ...updates, ...quoted, 'set session_replication_role = origin;'].join('\n');
}
