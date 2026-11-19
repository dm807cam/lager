import type { Capabilities } from './apps.js';

/** The capability names `lager.use()` can resolve. */
export const SUPPORTED_CAPABILITIES: readonly string[] = ['db', 'user', 'permissions', 'assets', 'room', 'page', 'downloads'];

export interface AppCheck { used: string[]; unsupported: string[]; undeclared: string[]; warnings: string[] }

const STORAGE_CHECKS: { api: string; re: RegExp }[] = [
  { api: 'localStorage', re: /\blocalStorage\b/ },
  { api: 'sessionStorage', re: /\bsessionStorage\b/ },
  { api: 'indexedDB', re: /\bindexedDB\b/ },
];
const USE_RE = /\blager\s*\.\s*use\s*\(\s*(["'])([^"'\\\r\n]*)\1/g;
const COMPLETE_RE = /\blager\s*\.\s*complete\s*\(/;

/**
 * APIs of other app hosts that do nothing on Lager. Apps written for claude.ai use these; they need converting
 * (`window.claude.*` to `window.lager.*`, `window.storage` to `lager.use("db")`) before they work here.
 */
const FOREIGN_CHECKS: { api: string; re: RegExp; fix: string }[] = [
  { api: 'window.claude', re: /\bclaude\s*\.\s*(use|complete)\s*\(/, fix: 'use window.lager with the same calls (lager.use, lager.complete)' },
  { api: 'window.storage', re: /\bwindow\s*\.\s*storage\b|(^|[^.\w$])storage\s*\.\s*(get|set|delete|list)\s*\(/m, fix: 'keep the data in lager.use("db") instead' },
];

/** One English warning per browser-storage API, and per API of another app host, that the HTML uses. */
function storageWarnings(html: string): string[] {
  return [
    ...STORAGE_CHECKS.filter((c) => c.re.test(html)).map(
      (c) => `The app uses ${c.api}. Browser storage is lost when the device or the instance changes - use lager.use("db") instead.`),
    ...FOREIGN_CHECKS.filter((c) => c.re.test(html)).map(
      (c) => `The app uses ${c.api}, which does not exist on Lager - ${c.fix}.`),
  ];
}

/**
 * Which runtime capabilities the source asks for (string-literal `lager.use("…")` calls), which of them Lager cannot
 * provide, and which supported ones the declaration `capabilities` leaves out (`permissions` needs no declaration).
 */
export function checkApp(html: string, capabilities: Capabilities = {}): AppCheck {
  const used = [...new Set([...html.matchAll(USE_RE)].map((m) => m[2]))].sort();
  const unsupported = used.filter((n) => !SUPPORTED_CAPABILITIES.includes(n));
  const declared = (n: string): boolean => {
    const v = Object.prototype.hasOwnProperty.call(capabilities, n) ? (capabilities as Record<string, unknown>)[n] : undefined;
    return v !== null && typeof v === 'object';
  };
  const callsComplete = COMPLETE_RE.test(html);
  // `lager.complete` is not reached through `use()`, but it needs its own declaration all the same.
  const undeclared = [...used.filter((n) => SUPPORTED_CAPABILITIES.includes(n) && n !== 'permissions' && !declared(n)),
    ...(callsComplete && !declared('complete') ? ['complete'] : [])];
  const warnings = [
    ...storageWarnings(html),
    ...unsupported.map((n) => `"${n}" is not provided by Lager; lager.use("${n}") returns null.`),
    ...undeclared.map((n) => n === 'complete' ? 'lager.complete is used but "complete" is not declared in capabilities; the call rejects.' : `"${n}" is used but not declared in capabilities.`),
    ...(callsComplete ? ['lager.complete calls the language model the server administrator set up; it rejects when none is set up, for guests and for viewers who may only view.'] : []),
  ];
  return { used, unsupported, undeclared, warnings };
}
