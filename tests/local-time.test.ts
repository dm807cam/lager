import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { dateText } from '../src/http/pages.js';
import { formatDate, LOCALES } from '../src/i18n/index.js';
import { showcase, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
const ZONE = process.env.TZ;
afterEach(() => {
  s?.h.core.close(); s = undefined;
  // Node reads TZ again when it is set, for Intl as well.
  if (ZONE === undefined) delete process.env.TZ; else process.env.TZ = ZONE;
});

const ISO = '2026-11-25T10:51:00.000Z';

describe('dates', () => {
  it('without the script they say they are UTC, in every language', () => {
    for (const locale of LOCALES) {
      expect(formatDate(locale, ISO, true), locale).toMatch(/UTC/);
      expect(formatDate(locale, ISO), locale).not.toMatch(/UTC/);
    }
    // The exact text, so that a change in how ICU names the zone shows up here.
    expect(LOCALES.map((l) => formatDate(l, ISO, true))).toEqual(['Nov 25, 2026, 10:51 UTC', '25. Nov. 2026, 10:51 UTC', '25 nov. 2026, 10:51 UTC', '25 nov 2026, 10:51 UTC']);
    expect(dateText('en', ISO)).toBe(`<time datetime="${ISO}" data-local="datetime">Nov 25, 2026, 10:51 UTC</time>`);
  });

  it('the pages mark them for the script', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    for (const path of ['/publish', '/instances/notes', '/admin/invites', '/admin/users']) {
      const doc = new JSDOM((await request(s.h.app).get(path).set('Host', s.h.host).set('Cookie', cookie)).text).window.document;
      const times = [...doc.querySelectorAll('main time[datetime][data-local]')];
      expect(times.length, path).toBeGreaterThan(0);
      for (const el of times) expect(Number.isNaN(Date.parse(el.getAttribute('datetime')!)), path).toBe(false);
    }
  });

  it('the script writes them in the viewer’s own time zone and the page’s language', () => {
    const html = `<!doctype html><html lang="de"><body>
      <time id="a" datetime="${ISO}" data-local="datetime">Nov 25, 2026, 10:51 UTC</time>
      <time id="b" datetime="${ISO}" data-local="day" title="x UTC">25. Nov. 2026</time>
      <time id="c" datetime="not a date" data-local="datetime">kept</time></body></html>`;
    const win = new JSDOM(html, { runScripts: 'outside-only' }).window;
    win.eval(fs.readFileSync(new URL('../src/static/app.js', import.meta.url), 'utf8'));
    const doc = win.document;
    // The same formatter in this process's zone: whatever zone the browser has, that is the one used.
    const local = new Intl.DateTimeFormat('de', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ISO));
    expect(doc.getElementById('a')!.textContent).toBe(local);
    expect(doc.getElementById('a')!.textContent).not.toMatch(/UTC/);
    expect(doc.getElementById('b')!.textContent).toBe(new Intl.DateTimeFormat('de', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(ISO)));
    expect(doc.getElementById('b')!.getAttribute('title')).toBe(local);
    expect(doc.getElementById('c')!.textContent).toBe('kept');
  });

  it('in a zone other than UTC the script shows that zone’s time, and the day changes across midnight', () => {
    process.env.TZ = 'America/Los_Angeles';
    const win = new JSDOM(`<!doctype html><html lang="de"><body>
      <time id="a" datetime="${ISO}" data-local="datetime">x</time>
      <time id="b" datetime="2026-11-25T03:00:00.000Z" data-local="day">x</time></body></html>`, { runScripts: 'outside-only' }).window;
    win.eval(fs.readFileSync(new URL('../src/static/app.js', import.meta.url), 'utf8'));
    expect(win.document.getElementById('a')!.textContent).toBe('25. Nov. 2026, 02:51');
    // 03:00 UTC on the 25th is still the 24th in Los Angeles.
    expect(win.document.getElementById('b')!.textContent).toBe('24. Nov. 2026');
  });
});
