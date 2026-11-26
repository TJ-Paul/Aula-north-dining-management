import { Sparkles } from 'lucide-react';

export type MenuEntry = { name: string; alternatives: string[] };

/** "Khashi (or Chicken / Egg)" → { name: 'Khashi', alternatives: ['Chicken', 'Egg'] }. */
export function parseMenu(lines: string[]): MenuEntry[] {
  return lines.map((line) => {
    const m = line.match(/^(.*) \(or (.*)\)$/);
    return m ? { name: m[1], alternatives: m[2].split(' / ') } : { name: line, alternatives: [] };
  });
}

/**
 * The menu as chips, one dish each, so it reads at a glance. For an improvement or feast
 * the first dish (the star of the meal) is highlighted; alternatives sit in the same chip
 * after a divider ("Khashi | or chicken").
 */
export function MenuChips({ items, star, size = 'md', hero: heroTone = 'bg-accent text-accent-fg' }: {
  items: MenuEntry[]; star?: boolean; size?: 'sm' | 'md'; /** Classes for the main dish's chip (the meal's own colour). */ hero?: string;
}) {
  if (items.length === 0) return null;
  const pad = size === 'sm' ? 'px-[clamp(0.45rem,2.4vw,0.625rem)] py-1 text-[clamp(0.6875rem,3.5vw,0.75rem)]' : 'px-[clamp(0.6rem,3.2vw,0.875rem)] py-1.5 text-[clamp(0.75rem,4vw,0.875rem)]';
  const altPad = size === 'sm' ? 'px-[clamp(0.4rem,2vw,0.5rem)] py-1 text-[clamp(0.625rem,3.2vw,0.6875rem)]' : 'px-2.5 py-1.5 text-[clamp(0.6875rem,3.5vw,0.75rem)]';
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Menu">
      {items.map((it, i) => {
        const hero = star && i === 0;
        return (
          <li key={`${it.name}-${i}`}
            className={`flex max-w-full items-stretch overflow-hidden rounded-full ${hero
              ? `${heroTone} shadow-sm`
              : 'lift-sm bg-subtle text-fg ring-1 ring-inset ring-border'}`}>
            <span className={`flex items-center gap-1.5 font-medium ${pad} ${hero ? 'font-semibold' : ''}`}>
              {hero && <Sparkles size={size === 'sm' ? 12 : 14} aria-hidden />}
              {it.name}
            </span>
            {it.alternatives.length > 0 && (
              <span className={`flex items-center border-l ${altPad} ${hero
                ? 'border-current/25 bg-black/10 opacity-90'
                : 'border-border bg-surface text-muted'}`}>
                or {it.alternatives.join(' / ')}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
