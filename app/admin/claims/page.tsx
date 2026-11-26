'use client';

import { ArrowRight, Check, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { AdminShell, Badge, Empty, Notice, Panel } from '@/components/admin-shell';
import { Button } from '@/components/sheet';
import { ChangeRequests } from '@/components/change-requests';
import { dhakaTime } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

type Claim = {
  claim_id: string; kind: 'INITIAL' | 'CHANGE'; requested_at: string; note: string | null;
  coupon_number: number; register: { name?: string; student_id?: string; room?: string; phone?: string };
  claimed_name: string; claimed_phone: string | null; name_matches: boolean; phone_matches: boolean;
  claimed_student_id: string | null; student_id_matches: boolean | null;
  claimant: { id: string; public_id: string; name: string; current_coupon: number | null };
  current_holder: { name: string; public_id: string } | null;
  competing_pending_claims: number;
};

const OUTCOME: Record<string, string> = {
  APPROVED: 'approved', HELD_BY_OTHER: 'held by another student (approve it on its own to move it)',
  NOT_PENDING: 'no longer pending', ALREADY_APPROVED: 'already approved',
};

export default function ClaimsPage() {
  return <AdminShell active="claims">{() => <Claims />}</AdminShell>;
}

function Match({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${ok ? 'text-ok' : 'text-warn'}`}>
      {ok ? <Check size={14} /> : <X size={14} />}{label} {ok ? 'matches' : 'differs'}
    </span>
  );
}

function Claims() {
  const { data, error, reload } = useLoad(() => rpc<Claim[]>('admin_coupon_claims'), 10000);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('Checked against the hall office list');
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [moving, setMoving] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote(await fn());
      setSelected(new Set());
      setRejecting(null);
      setMoving(null);
      await reload();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approveMany = (ids: string[]) => run(async () => {
    const r = await rpc<{ results: Array<{ claim_id: string; status: string }> }>('approve_coupon_claims', { p_claim_ids: ids, p_reason: reason });
    const ok = r.results.filter((x) => x.status === 'APPROVED').length;
    const other = r.results.filter((x) => x.status !== 'APPROVED').map((x) => {
      const c = data?.find((d) => d.claim_id === x.claim_id);
      return `Coupon ${c?.coupon_number ?? '?'}: ${OUTCOME[x.status] ?? x.status}.`;
    });
    return [`${ok} approved.`, ...other].join(' ');
  });

  const approveOne = (c: Claim, reassign: boolean) => run(async () => {
    const r = await rpc<{ status: string; reassigned_from?: string | null }>('approve_coupon_claim', {
      p_claim_id: c.claim_id, p_reason: reason, p_reassign: reassign,
    });
    if (r.status === 'APPROVED') {
      return r.reassigned_from
        ? `Coupon ${c.coupon_number} moved from ${r.reassigned_from} to ${c.claimed_name}. ${r.reassigned_from} has been told to contact the hall office and request their new number.`
        : `Coupon ${c.coupon_number} approved for ${c.claimed_name}.`;
    }
    return `Coupon ${c.coupon_number}: ${OUTCOME[r.status] ?? r.status}.`;
  });

  if (!data) return <Empty>{error ?? 'Loading…'}</Empty>;

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <>
      <ChangeRequests />
      <p className="text-sm text-muted">
        Compare what each student entered with the hall office’s list (the register), and approve or reject.
        A change request asks to move a student to a new coupon number.
      </p>
      <Notice text={note} />

      <Panel
        title={`Waiting for approval (${data.length})`}
        action={data.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <input value={reason} onChange={(e) => setReason(e.target.value)} className="input !min-h-10 w-64" aria-label="Approval reason" />
            <Button variant="primary" disabled={busy || selected.size === 0 || !reason.trim()} onClick={() => approveMany([...selected])}>
              Approve selected ({selected.size})
            </Button>
          </div>
        )}>
        {data.length === 0 ? <Empty>No claims are waiting.</Empty> : (
          <ul className="grid gap-3">
            {data.map((c) => (
              <li key={c.claim_id} className={`rounded-xl border p-3 ${c.current_holder || c.competing_pending_claims > 0 ? 'border-warn' : 'border-border'}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <input type="checkbox" className="size-5" checked={selected.has(c.claim_id)} onChange={() => toggle(c.claim_id)}
                    aria-label={`Select claim for coupon ${c.coupon_number}`} />
                  {c.kind === 'CHANGE'
                    ? <Badge tone="info">Change {c.claimant.current_coupon ?? 'no coupon'} <ArrowRight size={12} className="inline" /> {c.coupon_number}</Badge>
                    : <Badge tone="info">New claim</Badge>}
                  <span className="text-xs text-muted">{dhakaTime(c.requested_at)} · account {c.claimant.public_id}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg bg-subtle p-2">
                    <div className="text-xs text-muted">Hall register · coupon {c.coupon_number}</div>
                    <div className="font-semibold">{c.register.name ?? '—'}</div>
                    <div className="text-sm text-muted">Student ID {c.register.student_id ?? '— (not on the list)'}</div>
                  </div>
                  <div className="p-2">
                    <div className="text-xs text-muted">Student entered</div>
                    <div className="font-semibold">{c.claimed_name}</div>
                    <div className="text-sm text-muted">Student ID {c.claimed_student_id ?? '— (not given)'}</div>
                    <div className="mt-1 flex flex-wrap gap-3">
                      {c.register.student_id && <Match ok={!!c.student_id_matches} label="Student ID" />}
                      <Match ok={c.name_matches} label="Name" />
                    </div>
                    {c.note && <div className="mt-1 text-sm">“{c.note}”</div>}
                  </div>
                </div>
                {c.current_holder && (
                  <p className="mt-2 flex gap-2 text-sm text-warn">
                    <TriangleAlert size={16} className="mt-0.5 shrink-0" />
                    Coupon {c.coupon_number} is currently held by {c.current_holder.name} ({c.current_holder.public_id}).
                    Approving moves it to this student; {c.current_holder.name} will be told to get a new number from the hall office.
                  </p>
                )}
                {c.competing_pending_claims > 0 && (
                  <p className="mt-2 flex items-center gap-2 text-sm text-warn">
                    <TriangleAlert size={16} />
                    {c.competing_pending_claims === 1 ? '1 other student also claims' : `${c.competing_pending_claims} other students also claim`} coupon {c.coupon_number}. Approving one rejects the others.
                  </p>
                )}
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  {rejecting === c.claim_id ? (
                    <>
                      <input autoFocus value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Why? (the student sees this)"
                        className="input !min-h-10 min-w-0 flex-1" />
                      <Button variant="danger" disabled={busy || !rejectReason.trim()}
                        onClick={() => run(async () => {
                          await rpc('reject_coupon_claim', { p_claim_id: c.claim_id, p_reason: rejectReason });
                          return `Claim for coupon ${c.coupon_number} rejected. The student has been told why.`;
                        })}>Reject</Button>
                      <Button onClick={() => setRejecting(null)}>Back</Button>
                    </>
                  ) : moving === c.claim_id ? (
                    <>
                      <span className="self-center text-sm">Move coupon {c.coupon_number} from {c.current_holder?.name}?</span>
                      <Button variant="danger" disabled={busy || !reason.trim()} onClick={() => approveOne(c, true)}>Yes, move it</Button>
                      <Button onClick={() => setMoving(null)}>Back</Button>
                    </>
                  ) : (
                    <>
                      <Button disabled={busy} onClick={() => { setRejecting(c.claim_id); setRejectReason(''); }}>Reject…</Button>
                      <Button variant="primary" disabled={busy || !reason.trim()}
                        onClick={() => (c.current_holder ? setMoving(c.claim_id) : approveOne(c, false))}>
                        {c.current_holder ? 'Approve and move…' : 'Approve'}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {data.length > 0 && <p className="text-xs text-muted">Approving uses the reason in the box above. Every decision is kept in the audit log.</p>}
    </>
  );
}
