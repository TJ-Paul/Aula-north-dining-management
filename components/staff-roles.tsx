'use client';

import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AddStaff } from '@/components/add-staff';
import { Badge, ConfirmButton, Empty, Notice, Panel } from '@/components/admin-shell';
import { Button } from '@/components/sheet';
import { rpc } from '@/lib/rpc';
import { accountRoute, type Role, type Session } from '@/lib/session';
import { useLoad } from '@/lib/use-load';

type Person = { id: string; name: string; role: Role; is_verified: boolean; coupon_number: number | null; phone: string | null };

const ROLES: Array<{ role: Role; label: string; what: string }> = [
  { role: 'STUDENT', label: 'Student', what: 'books meals' },
  { role: 'ATTENDANT', label: 'Door staff', what: 'the door screen: takes coupons and runs the gate' },
  { role: 'ADMIN', label: 'Mess manager', what: 'the dashboard: meals, door, gate, announcements, claims, feedback' },
  { role: 'SUPER_ADMIN', label: 'Dev', what: 'everything: edits anyone’s details, password, photo and role; imports the register' },
  { role: 'VIEWER', label: 'Viewer', what: 'sees every screen, changes nothing (for professors and visitors)' },
];
/** What a reset password becomes (the person changes it themselves afterwards). */
const RESET_PASSWORD = '12345678';

const LABEL = Object.fromEntries(ROLES.map((r) => [r.role, r.label])) as Record<Role, string>;

/** Staff accounts and roles; shown as the "Staff & roles" section of Everyone. */
export function StaffAndRoles({ session }: { session: Session }) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const people = useLoad(() => rpc<Person[]>('admin_find_people', { p_query: query }));
  const [editing, setEditing] = useState<{ id: string; role: Role; reason: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canChange = session.role === 'SUPER_ADMIN';
  const canReset = (p: Person) => p.id !== session.id && (p.role === 'STUDENT' || session.role === 'SUPER_ADMIN');

  /** One tap (plus a confirming tap): the password becomes 12345678; they change it from Profile → Password. */
  const resetPassword = async (p: Person) => {
    setBusy(true);
    try {
      await accountRoute('reset_password', { user_id: p.id, password: RESET_PASSWORD });
      setNote(`${p.name ? `${p.name}’s` : 'Their'} password is now ${RESET_PASSWORD}. Ask them to change it from Profile → Password.`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reloadPeople = people.reload;
  useEffect(() => { reloadPeople(); }, [query, reloadPeople]);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const r = await rpc<{ status: string }>('set_user_role', { p_user_id: editing.id, p_role: editing.role, p_reason: editing.reason });
      setNote(r.status === 'LAST_SUPER_ADMIN' ? 'There must always be at least one dev.'
        : r.status === 'UNCHANGED' ? 'No change.' : 'Role changed.');
      setEditing(null);
      await people.reload();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(input.trim()); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Coupon number or name" aria-label="Coupon number or name" className="input min-w-0 flex-1" />
        <Button type="submit" variant="primary"><span className="flex items-center gap-2"><Search size={16} aria-hidden /> Search</span></Button>
      </form>
      <Notice text={note} />
      {canChange && !query && <AddStaff onAdded={reloadPeople} />}

      <Panel title={query ? `Results for “${query}”` : 'Staff'}>
        {!people.data ? <Empty>{people.error ?? 'Loading…'}</Empty> : people.data.length === 0 ? <Empty>Nobody found.</Empty> : (
          <ul className="divide-y divide-border">
            {people.data.map((p) => (
              <li key={p.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{p.name || 'Unnamed'}</div>
                    <div className="text-sm text-muted">
                      {p.coupon_number ? `Coupon ${p.coupon_number}` : 'No verified coupon'}{p.phone && ` · +${p.phone}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={p.role === 'STUDENT' || p.role === 'VIEWER' ? 'info' : 'ok'}>{LABEL[p.role]}</Badge>
                    {canReset(p) && (
                      <ConfirmButton disabled={busy} onConfirm={() => resetPassword(p)}>
                        Reset password
                      </ConfirmButton>
                    )}
                    {canChange && editing?.id !== p.id && (
                      <Button onClick={() => setEditing({ id: p.id, role: p.role, reason: '' })}>Change role</Button>
                    )}
                  </div>
                </div>
                {editing?.id === p.id && (
                  <div className="mt-3 grid gap-2 rounded-xl bg-subtle p-3">
                    {ROLES.map((r) => (
                      <label key={r.role} className="flex items-start gap-2 text-sm">
                        <input type="radio" name={`role-${p.id}`} value={r.role} aria-label={r.label} checked={editing.role === r.role} className="mt-1"
                          onChange={() => setEditing({ ...editing, role: r.role })} />
                        <span><b>{r.label}</b> <span className="text-muted">· {r.what}</span></span>
                      </label>
                    ))}
                    <input value={editing.reason} onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
                      placeholder="Reason (kept in the audit log)" className="input !min-h-10" />
                    <div className="flex justify-end gap-2">
                      <Button onClick={() => setEditing(null)}>Cancel</Button>
                      <Button variant="primary" disabled={busy || !editing.reason.trim() || editing.role === p.role} onClick={save}>Save</Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {!canChange && <p className="mt-3 text-xs text-muted">Only a dev can change roles.</p>}
      </Panel>
    </>
  );
}
