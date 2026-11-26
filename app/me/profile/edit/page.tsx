'use client';

import { ArrowLeft, Camera, Check, Clock, Pencil, Trash2, UserRound, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AvatarCropper, PhotoTooBig, photoProblem } from '@/components/avatar-cropper';
import { CouponStatus } from '@/components/coupon-status';
import { Roommates } from '@/components/roommates';
import { Button } from '@/components/sheet';
import { PageSkeleton } from '@/components/skeleton';
import { AppFrame } from '@/components/top-bar';
import { rpc } from '@/lib/rpc';
import { uploadImage } from '@/lib/upload';
import { isDev, useSessionWithReload } from '@/lib/session';
import { useLoad } from '@/lib/use-load';

/** Edit profile: photo, name (students ask an admin), room, phone, roommates and the coupon number. */
export default function EditProfilePage() {
  const { session, reload } = useSessionWithReload();
  const [room, setRoom] = useState('');
  const [phone, setPhone] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  const [problem, setProblem] = useState<'NOT_IMAGE' | 'TOO_BIG' | null>(null);
  const roomSeen = useRef(false);

  useEffect(() => {
    if (!session || roomSeen.current) return;
    roomSeen.current = true;
    setRoom(session.room ?? '');
    setPhone(session.phone ?? '');
  }, [session]);

  if (!session) return <PageSkeleton />;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      setMsg(done);
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppFrame session={session} active="profile">
      <div className="flex items-center justify-between">
        <Link href="/me/profile" className="flex w-fit items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> Profile</Link>
        <Link href="/me/profile" className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg">Done</Link>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Edit profile</h1>
      {msg && <p className="rounded-xl bg-subtle px-3 py-2 text-sm" role="status">{msg}</p>}

      <section className="card flex items-center gap-4">
        <button onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Change profile photo"
          className="relative size-24 shrink-0 overflow-hidden rounded-3xl bg-subtle">
          {session.avatar_url
            ? <img src={session.avatar_url} alt="" className="size-full object-cover" />
            : <UserRound className="m-auto size-10 text-muted" />}
          <span className="absolute inset-x-0 bottom-0 flex justify-center bg-black/45 py-1 text-white"><Camera size={15} /></span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const p = photoProblem(f);
            if (p) setProblem(p); else setCropping(f);
          }} />
        {problem && <PhotoTooBig kind={problem} onClose={() => setProblem(null)} />}
        {cropping && (
          <AvatarCropper file={cropping} busy={busy} onCancel={() => setCropping(null)} onSave={(file) => run(async () => {
            // set_my_photo: the one change a view-only account may make too.
            await rpc('set_my_photo', { p_avatar_url: await uploadImage(file, session.id, { ownPhoto: true }) });
            setCropping(null);
          }, 'Photo updated.')} />
        )}
        <div className="grid gap-2">
          <p className="font-semibold">Profile photo</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => fileRef.current?.click()}>
              <span className="flex items-center gap-2"><Camera size={16} /> {session.avatar_url ? 'Change' : 'Add photo'}</span>
            </Button>
            {session.avatar_url && (
              <Button disabled={busy} onClick={() => run(() => rpc('set_my_photo', { p_clear: true }), 'Photo removed.')}>
                <span className="flex items-center gap-2 text-bad"><Trash2 size={16} /> Remove</span>
              </Button>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Name</p>
        <NameEditor name={session.name} direct={isDev(session)} onChanged={reload} />
      </section>

      {!session.view_only && (
        <section className="card">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Student ID</p>
          <StudentIdEditor current={session.student_id} />
        </section>
      )}

      <form className="card grid gap-3" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          if (room !== (session.room ?? '')) await rpc('update_my_profile', { p_room: room });
          if (phone !== (session.phone ?? '')) {
            const r = await rpc<{ status: string }>('set_my_phone', { p_phone: phone });
            if (r.status === 'INVALID_PHONE') throw new Error('Phone: an 11-digit number starting 01, or leave it empty.');
          }
        }, 'Saved.');
      }}>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Room</span>
            <input className="input" value={room} onChange={(e) => setRoom(e.target.value)} maxLength={20} placeholder="e.g. 312" />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Phone <span className="normal-case">(optional)</span></span>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={16} placeholder="01XXXXXXXXX" autoComplete="tel" />
          </label>
        </div>
        <Button type="submit" variant="primary" className="w-fit" disabled={busy || (room === (session.room ?? '') && phone === (session.phone ?? ''))}>Save</Button>
      </form>

      {session.coupon_number && <Roommates />}

      {session.role === 'STUDENT' && <CouponStatus session={session} onChanged={reload} />}
    </AppFrame>
  );
}

type Extras = {
  walk_ins: number;
  name_request: { id: string; new_name: string; requested_at: string } | null;
  student_id_request: { id: string; new_student_id: string; requested_at: string } | null;
};

