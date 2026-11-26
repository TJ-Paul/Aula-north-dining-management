'use client';

import {
  CakeSlice, Check, Clock, ImagePlus, LoaderCircle, Megaphone, Moon, PartyPopper, Plus, Sparkles, Sun, Timer, Users, Utensils, X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/sheet';
import { rpc } from '@/lib/rpc';
import { useSession } from '@/lib/session';
import { uploadImage } from '@/lib/upload';

export type MenuItem = { name: string; alternatives: string };   // alternatives as "Chicken, Egg"
export type MealForm = {
  date: string; mealType: 'LUNCH' | 'DINNER' | 'PARON'; occasion: 'REGULAR' | 'IMPROVEMENT' | 'FEAST';
  name: string; start: string; end: string; description: string; items: MenuItem[];
  choicesClose: string;   // "2026-11-07T12:00" Dhaka time, or '' = until the meal starts
  seats: string;          // seats per batch
  bookingOpen: string;    // minutes before the start that booking opens
  arrive: string;         // minutes a booked student has to arrive
  notice: string;         // shown to students on the meal card
  poster: string;         // poster URL for improvements and feasts, '' for none
};

// The hall's usual times, filled in for a new meal (any of them can still be changed):
// lunch 12:30–2:30 pm; dinner, improvement and feast 8:30–10:30 pm.
const DEFAULT_START: Record<MealForm['mealType'], string> = { LUNCH: '12:30', DINNER: '20:30', PARON: '20:30' };
const DEFAULT_END: Record<MealForm['mealType'], string> = { LUNCH: '14:30', DINNER: '22:30', PARON: '' };

/** A new form for a lunch, dinner, improvement or feast on a date, with that meal's usual times. */
export type QuickKind = 'LUNCH' | 'DINNER' | 'IMPROVEMENT' | 'FEAST';
export const mealFormFor = (date: string, kind: QuickKind): MealForm => {
  const type = kind === 'LUNCH' ? 'LUNCH' : 'DINNER';
  const occasion = kind === 'IMPROVEMENT' || kind === 'FEAST' ? kind : 'REGULAR';
  return { ...emptyMealForm(date), mealType: type, occasion, start: DEFAULT_START[type], end: DEFAULT_END[type] };
};

export const emptyMealForm = (date: string): MealForm => ({
  date, mealType: 'DINNER', occasion: 'REGULAR', name: '', start: DEFAULT_START.DINNER, end: DEFAULT_END.DINNER, description: '', items: [],
  choicesClose: '', seats: '50', bookingOpen: '15', arrive: '5', notice: '', poster: '',
});

/** Bangladesh has no daylight saving: Dhaka is always UTC+6. An end before the start means after midnight. */
export function toTimestamps(f: MealForm) {
  const start = `${f.date}T${f.start}:00+06:00`;
  if (!f.end) return { start, end: null };
  let end = new Date(`${f.date}T${f.end}:00+06:00`);
  if (end <= new Date(start)) end = new Date(end.getTime() + 24 * 3600_000);
  return { start, end: end.toISOString() };
}

/** The menu-choice deadline as a timestamp, or null for "until the meal starts". */
export const choicesCloseAt = (f: MealForm) => (f.choicesClose ? `${f.choicesClose}:00+06:00` : null);

export const isSpecial = (f: Pick<MealForm, 'mealType' | 'occasion'>) => f.mealType === 'PARON' || f.occasion !== 'REGULAR';

export function itemsJson(items: MenuItem[]) {
  return JSON.stringify(items.filter((i) => i.name.trim()).map((i) => ({
    name: i.name.trim(),
    alternatives: i.alternatives.split(',').map((a) => a.trim()).filter(Boolean),
  })));
}

/** Opens the browser's own calendar or clock when the field is tapped anywhere, not just on the small icon. */
const openPicker = (e: React.MouseEvent<HTMLInputElement>) => {
  try { e.currentTarget.showPicker?.(); } catch { /* not allowed here; typing still works */ }
};

/** The five kinds of meal, as big buttons. Lunch and dinner are regular; the rest are special (batches, booking). */
export const KINDS = [
  { key: 'LUNCH', label: 'Lunch', mealType: 'LUNCH', occasion: 'REGULAR', icon: Sun, tone: 'text-accent bg-accent-soft', on: 'ring-accent' },
  { key: 'DINNER', label: 'Dinner', mealType: 'DINNER', occasion: 'REGULAR', icon: Moon, tone: 'text-accent bg-accent-soft', on: 'ring-accent' },
  { key: 'PARON', label: 'Paron', mealType: 'PARON', occasion: 'REGULAR', icon: CakeSlice, tone: 'text-bad bg-bad-soft', on: 'ring-bad' },
  { key: 'IMPROVEMENT', label: 'Improvement', mealType: 'DINNER', occasion: 'IMPROVEMENT', icon: Sparkles, tone: 'text-gold bg-gold-soft', on: 'ring-gold' },
  { key: 'FEAST', label: 'Feast', mealType: 'DINNER', occasion: 'FEAST', icon: PartyPopper, tone: 'feast-fill', on: 'ring-rose-500' },
] as const;
type KindKey = (typeof KINDS)[number]['key'];
/** "8:30 – 10:30 pm" when both share am/pm, "11:30 am – 1:30 pm" otherwise. */
const shortSpan = (a: string, b: string) => (a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`);

const kindOf = (f: Pick<MealForm, 'mealType' | 'occasion'>): KindKey =>
  f.mealType === 'PARON' ? 'PARON' : f.occasion === 'REGULAR' ? f.mealType : f.occasion;

const hm = (t: string) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};
const dayText = (d: string) => (d ? new Date(`${d}T12:00:00+06:00`).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'short', day: 'numeric', month: 'short' }) : '');

/**
 * Create or edit a meal. Pick the kind with one big button; the usual date and times are already
 * filled in (one small line, tap to change); add the dishes; done. Improvements and feasts need a name.
 */
export function MealEditor({ initial, mode, busy, onSubmit, onCancel, suggestions = [], footer, inSheet }: {
  initial: MealForm; mode: 'create' | 'edit'; busy: boolean;
  onSubmit: (f: MealForm) => void; onCancel?: () => void;
  /** Edit mode: a button at the left of Save (the Dashboard's pop-up puts Delete there). */
  footer?: React.ReactNode;
  /** In a pop-up: the first line leaves room for its × (always so when creating). */
  inSheet?: boolean;
  /** Dishes used recently, offered as one-tap chips. */
  suggestions?: string[];
}) {
  const [f, setF] = useState(initial);
  const [when, setWhen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(!!initial.notice);
  const [dishDraft, setDishDraft] = useState('');
  const set = <K extends keyof MealForm>(k: K, v: MealForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const special = isSpecial(f);
  const kind = kindOf(f);
  const needsName = f.occasion !== 'REGULAR';
  const showName = mode === 'edit' || f.mealType === 'PARON' || needsName;

  const pickKind = (k: (typeof KINDS)[number]) => setF((x) => ({
    ...x, mealType: k.mealType, occasion: k.occasion,
    // The times follow the meal unless the admin already changed them.
    start: x.start === DEFAULT_START[x.mealType] ? DEFAULT_START[k.mealType] : x.start,
    end: x.end === DEFAULT_END[x.mealType] ? DEFAULT_END[k.mealType] : x.end,
    name: k.occasion === 'REGULAR' && k.mealType !== 'PARON' ? '' : x.name,
  }));

  return (
    <form className="grid grid-cols-[minmax(0,1fr)] gap-4" onSubmit={(e) => {
      e.preventDefault();
      // A special meal left without a name is simply called by its kind: "Improvement", "Feast", "Paron".
      const plain = kind === 'IMPROVEMENT' ? 'Improvement' : kind === 'FEAST' ? 'Feast' : kind === 'PARON' ? 'Paron' : '';
      // A dish still sitting in the box (Enter not pressed) counts too; empty ones never do.
      const typed = dishDraft.trim();
      const items = typed && !f.items.some((i) => i.name.trim().toLowerCase() === typed.toLowerCase())
        ? [...f.items, { name: typed, alternatives: '' }] : f.items;
      setDishDraft('');
      const done = { ...f, items };
      onSubmit(plain && !f.name.trim() ? { ...done, name: plain } : done);
    }}>
      {/* Date and times: almost always the defaults, so one small line until tapped. */}
      {!when ? (
        <button type="button" onClick={() => setWhen(true)}
          className={`flex items-center gap-2 lift-sm rounded-xl bg-subtle px-3 py-2 text-left text-[0.8125rem] text-muted ${mode === 'create' || inSheet ? 'mr-10' : ''}`}>
          <span className="min-w-0 flex-1 truncate"><b className="font-medium text-fg">{dayText(f.date)}</b> · {f.end ? shortSpan(hm(f.start), hm(f.end)) : hm(f.start)}</span>
          <span className="font-medium text-accent">Change</span>
        </button>
      ) : (
        <div className={`grid grid-cols-2 gap-1.5 ${mode === 'create' || inSheet ? 'mr-10' : ''}`}>
          <input type="date" required value={f.date} onChange={(e) => set('date', e.target.value)} onClick={openPicker}
            disabled={mode === 'edit'} aria-label="Date" className="input col-span-2 !min-h-10 min-w-0 cursor-pointer !px-2 text-sm disabled:opacity-60" />
          <input type="time" required value={f.start} onChange={(e) => set('start', e.target.value)} onClick={openPicker}
            disabled={mode === 'edit'} aria-label="Starts" className="input !min-h-10 min-w-0 cursor-pointer !px-2 text-sm disabled:opacity-60" />
          <input type="time" value={f.end} onChange={(e) => set('end', e.target.value)} onClick={openPicker}
            aria-label="Ends (optional)" className="input !min-h-10 min-w-0 cursor-pointer !px-2 text-sm" />
        </div>
      )}

      {mode === 'create' ? (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind of meal">
          {KINDS.map((k) => {
            const on = kind === k.key;
            return (
              <button key={k.key} type="button" role="radio" aria-checked={on} onClick={() => pickKind(k)}
                className={`kind-chip lift-soft flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition active:scale-95 ${on
                  ? `border-transparent ${k.tone}` : 'border-border text-muted'}`}>
                <k.icon size={15} /> {k.label}
              </button>
            );
          })}
        </div>
      ) : (
        <Segmented value={f.occasion} onChange={(v) => set('occasion', v)}
          options={[['REGULAR', 'Regular'], ['IMPROVEMENT', 'Improvement'], ['FEAST', 'Feast']]} />
      )}

      {showName && (
        <input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={80}
          placeholder={kind === 'IMPROVEMENT' ? 'Improvement name' : kind === 'FEAST' ? 'Feast name' : kind === 'PARON' ? 'Paron name' : 'Name (optional)'} aria-label="Name" className="input text-base font-medium" />
      )}

      <Dishes items={f.items} onChange={(items) => set('items', items)} star={special} suggestions={suggestions} draft={dishDraft} setDraft={setDishDraft}
        hero={kind === 'IMPROVEMENT' ? 'bg-gold-soft text-gold' : kind === 'FEAST' ? 'bg-rose-500/10 text-rose-500' : kind === 'PARON' ? 'bg-bad-soft text-bad' : 'bg-accent-soft text-accent'} />


      {special && (
      <div className="grid gap-2">
        {f.items.some((i) => i.alternatives.trim()) && (
          <label className="grid gap-1 text-xs text-muted">
            Students choose between alternatives until (empty = until the meal starts)
            <input type="datetime-local" value={f.choicesClose} onChange={(e) => set('choicesClose', e.target.value)} onClick={openPicker}
              className="input cursor-pointer" />
          </label>
        )}
        <Poster url={f.poster} onChange={(u) => set('poster', u)} />
      </div>
      )}

      {/* Notice: rarely used, so a quiet row until tapped (open when the meal already has one). */}
      {noticeOpen ? (
        <div className="relative">
          <Megaphone size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <input value={f.notice} onChange={(e) => set('notice', e.target.value)} maxLength={1000} autoFocus={!f.notice}
            placeholder="Notice for students" aria-label="Notice (optional)" className="input pl-9" />
        </div>
      ) : (
        <button type="button" onClick={() => setNoticeOpen(true)}
          className="flex items-center gap-2 lift-sm rounded-xl bg-subtle px-3 py-2 text-left text-[0.8125rem] text-muted">
          <Megaphone size={14} aria-hidden />
          <span className="min-w-0 flex-1 truncate font-medium text-fg">Notice</span>
          <span className="font-medium text-accent">Add</span>
        </button>
      )}

      {/* Seats and booking time: rarely changed, so one quiet line until tapped (like the date). */}
      {special && (!batchOpen ? (
        <button type="button" onClick={() => setBatchOpen(true)}
          className="flex items-center gap-2 lift-sm rounded-xl bg-subtle px-3 py-2 text-left text-[0.8125rem] text-muted">
          <span className="min-w-0 flex-1 truncate"><b className="font-medium text-fg">{f.seats || '—'} seats</b> · booking {f.bookingOpen || '—'} min before</span>
          <span className="font-medium text-accent">Change</span>
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Minutes label="Seats per batch" suffix="seats" value={f.seats} onChange={(v) => set('seats', v)} max={500} />
          <Minutes label="Booking opens" suffix="min before" value={f.bookingOpen} onChange={(v) => set('bookingOpen', v)} max={180} />
        </div>
      ))}

      {mode === 'create' ? (
        <button type="submit" disabled={busy}
          className={`mt-1 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-semibold shadow-lg transition active:scale-[0.98] disabled:opacity-60 ${
            kind === 'FEAST' ? 'feast-fill shadow-rose-500/30' : kind === 'IMPROVEMENT' ? 'bg-gold text-surface shadow-gold/30' : 'bg-accent text-accent-fg shadow-accent/30'}`}>
          {busy ? <LoaderCircle size={20} className="animate-spin" /> : <Check size={20} strokeWidth={2.6} />}
          {busy ? 'Creating…' : `Create ${(f.name.trim() && f.occasion !== 'REGULAR') ? f.name.trim() : KINDS.find((k) => k.key === kind)!.label.toLowerCase()}`}
          {!busy && f.items.filter((i) => i.name.trim()).length > 0 && (
            <span className="rounded-full bg-black/15 px-2 py-0.5 text-xs font-medium">{f.items.filter((i) => i.name.trim()).length} dishes</span>
          )}
        </button>
      ) : (
        <div className="flex justify-end gap-2">
          {footer && <div className="mr-auto">{footer}</div>}
          {onCancel && <Button onClick={onCancel}>Cancel</Button>}
          <Button type="submit" variant="primary" disabled={busy} className="min-w-32">{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      )}
    </form>
  );
}

/**
 * The menu, made to be quick and pleasant: a big box where you type a dish and press Enter, again and
 * again; each dish drops in as a row (rename it in place, a quiet "or" for alternatives, × to remove).
 * Recently used dishes are one tap away.
 */
function Dishes({ items, onChange, star, suggestions, hero, draft, setDraft }: {
  items: MenuItem[]; onChange: (items: MenuItem[]) => void; star: boolean; suggestions: string[];
  /** The main dish's colours. */ hero: string;
  /** What is typed in the dish box: the form adds it on save, so Enter is optional. */ draft: string; setDraft: (v: string) => void;
}) {
  const [altOpen, setAltOpen] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const have = new Set(items.map((i) => i.name.trim().toLowerCase()));
  const add = (name: string) => {
    const n = name.trim();
    setDraft('');
    input.current?.focus();
    if (!n || have.has(n.toLowerCase()) || items.length >= 30) return;
    onChange([...items, { name: n, alternatives: '' }]);
  };
  const patch = (i: number, p: Partial<MenuItem>) => onChange(items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const offer = suggestions.filter((x) => !have.has(x.toLowerCase())).slice(0, 10);
  const count = items.filter((i) => i.name.trim()).length;

  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between px-0.5">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><Utensils size={15} className="text-accent" /> Menu</p>
        {count > 0 && <span key={count} className="pop-in rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent tabular-nums">{count} {count === 1 ? 'dish' : 'dishes'}</span>}
      </div>

      {items.length > 0 && (
        <ul className="grid gap-1.5">
          {items.map((it, i) => (
            <li key={i} className={`pop-in rounded-2xl px-3 ${star && i === 0 ? hero : 'bg-subtle'}`}>
              <div className="flex h-12 items-center gap-2">
                {star && i === 0
                  ? <Sparkles size={16} className="shrink-0" aria-label="Main dish" />
                  : <span className="w-4 shrink-0 text-center text-xs font-semibold text-muted tabular-nums">{i + 1}</span>}
                <input value={it.name} onChange={(e) => patch(i, { name: e.target.value })} maxLength={80} aria-label={`Dish ${i + 1}`}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); input.current?.focus(); } }}
                  className="h-full min-w-0 flex-1 bg-transparent text-base font-medium text-fg outline-none" />
                {!it.alternatives && altOpen !== i && (
                  <button type="button" onClick={() => setAltOpen(i)} className="shrink-0 px-1.5 py-2 text-xs text-muted/80 hover:text-fg">or</button>
                )}
                <button type="button" aria-label={`Remove ${it.name}`} onClick={() => onChange(items.filter((_, j) => j !== i))}
                  className="-mr-1 shrink-0 rounded-full p-2 text-muted hover:text-fg"><X size={16} /></button>
              </div>
              {(it.alternatives || altOpen === i) && (
                <div className="-mt-1.5 flex items-center gap-2 pb-2 pl-6">
                  <span className="text-xs text-muted">or</span>
                  <input value={it.alternatives} onChange={(e) => patch(i, { alternatives: e.target.value })} autoFocus={altOpen === i}
                    onBlur={() => setAltOpen(null)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); input.current?.focus(); } }}
                    placeholder="Chicken, Egg" aria-label={`Alternatives to ${it.name}`}
                    className="h-8 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted/70" />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* The whole box is the target: tap anywhere, type, Enter, repeat. */}
      <label className="flex h-12 cursor-text items-center gap-3 rounded-[0.9rem] border border-border bg-surface px-3.5 transition focus-within:border-accent">
        <Plus size={18} className="shrink-0 text-muted" aria-hidden />
        <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={80}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }}
          placeholder={items.length ? 'Next dish' : 'Type a dish'} aria-label="Add a dish" enterKeyHint="next"
          autoCapitalize="words" autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted" />
        {draft.trim() && (
          <button type="button" onClick={() => add(draft)} aria-label="Add dish"
            className="pop-in shrink-0 rounded-full bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg active:scale-95">Add</button>
        )}
      </label>

      {offer.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Recent dishes">
          {offer.map((x) => (
            <button key={x} type="button" onClick={() => add(x)}
              className="rounded-full bg-subtle px-3 py-1.5 text-sm text-muted transition hover:text-fg active:scale-95">+ {x}</button>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Saved right after the meal itself: notice, and for special meals seats, booking time and poster, then the
 * menu-choice deadline. Returns a warning to show, or null.
 */
export async function saveMealExtras(mealId: string, f: MealForm): Promise<string | null> {
  let warn: string | null = null;
  await rpc('set_meal_notice', { p_meal_service_id: mealId, p_notice: f.notice });
  if (isSpecial(f)) {
    const seats = await rpc<{ status: string }>('set_batch_capacity', { p_meal_service_id: mealId, p_capacity: Number(f.seats) });
    if (seats.status !== 'OK') warn = 'Saved, but seats per batch must be between 1 and 500; it was left unchanged.';
    const timers = await rpc<{ status: string }>('set_meal_timers', {
      p_meal_service_id: mealId, p_booking_open_minutes: Number(f.bookingOpen), p_arrival_minutes: 5,
    });
    if (timers.status !== 'OK') warn = 'Saved, but booking opens 1–180 min before the start; the timer was left unchanged.';
    await rpc('set_meal_poster', { p_meal_service_id: mealId, p_poster_url: f.poster || null });
  }
  const r = await rpc<{ status: string }>('set_menu_choice_deadline', { p_meal_service_id: mealId, p_close_at: choicesCloseAt(f) });
  if (r.status === 'CHOICES_AFTER_START') warn = 'Saved, but the choice deadline must be before the meal starts; choices stay open until the start.';
  return warn;
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<[T, string]> }) {
  return (
    <div className="inline-flex rounded-full bg-subtle p-1 text-sm" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={`rounded-full px-4 py-1.5 transition ${value === v ? 'bg-accent font-medium text-accent-fg shadow-sm' : 'text-muted hover:text-fg'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Minutes({ label, suffix, value, onChange, max }: {
  label: string; suffix: string; value: string; onChange: (v: string) => void; max: number;
}) {
  return (
    <label className="grid min-w-0 gap-1.5">
      <span className="truncate text-xs text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <input type="number" inputMode="numeric" min={1} max={max} required value={value} onChange={(e) => onChange(e.target.value)}
          className="font-display h-11 w-16 shrink-0 rounded-xl border border-border bg-subtle text-center text-lg font-bold tabular-nums outline-none focus:border-accent"
          aria-label={`${label} (${suffix})`} />
        <span className="truncate text-sm text-muted">{suffix}</span>
      </span>
    </label>
  );
}

/** Pick a poster; it is shrunk to under 750 KB and uploaded straight away. */
function Poster({ url, onChange }: { url: string; onChange: (url: string) => void }) {
  const session = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (file: File) => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await uploadImage(file, session.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-1">
      <input ref={input} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const file = e.target.files?.[0]; if (file) pick(file); e.target.value = ''; }} />
      {url ? (
        <div className="relative w-fit">
          <img src={url} alt="Poster" className="max-h-56 rounded-xl object-contain" />
          <div className="absolute right-2 top-2 flex gap-1">
            <button type="button" onClick={() => input.current?.click()} className="rounded-full bg-black/60 px-3 py-1 text-xs text-white">Change</button>
            <button type="button" onClick={() => onChange('')} aria-label="Remove poster" className="rounded-full bg-black/60 p-1.5 text-white"><X size={14} /></button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => input.current?.click()} disabled={busy}
          className="flex h-24 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-border bg-surface text-sm text-muted transition hover:border-accent hover:text-accent">
          {busy ? <LoaderCircle size={22} className="animate-spin" /> : <ImagePlus size={22} />}
          {busy ? 'Uploading…' : 'Add poster'}
        </button>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
