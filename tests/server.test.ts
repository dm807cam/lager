import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyProxyTimeouts, createShutdown, HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, startupError } from '../src/lifecycle.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const children: ChildProcess[] = [];
afterEach(() => { for (const c of children.splice(0)) c.kill('SIGKILL'); });

interface Run { child: ChildProcess; out: () => string; err: () => string; exit: Promise<number | null> }

/** Starts the real entry point (`src/server.ts`, as `npm run dev` does) with exactly the given environment. */
function startServer(env: Record<string, string>): Run {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env } });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { err += String(d); });
  return { child, out: () => out, err: () => err, exit: new Promise((resolve) => child.on('exit', (code) => resolve(code))) };
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

async function until(done: () => boolean, what: () => string): Promise<void> {
  for (let i = 0; i < 300 && !done(); i++) await new Promise((r) => setTimeout(r, 50));
  if (!done()) throw new Error(`Timed out waiting for the server: ${what()}`);
}

describe('server start', () => {
  it('a missing or malformed variable ends in one line that names it, without a stack trace', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-server-'));
    const base = { LAGER_PUBLIC_URL: 'http://localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_DATA_DIR: dataDir, LAGER_ADMIN_EMAIL: 'admin@x.y', LAGER_ADMIN_PASSWORD: 'admin-password-1' };
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ ...base, LAGER_PUBLIC_URL: '' }, /^Lager cannot start: Missing required environment variable LAGER_PUBLIC_URL\n$/],
      [{ ...base, LAGER_PORT: 'eighty' }, /^Lager cannot start: LAGER_PORT must be a whole number, between 1 and 65535 \(it is "eighty"\)\n$/],
      [{ ...base, LAGER_ADMIN_PASSWORD: '' }, /^Lager cannot start: .*LAGER_ADMIN_EMAIL and LAGER_ADMIN_PASSWORD.*\n$/],
    ];
    const runs = cases.map(([env]) => startServer(env));
    for (const [i, run] of runs.entries()) {
      expect(await run.exit).toBe(1);
      expect(run.err()).toMatch(cases[i][1]);
      expect(run.out()).toBe('');
    }
  }, 30_000);

  it('keeps idle connections for the proxy in front of it, and two stop signals end it cleanly', async () => {
    const port = await freePort();
    const run = startServer({
      LAGER_PUBLIC_URL: `http://localhost:${port}`, LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_PORT: String(port), LAGER_HOST: '127.0.0.1',
      LAGER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'lager-server-')), LAGER_ADMIN_EMAIL: 'admin@x.y', LAGER_ADMIN_PASSWORD: 'admin-password-1',
    });
    await until(() => run.out().includes('Lager listening') || run.child.exitCode !== null, () => run.err() || run.out());
    const keepAlive = await new Promise<string | undefined>((resolve, reject) => {
      const agent = new http.Agent({ keepAlive: true });
      http.get({ host: '127.0.0.1', port, path: '/healthz', headers: { Host: `localhost:${port}` }, agent }, (res) => {
        res.resume();
        res.on('end', () => { agent.destroy(); resolve(res.headers['keep-alive']); });
      }).on('error', reject);
    });
    expect(keepAlive).toBe(`timeout=${KEEP_ALIVE_TIMEOUT_MS / 1000}`);
    // Two different signals, because a signal that is already pending is not delivered twice.
    run.child.kill('SIGTERM');
    run.child.kill('SIGINT');
    expect(await run.exit).toBe(0);
    expect(run.err()).toBe('');
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
