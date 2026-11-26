'use client';

import { Children, useEffect, useRef, useState, type ReactNode } from 'react';

/** Laptop screens only (phones always get one column), and only when the list itself has room for two. */
const WIDE = '(min-width: 64rem)';
const TWO_COLUMNS_FROM = 760; // px of list width: below this a card is too narrow to sit beside another

/**
 * A list of cards. On phones it is the usual single column (`className`); on a laptop, when the list is
 * wide enough, the cards are dealt into two columns, left, right, left, right, so they keep their order
 * across each row and cards of different heights leave no holes.
 */
export function Masonry({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [two, setTwo] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const q = matchMedia(WIDE);
    const check = () => setTwo(q.matches && el.getBoundingClientRect().width >= TWO_COLUMNS_FROM);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    q.addEventListener('change', check);
    return () => { ro.disconnect(); q.removeEventListener('change', check); };
  }, []);
  const items = Children.toArray(children);
  const cols: ReactNode[][] = [[], []];
  items.forEach((c, i) => cols[i % 2].push(c));
  // One steady outer box (it is what gets measured), the list inside it.
  return (
    <div ref={ref} className="min-w-0">
      {!two || items.length < 2 ? <div className={className}>{items}</div> : (
        <div className="grid grid-cols-2 items-start gap-4">
          {cols.map((col, i) => <div key={i} className="grid min-w-0 gap-4">{col}</div>)}
        </div>
      )}
    </div>
  );
}
