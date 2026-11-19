import fs from 'node:fs';
import type { Server } from 'node:http';

/**
 * Everything Lager writes belongs to the account it runs as and to nobody else: from here on directories are created with mode
 * 700 and files with 600. Set for the whole process and not per call, so that it also holds for the files SQLite creates on
 * its own (databases, their WAL and SHM files, snapshots) and for every place that writes a file in the future.
 */
export function restrictNewFiles(): void {
  process.umask(0o077);
}

/**
 * A data directory from before `restrictNewFiles`, which other accounts on the machine may still enter, is closed: one chmod of
 * the top directory, which shuts everything below it without walking the tree. Only a directory this account owns is touched.
 * Returns whether the mode changed, so the caller can say so once (a file system without modes keeps what it reports).
 */
export function closeDataDir(dataDir: string): boolean {
  try {
    const before = fs.statSync(dataDir);
    if ((before.mode & 0o077) === 0 || typeof process.getuid !== 'function' || before.uid !== process.getuid()) return false;
    fs.chmodSync(dataDir, 0o700);
    return (fs.statSync(dataDir).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * Reverse proxies keep connections to Lager open and reuse them (nginx for 60 seconds by default, Cloudflare Tunnel and
 * most load balancers similarly). Node closes an idle connection after 5 seconds by default; a proxy that sends the next request
 * at that moment answers with a 502. Lager therefore keeps idle connections longer than the proxies do, and waits for
 * request headers a little longer still, as Node expects.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;

export function applyProxyTimeouts(server: Pick<Server, 'keepAliveTimeout' | 'headersTimeout'>): void {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
}

export interface ShutdownParts {
  /** Stops the background jobs. */
  stopJobs(): void;
  server: Pick<Server, 'close' | 'closeAllConnections'>;
  /** Closes the databases; called once, after the last connection is gone. */
  closeCore(): void;
  exit(code: number): void;
}

/**
 * The handler for SIGTERM and SIGINT. It works once: a second signal (an impatient Ctrl+C, or a supervisor that sends both)
 * arrives while the first shutdown is finishing and must not close the databases a second time.
 */
export function createShutdown(parts: ShutdownParts): () => void {
  let stopping = false;
  return () => {
    if (stopping) return;
    stopping = true;
    parts.stopJobs();
    parts.server.close(() => {
      parts.closeCore();
      parts.exit(0);
    });
    parts.server.closeAllConnections();
  };
}

/** What is printed when Lager cannot start: the one line that says what to change, without a stack trace. */
export function startupError(e: unknown): string {
  return `Lager cannot start: ${e instanceof Error ? e.message : String(e)}`;
}
