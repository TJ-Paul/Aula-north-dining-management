'use client';

import { Upload } from 'lucide-react';
import { useState } from 'react';
import { AdminShell, Badge, Empty, Notice, Panel } from '@/components/admin-shell';
import { Button } from '@/components/sheet';
import { parseRegistryCsv, type RegistryRow } from '@/lib/csv';
import { rpc } from '@/lib/rpc';
import type { Session } from '@/lib/session';
import { useLoad } from '@/lib/use-load';



export default function RegistryPage() {
  return <AdminShell active="registry">{(s) => <Registry session={s} />}</AdminShell>;
}

function Registry({ session }: { session: Session }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [imports, setImports] = useState(0);
  const parsed = text.trim() ? parseRegistryCsv(text) : null;
  const canImport = session.role === 'SUPER_ADMIN';

  const doImport = async (rows: RegistryRow[]) => {
    setBusy(true);
    try {
      const r = await rpc<{ inserted: number; updated: number; notified: number }>('import_coupons', { p_rows: JSON.stringify(rows) });
      setNote(`Imported: ${r.inserted} new coupons, ${r.updated} updated, ${rows.length - r.inserted - r.updated} unchanged.`
        + (r.notified ? ` ${r.notified} ${r.notified === 1 ? 'student was' : 'students were'} told to update their coupon number; their requests will appear in Claims.` : ''));
      setImports((n) => n + 1);
      setText('');
    } catch (e) {
      setNote(`Import failed, nothing was changed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Notice text={note} />

      <Panel title="Import the hall coupon register">
        <p className="mb-3 text-sm text-muted">
          A CSV file from the hall office with columns <b>coupon, name, student id</b> (a header row is optional; with one, any order).
          New coupons are added and changed details are updated. Coupons are never deleted, and importing the same file twice changes nothing.
        </p>
        {!canImport ? <Empty>Only a dev can import the register.</Empty> : (
          <div className="grid gap-3">
            <label className="flex w-fit cursor-pointer items-center gap-2 rounded-xl bg-subtle px-4 py-3 text-sm font-medium hover:bg-border">
              <Upload size={16} /> Choose CSV file
              <input type="file" accept=".csv,text/csv,text/plain" className="hidden"
                onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); e.target.value = ''; }} />
            </label>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} className="input font-mono text-sm"
              placeholder={'coupon,name,student id\n245,Rahim Uddin,2021331045'} />
            {parsed && (
              <div className="grid gap-2">
                <p className="text-sm">
                  <b>{parsed.rows.length}</b> coupon{parsed.rows.length === 1 ? '' : 's'} ready
                  {parsed.errors.length > 0 && <span className="text-bad"> · {parsed.errors.length} problem{parsed.errors.length === 1 ? '' : 's'} to fix first</span>}
                </p>
                {parsed.errors.length > 0 && (
                  <ul className="list-inside list-disc text-sm text-bad">{parsed.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}</ul>
                )}
                {parsed.rows.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="text-muted"><tr><th className="py-1 pr-4">Coupon</th><th className="pr-4">Name</th><th>Student ID</th></tr></thead>
                      <tbody>
                        {parsed.rows.slice(0, 8).map((r) => (
                          <tr key={r.coupon_number} className="border-t border-border">
                            <td className="py-1 pr-4 tabular-nums">{r.coupon_number}</td><td className="pr-4">{r.hall_record.name ?? '—'}</td>
                            <td>{r.hall_record.student_id ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {parsed.rows.length > 8 && <p className="mt-1 text-xs text-muted">…and {parsed.rows.length - 8} more</p>}
                  </div>
                )}
                <Button variant="primary" className="w-fit" disabled={busy || parsed.errors.length > 0 || parsed.rows.length === 0}
                  onClick={() => doImport(parsed.rows)}>
                  Import {parsed.rows.length} coupon{parsed.rows.length === 1 ? '' : 's'}
                </Button>
              </div>
            )}
          </div>
        )}
      </Panel>


    </>
  );
}
