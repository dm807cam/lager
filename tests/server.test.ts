import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { applyProxyTimeouts, createShutdown, HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, startupError } from '../src/lifecycle.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => { for (const c of children.splice(0)) c.kill('SIGKILL'); });
afterAll(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-server-'));
  dirs.push(dir);
  return dir;
}

/**
 * What Lager itself wrote to standard error. Node's own warnings (`(node:123) ExperimentalWarning: SQLite …` on Node 22 and the
 * hint line after it) are not Lager's and depend on the Node version.
 */
const ownLines = (stderr: string): string[] => stderr.split('\n').filter((l) => l !== '' && !/^\(node:\d+\) /.test(l) && !/^\(Use `node --trace-/.test(l));

interface Run { child: ChildProcess; out: () => string; err: () => string; exit: Promise<number | null> }

/** Starts the real entry point (`src/server.ts`, as `npm run dev` does) with exactly the given environment. */
function startServer(env: Record<string, string>): Run {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1', ...env } });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { err += String(d); });
  return { child, out: () => out, err: () => err, exit: new Promise((resolve) => child.on('exit', (code) => resolve(code))) };
}

async function until(done: () => boolean, what: () => string): Promise<void> {
  for (let i = 0; i < 300 && !done(); i++) await new Promise((r) => setTimeout(r, 50));
  if (!done()) throw new Error(`Timed out waiting for the server: ${what()}`);
}

describe('server start', () => {
  it('a missing or malformed variable ends in one line that names it, without a stack trace', async () => {
    const dataDir = tempDir();
    const base = { LAGER_PUBLIC_URL: 'http://localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_DATA_DIR: dataDir, LAGER_ADMIN_EMAIL: 'admin@x.y', LAGER_ADMIN_PASSWORD: 'admin-password-1' };
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ ...base, LAGER_PUBLIC_URL: '' }, /^Lager cannot start: Missing required environment variable LAGER_PUBLIC_URL$/],
      [{ ...base, LAGER_PORT: 'eighty' }, /^Lager cannot start: LAGER_PORT must be a whole number, between 0 and 65535 \(it is "eighty"\)$/],
      [{ ...base, LAGER_ADMIN_PASSWORD: '' }, /^Lager cannot start: .*LAGER_ADMIN_EMAIL and LAGER_ADMIN_PASSWORD.*$/],
    ];
    const runs = cases.map(([env]) => startServer(env));
    for (const [i, run] of runs.entries()) {
      expect(await run.exit).toBe(1);
      const lines = ownLines(run.err());
      expect(lines, run.err()).toHaveLength(1);
      expect(lines[0]).toMatch(cases[i][1]);
      expect(run.out()).toBe('');
    }
  }, 30_000);

  it('keeps idle connections for the proxy in front of it, and two stop signals end it cleanly', async () => {
    // Port 0: the system picks a free port and the start line names it, so no port is guessed here.
    const run = startServer({
      LAGER_PUBLIC_URL: 'http://localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_PORT: '0', LAGER_HOST: '127.0.0.1',
      LAGER_DATA_DIR: tempDir(), LAGER_ADMIN_EMAIL: 'admin@x.y', LAGER_ADMIN_PASSWORD: 'admin-password-1',
    });
    const listening = (): RegExpExecArray | null => /Lager listening on 127\.0\.0\.1:(\d+),/.exec(run.out());
    await until(() => listening() !== null || run.child.exitCode !== null, () => run.err() || run.out());
    const port = Number(listening()![1]);
    expect(port).toBeGreaterThan(0);
    const keepAlive = await new Promise<string | undefined>((resolve, reject) => {
      const agent = new http.Agent({ keepAlive: true });
      http.get({ host: '127.0.0.1', port, path: '/healthz', headers: { Host: 'localhost:8080' }, agent }, (res) => {
        res.resume();
        res.on('end', () => { agent.destroy(); resolve(res.headers['keep-alive']); });
      }).on('error', reject);
    });
    expect(keepAlive).toBe(`timeout=${KEEP_ALIVE_TIMEOUT_MS / 1000}`);
    // Two different signals, because a signal that is already pending is not delivered twice.
    run.child.kill('SIGTERM');
    run.child.kill('SIGINT');
    expect(await run.exit).toBe(0);
    expect(ownLines(run.err())).toEqual([]);
  }, 30_000);
});

describe('server lifecycle', () => {
  it('sets the timeouts for connections a reverse proxy reuses', () => {
    const server = http.createServer();
    applyProxyTimeouts(server);
    expect(server.keepAliveTimeout).toBe(65_000);
    // Node needs the header timeout above the keep-alive timeout, or a reused connection can be cut while the next request arrives.
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(HEADERS_TIMEOUT_MS).toBeGreaterThan(KEEP_ALIVE_TIMEOUT_MS);
  });

  it('shuts down once, however many signals arrive', () => {
    const calls: string[] = [];
    let closed: (() => void) | undefined;
    let open = true;
    const shutdown = createShutdown({
      stopJobs: () => calls.push('jobs'),
      server: {
        close: (cb?: (err?: Error) => void) => { calls.push('server.close'); closed = () => cb?.(); return undefined as never; },
        closeAllConnections: () => { calls.push('connections'); },
      },
      // The database throws when it is closed twice, which used to end the process with status 1.
      closeCore: () => { if (!open) throw new Error('database is not open'); open = false; calls.push('core'); },
      exit: (code) => calls.push(`exit ${code}`),
    });
    shutdown();
    shutdown();
    closed!();
    shutdown();
    expect(calls).toEqual(['jobs', 'server.close', 'connections', 'core', 'exit 0']);
  });

  it('reports a start-up error as its message', () => {
    expect(startupError(new Error('LAGER_PORT must be a whole number'))).toBe('Lager cannot start: LAGER_PORT must be a whole number');
    expect(startupError('boom')).toBe('Lager cannot start: boom');
  });
});
