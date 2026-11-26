'use client';

import { Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Sheet } from '@/components/sheet';

const SIZES = [
  { value: 0.65, label: 'Smallest' },
  { value: 0.9, label: 'Smaller' },
  { value: 1, label: 'Default' },
  { value: 1.1, label: 'Larger' },
  { value: 1.2, label: 'Largest' },
];
const KEY = 'aula-scale';

/** The gear on Profile: each person picks how big the app looks on their phone (saved on the phone only). */
export function TextSizeButton({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    try { const z = parseFloat(localStorage.getItem(KEY) ?? ''); if (z >= 0.6 && z <= 1.4) setScale(z); } catch { /* private mode */ }
  }, []);
  const pick = (z: number) => {
    setScale(z);
    document.documentElement.style.setProperty('--ui-scale', String(z));
    try { if (z === 1) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(z)); } catch { /* private mode */ }
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Settings: text size" title="Text size"
        className={`flex size-9 items-center justify-center rounded-full bg-surface/80 text-muted shadow-sm hover:text-fg ${className}`}>
        <Settings size={17} />
      </button>
      {open && (
        <Sheet title="Text size" onClose={() => setOpen(false)}>
          <p className="mb-3 text-sm text-muted">Makes everything in the app smaller or bigger, on this phone only. Smallest fits the most on screen.</p>
          <div className="grid grid-cols-5 gap-1 rounded-2xl bg-subtle p-1" role="radiogroup" aria-label="Text size">
            {SIZES.map((s) => (
              <button key={s.value} type="button" role="radio" aria-checked={scale === s.value} onClick={() => pick(s.value)}
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl ${scale === s.value ? 'bg-surface font-semibold text-fg shadow-sm' : 'text-muted'}`}>
                <span className="font-display leading-none" style={{ fontSize: `${s.value * 1.1}rem` }}>Aa</span>
                <span className="text-[0.625rem]">{s.label}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
