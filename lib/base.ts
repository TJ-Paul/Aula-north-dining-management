// The folder the site lives in on GitHub Pages (e.g. "/aula-dining-demo"), "" when at the root.
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** An app path ("/me") as a real URL path on this site (for location.href, plain <a>, icons). */
export const withBase = (path: string) => (path.startsWith('/') && !path.startsWith('//') ? `${BASE}${path}` : path);
