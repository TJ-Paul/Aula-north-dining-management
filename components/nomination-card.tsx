'use client';

import { Crown } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/sheet';
import { dhakaDate } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

type Nomination = {
  nomination_id: string; nominated_by: string; note: string | null; created_at: string; next_serial: number;
  join_month: { id: string; serial: number; name: string; starts_on: string; ends_on: string } | null;
};

const MESSAGES: Record<string, string> = {
  MONTH_DETAILS_REQUIRED: 'Fill in the mess month name and dates.',
  INVALID_DATES: 'Check the dates: the end must be after the start, at most 3 months later.',
  STARTS_BEFORE_CURRENT_MONTH: 'The new month must start after the current one started.',
};

/**
 * Shown to a nominated student: accept or decline. The first to accept sets up
 * the new mess month; later nominees just join it.
 */
export function NominationCard({ onDone }: { onDone?: () => void }) {
  const { data, reload } = useLoad(() => rpc<Nomination | null>('my_nomination'), undefined, { lazy: true });
  const [f, setF] = useState({ name: '', starts: '', ends: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  const respond = async (accept: boolean) => {
    setBusy(true);
    try {
      const r = await rpc<{ status: string; serial?: number; created_month?: boolean }>('respond_to_nomination', {
        p_nomination_id: data.nomination_id, p_accept: accept,
        p_month_name: data.join_month ? null : f.name, p_starts_on: data.join_month ? null : f.starts || null,
        p_ends_on: data.join_month ? null : f.ends || null,
      });
      if (r.status === 'ACCEPTED') {
        setMsg(`You are now a mess manager of mess month ${r.serial}. Sign out and in again if the Dashboard tab doesn't appear.`);
        location.reload();
      } else if (r.status === 'REJECTED') {
        setMsg('Declined.');
        await reload();
      } else {
        setMsg(MESSAGES[r.status] ?? r.status);
      }
      onDone?.();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border-2 border-warn bg-surface p-4">
      <h2 className="flex items-center gap-2 font-semibold"><Crown size={18} className="text-warn" /> You’ve been nominated as a mess manager</h2>
      <p className="mt-1 text-sm text-muted">By {data.nominated_by}{data.note && `: “${data.note}”`}</p>
      {data.join_month ? (
        <p className="mt-3 text-sm">
          Accepting makes you a manager of <b>mess month {data.join_month.serial}: {data.join_month.name}</b> ({dhakaDate(data.join_month.starts_on)} – {dhakaDate(data.join_month.ends_on)}),
          already set up by another manager.
        </p>
      ) : (
        <div className="mt-3 grid gap-2 text-sm">
          <p>You are the first to accept, so set up <b>mess month {data.next_serial}</b>:</p>
          <label className="grid gap-1"><span>Mess month name</span>
            <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} placeholder="e.g. Kartik 1433" /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1"><span>Starts</span>
              <input type="date" className="input" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} /></label>
            <label className="grid gap-1"><span>Ends</span>
              <input type="date" className="input" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} /></label>
          </div>
          <p className="text-xs text-muted">Your name, coupon, room and phone from your profile are shown on the mess dashboard.
            After accepting, add a banner picture from the Mess tab (the pencil on the month card).</p>
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button disabled={busy} onClick={() => respond(false)}>Decline</Button>
        <Button variant="primary" disabled={busy} onClick={() => respond(true)}>Accept</Button>
      </div>
      {msg && <p className="mt-2 text-sm" role="status">{msg}</p>}
    </section>
  );
}
