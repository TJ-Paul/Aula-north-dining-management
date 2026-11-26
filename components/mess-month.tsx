'use client';

import { CakeSlice, ChevronRight, Crown, ImagePlus, Megaphone, PartyPopper, Pencil, Phone, Soup, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Badge } from '@/components/admin-shell';
import { AvatarCropper, PhotoTooBig, photoProblem } from '@/components/avatar-cropper';
import { Button, Sheet } from '@/components/sheet';
import { dateSpan, monthStage, titleCase } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useSession } from '@/lib/session';
import { uploadImage } from '@/lib/upload';

export type Manager = {
  user_id: string; name: string; coupon_number: number | null; room: string | null; phone: string | null;
  status: 'ACTIVE' | 'RETIRED'; joined_at: string; retired_at: string | null; avatar_url?: string | null;
};
export type MonthRef = { id: string; serial: number; name: string; starts_on: string; ends_on: string; over: boolean; banner_url?: string | null };
export type Dashboard = {
  months: MonthRef[];
  is_admin: boolean;
  i_am_active_manager: boolean;
  month: null | (MonthRef & {
    is_latest: boolean;
    /** The viewer is a dev or one of this month's managers: they may rename it, move its dates, set its banner. */
    can_edit?: boolean;
    managers: Manager[]; counts: { meals: number; improvements: number; feasts: number; parons: number };
  });
  nominations: Array<{ id: string; nominee: string; nominated_by: string; status: string; created_at: string; next_month?: boolean }> | null;
};
export type Month = NonNullable<Dashboard['month']>;

export const TILES = [
  { kind: 'meals', label: 'All meals', key: 'meals', Icon: Soup, tone: 'text-accent bg-accent-soft', tint: 'var(--accent)' },
  { kind: 'improvements', label: 'Improvements', key: 'improvements', Icon: Sparkles, tone: 'text-gold bg-gold-soft', tint: 'var(--accent)' },
  { kind: 'feasts', label: 'Feasts', key: 'feasts', Icon: PartyPopper, tone: 'feast-fill', tint: 'var(--accent)' },
  { kind: 'parons', label: 'Parons', key: 'parons', Icon: CakeSlice, tone: 'text-bad bg-bad-soft', tint: 'var(--accent)' },
] as const;

/** Day N of M for a month (0 before it starts). */
export function monthProgress(m: { starts_on: string; ends_on: string }) {
  const start = new Date(`${m.starts_on}T00:00:00+06:00`).getTime();
  const end = new Date(`${m.ends_on}T23:59:59+06:00`).getTime();
  const total = Math.max(1, Math.round((end - start) / 86400000));
  const day = Math.min(total, Math.max(0, Math.ceil((Date.now() - start) / 86400000)));
  return { day, total };
}

/** "1 day left", "5 days left", "Last day". */
function daysLeft(n: number) {
  return n <= 0 ? 'Last day' : `${n} ${n === 1 ? 'day' : 'days'} left`;
}

/**
 * The month at a glance, a 16:9 card: its banner (if any) behind the name, the dates, and for the
 * running month how many days are left (no bar). The month number sits in a circle at the top right.
 * Its managers and devs get a pencil to rename it, move its dates or change the banner.
 */
export function MonthHero({ month: m, onChanged }: { month: MonthRef & { can_edit?: boolean }; onChanged?: () => void }) {
  const { day, total } = monthProgress(m);
  const stage = monthStage(m);
  const [editing, setEditing] = useState(false);
  const pic = m.banner_url;
  const startsIn = Math.ceil((new Date(`${m.starts_on}T00:00:00+06:00`).getTime() - Date.now()) / 86400000);
  return (
    <section className={`relative aspect-video overflow-hidden rounded-3xl border border-border ${pic ? 'bg-black text-white' : 'bg-gradient-to-br from-accent/25 via-surface to-surface'}`}>
      {pic ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={pic} alt="" className="absolute inset-0 size-full object-cover" />
          <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-black/10" aria-hidden />
        </>
      ) : <span className="pointer-events-none absolute -right-10 -top-12 size-40 rounded-full bg-accent/10 blur-2xl" aria-hidden />}

      <div className="absolute right-3.5 top-3.5 flex items-center gap-2">
        {m.can_edit && (
          <button type="button" onClick={() => setEditing(true)} aria-label="Edit this mess month"
            className={`flex size-9 items-center justify-center rounded-full ${pic ? 'bg-black/45 text-white' : 'bg-surface/80 text-fg shadow-sm'}`}>
            <Pencil size={15} />
          </button>
        )}
        <span title={`Mess month ${m.serial}`} aria-label={`Mess month ${m.serial}`}
          className={`flex size-9 items-center justify-center rounded-full text-base font-bold tabular-nums ring-2 ${pic ? 'bg-black/45 text-white ring-white/70' : 'bg-accent-soft text-accent ring-accent/40'}`}>
          {m.serial}
        </span>
      </div>

      <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6">
        <h1 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
          <span className="line-clamp-2 break-words">{m.name}</span>
          {stage === 'Current' ? <Badge tone="ok">Current</Badge> : <Badge>{stage}</Badge>}
        </h1>
        <p className={`mt-0.5 flex items-baseline justify-between gap-3 text-sm ${pic ? 'text-white/85' : 'text-muted'}`}>
          <span>{dateSpan(m.starts_on, m.ends_on)}</span>
          {stage === 'Current' && <span className={`shrink-0 font-medium ${pic ? 'text-white' : 'text-fg'}`}>{daysLeft(total - day)}</span>}
        </p>
        {stage === 'Upcoming' && startsIn > 0 && (
          <p className={`mt-1 text-xs ${pic ? 'text-white/85' : 'text-muted'}`}>Starts in {startsIn} {startsIn === 1 ? 'day' : 'days'}</p>
        )}
      </div>
      {editing && <MonthEditor month={m} onClose={() => setEditing(false)} onChanged={() => onChanged?.()} />}
    </section>
  );
}

