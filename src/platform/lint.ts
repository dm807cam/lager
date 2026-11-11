import { storageWarnings } from './check.js';

/** Returns one German warning per browser-storage API the artifact uses. */
export function lintArtifact(html: string): string[] {
  return storageWarnings(html);
}
