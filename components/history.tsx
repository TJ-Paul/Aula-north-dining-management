'use client';

import { History, Ticket } from 'lucide-react';
import { titleCase } from '@/lib/format';

export type PersonHistory = {
  changes: Array<{ field: 'NAME' | 'STUDENT_ID'; old: string | null; new: string | null; changed_at: string }>;
  coupons: Array<{ coupon_number: number; status: string; from: string | null; to: string | null; name: string | null; student_id: string | null }>;
};
export type EarlierHolder = { name: string | null; student_id: string | null; from: string | null; to: string | null };

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' }) : '…';

/**
 * Past records, kept as they were: earlier names and student IDs, the coupons held over the
 * semesters, and who held the current coupon before. Hidden when there is nothing yet.
 */
export function HistoryCard({ history, earlier, couponNumber, you }: {
  history: PersonHistory; earlier: EarlierHolder[]; couponNumber: number | null; you: boolean;
}) {
  const pastCoupons = history.coupons.filter((c) => c.status === 'REVOKED');
  if (history.changes.length + pastCoupons.length + earlier.length === 0) return null;
  return (
    <section className="card grid gap-4">
      <h2 className="flex items-center gap-2 font-semibold"><History size={18} className="text-accent" /> History</h2>

      {earlier.length > 0 && couponNumber && (
        <div className="grid gap-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Coupon {couponNumber} before {you ? 'you' : 'them'}</p>
          <ol className="grid gap-1.5">
            {earlier.map((h, i) => (
              <li key={i} className="flex items-center gap-3 rounded-xl bg-subtle px-3 py-2 text-sm">
                <Ticket size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{titleCase(h.name) ?? '—'}</span>
                  <span className="block text-xs text-muted">{h.student_id ?? 'no student ID'}</span>
                </span>
                <span className="shrink-0 text-xs text-muted">{day(h.from)} – {day(h.to)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {pastCoupons.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Earlier coupons</p>
          <ul className="flex flex-wrap gap-2">
            {pastCoupons.map((c, i) => (
              <li key={i} className="rounded-full border border-border px-3 py-1 text-sm">
                <b className="tabular-nums">{c.coupon_number}</b> <span className="text-xs text-muted">{day(c.from)} – {day(c.to)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {history.changes.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Earlier names and student IDs</p>
          <ul className="grid gap-1 text-sm">
            {history.changes.map((c, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-muted line-through">{c.old}</span>
                <span className="text-muted">→</span>
                <span>{c.new ?? '—'}</span>
                <span className="text-xs text-muted">· {c.field === 'NAME' ? 'name' : 'student ID'}, {day(c.changed_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
