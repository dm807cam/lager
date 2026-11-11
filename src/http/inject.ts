const TAG = '<script src="/__lager/runtime.js"></script>';
const DEFAULT_THEME_COLOR = '#1f2a5c';
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

/** What the page head needs to know about its app to be installable. */
export interface PageMeta { title: string; themeColor: string; iconVersion: number }

const attr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Only the start of a document is looked at: the head is there, and a crafted body cannot make the scans slow. */
const SCAN_LIMIT = 64 * 1024;
/** Tags the page may already carry; `[^<>]*` cannot run past the next tag, so the scan is linear. */
const TAG_RE = /<(link|meta)\b[^<>]*>/gi;
const attrValue = (tag: string, name: string): string | null => {
  const m = new RegExp(`[\\s/"']${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};

interface Existing { manifest: boolean; touchIcon: boolean; themeColor: boolean; viewport: boolean }

function existingTags(head: string): Existing {
  const found: Existing = { manifest: false, touchIcon: false, themeColor: false, viewport: false };
  for (const m of head.matchAll(TAG_RE)) {
    const tag = m[0];
    if (m[1].toLowerCase() === 'link') {
      const rel = (attrValue(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('manifest')) found.manifest = true;
      if (rel.includes('apple-touch-icon')) found.touchIcon = true;
    } else {
      const name = (attrValue(tag, 'name') ?? '').trim().toLowerCase();
      if (name === 'viewport') found.viewport = true;
      if (name === 'theme-color') found.themeColor = true;
    }
  }
  return found;
}

function installTags(head: string, meta: PageMeta): string {
  const color = /^#[0-9a-f]{6}$/i.test(meta.themeColor) ? meta.themeColor.toLowerCase() : DEFAULT_THEME_COLOR;
  const v = Number.isSafeInteger(meta.iconVersion) && meta.iconVersion > 0 ? meta.iconVersion : 0;
  const has = existingTags(head);
  let tags = '';
  // A page with its own manifest manages its install tags itself; otherwise each tag is added only if the page lacks it.
  if (!has.manifest) {
    tags += '<link rel="manifest" href="/__lager/manifest.webmanifest">';
    if (!has.touchIcon) tags += `<link rel="apple-touch-icon" href="/__lager/icon-180.png?v=${v}">`;
    tags += `<link rel="icon" type="image/png" href="/__lager/icon-192.png?v=${v}">`;
    if (!has.themeColor) tags += `<meta name="theme-color" content="${attr(color)}">`;
    tags += '<meta name="apple-mobile-web-app-capable" content="yes">'
      + '<meta name="mobile-web-app-capable" content="yes">'
      + `<meta name="apple-mobile-web-app-title" content="${attr(meta.title)}">`;
  }
  if (!has.viewport) tags += VIEWPORT;
  return tags;
}

/**
 * Inserts the runtime script tag exactly once: after <head>, else after <html>, else after the doctype, else at the start.
 * With `meta` the tags that make the page installable follow it (manifest, icons, theme colour, and a viewport when the page has none).
 */
export function injectRuntime(html: string, meta?: PageMeta): string {
  const head = html.length > SCAN_LIMIT ? html.slice(0, SCAN_LIMIT) : html;
  const tag = TAG + (meta ? installTags(head, meta) : '');
  for (const re of [/<head(\s[^<>]*)?>/i, /<html(\s[^<>]*)?>/i, /<!doctype[^<>]*>/i]) {
    const m = re.exec(head);
    if (m) {
      const end = m.index + m[0].length;
      return html.slice(0, end) + tag + html.slice(end);
    }
  }
  return tag + html;
}
