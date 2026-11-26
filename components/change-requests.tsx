'use client';

import { ArrowRight, Check, IdCard, UserPen, X } from 'lucide-react';
import { useState } from 'react';
import { Panel } from '@/components/admin-shell';
import { Avatar } from '@/components/person';
import { dhakaDate } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

type NameReq = { request_id: string; coupon_number: number | null; old_name: string | null; new_name: string; register_name: string | null; avatar_url: string | null; requested_at: string };
type SidReq = {
  request_id: string; coupon_number: number | null; name: string | null; old_student_id: string | null; new_student_id: string;
  register_student_id: string | null; avatar_url: string | null; requested_at: string;
};

const RESULT: Record<string, string> = {
  APPROVED: 'Verified: changed.', REJECTED: 'Declined: nothing changed.', ALREADY_DECIDED: 'Someone already decided this one.',
  OWN_REQUEST: 'You can’t verify your own change; another mess manager or a dev must.', STUDENT_ID_TAKEN: 'Another account already has that student ID.',
};

/** Name and student ID changes waiting for a mess manager or dev: compare with the hall register, then verify or decline. */
export function ChangeRequests() {
  const names = useLoad(() => rpc<NameReq[]>('admin_name_requests'), 15000);
  const sids = useLoad(() => rpc<SidReq[]>('admin_student_id_requests'), 15000);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const decide = async (fn: string, id: string, approve: boolean) => {
    setBusy(true);
    try {
      const r = await rpc<{ status: string }>(fn, { p_request_id: id, p_approve: approve });
      setNote(RESULT[r.status] ?? r.status);
      await Promise.all([names.reload(), sids.reload()]);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const n = names.data ?? [];
  const s = sids.data ?? [];
  if (n.length + s.length === 0) return null;

  const row = (key: string, avatar: string | null, coupon: number | null, title: string, from: string | null, to: string,
    register: string | null, at: string, fn: string, id: string) => (
    <li key={key} className="flex items-center gap-3 rounded-2xl bg-subtle p-3">
      <Avatar url={avatar} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold"><span className="tabular-nums">{coupon ?? '—'}</span> · {title}</p>
        <p className="flex flex-wrap items-center gap-1 text-sm">
          <span className="text-muted line-through">{from || 'none'}</span><ArrowRight size={13} className="text-muted" /><b>{to}</b>
        </p>
        <p className="text-xs text-muted">{register ? `Hall register: ${register}` : 'Not in the hall register'} · {dhakaDate(at)}</p>
      </div>
      <button disabled={busy} onClick={() => decide(fn, id, false)} aria-label="Decline" className="rounded-full p-2 text-muted hover:bg-surface"><X size={18} /></button>
      <button disabled={busy} onClick={() => decide(fn, id, true)} aria-label="Verify" className="rounded-full bg-accent p-2 text-accent-fg"><Check size={18} /></button>
    </li>
  );

  return (
    <Panel title={<span className="flex items-center gap-2"><UserPen size={18} className="text-accent" /> Changes to verify · {n.length + s.length}</span>}>
      {note && <p className="mb-2 rounded-xl bg-surface px-3 py-2 text-sm" role="status">{note}</p>}
      <ul className="grid gap-2">
        {n.map((r) => row(`n-${r.request_id}`, r.avatar_url, r.coupon_number, 'Name', r.old_name, r.new_name, r.register_name, r.requested_at, 'decide_name_change', r.request_id))}
        {s.map((r) => row(`s-${r.request_id}`, r.avatar_url, r.coupon_number, `${r.name ?? '—'} · student ID`, r.old_student_id, r.new_student_id,
          r.register_student_id, r.requested_at, 'decide_student_id_change', r.request_id))}
      </ul>
      <p className="mt-2 flex items-center gap-1 text-xs text-muted"><IdCard size={12} /> Coupon number changes are below with the coupon claims.</p>
    </Panel>
  );
}