const EDIT_MESSAGES: Record<string, string> = {
  NAME_LENGTH: 'The name needs 2 to 60 characters.',
  INVALID_DATES: 'Check the dates: the end must be after the start, at most 3 months later.',
  STARTS_BEFORE_PREVIOUS_MONTH: 'It must start after the previous mess month started.',
  STARTS_AFTER_NEXT_MONTH: 'It must start before the next mess month starts.',
  NOT_YOUR_MONTH: 'Only this month’s mess managers or a dev can change it.',
};

/** Rename the month, move its dates, and add, change or remove its 16:9 banner. */
function MonthEditor({ month: m, onClose, onChanged }: { month: MonthRef; onClose: () => void; onChanged: () => void }) {
  const session = useSession();
  const [f, setF] = useState({ name: m.name, starts: m.starts_on, ends: m.ends_on });
  const [banner, setBanner] = useState(m.banner_url ?? null);
  const [cropping, setCropping] = useState<File | null>(null);
  const [problem, setProblem] = useState<'NOT_IMAGE' | 'TOO_BIG' | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try { await fn(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  /** A new picture (cropped file) or none (null): saved at once, the rest of the form untouched. */
  const setPicture = (file: File | null) => run(async () => {
    const url = file && session ? await uploadImage(file, session.id) : null;
    const r = await rpc<{ status: string }>('set_mess_month_banner', { p_mess_month_id: m.id, p_banner_url: url, p_clear: url === null });
    if (r.status !== 'OK') { setMsg(EDIT_MESSAGES[r.status] ?? r.status); return; }
    setBanner(url);
    onChanged();
  });

  return (
    <Sheet title={`Mess month ${m.serial}`} onClose={onClose}>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <div className="relative aspect-video overflow-hidden rounded-2xl border border-border bg-subtle">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {banner ? <img src={banner} alt="" className="size-full object-cover" />
              : <span className="flex size-full flex-col items-center justify-center gap-1 text-sm text-muted"><ImagePlus size={26} /> No banner yet</span>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={() => input.current?.click()}>
              <span className="flex items-center justify-center gap-1.5 text-sm"><ImagePlus size={16} /> {banner ? 'Change' : 'Add banner'}</span>
            </Button>
            <Button disabled={busy || !banner} onClick={() => setPicture(null)}>
              <span className="flex items-center justify-center gap-1.5 text-sm"><Trash2 size={16} /> Remove</span>
            </Button>
          </div>
          <p className="text-xs text-muted">16:9 pictures fit best. You can move and zoom it before saving.</p>
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            const p = photoProblem(file);
            if (p) setProblem(p); else setCropping(file);
          }} />
        </div>

        <form className="grid gap-3 text-sm" onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await rpc<{ status: string }>('update_mess_month',
              { p_mess_month_id: m.id, p_name: f.name, p_starts_on: f.starts, p_ends_on: f.ends });
            if (r.status !== 'OK') { setMsg(EDIT_MESSAGES[r.status] ?? r.status); return; }
            onChanged();
            onClose();
          });
        }}>
          <label className="grid gap-1"><span>Name</span>
            <input className="input" value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1"><span>Starts</span>
              <input type="date" className="input" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} /></label>
            <label className="grid gap-1"><span>Ends</span>
              <input type="date" className="input" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} /></label>
          </div>
          {msg && <p className="rounded-xl bg-subtle px-3 py-2" role="status">{msg}</p>}
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </form>
      </div>
      {problem && <PhotoTooBig kind={problem} onClose={() => setProblem(null)} />}
      {cropping && session && (
        <AvatarCropper banner file={cropping} busy={busy} onCancel={() => setCropping(null)} onSave={async (file) => {
          await setPicture(file);
          setCropping(null);
        }} />
      )}
    </Sheet>
  );
}

