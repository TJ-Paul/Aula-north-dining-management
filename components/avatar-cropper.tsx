'use client';

import { ImageOff, Minus, Move, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Sheet } from '@/components/sheet';

const VIEW = 280;   // the round preview, in CSS pixels
const OUT = 512;    // the saved photo, in pixels (square)
/** A mess month banner: 16:9, like the pictures made for it and the month card. */
const BANNER = { w: 320, h: 180, outW: 1280, outH: 720 };

/**
 * Any size of photo is fine: the cropper saves a small 512 × 512 copy (usually under 150 KB),
 * so a 4 MB phone photo needs no resizing elsewhere first. Only non-pictures are turned away.
 */
export function photoProblem(file: File): 'NOT_IMAGE' | 'TOO_BIG' | null {
  return file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name) ? null : 'NOT_IMAGE';
}

export function PhotoTooBig({ kind, onClose }: { kind: 'NOT_IMAGE' | 'TOO_BIG'; onClose: () => void }) {
  return (
    <Sheet title={kind === 'TOO_BIG' ? 'File size too big' : 'Not a picture'} onClose={onClose}>
      <div className="grid gap-4">
        <div className="flex items-start gap-3 rounded-xl bg-warn-soft p-3 text-sm text-warn">
          <ImageOff size={20} className="mt-0.5 shrink-0" />
          {kind === 'TOO_BIG'
            ? <p>Photos must be under 750 KB. Reduce the file size, or take a screenshot of your profile picture and upload the screenshot; it lowers the photo’s size.</p>
            : <p>This file can’t be opened as a photo. Choose a JPEG or PNG, or take a screenshot of the photo and upload that.</p>}
        </div>
        <Button variant="primary" onClick={onClose}>OK</Button>
      </div>
    </Sheet>
  );
}

/**
 * Drag the photo and zoom so the face sits inside the circle, then save.
 * Saves a 512 × 512 JPEG of exactly what the circle shows. `banner`: a 16:9 frame instead,
 * saved as 1280 × 720 (a mess month's banner).
 */
export function AvatarCropper({ file, busy, onCancel, onSave, banner }: {
  file: File; busy: boolean; onCancel: () => void; onSave: (cropped: File) => void; banner?: boolean;
}) {
  const VW = banner ? BANNER.w : VIEW, VH = banner ? BANNER.h : VIEW;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    let live = true;   // ignore a load that was cancelled (React may start this twice)
    const i = new Image();
    i.onload = () => {
      if (!live) return;
      setImg(i);
      const s = Math.max(VW / i.naturalWidth, VH / i.naturalHeight);
      const w = i.naturalWidth * s, h = i.naturalHeight * s;
      // Start centred, a little towards the top, where heads usually are.
      setPos({ x: (VW - w) / 2, y: (VH - h) * (banner ? 0.5 : 0.2) });
    };
    i.onerror = () => { if (live) setFailed(true); };   // e.g. an iPhone HEIC photo in a browser that can't read it
    i.src = url;
    return () => { live = false; URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const base = img ? Math.max(VW / img.naturalWidth, VH / img.naturalHeight) : 1;
  const w = img ? img.naturalWidth * base * zoom : VW;
  const h = img ? img.naturalHeight * base * zoom : VH;
  const clamp = (p: { x: number; y: number }, ww = w, hh = h) => ({
    x: Math.min(0, Math.max(VW - ww, p.x)), y: Math.min(0, Math.max(VH - hh, p.y)),
  });

  // Zoom around the middle of the circle.
  const setZoomAround = (z: number) => {
    const nz = Math.min(4, Math.max(1, z));
    if (!img) return setZoom(nz);
    const nw = img.naturalWidth * base * nz, nh = img.naturalHeight * base * nz;
    const cx = (VW / 2 - pos.x) / w, cy = (VH / 2 - pos.y) / h;
    setPos(clamp({ x: VW / 2 - cx * nw, y: VH / 2 - cy * nh }, nw, nh));
    setZoom(nz);
  };

  const save = async () => {
    if (!img) return;
    const k = (banner ? BANNER.outW : OUT) / VW;
    const canvas = document.createElement('canvas');
    canvas.width = banner ? BANNER.outW : OUT;
    canvas.height = banner ? BANNER.outH : OUT;
    canvas.getContext('2d')!.drawImage(img, pos.x * k, pos.y * k, w * k, h * k);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (blob) onSave(new File([blob], banner ? 'banner.jpg' : 'avatar.jpg', { type: 'image/jpeg' }));
  };

  if (failed) return <PhotoTooBig kind="NOT_IMAGE" onClose={onCancel} />;

  return (
    <Sheet title={banner ? 'Position the banner' : 'Position your photo'} onClose={onCancel}>
      <div className="grid justify-items-center gap-4">
        <div
          className={`relative touch-none select-none overflow-hidden bg-subtle ring-4 ring-accent/40 ${banner ? 'rounded-2xl' : 'rounded-full'}`}
          style={{ width: VW, height: VH, cursor: drag.current ? 'grabbing' : 'grab' }}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) setPos(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }));
          }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
          onWheel={(e) => setZoomAround(zoom - e.deltaY / 500)}
        >
          {img && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={img.src} alt="" draggable={false} className="pointer-events-none absolute max-w-none"
              style={{ left: pos.x, top: pos.y, width: w, height: h }} />
          )}
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted"><Move size={13} /> Drag to move · {banner ? 'zoom to frame it' : 'zoom to fit your face'}</p>
        <div className="flex w-full items-center gap-3" style={{ maxWidth: VW }}>
          <button type="button" onClick={() => setZoomAround(zoom - 0.25)} aria-label="Zoom out" className="rounded-full p-1.5 text-muted hover:bg-subtle"><Minus size={16} /></button>
          <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoomAround(Number(e.target.value))}
            aria-label="Zoom" className="flex-1 accent-[var(--accent)]" />
          <button type="button" onClick={() => setZoomAround(zoom + 0.25)} aria-label="Zoom in" className="rounded-full p-1.5 text-muted hover:bg-subtle"><Plus size={16} /></button>
        </div>
        <div className="grid w-full grid-cols-2 gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!img || busy} onClick={save}>{busy ? 'Saving…' : banner ? 'Save banner' : 'Save photo'}</Button>
        </div>
      </div>
    </Sheet>
  );
}
