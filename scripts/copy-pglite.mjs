// Copies PGlite (Postgres compiled to WebAssembly) into public/pglite, so the browser loads it as
// plain files next to the site instead of through the bundler.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const from = join('node_modules', '@electric-sql', 'pglite', 'dist');
const to = join('public', 'pglite');
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
for (const f of readdirSync(from)) {
  if (/\.(js|wasm|data)$/.test(f)) copyFileSync(join(from, f), join(to, f));
}
console.log('PGlite copied to public/pglite');
