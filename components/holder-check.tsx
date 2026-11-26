'use client';

import { useEffect, useState } from 'react';
import { Badge, ConfirmButton, Empty, Panel } from '@/components/admin-shell';
import { Button } from '@/components/sheet';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

type Holder = {
  user_id: string; public_id: string; coupon_number: number; holder_name: string; register_name: string | null;
  holder_phone: string | null; register_phone: string | null; name_matches: boolean; phone_matches: boolean;
  holder_student_id: string | null; register_student_id: string | null; student_id_matches: boolean | null;
  coupon_retired: boolean; update_requested_at: string | null;
};
type Check = { holders: Holder[]; register_size: number; unclaimed: number };

const DEFAULT_MESSAGE =
  'Coupon numbers have been updated by the hall office. Please check your new coupon number with the hall office and request it in the app (Profile → Change coupon).';

/**
 * After importing a new hall sheet: who holds a coupon whose register entry now
 * names someone else, and a way to ask them (or everyone) to request their new number.
 */
export function HolderCheck({ refreshKey }: { refreshKey: number }) {
  const check = useLoad(() => rpc<Check>('registry_holder_check'));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reloadCheck = check.reload;
  useEffect(() => { if (refreshKey > 0) reloadCheck(); }, [refreshKey, reloadCheck]);
  if (!check.data) return <Panel title="Coupon holders vs the register"><Empty>{check.error ?? 'Loading…'}</Empty></Panel>;

  // Coupon numbers are the identity; a holder whose student ID (or name) no longer matches the register needs a check.
  const mismatched = check.data.holders.filter((h) => h.coupon_retired || (h.register_student_id ? !h.student_id_matches : !h.name_matches));
  const notify = async (ids: string[] | null) => {
    setBusy(true);
    try {
      const r = await rpc<{ notified: number }>('request_coupon_updates', { p_user_ids: ids, p_message: message });
      setNote(`${r.notified} student${r.notified === 1 ? '' : 's'} notified (in the app and by SMS). They keep their current number until you approve their new one under Claims.`);
      setSelected(new Set());
      await check.reload();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Coupon holders vs the register">
      <p className="mb-3 text-sm text-muted">
        {check.data.holders.length} {check.data.holders.length === 1 ? 'student holds' : 'students hold'} a coupon; {check.data.unclaimed} of {check.data.register_size} coupons in the register have no verified holder yet.
        After importing a new sheet, students whose coupon now belongs to someone else on the list appear here.
      </p>
      {note && <p className="mb-3 rounded-xl bg-subtle px-3 py-2 text-sm" role="status">{note}</p>}

      {mismatched.length === 0 ? <Empty>Every holder still matches the register.</Empty> : (
        <ul className="mb-3 divide-y divide-border">
          {mismatched.map((h) => (
            <li key={h.user_id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <input type="checkbox" className="size-5" checked={selected.has(h.user_id)} aria-label={`Select ${h.holder_name}`}
                onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(h.user_id)) n.delete(h.user_id); else n.add(h.user_id); return n; })} />
              <span className="min-w-0 flex-1">
                <b className="tabular-nums">{h.coupon_number}</b> · held by <b>{h.holder_name}</b> ({h.public_id})
                <span className="text-muted"> · register now says {h.coupon_retired ? 'the coupon is retired'
                  : <><b>{h.register_name ?? 'nobody'}</b>{h.register_student_id && <> (ID {h.register_student_id}; theirs {h.holder_student_id ?? 'not given'})</>}</>}</span>
              </span>
              {h.update_requested_at && <Badge>notified</Badge>}
            </li>
          ))}
        </ul>
      )}

      <label className="mb-3 grid gap-1 text-sm">
        <span>Message to send</span>
        <textarea className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || selected.size === 0 || !message.trim()} onClick={() => notify([...selected])}>
          Notify selected ({selected.size})
        </Button>
        {mismatched.length > 0 && (
          <Button disabled={busy || !message.trim()} onClick={() => notify(mismatched.map((h) => h.user_id))}>
            Notify all {mismatched.length} mismatched
          </Button>
        )}
        <ConfirmButton disabled={busy || !message.trim()}
          onConfirm={() => notify(null)}>
          Notify every student (new semester)
        </ConfirmButton>
      </div>
    </Panel>
  );
}
