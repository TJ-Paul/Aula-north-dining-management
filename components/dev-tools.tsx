'use client';

import { Camera, Crown, KeyRound, ShieldCheck, Trash2, Wrench } from 'lucide-react';
import Link from 'next/link';
import { ConfirmButton } from '@/components/admin-shell';
import { useEffect, useRef, useState } from 'react';
import { AvatarCropper, PhotoTooBig, photoProblem } from '@/components/avatar-cropper';
import { Button } from '@/components/sheet';
import { rpc } from '@/lib/rpc';
import { ROLE_LABEL, accountRoute, type Role, type Session } from '@/lib/session';
import { uploadImage } from '@/lib/upload';

type Person = {
  user_id: string; name: string | null; student_id: string | null; room: string | null; phone: string | null; role: string; avatar_url: string | null;
  managed?: Array<{ id: string; serial: number; name: string; status: 'ACTIVE' | 'RETIRED' }>;
  mess_months?: Array<{ id: string; serial: number; name: string }> | null;
};

const MESSAGES: Record<string, string> = {
  OK: 'Saved.', INVALID_NAME: 'Use 2 to 80 characters for the name.', INVALID_STUDENT_ID: 'That student ID doesn’t look right (3–24 letters and digits).',
  STUDENT_ID_TAKEN: 'Another account already has that student ID.', INVALID_ROOM: 'Room: up to 20 characters.',
  INVALID_PHONE: 'Phone: an 11-digit number starting 01.', NOT_FOUND: 'This account no longer exists.',
  LAST_SUPER_ADMIN: 'There must always be at least one dev.', UNCHANGED: 'No change.',
  ASSIGNED: 'Done: they are a mess manager now.', ALREADY_MANAGER: 'They already manage that month.',
  RETIRED: 'Removed as mess manager. Their record stays.', NOT_ACTIVE: 'They are not an active mess manager.',
};
const ROLES: Role[] = ['STUDENT', 'ATTENDANT', 'ADMIN', 'SUPER_ADMIN', 'VIEWER'];

/** Dev only: change anything about a person (details, photo, password, role). Every change is audited. */
export function DevTools({ person: p, me, onChanged }: { person: Person; me: Session; onChanged: () => Promise<void> }) {
  const [f, setF] = useState({ name: p.name ?? '', sid: p.student_id ?? '', room: p.room ?? '', phone: p.phone ?? '' });
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(p.role as Role);
  // Their role can change under us (e.g. made a mess manager): show the new one.
  useEffect(() => setRole(p.role as Role), [p.role]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  const [problem, setProblem] = useState<'NOT_IMAGE' | 'TOO_BIG' | null>(null);

  const run = async (fn: () => Promise<{ status: string } | unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = (await fn()) as { status?: string } | undefined;
      setMsg(ok ?? MESSAGES[r?.status ?? 'OK'] ?? r?.status ?? 'Done.');
      await onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card grid gap-4 border-2 border-dashed border-accent/40">
      <h2 className="flex items-center gap-2 font-semibold"><Wrench size={18} className="text-accent" /> Dev tools</h2>
      {msg && <p className="rounded-xl bg-subtle px-3 py-2 text-sm" role="status">{msg}</p>}

      <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => {
        e.preventDefault();
        run(() => rpc('dev_update_person', { p_user_id: p.user_id, p_name: f.name, p_student_id: f.sid, p_room: f.room, p_phone: f.phone }));
      }}>
        {([['name', 'Name'], ['sid', 'Student ID'], ['room', 'Room'], ['phone', 'Phone (01…)']] as const).map(([k, label]) => (
          <label key={k} className="grid gap-1 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
            <input className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}
              inputMode={k === 'phone' ? 'tel' : undefined} />
          </label>
        ))}
        <Button type="submit" variant="primary" disabled={busy} className="w-fit sm:col-span-2">Save details</Button>
      </form>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <span className="mr-auto text-sm font-medium">Photo</span>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          const pr = photoProblem(file);
          if (pr) setProblem(pr); else setCropping(file);
        }} />
        <Button disabled={busy} onClick={() => fileRef.current?.click()}><span className="flex items-center gap-2"><Camera size={16} /> {p.avatar_url ? 'Change' : 'Add'}</span></Button>
        {p.avatar_url && (
          <Button disabled={busy} onClick={() => run(() => rpc('dev_set_photo', { p_user_id: p.user_id, p_avatar_url: null, p_clear: true }), 'Photo removed.')}>
            <span className="flex items-center gap-2 text-bad"><Trash2 size={16} /> Remove</span>
          </Button>
        )}
        {problem && <PhotoTooBig kind={problem} onClose={() => setProblem(null)} />}
        {cropping && (
          <AvatarCropper file={cropping} busy={busy} onCancel={() => setCropping(null)} onSave={(file) => run(async () => {
            const url = await uploadImage(file, me.id);
            await rpc('dev_set_photo', { p_user_id: p.user_id, p_avatar_url: url, p_clear: false });
            setCropping(null);
          }, 'Photo updated.')} />
        )}
      </div>

      <form className="flex flex-wrap items-end gap-2 border-t border-border pt-4" onSubmit={(e) => {
        e.preventDefault();
        run(() => accountRoute('reset_password', { user_id: p.user_id, password }), `New password set: ${password}. Tell them in person.`)
          .then(() => setPassword(''));
      }}>
        <label className="grid min-w-0 flex-1 gap-1 text-sm">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted"><KeyRound size={13} /> New password</span>
          <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} placeholder="8+ characters" autoComplete="off" />
        </label>
        <Button type="submit" disabled={busy || password.length < 8}>Set password</Button>
      </form>

      {p.mess_months && <ManagerTools person={p} busy={busy} run={run} />}

      {p.user_id !== me.id && (
        <form className="flex flex-wrap items-end gap-2 border-t border-border pt-4" onSubmit={(e) => {
          e.preventDefault();
          run(() => rpc('set_user_role', { p_user_id: p.user_id, p_role: role, p_reason: 'Changed by a dev' }));
        }}>
          <label className="grid min-w-0 flex-1 gap-1 text-sm">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted"><ShieldCheck size={13} /> Role</span>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <Button type="submit" disabled={busy || role === p.role}>Change role</Button>
        </form>
      )}
    </section>
  );
}

