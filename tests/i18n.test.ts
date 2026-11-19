import { describe, expect, it } from 'vitest';
import { de } from '../src/i18n/de.js';
import { en } from '../src/i18n/en.js';
import { es } from '../src/i18n/es.js';
import { fr } from '../src/i18n/fr.js';
import { formatDate, isLocale, LOCALE_NAMES, LOCALES, negotiateLocale, t, type MessageKey } from '../src/i18n/index.js';

const catalogs = { de, fr, es } as const;
const keys = Object.keys(en) as MessageKey[];
const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

describe('catalogs', () => {
  it('all catalogs have exactly the English keys', () => {
    for (const [name, catalog] of Object.entries(catalogs)) {
      expect(Object.keys(catalog).sort(), name).toEqual([...keys].sort());
    }
  });

  it('placeholders match the English template in every catalog', () => {
    for (const [name, catalog] of Object.entries(catalogs)) {
      for (const key of keys) expect(placeholders(catalog[key]), `${name}:${key}`).toEqual(placeholders(en[key]));
    }
  });

  it('no catalog value is empty or equal to its key', () => {
    for (const [name, catalog] of Object.entries({ en, ...catalogs })) {
      for (const key of keys) {
        const value = (catalog as Record<string, string>)[key];
        expect(value.trim(), `${name}:${key}`).not.toBe('');
        expect(value, `${name}:${key}`).not.toBe(key);
      }
    }
  });

  it('brand copy names Lager and no particular AI in every locale', () => {
    for (const locale of LOCALES) {
      for (const key of ['brand.tagline', 'brand.pitch'] as const) {
        expect(t(locale, key), `${locale}:${key}`).toContain('Lager');
        expect(t(locale, key), `${locale}:${key}`).not.toMatch(/Claude|ChatGPT|Gemini/);
      }
    }
    expect(t('en', 'brand.tagline')).toBe("The only two apps you'll ever need: your AI + Lager.");
    expect(t('en', 'brand.pitch')).toBe('We used to buy apps. Now your AI builds any app you can imagine, on the spot. Lager is where they run — on your server, with your data staying yours.');
  });

  it('translations differ from English for the main strings', () => {
    for (const locale of ['de', 'fr', 'es'] as const) {
      for (const key of ['login.title', 'login.submit', 'brand.tagline', 'mail.verify.subject'] as const) {
        expect(t(locale, key), `${locale}:${key}`).not.toBe(t('en', key));
      }
    }
  });
});

describe('t', () => {
  it('interpolates and falls back', () => {
    const key = 'auth.password.short' as const;
    expect(t('de', key, { min: 10 })).toContain('10');
    expect(t('en', key, { min: 10 })).toContain('10');
    expect(t('fr', key)).not.toContain('{');
    expect(t('fr', key)).not.toContain('undefined');
  });

  it('falls back to English for a key a catalog lacks', () => {
    const original = de['login.title'];
    // Emulate a gap by removing the key temporarily.
    delete (de as Record<string, string>)['login.title'];
    try {
      expect(t('de', 'login.title')).toBe(en['login.title']);
    } finally {
      (de as Record<string, string>)['login.title'] = original;
    }
  });

  it('has the four locales with their own names', () => {
    expect(LOCALES).toEqual(['en', 'de', 'fr', 'es']);
    expect(LOCALE_NAMES).toEqual({ en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español' });
    expect(isLocale('fr')).toBe(true);
    expect(isLocale('ja')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('negotiateLocale', () => {
  it('follows q-values and primary subtags', () => {
    expect(negotiateLocale('fr-CA,fr;q=0.9,en;q=0.8', 'en')).toBe('fr');
    expect(negotiateLocale('es;q=0.1,de;q=0.9', 'en')).toBe('de');
    expect(negotiateLocale('ja', 'es')).toBe('es');
    expect(negotiateLocale(undefined, 'de')).toBe('de');
    expect(negotiateLocale('*', 'fr')).toBe('fr');
    expect(negotiateLocale('', 'fr')).toBe('fr');
    expect(negotiateLocale('de;q=0', 'en')).toBe('en');
    expect(negotiateLocale('ja,DE-ch;q=0.5', 'en')).toBe('de');
    expect(negotiateLocale('x'.repeat(5000), 'en')).toBe('en');
  });
});

describe('formatDate', () => {
  it('differs by locale and is stable', () => {
    const iso = '2026-03-04T15:07:42.000Z';
    const out = LOCALES.map((l) => formatDate(l, iso));
    expect(new Set(out).size).toBe(4);
    expect(formatDate('en', iso)).toBe(formatDate('en', iso));
    for (const o of out) { expect(o).toContain('15'); expect(o).toContain('07'); }
    // Rendered in UTC regardless of the server's zone.
    expect(formatDate('de', '2026-03-04T23:59:00.000Z')).toContain('23');
  });
});
