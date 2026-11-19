import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * install.sh runs against stand-ins for docker, curl and a few system commands, which record every call. That checks
 * what the installer writes and runs, and that running it again keeps settings and only updates, without Docker or
 * Cloudflare. The installer targets Linux (GNU tools), so the tests do too.
 */

const SCRIPT = path.resolve(process.cwd(), 'install.sh');
const TUNNEL_ID = '11111111-2222-3333-4444-555555555555';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const STUBS: Record<string, string> = {
  id: '#!/bin/sh\nif [ "$1" = "-u" ]; then echo "${STUB_UID:-0}"; else /usr/bin/id "$@"; fi\n',
  uname: '#!/bin/sh\nif [ "$1" = "-m" ] && [ -n "$STUB_ARCH" ]; then echo "$STUB_ARCH"; exit 0; fi\nfor u in /usr/bin/uname /bin/uname; do [ -x "$u" ] && exec "$u" "$@"; done\nexit 1\n',
  sleep: '#!/bin/sh\nexit 0\n',
  chown: '#!/bin/sh\necho "chown $*" >> "$STUB_LOG"\n',
  systemctl: '#!/bin/sh\nexit 0\n',
  // STUB_NO_HOSTNAME_I: a hostname without -I, as on Arch and Alpine.
  hostname: '#!/bin/sh\nif [ "$1" = "-I" ]; then\n  if [ -n "$STUB_NO_HOSTNAME_I" ]; then echo "hostname: invalid option -- I" >&2; exit 1; fi\n  echo "192.168.1.23 fd00::1"\nelse echo "testpi"; fi\n',
  ip: '#!/bin/sh\nif [ -n "$STUB_NO_IP" ]; then exit 127; fi\necho "1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.50 uid 0"\n',
  curl: '#!/bin/sh\necho "curl $*" >> "$STUB_LOG"\nexit "${STUB_HEALTH_EXIT:-0}"\n',
  docker: `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
args="$*"
case "$args" in "compose version"*) exit 0 ;; esac
if [ "$1" = run ]; then
  dir=""; prev=""
  for a in "$@"; do if [ "$prev" = "-v" ]; then dir="\${a%%:*}"; fi; prev="$a"; done
  case "$args" in
    *"tunnel login"*) echo "Please open https://dash.cloudflare.com/argotunnel?callback=x"; echo cert > "$dir/cert.pem" ;;
    *"tunnel create"*)
      if [ -n "$STUB_TUNNEL_EXISTS" ] && [ ! -e "$dir/.exists-once" ]; then
        touch "$dir/.exists-once"; echo "failed to create tunnel: tunnel with name already exists" >&2; exit 1
      fi
      echo '{}' > "$dir/${TUNNEL_ID}.json"; echo "Created tunnel \${@: -1} with id ${TUNNEL_ID}" ;;
  esac
  exit 0
fi
if [ "$1" = compose ]; then
  case "$args" in
    *" ps "*)
      if [ -n "$STUB_RUNNING" ]; then echo lager; fi
      # Far more output than a pipe holds, which a reader that stops at the first match would cut off.
      if [ "$STUB_RUNNING" = many ]; then for i in $(seq 1 30000); do echo "other-service-$i"; done; fi ;;
    *"backup.js"*) if [ -n "$STUB_BACKUP_FAIL" ]; then echo "backup: no space left on device" >&2; exit 1; fi ;;
  esac
  exit 0
fi
exit 0
`,
};

interface Run { status: number | null; stdout: string; stderr: string; calls: string[]; dir: string }

function sandbox(): { dir: string; bin: string; log: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-install-'));
  dirs.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  return { dir: path.join(root, 'lager'), bin, log: path.join(root, 'calls.log') };
}

function install(box: { dir: string; bin: string; log: string }, env: Record<string, string> = {}): Run {
  fs.writeFileSync(box.log, '');
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: `${box.bin}:${process.env.PATH}`, HOME: os.tmpdir(), STUB_LOG: box.log, LAGER_DIR: box.dir, LAGER_NONINTERACTIVE: '1', ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: fs.readFileSync(box.log, 'utf8').split('\n').filter(Boolean), dir: box.dir };
}