/** The name, with a pencil to ask for a change; an admin approves it before it shows. */
function NameEditor({ name, direct, onChanged }: { name: string | null; direct: boolean; onChanged: () => void }) {
  const { data, reload } = useLoad(() => rpc<Extras>('my_extras'));
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      // Devs rename themselves straight away; everyone else asks a mess manager or dev to verify it.
      const r = await rpc<{ status: string }>(direct ? 'set_my_name' : 'request_name_change', { p_name: value });
      setMsg(r.status === 'SENT' ? 'Sent. It shows once a mess manager verifies it.' : r.status === 'OK' ? null
        : r.status === 'SAME_NAME' ? 'That is already your name.' : 'Use 2 to 80 characters.');
      if (r.status !== 'INVALID_NAME') setEditing(false);
      if (r.status === 'OK') onChanged();
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pending = data?.name_request;

  return (
    <div className="grid gap-1">
      {editing ? (
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input className="input min-w-0 flex-1" value={value} onChange={(e) => setValue(e.target.value)} maxLength={80}
            autoFocus onFocus={(e) => e.currentTarget.select()} aria-label="New name" placeholder="Full name" />
          <button type="submit" disabled={busy} aria-label={direct ? 'Save name' : 'Send for approval'} className="rounded-full bg-accent p-2.5 text-accent-fg"><Check size={18} /></button>
          <button type="button" onClick={() => setEditing(false)} aria-label="Cancel" className="rounded-full p-2.5 text-muted hover:bg-subtle"><X size={18} /></button>
        </form>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-lg font-semibold">{name || 'No name yet'}</span>
          <button onClick={() => { setValue(pending?.new_name ?? name ?? ''); setEditing(true); setMsg(null); }}
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"><Pencil size={14} /> Change</button>
        </div>
      )}
      {pending && !editing && (
        <p className="text-xs text-warn">
          <Clock size={12} className="mr-1 inline align-[-1px]" />“{pending.new_name}” needs approval ·{' '}
          <button className="underline underline-offset-2" onClick={async () => { await rpc('cancel_name_change'); await reload(); }}>cancel</button>
        </p>
      )}
      {!direct && !pending && !editing && <p className="text-xs text-muted">A mess manager verifies a new name against the hall register before it shows.</p>}
      {msg && <p className="text-xs text-muted">{msg}</p>}
    </div>
  );
}

const SID_MESSAGES: Record<string, string> = {
  SENT: 'Sent. It shows once a mess manager verifies it.', SAME_STUDENT_ID: 'That is already your student ID.',
  STUDENT_ID_TAKEN: 'Another account already has that student ID. Ask a mess manager if it is yours.',
  INVALID_STUDENT_ID: 'That doesn’t look like a student ID (3–24 letters and digits).',
};

/** The student ID (used to sign in): a change waits for a mess manager or dev to verify it. */
function StudentIdEditor({ current }: { current: string | null }) {
  const { data, reload } = useLoad(() => rpc<Extras>('my_extras'));
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = data?.student_id_request;
  const send = async () => {
    setBusy(true);
    try {
      const r = await rpc<{ status: string }>('request_student_id_change', { p_student_id: value });
      setMsg(SID_MESSAGES[r.status] ?? r.status);
      if (r.status === 'SENT' || r.status === 'SAME_STUDENT_ID') setEditing(false);
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-1">
      {editing ? (
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input className="input min-w-0 flex-1" value={value} onChange={(e) => setValue(e.target.value)} maxLength={30}
            autoFocus autoCapitalize="characters" aria-label="New student ID" placeholder="Student ID" />
          <button type="submit" disabled={busy || !value.trim()} aria-label="Send for verification" className="rounded-full bg-accent p-2.5 text-accent-fg"><Check size={18} /></button>
          <button type="button" onClick={() => setEditing(false)} aria-label="Cancel" className="rounded-full p-2.5 text-muted hover:bg-subtle"><X size={18} /></button>
        </form>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-lg font-semibold tabular-nums">{current || <span className="text-base font-normal text-muted">None yet</span>}</span>
          <button onClick={() => { setValue(pending?.new_student_id ?? current ?? ''); setEditing(true); setMsg(null); }}
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"><Pencil size={14} /> Change</button>
        </div>
      )}
      {pending && !editing && (
        <p className="text-xs text-warn">
          <Clock size={12} className="mr-1 inline align-[-1px]" />“{pending.new_student_id}” needs verifying ·{' '}
          <button className="underline underline-offset-2" onClick={async () => { await rpc('cancel_student_id_change'); await reload(); }}>cancel</button>
        </p>
      )}
      {!pending && !editing && <p className="text-xs text-muted">You sign in with it. A mess manager verifies a change first.</p>}
      {msg && <p className="text-xs text-muted">{msg}</p>}
    </div>
  );
}
