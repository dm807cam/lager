const TAG = '<script src="/__lager/runtime.js"></script>';
const DEFAULT_THEME_COLOR = '#1f2a5c';
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

/** What the page head needs to know about its app to be installable. */
export interface PageMeta { title: string; themeColor: string; iconVersion: number }

const attr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A link tag whose `rel` list names `manifest`, in any case, quoting or attribute order. */
const OWN_MANIFEST = /<link\b[^>]*?\brel\s*=\s*(?:"[^"]*\bmanifest\b[^"]*"|'[^']*\bmanifest\b[^']*'|manifest(?=[\s>/]))/i;
const OWN_VIEWPORT = /<meta\b[^>]*?\bname\s*=\s*["']?viewport\b/i;

function installTags(html: string, meta: PageMeta): string {
  const color = /^#[0-9a-f]{6}$/i.test(meta.themeColor) ? meta.themeColor.toLowerCase() : DEFAULT_THEME_COLOR;
  const v = Number.isSafeInteger(meta.iconVersion) && meta.iconVersion > 0 ? meta.iconVersion : 0;
  let tags = '';
  if (!OWN_MANIFEST.test(html)) {
    tags += '<link rel="manifest" href="/__lager/manifest.webmanifest">'
      + `<link rel="apple-touch-icon" href="/__lager/icon-180.png?v=${v}">`
      + `<link rel="icon" type="image/png" href="/__lager/icon-192.png?v=${v}">`
      + `<meta name="theme-color" content="${attr(color)}">`
      + '<meta name="apple-mobile-web-app-capable" content="yes">'
      + '<meta name="mobile-web-app-capable" content="yes">'
      + `<meta name="apple-mobile-web-app-title" content="${attr(meta.title)}">`;
  }
  if (!OWN_VIEWPORT.test(html)) tags += VIEWPORT;
  return tags;
}

/**
 * Inserts the runtime script tag exactly once: after <head>, else after <html>, else after the doctype, else at the start.
 * With `meta` the tags that make the page installable follow it (manifest, icons, theme colour, and a viewport when the page has none).
 */
export function injectRuntime(html: string, meta?: PageMeta): string {
  const tag = TAG + (meta ? installTags(html, meta) : '');
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) {
      const end = m.index + m[0].length;
      return html.slice(0, end) + tag + html.slice(end);
    }
  }
  return tag + html;
}
