import fs from 'node:fs';
import type { ICON_SIZES } from './icons.js';

// dist/assets after a build, ../../assets next to src when running from source.
const DIR = [new URL('../assets/', import.meta.url), new URL('../../assets/', import.meta.url)].find((u) => fs.existsSync(new URL('app-fallback-512.png', u)))
  ?? new URL('../assets/', import.meta.url);

/**
 * The generated-looking icon that public routes serve for an app whose own icon has not been drawn yet. Public requests never
 * queue rendering (they need no sign-in, so anyone could fill the queue); drawing happens only in authenticated actions and the
 * background backfill.
 */
export function fallbackIconPath(size: (typeof ICON_SIZES)[number]): string {
  return decodeURIComponent(new URL(`app-fallback-${size}.png`, DIR).pathname);
}
