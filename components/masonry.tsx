'use client';

import { Children, useEffect, useState, type ReactNode } from 'react';

const WIDE = '(min-width: 64rem)';

/** Whether the screen is laptop-wide (follows the window as it is resized). */
function useWide() {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && matchMedia(WIDE).matches);
  useEffect(() => {
    const q = matchMedia(WIDE);
    const on = () => setWide(q.matches);
    on();
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return wide;
}

/**
 * A list of cards. On phones it is the usual single column (`className`); on a laptop the cards are
 * dealt into two columns, left, right, left, right, so they keep their order across each row and
 * cards of different heights leave no holes.
 */
export function Masonry({ className, children }: { className: string; children: ReactNode }) {
  const wide = useWide();
  const items = Children.toArray(children);
  if (!wide || items.length < 2) return <div className={className}>{items}</div>;
  const cols: ReactNode[][] = [[], []];
  items.forEach((c, i) => cols[i % 2].push(c));
  return (
    <div className="grid grid-cols-2 items-start gap-4">
      {cols.map((col, i) => <div key={i} className="grid min-w-0 gap-4">{col}</div>)}
    </div>
  );
}
