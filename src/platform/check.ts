import type { Capabilities } from './apps.js';

/** The capability names `claude.use()` can resolve on Lager (`artifact` and `self` are aliases). */
export const SUPPORTED_CAPABILITIES: readonly string[] = ['db', 'user', 'permissions', 'assets', 'room', 'artifact', 'self', 'downloads'];

export interface ArtifactCheck { used: string[]; unsupported: string[]; undeclared: string[]; warnings: string[] }

const STORAGE_CHECKS: { api: string; re: RegExp }[] = [
  { api: 'localStorage', re: /\blocalStorage\b/ },
  { api: 'sessionStorage', re: /\bsessionStorage\b/ },
  { api: 'indexedDB', re: /\bindexedDB\b/ },
];
const USE_RE = /\bclaude\s*\.\s*use\s*\(\s*(["'])([^"'\\\r\n]*)\1/g;
const COMPLETE_RE = /\bclaude\s*\.\s*complete\s*\(/;
const ALIASES = ['artifact', 'self'];

/** One German warning per browser-storage API the artifact uses. */
export function storageWarnings(html: string): string[] {
  return STORAGE_CHECKS.filter((c) => c.re.test(html)).map(
    (c) =>
      `Das Artefakt verwendet ${c.api}. Der Browser-Speicher geht beim Wechsel des Geräts oder der Instanz verloren – nutze stattdessen claude.use("db").`,
  );
}

/**
 * Which runtime capabilities the source asks for (string-literal `claude.use("…")` calls), which of them Lager cannot
 * provide, and which supported ones the declaration `capabilities` leaves out (`permissions` needs no declaration).
 */
export function checkArtifact(html: string, capabilities: Capabilities = {}): ArtifactCheck {
  const used = [...new Set([...html.matchAll(USE_RE)].map((m) => m[2]))].sort();
  const unsupported = used.filter((n) => !SUPPORTED_CAPABILITIES.includes(n));
  const declared = (n: string): boolean => (ALIASES.includes(n) ? ALIASES : [n]).some((k) => Object.prototype.hasOwnProperty.call(capabilities, k));
  const undeclared = used.filter((n) => SUPPORTED_CAPABILITIES.includes(n) && n !== 'permissions' && !declared(n));
  const warnings = [
    ...storageWarnings(html),
    ...unsupported.map((n) => `„${n}“ wird von Lager nicht nachgebildet; claude.use("${n}") liefert null.`),
    ...undeclared.map((n) => `„${n}“ wird benutzt, ist aber nicht in capabilities deklariert.`),
    ...(COMPLETE_RE.test(html) ? ['claude.complete wird von Lager nicht bereitgestellt; der Aufruf lehnt mit einer Fehlermeldung ab.'] : []),
  ];
  return { used, unsupported, undeclared, warnings };
}
