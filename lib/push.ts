'use client';

import { rpc } from '@/lib/rpc';
import { BASE } from '@/lib/base';

// The demo has no push server, so phone notifications are off (in-app notifications still work).
const PUBLIC_KEY = '';

export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!PUBLIC_KEY;

/** Registers the service worker once (also what makes the app installable). */
export async function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` }); } catch { return null; }
}

function keyBytes(base64: string) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Asks permission (if needed) and registers this phone for notifications. Returns the permission. */
export async function enablePush(): Promise<NotificationPermission | 'unsupported'> {
  if (!pushSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  const sub = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(PUBLIC_KEY) }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await rpc('save_push_subscription', { p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth });
  return 'granted';
}

/** Re-saves this phone's subscription for whoever is signed in now (e.g. after signing in). */
export async function refreshPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.getRegistration(`${BASE}/`);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) { await enablePush(); return; }
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await rpc('save_push_subscription', { p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth }).catch(() => undefined);
}

export async function disablePush() {
  const reg = await navigator.serviceWorker?.getRegistration(`${BASE}/`);
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await rpc('remove_push_subscription', { p_endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe();
  }
}
