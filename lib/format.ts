// Times are stored in UTC and always shown in Asia/Dhaka (spec I11).

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', hour12: true });

/** "2:21 pm" in Dhaka time (12-hour everywhere in the app). */
export function dhakaTime(iso: string) {
  return clock.format(new Date(iso)).replace(/\s?(AM|PM)$/i, (m) => ` ${m.trim().toLowerCase()}`);
}

export function ago(seconds: number) {
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

/** "6:32:24" (hours:minutes:seconds), "4:05" under an hour — or null once passed. */
export function countdown(iso: string, now: number) {
  const s = Math.floor((new Date(iso).getTime() - now) / 1000);
  if (s < 0) return null;
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}

/** Time left until `iso`, going below zero afterwards: "3:12", then "−0:41". */
export function signedCountdown(iso: string, now: number) {
  const left = Math.floor((new Date(iso).getTime() - now) / 1000);
  const s = Math.abs(left);
  return `${left < 0 ? '−' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Time since `iso`, counting up: "4:07" or "1:02:45". */
export function elapsed(iso: string, now: number) {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}

export function mealName(type: string) {
  return type[0] + type.slice(1).toLowerCase();
}

export const OCCASION: Record<string, string> = { REGULAR: '', IMPROVEMENT: 'Improvement', FEAST: 'Feast' };

/** "Feast night" if the meal has a name, else "Dinner" / "Paron"; with the occasion when it isn't regular. */
export function mealTitle(m: { name?: string | null; meal_type: string; occasion?: string | null }) {
  const base = m.name || mealName(m.meal_type);
  const occ = m.occasion && m.occasion !== 'REGULAR' && !m.name ? ` · ${OCCASION[m.occasion]}` : '';
  return base + occ;
}

/** "5 Nov 2026" in Dhaka time. */
export function dhakaDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' });
}

/** "6 Oct – 18 Nov 2026"; the year twice only when the two dates fall in different years. */
export function dateSpan(from: string, to: string) {
  const f = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', ...o });
  const sameYear = f(from, { year: 'numeric' }) === f(to, { year: 'numeric' });
  return `${f(from, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })} – ${f(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** "8:30 pm – 10:30 pm" (end optional). */
export function timeRange(start: string, end?: string | null) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', hour12: true });
  return end ? `${f.format(new Date(start))} – ${f.format(new Date(end))}` : f.format(new Date(start));
}

/** Today's date in Dhaka as "2026-11-05", comparable with database dates. */
export function dhakaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
}

/** Where a mess month stands today. */
export function monthStage(m: { starts_on: string; ends_on: string }) {
  const today = dhakaToday();
  return today > m.ends_on ? 'Ended' : today < m.starts_on ? 'Upcoming' : 'Current';
}

/** "KABBO KUMAR KARMOKER" → "Kabbo Kumar Karmoker" (hall sheets are often in capitals). */
export function titleCase(name: string | null) {
  if (!name) return null;
  return name === name.toUpperCase() ? name.toLowerCase().replace(/(^|[\s.-])\p{L}/gu, (m) => m.toUpperCase()) : name;
}
