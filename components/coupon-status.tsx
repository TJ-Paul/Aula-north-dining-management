'use client';

import { BadgeCheck, Clock, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/sheet';
import { dhakaTime } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import type { Session } from '@/lib/session';
import { withBase } from '@/lib/base';

const COUPON_MAX = 450;

const OUTCOME: Record<string, string> = {
  PENDING: 'Sent. An admin will check it against the hall office’s list.',
  INVALID_COUPON_NUMBER: `Coupon numbers run from 1 to ${COUPON_MAX}.`,
  NOT_IN_REGISTER: 'That number is not in the hall register yet. Check it with the hall office.',
  COUPON_RETIRED: 'That coupon number is no longer in use. Check with the hall office.',
  ALREADY_YOURS: 'That is already your coupon number.',
  COUPON_TAKEN: 'Someone else holds that coupon, and the hall register doesn’t list you under it. Check the number and try again, or tell an admin.',
};

const date = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' });

/**
 * The student's coupon: verified number, a request waiting for an admin, the
 * last refusal or reassignment, the "please update" notice, and the form to
 * request a (new) number.
 */
export function CouponStatus({ session, onChanged, compact }: { session: Session; onChanged: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = session;
  const needsNumber = !s.coupon_number && !s.pending_claim;

  // A refused first claim: start the claim again from scratch, every field empty.
  const rejected = !s.coupon_number && !s.pending_claim && s.last_decision?.status === 'REJECTED';

  const submit = async () => {
    const n = Number(number);
    if (!/^\d+$/.test(number) || n < 1 || n > COUPON_MAX) { setMsg(OUTCOME.INVALID_COUPON_NUMBER); return; }
    setBusy(true);
    try {
      const r = await rpc<{ status: string }>('request_coupon', { p_coupon_number: n, p_note: note || null });
      setMsg(OUTCOME[r.status] ?? r.status);
      if (r.status === 'PENDING') { setOpen(false); setNumber(''); setNote(''); onChanged(); }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (rejected) return <ClaimAgain session={s} onChanged={onChanged} />;

  return (
    <section className="grid gap-3">
      {s.coupon_number && (
        <div className="flex items-center gap-3 rounded-2xl border-2 border-ok bg-surface p-4">
          <BadgeCheck className="shrink-0 text-ok" />
          <div>
            <div className="text-lg font-semibold">Coupon {s.coupon_number}</div>
            <div className="text-sm text-muted">Verified{s.coupon_since && ` since ${date(s.coupon_since)}`}</div>
          </div>
        </div>
      )}

      {s.update_requested_at && !s.pending_claim && (
        <p className="flex gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          {s.update_request_message ?? 'Coupon numbers have been updated. Request your new number below.'}
        </p>
      )}

      {s.last_decision && !s.pending_claim && (
        <p className="flex gap-2 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          {s.last_decision.status === 'REVOKED'
            ? <>Coupon updated: coupon {s.last_decision.coupon_number} is no longer yours. Contact the hall office for your new coupon number, then request it below.</>
            : <>Your request for coupon {s.last_decision.coupon_number} was not approved{s.last_decision.reason ? `: ${s.last_decision.reason}` : '.'} You can request again.</>}
        </p>
      )}

      {s.pending_claim && (
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4">
          <Clock className="shrink-0 text-muted" />
          <div>
            <div className="font-semibold">
              {s.pending_claim.kind === 'CHANGE' ? 'Change to' : 'Request for'} coupon {s.pending_claim.coupon_number}: waiting for an admin
            </div>
            <div className="text-sm text-muted">
              Sent {date(s.pending_claim.requested_at)} {dhakaTime(s.pending_claim.requested_at)}.
              {s.coupon_number ? ` You keep coupon ${s.coupon_number} until it is approved.` : ' You can book meals once it is approved.'}
            </div>
          </div>
        </div>
      )}

      {msg && <p className="rounded-xl bg-subtle px-3 py-2 text-sm" role="status">{msg}</p>}

      {(open || (needsNumber && !compact)) ? (
        <form className="grid gap-3 rounded-2xl border border-border bg-surface p-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <h3 className="font-semibold">{s.coupon_number || s.last_decision ? 'Request your new coupon number' : 'Request your coupon number'}</h3>
          <label className="grid gap-1 text-sm">
            <span>Coupon number from the hall office</span>
            <input className="input" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} placeholder={`1–${COUPON_MAX}`} required />
          </label>
          <label className="grid gap-1 text-sm">
            <span>Note for the admin (optional)</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. New semester, room 312" />
          </label>
          <div className="flex justify-end gap-2">
            {s.coupon_number && <Button onClick={() => setOpen(false)}>Cancel</Button>}
            <Button type="submit" variant="primary" disabled={busy}>Send for approval</Button>
          </div>
        </form>
      ) : s.coupon_number ? (
        <Button className="w-fit" onClick={() => { setOpen(true); setMsg(null); }}>
          {s.pending_claim ? 'Request a different number instead' : 'Change coupon number'}
        </Button>
      ) : compact && needsNumber ? (
        <a href={withBase("/me/profile")} className="w-fit rounded-xl bg-fg px-4 py-3 font-medium text-bg">Request your coupon number</a>
      ) : null}
    </section>
  );
}

const CLAIM_OUTCOME: Record<string, string> = {
  ...OUTCOME,
  INVALID_STUDENT_ID: 'Enter your student ID as it is on your university ID card.',
  STUDENT_ID_TAKEN: 'Another account already uses this student ID. If it is yours, tell an admin.',
};

/** After a rejection: the full claim form again, empty, with the admin's reason on top. */
function ClaimAgain({ session: s, onChanged }: { session: Session; onChanged: () => void }) {
  const empty = { coupon: '', studentId: '', name: '' };
  const [f, setF] = useState(empty);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = s.last_decision!;
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async () => {
    const n = Number(f.coupon);
    if (!/^\d+$/.test(f.coupon) || n < 1 || n > COUPON_MAX) { setMsg(CLAIM_OUTCOME.INVALID_COUPON_NUMBER); return; }
    if (!/^[A-Za-z0-9]{3,24}$/.test(f.studentId.replace(/[\s/-]/g, ''))) { setMsg(CLAIM_OUTCOME.INVALID_STUDENT_ID); return; }
    if (f.name.trim().length < 2) { setMsg('Enter your full name as the hall office has it.'); return; }
    setBusy(true);
    setMsg(null);
    try {
      const r = await rpc<{ status: string }>('request_coupon', {
        p_coupon_number: n, p_full_name: f.name.trim(), p_student_id: f.studentId.replace(/\s/g, ''),
      });
      if (r.status === 'PENDING') { setF(empty); onChanged(); return; }
      setMsg(CLAIM_OUTCOME[r.status] ?? r.status);
      if (r.status === 'COUPON_TAKEN') setF(empty);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-4">
      <div className="flex gap-3 rounded-2xl bg-bad-soft p-4 text-bad">
        <TriangleAlert className="mt-0.5 shrink-0" size={20} />
        <div className="text-sm">
          <p className="font-semibold">Your claim for coupon {d.coupon_number} was not approved</p>
          {d.reason && <p className="mt-0.5">{d.reason}</p>}
          <p className="mt-1">Fill in the form again, exactly as the hall office has your details.</p>
        </div>
      </div>
      <form className="grid gap-3 rounded-2xl border border-border bg-surface p-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2 className="text-lg font-semibold">Claim your coupon</h2>
        <input className="input" inputMode="numeric" value={f.coupon} onChange={set('coupon')} required
          placeholder="Coupon number" aria-label="Coupon number" />
        <input className="input" value={f.studentId} onChange={set('studentId')} autoComplete="off" required
          placeholder="Student ID" aria-label="Student ID" />
        <input className="input" value={f.name} onChange={set('name')} autoComplete="name" required
          placeholder="Full name" aria-label="Full name" />
        {msg && <p className="text-sm text-bad" role="alert">{msg}</p>}
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Please wait…' : 'Send for approval'}</Button>
      </form>
    </section>
  );
}