const read = (dir: string, file: string): string => fs.readFileSync(path.join(dir, file), 'utf8');
const envOf = (dir: string): Record<string, string> =>
  Object.fromEntries(read(dir, '.env').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

describe.runIf(process.platform === 'linux')('install.sh', () => {
  it('sets up Lager behind a Cloudflare Tunnel on the first run', () => {
    const box = sandbox();
    const r = install(box, { LAGER_MODE: 'cloudflare', LAGER_DOMAIN: 'MyLager.net', LAGER_ADMIN_EMAIL: 'me@mylager.net' });
    expect(r.status, r.stderr).toBe(0);
    const env = envOf(r.dir);
    expect(env).toMatchObject({
      LAGER_PUBLIC_URL: 'https://mylager.net', LAGER_APPS_DOMAIN: 'mylager.net', LAGER_TRUST_PROXY: 'true',
      LAGER_BIND: '127.0.0.1', LAGER_ADMIN_EMAIL: 'me@mylager.net',
    });
    expect(env.LAGER_ADMIN_PASSWORD).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(r.stdout).toContain(env.LAGER_ADMIN_PASSWORD);
    expect(r.stdout).toContain('https://mylager.net/mcp');
    expect(fs.statSync(path.join(r.dir, '.env')).mode & 0o777).toBe(0o600);

    const compose = read(r.dir, 'docker-compose.yml');
    expect(compose).toContain('image: ghcr.io/dm807cam/lager:latest');
    expect(compose).toContain('"127.0.0.1:8080:8080"');
    expect(compose).toContain('cloudflared:');
    expect(compose).toContain('tunnel --no-autoupdate --config /etc/cloudflared/config.yml run');

    const config = read(r.dir, 'cloudflared/config.yml');
    expect(config).toContain(`tunnel: ${TUNNEL_ID}`);
    expect(config).toContain(`credentials-file: /etc/cloudflared/${TUNNEL_ID}.json`);
    expect(config).toContain('hostname: mylager.net');
    expect(config).toContain('hostname: "*.mylager.net"');
    expect(config).toContain('service: http_status:404');

    const docker = r.calls.filter((c) => c.startsWith('docker '));
    expect(docker.filter((c) => c.includes('tunnel login'))).toHaveLength(1);
    expect(docker.filter((c) => c.includes('tunnel create lager-testpi'))).toHaveLength(1);
    expect(docker.filter((c) => c.includes('route dns --overwrite-dns'))).toEqual([
      expect.stringContaining(`${TUNNEL_ID} mylager.net`), expect.stringContaining(`${TUNNEL_ID} *.mylager.net`),
    ]);
    expect(docker.some((c) => c.includes('compose') && c.includes('pull'))).toBe(true);
    expect(docker.some((c) => c.includes('compose') && c.includes('up -d --remove-orphans'))).toBe(true);
    // A first installation has nothing to back up.
    expect(docker.some((c) => c.includes('backup.js'))).toBe(false);
    expect(r.calls).toContain('chown 65532:65532 ' + path.join(r.dir, 'cloudflared'));
    expect(read(r.dir, 'installer.env')).toContain(`LAGER_TUNNEL_ID=${TUNNEL_ID}`);
  });

  it('running it again updates without asking, keeps settings and takes a backup first', () => {
    const box = sandbox();
    const first = install(box, { LAGER_MODE: 'cloudflare', LAGER_DOMAIN: 'mylager.net', LAGER_ADMIN_EMAIL: 'me@mylager.net' });
    expect(first.status, first.stderr).toBe(0);
    const before = envOf(box.dir);
    // No answers this time: everything comes from the first run.
    const again = install(box, { STUB_RUNNING: '1' });
    expect(again.status, again.stderr).toBe(0);
    expect(envOf(box.dir)).toEqual(before);
    expect(again.stdout).not.toContain(before.LAGER_ADMIN_PASSWORD);
    expect(again.stdout).toContain('Lager is up to date');
    const docker = again.calls.filter((c) => c.startsWith('docker '));
    expect(docker.some((c) => c.includes('tunnel login'))).toBe(false);
    expect(docker.some((c) => c.includes('tunnel create'))).toBe(false);
    expect(docker.filter((c) => c.includes('route dns'))).toHaveLength(2);
    const backup = docker.findIndex((c) => c.includes('exec -T lager node dist/backup.js /backups/'));
    const pull = docker.findIndex((c) => c.includes(' pull'));
    expect(backup).toBeGreaterThan(-1);
    expect(backup).toBeLessThan(pull);
  });

  it('keeps only the newest backups', () => {
    const box = sandbox();
    expect(install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com' }).status).toBe(0);
    for (const name of ['2026-01-01-000000', '2026-01-02-000000', '2026-01-03-000000']) fs.mkdirSync(path.join(box.dir, 'backups', name));
    expect(install(box, { STUB_RUNNING: '1', LAGER_BACKUPS_KEEP: '2' }).status).toBe(0);
    expect(fs.readdirSync(path.join(box.dir, 'backups')).sort()).toEqual(['2026-01-02-000000', '2026-01-03-000000']);
  });

  it('leaves directories in the backup folder alone that it did not create', () => {
    const box = sandbox();
    expect(install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com' }).status).toBe(0);
    for (const name of ['2026-01-01-000000', '2026-01-02-000000', 'my own copy']) fs.mkdirSync(path.join(box.dir, 'backups', name));
    expect(install(box, { STUB_RUNNING: '1', LAGER_BACKUPS_KEEP: '1' }).status).toBe(0);
    expect(fs.readdirSync(path.join(box.dir, 'backups')).sort()).toEqual(['2026-01-02-000000', 'my own copy']);
    const bad = install(box, { STUB_RUNNING: '1', LAGER_BACKUPS_KEEP: 'all' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('LAGER_BACKUPS_KEEP');
  });

  it('accepts a number of backups with a leading zero and refuses what is not a small number', () => {
    const box = sandbox();
    expect(install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com' }).status).toBe(0);
    for (let day = 1; day <= 9; day++) fs.mkdirSync(path.join(box.dir, 'backups', `2026-01-0${day}-000000`));
    const r = install(box, { STUB_RUNNING: '1', LAGER_BACKUPS_KEEP: '08' });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(path.join(box.dir, 'backups'))).toHaveLength(8);
    expect(fs.existsSync(path.join(box.dir, 'backups', '2026-01-01-000000'))).toBe(false);
    for (const keep of ['12345', '99999999999999999999', '-1', '1 2']) {
      const bad = install(box, { STUB_RUNNING: '1', LAGER_BACKUPS_KEEP: keep });
      expect(bad.status, keep).toBe(1);
      expect(bad.stderr).toContain('LAGER_BACKUPS_KEEP must be a number');
    }
    expect(fs.readdirSync(path.join(box.dir, 'backups'))).toHaveLength(8);
  });

  it('stops the update when the backup fails, and shows why', () => {
    const box = sandbox();
    expect(install(box, { LAGER_MODE: 'cloudflare', LAGER_DOMAIN: 'mylager.net', LAGER_ADMIN_EMAIL: 'me@mylager.net' }).status).toBe(0);
    const files = ['.env', 'installer.env', 'docker-compose.yml', 'cloudflared/config.yml'];
    const before = files.map((f) => read(box.dir, f));
    fs.rmSync(path.join(box.dir, 'cloudflared/config.yml'));
    // Even with a new image and new answers, a failed backup leaves every file of the installation as it was.
    const r = install(box, { STUB_RUNNING: '1', STUB_BACKUP_FAIL: '1', LAGER_IMAGE: 'ghcr.io/dm807cam/lager:edge', LAGER_RECONFIGURE: '1', LAGER_MODE: 'local' });
    expect(files.slice(0, 3).map((f) => read(box.dir, f))).toEqual(before.slice(0, 3));
    expect(fs.existsSync(path.join(box.dir, 'cloudflared/config.yml'))).toBe(false);
    expect(r.calls.some((c) => c.includes('route dns'))).toBe(false);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no space left on device');
    expect(r.stderr).toContain('LAGER_SKIP_BACKUP=1');
    expect(r.stderr).not.toContain('failed. Nothing you set up');
    expect(r.calls.some((c) => c.includes(' pull'))).toBe(false);
    expect(r.calls.some((c) => c.includes('up -d'))).toBe(false);
  });

  it('updates without a backup only when LAGER_SKIP_BACKUP=1 says so', () => {
    const box = sandbox();
    expect(install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com' }).status).toBe(0);
    const r = install(box, { STUB_RUNNING: '1', STUB_BACKUP_FAIL: '1', LAGER_SKIP_BACKUP: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('Skipping the backup');
    expect(r.calls.some((c) => c.includes('backup.js'))).toBe(false);
    expect(r.calls.some((c) => c.includes('up -d --remove-orphans'))).toBe(true);
  });

  it('takes the backup however long the list of running services is', () => {
    const box = sandbox();
    expect(install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com' }).status).toBe(0);
    const r = install(box, { STUB_RUNNING: 'many' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c.includes('exec -T lager node dist/backup.js /backups/'))).toBe(true);
  });

  it('remembers the image of an earlier run until another one is given', () => {
    const box = sandbox();
    const image = (): string => /image: (ghcr\S+)/.exec(read(box.dir, 'docker-compose.yml'))?.[1] ?? '';
    expect(install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com', LAGER_IMAGE: 'ghcr.io/dm807cam/lager:edge' }).status).toBe(0);
    expect(image()).toBe('ghcr.io/dm807cam/lager:edge');
    expect(read(box.dir, 'installer.env')).toContain('LAGER_IMAGE=ghcr.io/dm807cam/lager:edge');
    // A plain run keeps it.
    expect(install(box, { STUB_RUNNING: '1' }).status).toBe(0);
    expect(image()).toBe('ghcr.io/dm807cam/lager:edge');
    // An image given later wins and is remembered in turn.
    expect(install(box, { STUB_RUNNING: '1', LAGER_IMAGE: 'ghcr.io/dm807cam/lager:0.1.0' }).status).toBe(0);
    expect(image()).toBe('ghcr.io/dm807cam/lager:0.1.0');
    expect(install(box, { STUB_RUNNING: '1' }).status).toBe(0);
    expect(image()).toBe('ghcr.io/dm807cam/lager:0.1.0');
    expect(read(box.dir, 'installer.env')).toContain('LAGER_IMAGE=ghcr.io/dm807cam/lager:0.1.0');
  });

  it('refuses an image name that could write other lines into its files', () => {
    for (const image of ['ghcr.io/dm807cam/lager:edge\n    privileged: true', 'ghcr.io/dm807cam/lager:edge extra', 'ghcr.io/dm807cam/lager:"edge"', 'ghcr.io/dm807cam/lager:edge\t']) {
      const box = sandbox();
      const r = install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com', LAGER_IMAGE: image });
      expect(r.status, image).toBe(1);
      expect(r.stderr).toContain('LAGER_IMAGE is not a valid image name');
      expect(fs.existsSync(path.join(box.dir, 'docker-compose.yml'))).toBe(false);
      expect(fs.existsSync(path.join(box.dir, 'installer.env'))).toBe(false);
    }
  });

  it('accepts a registry with a port and a digest, and keeps the earlier files when a later name is refused', () => {
    const box = sandbox();
    const digest = `registry.example.com:5000/me/lager@sha256:${'a'.repeat(64)}`;
    expect(install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com', LAGER_IMAGE: digest }).status).toBe(0);
    expect(read(box.dir, 'docker-compose.yml')).toContain(`image: ${digest}`);
    const bad = install(box, { STUB_RUNNING: '1', LAGER_IMAGE: 'x\nLAGER_MODE=cloudflare' });
    expect(bad.status).toBe(1);
    expect(read(box.dir, 'docker-compose.yml')).toContain(`image: ${digest}`);
    expect(read(box.dir, 'installer.env')).toContain('LAGER_MODE=local');
    expect(bad.calls.some((c) => c.includes('backup.js'))).toBe(false);
  });

  it('reads the last line of its state file even without a newline at the end', () => {
    const box = sandbox();
    expect(install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com', LAGER_IMAGE: 'ghcr.io/dm807cam/lager:edge' }).status).toBe(0);
    const state = read(box.dir, 'installer.env');
    expect(state.trimEnd().split('\n').at(-1)).toBe('LAGER_IMAGE=ghcr.io/dm807cam/lager:edge');
    fs.writeFileSync(path.join(box.dir, 'installer.env'), state.trimEnd());
    expect(install(box, { STUB_RUNNING: '1' }).status).toBe(0);
    expect(read(box.dir, 'docker-compose.yml')).toContain('image: ghcr.io/dm807cam/lager:edge');
  });

  it('an update keeps the way Lager was set up, whatever answers are passed without LAGER_RECONFIGURE=1', () => {
    const box = sandbox();
    expect(install(box, { LAGER_MODE: 'cloudflare', LAGER_DOMAIN: 'mylager.net', LAGER_ADMIN_EMAIL: 'me@mylager.net' }).status).toBe(0);
    const env = envOf(box.dir);
    const state = read(box.dir, 'installer.env');
    const r = install(box, { STUB_RUNNING: '1', LAGER_MODE: 'local', LAGER_DOMAIN: 'other.net', LAGER_TUNNEL_ID: 'aaaaaaaa-2222-3333-4444-555555555555' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('Ignoring LAGER_MODE=local');
    expect(r.stderr).toContain('Ignoring LAGER_DOMAIN=other.net');
    expect(r.stderr).toContain('Ignoring LAGER_TUNNEL_ID=');
    expect(r.stderr).toContain('LAGER_RECONFIGURE=1');
    expect(envOf(box.dir)).toEqual(env);
    expect(read(box.dir, 'installer.env')).toBe(state);
    expect(read(box.dir, 'docker-compose.yml')).toContain('cloudflared:');
    expect(read(box.dir, 'cloudflared/config.yml')).toContain('hostname: mylager.net');
    // The next plain update still has the tunnel.
    const plain = install(box, { STUB_RUNNING: '1' });
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stderr).not.toContain('Ignoring');
    expect(read(box.dir, 'docker-compose.yml')).toContain('cloudflared:');
    // Passing the same answers again is not worth a warning, and the image may change on any run.
    const same = install(box, { STUB_RUNNING: '1', LAGER_MODE: 'cloudflare', LAGER_DOMAIN: 'mylager.net', LAGER_IMAGE: 'ghcr.io/dm807cam/lager:edge' });
    expect(same.status, same.stderr).toBe(0);
    expect(same.stderr).not.toContain('Ignoring');
    expect(read(box.dir, 'docker-compose.yml')).toContain('image: ghcr.io/dm807cam/lager:edge');
    expect(read(box.dir, 'docker-compose.yml')).toContain('cloudflared:');
  });

  it('LAGER_RECONFIGURE=1 changes the way Lager is reached, in the settings and in the state together', () => {
    const box = sandbox();
    expect(install(box, { LAGER_MODE: 'cloudflare', LAGER_DOMAIN: 'mylager.net', LAGER_ADMIN_EMAIL: 'me@mylager.net' }).status).toBe(0);
    const r = install(box, { STUB_RUNNING: '1', LAGER_RECONFIGURE: '1', LAGER_MODE: 'local' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('Ignoring');
    expect(read(box.dir, 'installer.env')).toContain('LAGER_MODE=local');
    expect(envOf(box.dir).LAGER_PUBLIC_URL).toBe('http://lager.192-168-1-23.sslip.io:8080');
    expect(read(box.dir, 'docker-compose.yml')).not.toContain('cloudflared');
    // The backup of the running server was taken before the change.
    const docker = r.calls.filter((c) => c.startsWith('docker '));
    expect(docker.findIndex((c) => c.includes('backup.js'))).toBeGreaterThan(-1);
    expect(docker.findIndex((c) => c.includes('backup.js'))).toBeLessThan(docker.findIndex((c) => c.includes(' pull')));
  });

  it('an installation from before the image was remembered gets the default image', () => {
    const box = sandbox();
    expect(install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com' }).status).toBe(0);
    const state = path.join(box.dir, 'installer.env');
    fs.writeFileSync(state, read(box.dir, 'installer.env').split('\n').filter((l) => !l.startsWith('LAGER_IMAGE=')).join('\n'));
    expect(install(box, { STUB_RUNNING: '1' }).status).toBe(0);
    expect(read(box.dir, 'docker-compose.yml')).toContain('image: ghcr.io/dm807cam/lager:latest');
    expect(read(box.dir, 'installer.env')).toContain('LAGER_IMAGE=ghcr.io/dm807cam/lager:latest');
  });

  it('gives a tunnel a fresh name when one with that name already exists', () => {
    const box = sandbox();
    const r = install(box, { LAGER_MODE: 'cloudflare', LAGER_DOMAIN: 'mylager.net', LAGER_ADMIN_EMAIL: 'me@mylager.net', STUB_TUNNEL_EXISTS: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.filter((c) => c.includes('tunnel create'))).toHaveLength(2);
    expect(read(box.dir, 'installer.env')).toMatch(/LAGER_TUNNEL_NAME=lager-testpi-[a-z0-9]{6}/);
    expect(r.stderr).not.toContain('failed. Nothing you set up');
  });

  it('local mode uses sslip.io addresses of this machine and listens on the network', () => {
    const box = sandbox();
    const r = install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com' });
    expect(r.status, r.stderr).toBe(0);
    expect(envOf(box.dir)).toMatchObject({
      LAGER_PUBLIC_URL: 'http://lager.192-168-1-23.sslip.io:8080', LAGER_APPS_DOMAIN: 'apps.192-168-1-23.sslip.io', LAGER_TRUST_PROXY: 'false',
    });
    expect(read(box.dir, 'docker-compose.yml')).toContain('"0.0.0.0:8080:8080"');
    expect(read(box.dir, 'docker-compose.yml')).not.toContain('cloudflared');
    expect(r.calls.some((c) => c.includes('tunnel'))).toBe(false);
    expect(r.stdout).toContain('only in this network');
    // The two things that break these addresses are named where the user sees them.
    expect(r.stdout).toContain('DNS rebind protection');
    expect(r.stdout).toContain('fixed address');
  });

  it('finds the address of this machine without "hostname -I"', () => {
    const box = sandbox();
    const r = install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com', STUB_NO_HOSTNAME_I: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(envOf(box.dir).LAGER_PUBLIC_URL).toBe('http://lager.192-168-1-50.sslip.io:8080');
    const none = install(sandbox(), { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com', STUB_NO_HOSTNAME_I: '1', STUB_NO_IP: '1' });
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("Could not find this machine's address");
    expect(none.stderr).not.toContain('failed. Nothing you set up');
  });

  it('proxy mode takes the given addresses', () => {
    const box = sandbox();
    const r = install(box, { LAGER_MODE: 'proxy', LAGER_PUBLIC_URL: 'https://lager.example.com', LAGER_APPS_DOMAIN: 'apps.example.com', LAGER_ADMIN_EMAIL: 'me@example.com' });
    expect(r.status, r.stderr).toBe(0);
    expect(envOf(box.dir)).toMatchObject({ LAGER_PUBLIC_URL: 'https://lager.example.com', LAGER_APPS_DOMAIN: 'apps.example.com', LAGER_BIND: '127.0.0.1' });
  });

  it('refuses to run without root, on 32-bit systems, and without an answer it needs', () => {
    const box = sandbox();
    const user = install(box, { STUB_UID: '1000', LAGER_MODE: 'local' });
    expect(user.status).toBe(1);
    expect(user.stderr).toContain('as root');
    const arm32 = install(box, { STUB_ARCH: 'armv7l', LAGER_MODE: 'local' });
    expect(arm32.status).toBe(1);
    expect(arm32.stderr).toContain('64-bit Raspberry Pi OS');
    const missing = install(box, { LAGER_MODE: 'cloudflare' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('LAGER_DOMAIN');
    expect(fs.existsSync(path.join(box.dir, '.env'))).toBe(false);
  });

  it('explains when Lager does not come up', () => {
    const box = sandbox();
    const r = install(box, { LAGER_MODE: 'local', LAGER_ADMIN_EMAIL: 'me@example.com', STUB_HEALTH_EXIT: '7' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Lager did not start');
  });
});
