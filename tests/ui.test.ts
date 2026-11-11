import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { consentHtml, cookies, formsOf, idNames, pageVisits, showcase, visit, type Showcase } from './support/pages.js';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/forms.json');

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

describe('behaviour of the forms', () => {
  // The fixture was generated from the pages before the redesign; the markup may change, what the forms send may not.
  it('forms post the same fields to the same routes as before', async () => {
    s = await showcase();
    const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
    const names = idNames(s);
    const cookieOf = cookies(s);
    const actual: Record<string, unknown> = {};
    for (const v of pageVisits(s)) {
      const res = await visit(s, v, cookieOf);
      expect(res.status, v.name).toBe(v.status ?? 200);
      actual[v.name] = formsOf(res.text, names);
    }
    actual.consent = formsOf(await consentHtml(s), names);
    expect(actual).toEqual(expected);
  });
});
