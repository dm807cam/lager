const TAG = '<script src="/__lager/runtime.js"></script>';

/** Inserts the runtime script tag exactly once: after <head>, else after <html>, else after the doctype, else at the start. */
export function injectRuntime(html: string): string {
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) {
      const end = m.index + m[0].length;
      return html.slice(0, end) + TAG + html.slice(end);
    }
  }
  return TAG + html;
}
