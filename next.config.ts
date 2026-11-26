import type { NextConfig } from 'next';

// A fully static site (GitHub Pages). NEXT_PUBLIC_BASE_PATH is the repository's folder on
// <user>.github.io, e.g. "/aula-dining-demo"; the GitHub workflow sets it by itself.
const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const config: NextConfig = {
  output: 'export',
  basePath: base || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
};

export default config;
