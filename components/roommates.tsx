'use client';

import { BedDouble, Check, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { PersonLine, type PersonCard } from '@/components/person';
import { Button } from '@/components/sheet';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

type Linked = PersonCard & { link_id: string };
type Data = { accepted: Linked[]; incoming: Linked[]; outgoing: Linked[] };

const MESSAGES: Record<string, string> = {
  NOT_FOUND: 'No student with that coupon number and student ID has an account yet.',
  THATS_YOU: 'That’s you.',
  ALREADY: 'Already added (or waiting for them to accept).',
  TOO_MANY: 'You can have up to 8 roommates.',
};

/** Roommates are added by coupon number and student ID; the other student accepts, then both see each other. */
export function Roommates() {
  const { data, reload } = useLoad(() => rpc<Data>('my_roommates'));
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ coupon: '', sid: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  const act = async (fn: string, args: Record<string, unknown>, ok?: string) => {
    setBusy(true);
    try {
      const r = await rpc<{ status: string }>(fn, args);
      setMsg(r.status === 'SENT' ? 'Request sent. They’ll show here once they accept.' : MESSAGES[r.status] ?? ok ?? null);
      if (r.status === 'SENT') { setF({ coupon: '', sid: '' }); setAdding(false); }
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold"><BedDouble size={18} className="text-accent" /> Roommates</h2>
        {!adding && <button onClick={() => setAdding(true)} className="flex items-center gap-1 text-sm font-medium text-accent"><Plus size={16} /> Add</button>}
      </div>

      {data.incoming.map((p) => (
        <PersonLine key={p.link_id} p={p} right={
          <span className="flex gap-1">
            <button aria-label="Decline" disabled={busy} onClick={() => act('respond_roommate', { p_link_id: p.link_id, p_accept: false })}
              className="rounded-full p-2 text-muted hover:bg-subtle"><X size={18} /></button>
            <button aria-label="Accept" disabled={busy} onClick={() => act('respond_roommate', { p_link_id: p.link_id, p_accept: true }, 'Added.')}
              className="rounded-full bg-accent p-2 text-accent-fg"><Check size={18} /></button>
          </span>
        } />
      ))}
      {data.incoming.length > 0 && <p className="-mt-1 text-xs text-muted">Wants to add you as a roommate</p>}

      {data.accepted.map((p) => (
        <PersonLine key={p.link_id} p={p} right={
          <button aria-label="Remove" disabled={busy} onClick={() => act('remove_roommate', { p_link_id: p.link_id })}
            className="rounded-full p-2 text-muted hover:bg-subtle"><X size={16} /></button>
        } />
      ))}
      {data.outgoing.map((p) => (
        <PersonLine key={p.link_id} p={p} right={
          <span className="flex items-center gap-1 text-xs text-muted">waiting
            <button aria-label="Cancel request" disabled={busy} onClick={() => act('remove_roommate', { p_link_id: p.link_id })}
              className="rounded-full p-2 hover:bg-subtle"><X size={16} /></button></span>
        } />
      ))}
      {data.accepted.length + data.outgoing.length + data.incoming.length === 0 && !adding && (
        <p className="text-sm text-muted">No roommates added.</p>
      )}

      {adding && (
        <form className="grid gap-2 sm:grid-cols-[8rem_1fr_auto]" onSubmit={(e) => {
          e.preventDefault();
          act('request_roommate', { p_coupon_number: Number(f.coupon), p_student_id: f.sid });
        }}>
          <input className="input" inputMode="numeric" placeholder="Coupon" value={f.coupon} aria-label="Their coupon number"
            onChange={(e) => setF({ ...f, coupon: e.target.value.replace(/\D/g, '').slice(0, 4) })} required />
          <input className="input" placeholder="Their student ID" value={f.sid} aria-label="Their student ID"
            onChange={(e) => setF({ ...f, sid: e.target.value })} required />
          <div className="flex gap-2">
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy || !f.coupon || !f.sid}>Send</Button>
          </div>
        </form>
      )}
      {msg && <p className="text-sm text-muted" role="status">{msg}</p>}
    </section>
  );
}
