const CHECKS: { api: string; re: RegExp }[] = [
  { api: 'localStorage', re: /\blocalStorage\b/ },
  { api: 'sessionStorage', re: /\bsessionStorage\b/ },
  { api: 'indexedDB', re: /\bindexedDB\b/ },
];

/** Returns one German warning per browser-storage API the artifact uses. */
export function lintArtifact(html: string): string[] {
  return CHECKS.filter((c) => c.re.test(html)).map(
    (c) =>
      `Das Artefakt verwendet ${c.api}. Der Browser-Speicher geht beim Wechsel des Geräts oder der Instanz verloren – nutze stattdessen claude.use("db").`,
  );
}