/**
 * The month's counts, each opening the list of those meals with how many ate. One 3-column grid so
 * the edges line up: all meals across two columns with the announcements beside it, then
 * improvements, feasts and parons. Every tile is the same height.
 */
export function MonthTiles({ month: m }: { month: Month }) {
  const [all, ...kinds] = TILES;
  return (
    <section className="grid grid-cols-3 gap-2.5 sm:gap-3">
      <Link href={`/mess/month/meals/?month=${m.id}&kind=${all.kind}`} style={tint(all.tint)}
        className={`${TILE} col-span-2 flex items-center gap-3 !px-4`}>
        <span className="min-w-0 flex-1 pl-1">
          <span className="font-display block text-[2.4rem] font-extrabold leading-none tabular-nums">{m.counts[all.key]}</span>
          <span className="mt-1.5 block text-[0.8125rem] font-medium leading-tight text-fg/65">{all.label}</span>
        </span>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><ChevronRight size={17} /></span>
      </Link>
      <Link href="/announcements" style={tint('var(--accent)')} className={`${TILE} ${STACK}`}>
        <span className={`${ICON} size-10 bg-accent-soft text-accent`}><Megaphone size={20} aria-hidden /></span>
        <span className="w-full text-[0.6875rem] font-medium leading-tight text-fg/65 sm:text-xs">Announce&shy;ments</span>
      </Link>
      {kinds.map((t) => (
        <Link key={t.kind} href={`/mess/month/meals/?month=${m.id}&kind=${t.kind}`} style={tint(t.tint)} className={`${TILE} ${STACK} ${t.kind === 'feasts' ? 'feast-outline' : ''}`}>
          <span className="font-display text-[2rem] font-extrabold leading-none tabular-nums">{m.counts[t.key]}</span>
          <span className="mt-1.5 w-full truncate text-[clamp(0.625rem,3.3vw,0.8125rem)] font-medium leading-tight tracking-[-0.01em] text-fg/65">{t.label}</span>
        </Link>
      ))}
    </section>
  );
}

/** Same height for every tile, so the two rows read as one block. */
const TILE = 'card tile-wash h-32 transition hover:-translate-y-0.5 active:scale-[0.98]';
/** Icon square with a thin ring in the tile's own colour. */
const ICON = 'flex shrink-0 items-center justify-center rounded-2xl ring-1 ring-inset ring-[color-mix(in_srgb,var(--tint)_25%,transparent)]';
const tint = (c: string) => ({ '--tint': c }) as React.CSSProperties;
const STACK = 'flex flex-col items-center justify-center gap-1.5 !px-1.5 !py-2 text-center';

export function Managers({ managers }: { managers: Manager[] }) {
  return (
    <section className="card">
      <h2 className="mb-2 flex items-center gap-2 font-semibold"><span className="flex size-7 items-center justify-center rounded-lg bg-gold-soft text-gold"><Crown size={16} /></span> Mess managers</h2>
      {managers.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
        <ul className="-mx-1 divide-y divide-border/70">
          {managers.map((g) => (
            <li key={g.user_id} className="flex items-center gap-3 px-1 py-3 first:pt-1 last:pb-0.5">
              <span className="relative shrink-0 rounded-full p-[2px] bg-gradient-to-br from-gold/80 to-glow/70">
                {g.avatar_url
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={g.avatar_url} alt="" className="size-11 rounded-full object-cover ring-2 ring-surface" />
                  : <span className="flex size-11 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg ring-2 ring-surface">
                    {initials(g.name)}
                  </span>}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 truncate text-[0.9375rem] font-semibold leading-tight">
                  {titleCase(g.name)}
                  {g.status !== 'ACTIVE' && <Badge>Retired</Badge>}
                </div>
                <div className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted">
                  <span className="rounded-md bg-subtle px-1.5 py-0.5 font-semibold tabular-nums text-fg/80">Coupon {g.coupon_number ?? '—'}</span>
                  {g.room && <span>Room {g.room}</span>}
                </div>
              </div>
              {g.phone && (
                <a href={`tel:${g.phone}`} aria-label={`Call ${g.name}`}
                  className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent ring-1 ring-accent/15 hover:bg-accent hover:text-accent-fg">
                  <Phone size={17} />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
