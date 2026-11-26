import type { MetadataRoute } from 'next';
import { BASE } from '@/lib/base';

export const dynamic = 'force-static';

/** Lets phones install Aula Dining like an app (home-screen icon, opens full screen). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Aula Dining (demo)',
    short_name: 'Aula Dining (demo)',
    description: 'Mess meals, bookings and attendance for Aula North hall',
    start_url: `${BASE}/`,
    scope: `${BASE}/`,
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#070c0e',
    theme_color: '#070c0e',
    icons: [
      { src: `${BASE}/icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${BASE}/icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `${BASE}/icons/maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
