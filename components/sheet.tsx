'use client';

import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

/** Bottom sheet on phones, centred dialog on wider screens. Escape or the backdrop closes it. */
export function Sheet({ title, onClose, children, wide, bare }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean;
  /** No title line (only the ×), a card in the middle of the screen. */ bare?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={`fixed inset-0 z-50 flex justify-center ${bare ? 'items-center p-3' : 'items-end sm:items-center'}`} role="dialog" aria-modal="true" aria-label={title}>
      <button aria-label="Close" className="fade-in absolute inset-0 bg-[#070c0e]/60" onClick={onClose} />
      <div className={`relative w-full ${wide ? 'max-w-2xl' : 'max-w-md'} overflow-y-auto border border-border bg-surface shadow-2xl ${bare
        ? 'pop-open max-h-[88dvh] rounded-3xl p-5 pb-6'
        : 'sheet-up max-h-[90dvh] rounded-t-2xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-2xl'}`}>
        {bare ? (
          <button onClick={onClose} aria-label="Close" className="absolute right-3 top-3 z-10 rounded-full bg-surface p-2 text-muted hover:bg-subtle">
            <X size={20} />
          </button>
        ) : (
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button onClick={onClose} aria-label="Close" className="rounded-full p-2 text-muted hover:bg-subtle">
              <X size={20} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function Button({
  children, onClick, variant = 'secondary', disabled, className = '', type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
}) {
  const styles = {
    primary: 'bg-accent text-accent-fg hover:brightness-110',
    secondary: 'border border-border bg-surface text-fg hover:bg-subtle',
    danger: 'bg-bad text-accent-fg hover:brightness-110',
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`min-h-12 rounded-2xl px-5 font-semibold tracking-[-0.005em] transition active:scale-[0.98] disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}
