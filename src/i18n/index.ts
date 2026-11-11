import { de } from './de.js';
import { en } from './en.js';
import { es } from './es.js';
import { fr } from './fr.js';

export const LOCALES = ['en', 'de', 'fr', 'es'] as const;
export type Locale = (typeof LOCALES)[number];
/** Each language written in itself, as shown in language pickers. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español' };

/** `en.ts` is the single source of keys; every other catalog must provide exactly these. */
export type MessageKey = keyof typeof en;

const CATALOGS: Record<Locale, Readonly<Record<string, string>>> = { en, de, fr, es };

export function isMessageKey(value: unknown): value is MessageKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(en, value);
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * The text for `key` in `locale`, with `{name}` placeholders filled from `params`. A key missing from a catalog falls back
 * to English; a placeholder without a parameter renders as nothing. The result is plain text: escape it when it goes into HTML.
 */
export function t(locale: Locale, key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = CATALOGS[locale]?.[key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : ''));
}

const MAX_ACCEPT_LANGUAGE = 1000;

/**
 * The best supported language of an `Accept-Language` header (RFC 9110 q-values, primary subtags: `fr-CA` is `fr`), or `fallback`.
 * Entries with `q=0` and the wildcard never select anything.
 */
export function negotiateLocale(acceptLanguage: string | undefined, fallback: Locale): Locale {
  if (!acceptLanguage) return fallback;
  const ranked: Array<{ locale: Locale; q: number; order: number }> = [];
  acceptLanguage.slice(0, MAX_ACCEPT_LANGUAGE).split(',').forEach((entry, order) => {
    const [tag, ...params] = entry.trim().split(';');
    const primary = tag.trim().toLowerCase().split('-')[0];
    if (!isLocale(primary)) return;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*(\d(?:\.\d{0,3})?)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    }
    if (q > 0 && q <= 1) ranked.push({ locale: primary, q, order });
  });
  ranked.sort((a, b) => b.q - a.q || a.order - b.order);
  return ranked[0]?.locale ?? fallback;
}

const formatters = new Map<Locale, Intl.DateTimeFormat>();

/** Date and time to the minute in UTC, written the way `locale` writes it. */
export function formatDate(locale: Locale, iso: string): string {
  let f = formatters.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(locale, f);
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : f.format(date);
}

const sizeFormatters = new Map<Locale, Intl.NumberFormat>();

/** Size labels per language: French writes the binary prefixes as Kio, Mio and Gio and bytes as "o". */
const SIZE_UNITS: Partial<Record<Locale, readonly [string, string, string, string]>> = { fr: ['o', 'Kio', 'Mio', 'Gio'] };
const DEFAULT_SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const;

/** A byte count as bytes, KiB, MiB or GiB (Kio, Mio, Gio in French), with the decimal separator of `locale`. */
export function formatSize(locale: Locale, bytes: number): string {
  const units = SIZE_UNITS[locale] ?? DEFAULT_SIZE_UNITS;
  if (bytes < 1024) return `${bytes} ${units[0]}`;
  let f = sizeFormatters.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    sizeFormatters.set(locale, f);
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${f.format(value)} ${units[unit]}`;
}
