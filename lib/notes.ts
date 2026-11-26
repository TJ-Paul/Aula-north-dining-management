import { dhakaTime } from './format';

export type Note = { id: string; kind: string; payload: Record<string, string>; created_at: string };

/** The line under a notification's title; most carry their own message. */
export function noteBody(n: Note) {
  const p = n.payload;
  switch (n.kind) {
    case 'BOOKING_CONFIRMED': return `Confirmed for Aisle ${p.aisle}; arrive by ${dhakaTime(p.arrive_by)}.`;
    case 'PROMOTED_FROM_STANDBY': return `A seat opened up: you are confirmed for Aisle ${p.aisle}; arrive by ${dhakaTime(p.arrive_by)}.`;
    case 'STANDBY_OFFER': return `A place is available in Aisle ${p.aisle}. Accept by ${dhakaTime(p.respond_by)}.`;
    case 'INVITATION_ACCEPTED':
      return `You are invited to Aisle ${p.aisle}, entry ${dhakaTime(p.entry_window_start)}–${dhakaTime(p.entry_window_end)}, coupon ${p.coupon_number}.`;
    case 'ADMIN_MESSAGE': return p.message ?? '';
    default: return p.message ?? n.kind;
  }
}

/** One line for the bell: the title (when the notice has one) and its message. */
export function noteText(n: Note) {
  const p = n.payload;
  if (n.kind === 'ADMIN_MESSAGE') return `Mess managers: ${p.message}`;
  return p.title ? `${p.title} · ${noteBody(n)}` : noteBody(n);
}

/** A notification split for the bell: a short title (no leading emoji) and one line of detail. */
export function noteParts(n: Note): { title: string; detail: string } {
  const p = n.payload;
  if (n.kind === 'ADMIN_MESSAGE') return { title: 'Mess managers', detail: p.message ?? '' };
  const clean = (t: string) => t.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '').trim();
  const body = clean(noteBody(n));
  if (!p.title) return { title: body, detail: '' };
  // "Biriyani night: gate open" → "Gate open": the meal's name adds nothing to a batch step.
  const step = clean(p.title).match(/^.+?: ((?:gate open|booking open|batch\b).*)$/i);
  const title = step ? step[1][0].toUpperCase() + step[1].slice(1) : clean(p.title);
  return { title, detail: body };
}
