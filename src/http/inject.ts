const TAG = '<script src="/__lager/runtime.js"></script>';
const DEFAULT_THEME_COLOR = '#1f2a5c';
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

/** What the page head needs to know about its app to be installable. */
export interface PageMeta { title: string; themeColor: string; iconVersion: number }

const attr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The insertion point (`<head>`, else `<html>`, else the doctype) must lie within this many characters of the start. */
const INSERT_LIMIT = 64 * 1024;
/**
 * The app's own manifest, viewport, theme-color, apple-touch-icon and icon links are looked for in its `<head>` element, and
 * only when that element ends (`</head>` or `<body`) within this many characters. A longer head is treated as having none of
 * them, so a crafted document cannot make the scan expensive; the worst case is a duplicate tag.
 */
const HEAD_LIMIT = 256 * 1024;
/** Elements whose content is not markup. */
const RAW_TEXT = ['script', 'style', 'title', 'textarea'];

const attrValue = (tag: string, name: string): string | null => {
  const m = new RegExp(`[\\s/"']${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};

interface Scan { headOpenEnd: number; htmlOpenEnd: number; doctypeEnd: number; tags: string[] }

/** End (exclusive) of the tag that starts at `from`, skipping quoted attribute values; -1 when it never ends. */
function tagEnd(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '>') return i + 1;
    if (c === '"' || c === "'") {
      const close = s.indexOf(c, i + 1);
      if (close < 0) return -1;
      i = close;
    }
  }
  return -1;
}

/**
 * One linear pass over the start of the document that skips comments, CDATA and the content of script, style, title and textarea,
 * so a commented-out `<head>` is never mistaken for the real one. Returns where the real doctype, `<html>` and `<head>` start tags
 * end and the link/meta tags of the head.
 */
function scan(html: string): Scan {
  const text = html.length > HEAD_LIMIT ? html.slice(0, HEAD_LIMIT) : html;
  const lower = text.toLowerCase();
  const out: Scan = { headOpenEnd: -1, htmlOpenEnd: -1, doctypeEnd: -1, tags: [] };
  let inHead = false;
  let headDone = false;
  const pending: string[] = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (text[lt + 1] === '!' || text[lt + 1] === '?') {
      const end = tagEnd(text, lt + 2);
      if (end < 0) break;
      if (out.doctypeEnd < 0 && lower.startsWith('<!doctype', lt)) out.doctypeEnd = end;
      i = end;
      continue;
    }
    const m = /^<(\/?)([a-z][a-z0-9-]*)/.exec(lower.slice(lt, lt + 40));
    if (!m) { i = lt + 1; continue; }
    const end = tagEnd(text, lt + m[0].length);
    if (end < 0) break;
    const name = m[2];
    const closing = m[1] === '/';
    if (!closing) {
      if (name === 'html' && out.htmlOpenEnd < 0) out.htmlOpenEnd = end;
      if (name === 'head' && out.headOpenEnd < 0) { out.headOpenEnd = end; inHead = true; }
      if (name === 'body' && inHead) { inHead = false; headDone = true; }
      if (inHead && (name === 'link' || name === 'meta')) pending.push(text.slice(lt, end));
    } else if (name === 'head' && inHead) {
      inHead = false;
      headDone = true;
    }
    i = end;
    if (!closing && RAW_TEXT.includes(name)) {
      const close = lower.indexOf(`</${name}`, i);
      if (close < 0) break;
      i = close;
    }
  }
  // Tags are trusted only when the head ended within the limit.
  if (headDone) out.tags = pending;
  return out;
}

interface Existing { manifest: boolean; touchIcon: boolean; themeColor: boolean; viewport: boolean; icon: boolean }

function existingTags(tags: string[]): Existing {
  const found: Existing = { manifest: false, touchIcon: false, themeColor: false, viewport: false, icon: false };
  for (const tag of tags) {
    if (/^<link/i.test(tag)) {
      const rel = (attrValue(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('manifest')) found.manifest = true;
      if (rel.includes('apple-touch-icon')) found.touchIcon = true;
      if (rel.includes('icon')) found.icon = true;
    } else {
      const name = (attrValue(tag, 'name') ?? '').trim().toLowerCase();
      if (name === 'viewport') found.viewport = true;
      if (name === 'theme-color') found.themeColor = true;
    }
  }
  return found;
}

function installTags(tags: string[], meta: PageMeta): string {
  const color = /^#[0-9a-f]{6}$/i.test(meta.themeColor) ? meta.themeColor.toLowerCase() : DEFAULT_THEME_COLOR;
  const v = Number.isSafeInteger(meta.iconVersion) && meta.iconVersion > 0 ? meta.iconVersion : 0;
  const has = existingTags(tags);
  let out = '';
  // A page with its own manifest manages its install tags itself; otherwise each tag is added only if the page lacks it.
  if (!has.manifest) {
    out += '<link rel="manifest" href="/__lager/manifest.webmanifest">';
    if (!has.touchIcon) out += `<link rel="apple-touch-icon" href="/__lager/icon-180.png?v=${v}">`;
    if (!has.icon) out += `<link rel="icon" type="image/png" href="/__lager/icon-192.png?v=${v}">`;
    if (!has.themeColor) out += `<meta name="theme-color" content="${attr(color)}">`;
    out += '<meta name="apple-mobile-web-app-capable" content="yes">'
      + '<meta name="mobile-web-app-capable" content="yes">'
      + `<meta name="apple-mobile-web-app-title" content="${attr(meta.title)}">`;
  }
  if (!has.viewport) out += VIEWPORT;
  return out;
}

/**
 * Inserts the runtime script tag exactly once: after the real `<head>` start tag, else after `<html>`, else after the doctype
 * (each only if within the first 64 KiB), else at the start.
 * With `meta` the tags that make the page installable follow it (manifest, icons, theme colour, and a viewport when the page has none).
 */
export function injectRuntime(html: string, meta?: PageMeta): string {
  const found = scan(html);
  const tag = TAG + (meta ? installTags(found.tags, meta) : '');
  for (const end of [found.headOpenEnd, found.htmlOpenEnd, found.doctypeEnd]) {
    if (end >= 0 && end <= INSERT_LIMIT) return html.slice(0, end) + tag + html.slice(end);
  }
  return tag + html;
}
