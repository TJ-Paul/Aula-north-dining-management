'use client';

import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Panel } from '@/components/admin-shell';
import { Button } from '@/components/sheet';
import { accountRoute } from '@/lib/session';

/** Dev: create a door staff, mess manager, dev or view-only account with a first password. */
export function AddStaff({ onAdded }: { onAdded: () => void }) {
  const [f, setF] = useState({ name: '', phone: '', password: '', role: 'ATTENDANT' });
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" className="w-fit" onClick={() => setOpen(true)}>
          <span className="flex items-center gap-2"><UserPlus size={18} /> Add staff</span>
        </Button>
        {note && <span className="text-sm text-muted">{note}</span>}
      </div>
    );
  }

  return (
    <Panel title="Add a staff account" action={<Button onClick={() => setOpen(false)}>Close</Button>}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await accountRoute('staff', f);
          setNote(`${f.name} can now sign in with ${f.phone} and the password you set.`);
          setF({ name: '', phone: '', password: '', role: 'ATTENDANT' });
          setOpen(false);
          onAdded();
        } catch (err) {
          setNote((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}>
        <label className="grid gap-1 text-sm"><span>Name</span>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
        <label className="grid gap-1 text-sm"><span>Phone (they sign in with it)</span>
          <input className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="01712345678" required /></label>
        <label className="grid gap-1 text-sm"><span>First password (8+ characters)</span>
          <input className="input" type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="off" required /></label>
        <label className="grid gap-1 text-sm"><span>Role</span>
          <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="ATTENDANT">Door staff: collects coupons, runs the gate</option>
            <option value="ADMIN">Mess manager: the dashboard, meals, door and gate</option>
            <option value="SUPER_ADMIN">Dev: everything, including anyone’s details and roles</option>
            <option value="VIEWER">Viewer: sees every screen, changes nothing (for professors and visitors)</option>
          </select></label>
        <div className="sm:col-span-2 flex items-center justify-between gap-3">
          <span className="text-sm text-muted">{note}</span>
          <Button type="submit" variant="primary" disabled={busy}>Create account</Button>
        </div>
      </form>
    </Panel>
  );
}
