'use client';

import { VIEW_ONLY_MESSAGE, viewOnly } from '@/lib/rpc';

/** Photos and posters are kept under this size (the storage bucket refuses anything bigger). */
export const MAX_IMAGE_BYTES = 750 * 1024;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Shrinks a picture in the browser until it fits under 750 KB, so admins and students
 * can pick any phone photo without resizing it themselves.
 */
export async function shrinkImage(file: File, maxSide = 1600): Promise<File> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a picture (JPEG, PNG or WebP).');
  if (TYPES[file.type] && file.size <= MAX_IMAGE_BYTES) return file;
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('This picture can’t be opened. Try a JPEG or PNG.'); });
  let side = Math.min(maxSide, Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 8; attempt++) {
    const scale = side / Math.max(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.75, 0.65]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (blob && blob.size <= MAX_IMAGE_BYTES) return new File([blob], 'image.jpg', { type: 'image/jpeg' });
    }
    side = Math.round(side * 0.75);
  }
  throw new Error('This picture is too large even after shrinking it.');
}

/**
 * Stores a picture and returns its URL. In the demo it stays in this browser (Cache Storage) under
 * /api/files/<name>, which the service worker (public/sw.js) answers; the live app uses Supabase Storage.
 */
export async function uploadImage(original: File, _userId: string, opts: { ownPhoto?: boolean } = {}): Promise<string> {
  // A view-only account may change its own profile photo, nothing else (e.g. meal posters).
  if (viewOnly() && !opts.ownPhoto) throw new Error(VIEW_ONLY_MESSAGE);
  const file = await shrinkImage(original);
  const url = `/api/files/${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}.${TYPES[file.type]}`;
  const cache = await caches.open('aula-demo-files');
  await cache.put(new Request(new URL(url, location.origin)), new Response(file, { headers: { 'content-type': file.type } }));
  return url;
}
