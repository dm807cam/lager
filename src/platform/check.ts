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

/** One English warning per browser-storage API the artifact uses. */
export function storageWarnings(html: string): string[] {
  return STORAGE_CHECKS.filter((c) => c.re.test(html)).map(
    (c) =>
      `The artifact uses ${c.api}. Browser storage is lost when the device or the instance changes - use claude.use("db") instead.`,
  );
}

/**
 * Which runtime capabilities the source asks for (string-literal `claude.use("…")` calls), which of them Lager cannot
 * provide, and which supported ones the declaration `capabilities` leaves out (`permissions` needs no declaration).
 */
export function checkArtifact(html: string, capabilities: Capabilities = {}): ArtifactCheck {
  const used = [...new Set([...html.matchAll(USE_RE)].map((m) => m[2]))].sort();
  const unsupported = used.filter((n) => !SUPPORTED_CAPABILITIES.includes(n));
  const declared = (n: string): boolean => (ALIASES.includes(n) ? ALIASES : [n]).some((k) => {
    const v = Object.prototype.hasOwnProperty.call(capabilities, k) ? (capabilities as Record<string, unknown>)[k] : undefined;
    return v !== null && typeof v === 'object';
  });
  const callsComplete = COMPLETE_RE.test(html);
  // `claude.complete` is not reached through `use()`, but it needs its own declaration all the same.
  const undeclared = [...used.filter((n) => SUPPORTED_CAPABILITIES.includes(n) && n !== 'permissions' && !declared(n)),
    ...(callsComplete && !declared('complete') ? ['complete'] : [])];
  const warnings = [
    ...storageWarnings(html),
    ...unsupported.map((n) => `"${n}" is not provided by Lager; claude.use("${n}") returns null.`),
    ...undeclared.map((n) => n === 'complete' ? 'claude.complete is used but "complete" is not declared in capabilities; the call rejects.' : `"${n}" is used but not declared in capabilities.`),
    ...(callsComplete ? ['claude.complete calls the language model the server administrator set up; it rejects when none is set up, for guests and for viewers who may only view.'] : []),
  ];
  return { used, unsupported, undeclared, warnings };
}
