import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { DemoBoot } from '@/components/demo-boot';
import { BASE } from '@/lib/base';

// Both fonts are bundled with the app at build time (no request to Google from the phone) and cached for good.
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-bricolage', display: 'swap' });
const body = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-jakarta', display: 'swap' });

export const metadata: Metadata = {
  title: 'Aula Dining · demo',
  description: 'A working demo of a smart mess dining app: meals, seat booking in batches, coupons, attendance and notices. Runs entirely in the browser with made-up data.',
  icons: { icon: `${BASE}/icons/icon-192.png`, apple: `${BASE}/icons/apple-touch-icon.png` },
  appleWebApp: { capable: true, title: 'Aula Dining', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // The on-screen keyboard shrinks the page instead of covering it (no jumpy zoom while typing).
  interactiveWidget: 'resizes-content',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f6f8' },
    { media: '(prefers-color-scheme: dark)', color: '#070c0e' },
  ],
};

// After a new version is published, a browser may still hold an old copy of a page whose stylesheet
// is gone: then the page loads once more, past the cache.
const FRESH_SCRIPT = `addEventListener('load',function(){try{var bad=[].some.call(document.querySelectorAll('link[rel=stylesheet]'),function(l){return !l.sheet});if(!bad){sessionStorage.removeItem('aula-fresh');return}if(sessionStorage.getItem('aula-fresh'))return;sessionStorage.setItem('aula-fresh','1');var u=new URL(location.href);u.searchParams.set('v',Date.now());location.replace(u)}catch(e){}});`;

const THEME_SCRIPT = `try{var t=localStorage.getItem('aula-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;var z=parseFloat(localStorage.getItem('aula-scale'));if(z>=0.6&&z<=1.4)document.documentElement.style.setProperty('--ui-scale',z)}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${display.variable} ${body.variable}`}>
      <head>
        {/* Apply the theme picked with the switch before the page paints, so it never flashes. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: FRESH_SCRIPT }} />
      </head>
      <body className="antialiased"><DemoBoot>{children}</DemoBoot></body>
    </html>
  );
}
