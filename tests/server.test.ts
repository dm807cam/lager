import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { backup } from '../src/backup.js';
import { createCore } from '../src/core.js';
import { applyProxyTimeouts, closeDataDir, createShutdown, HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, restrictNewFiles, startupError } from '../src/lifecycle.js';

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

/** Every entry below `dir` with its permission bits, as `relative/path mode`. */
function modes(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    const line = `${path.relative(base, full)}${e.isDirectory() ? '/' : ''} ${(fs.statSync(full).mode & 0o777).toString(8)}`;
    return e.isDirectory() ? [line, ...modes(full, base)] : [line];
  });
}

// Permission bits as on Linux and macOS; Windows has none to check.
describe.skipIf(process.platform === 'win32')('file permissions of the data directory', () => {
  it('the server creates its data directory and the files in it for its own account only', async () => {
    const dataDir = path.join(tempDir(), 'data');
    const run = startServer({
      LAGER_PUBLIC_URL: 'http://localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_PORT: '0', LAGER_HOST: '127.0.0.1',
      LAGER_DATA_DIR: dataDir, LAGER_ADMIN_EMAIL: 'admin@x.y', LAGER_ADMIN_PASSWORD: 'admin-password-1',
    });
    await until(() => /Lager listening on/.test(run.out()) || run.child.exitCode !== null, () => run.err() || run.out());
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    const found = modes(dataDir);
    // The database with its WAL and SHM files, and the generated secret.
    expect(found.map((l) => l.split(' ')[0])).toEqual(expect.arrayContaining(['platform.sqlite', 'platform.sqlite-wal', 'platform.sqlite-shm', 'secret.key']));
    for (const line of found) expect(line).toMatch(line.includes('/ ') ? / 700$/ : / 600$/);
    // A directory that was private from the start is not reported as changed.
    expect(run.out()).not.toMatch(/closed its data directory/);
    run.child.kill('SIGTERM');
    expect(await run.exit).toBe(0);
  }, 30_000);

  it('an existing data directory that others could enter is closed at the start, and that is said once', async () => {
    const dataDir = tempDir();
    fs.chmodSync(dataDir, 0o755);
    const env = {
      LAGER_PUBLIC_URL: 'http://localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_PORT: '0', LAGER_HOST: '127.0.0.1',
      LAGER_DATA_DIR: dataDir, LAGER_ADMIN_EMAIL: 'admin@x.y', LAGER_ADMIN_PASSWORD: 'admin-password-1',
    };
    for (const said of [1, 0]) {
      const run = startServer(env);
      await until(() => /Lager listening on/.test(run.out()) || run.child.exitCode !== null, () => run.err() || run.out());
      expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(run.out().split('\n').filter((l) => l.includes(`closed its data directory ${dataDir}`))).toHaveLength(said);
      run.child.kill('SIGTERM');
      expect(await run.exit).toBe(0);
    }
  }, 30_000);

  it('closeDataDir changes only the top directory, and only one that is open to others', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'instances'), { mode: 0o755 });
    fs.chmodSync(path.join(dir, 'instances'), 0o755);
    expect(closeDataDir(dir)).toBe(false);
    fs.chmodSync(dir, 0o750);
    expect(closeDataDir(dir)).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    // The tree below is not walked: closing the top is what keeps others out.
    expect(fs.statSync(path.join(dir, 'instances')).mode & 0o777).toBe(0o755);
    expect(closeDataDir(dir)).toBe(false);
    expect(closeDataDir(path.join(dir, 'missing'))).toBe(false);
  });

  it('with new files restricted, everything a running Lager writes is private, and the backup can still read all of it', async () => {
    const before = process.umask();
    restrictNewFiles();
    try {
      const dataDir = path.join(tempDir(), 'data');
      const core = createCore({
        dataDir, port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.localhost:8080'), appsDomain: 'apps.localhost',
        adminEmail: 'admin@x.y', adminPassword: 'admin-password-1', secret: 'test-secret', snapshotKeep: 20, trustProxy: false, instanceQuotaBytes: 50 * 1024 * 1024,
      });
      try {
        const admin = core.users.list()[0];
        const first = core.apps.deploy({ slug: 'notes', html: '<p>1</p>', userId: admin.id, capabilities: { db: {}, assets: {} } });
        const inst = first.instances[0];
        core.data.set(inst.id, 'notes/a', { text: 'x' }, admin.id);
        core.assets.put(inst.id, Buffer.from('file'), 'text/plain', admin.id);
        // A second version makes the snapshot that is taken before the active version changes.
        core.apps.deploy({ slug: 'notes', html: '<p>2</p>', userId: admin.id, capabilities: { db: {}, assets: {} } });
        core.apps.selfPublish({ instanceId: inst.id, html: '<p>saved</p>', baseVersion: 2, userId: admin.id });
        const gone = core.apps.createInstance({ appId: first.app.id, slug: 'notes-two', ownerId: admin.id });
        core.data.set(gone.id, 'notes/a', { text: 'y' }, admin.id);
        core.apps.deleteInstance(gone.id, admin.id);

        const found = modes(dataDir);
        const names = found.join('\n');
        for (const part of ['platform.sqlite 600', 'data.sqlite 600', 'assets.sqlite 600', 'snapshots/ 700', 'index.html 600', 'trash/ 700', 'assets/ 700']) expect(names).toContain(part);
        for (const line of found) expect(line).toMatch(line.includes('/ ') ? / 700$/ : / 600$/);

        const target = path.join(tempDir(), 'copy');
        const result = backup(dataDir, target);
        expect(result.databases).toBeGreaterThanOrEqual(3);
        for (const line of modes(target)) expect(line).toMatch(line.includes('/ ') ? / 700$/ : / 600$/);
      } finally { core.close(); }
    } finally { process.umask(before); }
  });
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