/**
 * Make them a mess manager of any month at once (no nomination, nothing to accept), or remove them.
 * Removing retires them from every month they manage; their record stays.
 */
function ManagerTools({ person: p, busy, run }: {
  person: Person; busy: boolean; run: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
}) {
  const months = p.mess_months ?? [];
  const [month, setMonth] = useState(months[0]?.id ?? '');
  const active = (p.managed ?? []).filter((m) => m.status === 'ACTIVE');
  return (
    <div className="grid gap-2 border-t border-border pt-4">
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted"><Crown size={13} /> Mess manager</span>
      {(p.managed ?? []).length > 0 && (
        <ul className="flex flex-wrap gap-1.5 text-sm">
          {p.managed!.map((m) => (
            <li key={m.id}>
              <Link href={`/mess/month/?month=${m.id}`} className={`inline-flex rounded-full px-2.5 py-1 font-medium ${m.status === 'ACTIVE' ? 'bg-ok-soft text-ok' : 'bg-subtle text-muted'}`}>
                {m.serial} · {m.name}{m.status === 'ACTIVE' ? '' : ' (served)'}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {months.length === 0 ? <p className="text-sm text-muted">No mess month yet.</p> : (
        <form className="grid gap-2 sm:flex sm:items-end" onSubmit={(e) => {
          e.preventDefault();
          if (month) run(() => rpc('dev_assign_manager', { p_user_id: p.user_id, p_mess_month_id: month }));
        }}>
          <select className="input w-full min-w-0 sm:flex-1" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Mess month">
            {months.map((m) => <option key={m.id} value={m.id}>Mess month {m.serial} · {m.name}</option>)}
          </select>
          <Button type="submit" variant="primary" disabled={busy || !month}>Make mess manager</Button>
        </form>
      )}
      {active.length > 0 && (
        <div className="flex justify-end">
          <ConfirmButton variant="danger" disabled={busy}
            onConfirm={() => run(() => rpc('retire_manager', { p_user_id: p.user_id }))}>Remove as mess manager</ConfirmButton>
        </div>
      )}
    </div>
  );
}
