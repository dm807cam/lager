/**
 * Copies the data directory into a new directory while Lager keeps running: `node dist/backup.js <target>`.
 * A plain copy of a live SQLite database can be torn; every database is therefore written with `VACUUM INTO`,
 * which yields a consistent file. Everything else (versions, uploads, icons, the key) is written once and then
 * only renamed or deleted, so it is copied as it is. In every directory the databases are copied before the files and
 * sub-directories: a file that arrives during the backup is then merely extra, never one the copied database points to
 * but the backup lacks. The trash is left out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SQLITE_SIDECAR = /\.sqlite-(wal|shm|journal)$/;

export interface BackupResult { databases: number; files: number; bytes: number }

function copyDatabase(from: string, to: string): void {
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare('VACUUM INTO ?').run(to);
  } finally {
    db.close();
  }
}

function walk(from: string, to: string, result: BackupResult, top: boolean): void {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  const isDatabase = (e: fs.Dirent): boolean => e.isFile() && e.name.endsWith('.sqlite');
  const entries = fs.readdirSync(from, { withFileTypes: true });
  for (const entry of [...entries.filter(isDatabase), ...entries.filter((e) => !isDatabase(e))]) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (top && entry.name === 'trash') continue;
      walk(src, dst, result, false);
    } else if (entry.isFile()) {
      // Sidecars belong to the live database; half-written files are still being renamed into place.
      if (SQLITE_SIDECAR.test(entry.name) || entry.name.endsWith('.tmp')) continue;
      try {
        if (entry.name.endsWith('.sqlite')) { copyDatabase(src, dst); result.databases++; }
        else { fs.copyFileSync(src, dst); result.files++; }
        fs.chmodSync(dst, fs.statSync(src).mode & 0o777);
        result.bytes += fs.statSync(dst).size;
      } catch (e) {
        // Deleted between listing and copying (a pruned snapshot, a removed upload): not part of the backup.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }
}

/** Backs `dataDir` up into `target`, which must not exist yet or be empty, and must not lie inside the data directory. */
export function backup(dataDir: string, target: string): BackupResult {
  const from = path.resolve(dataDir);
  const to = path.resolve(target);
  if (!fs.existsSync(path.join(from, 'platform.sqlite'))) throw new Error(`${from} is not a Lager data directory (no platform.sqlite).`);
  if (to === from || to.startsWith(from + path.sep)) throw new Error('The backup target must be outside the data directory.');
  if (fs.existsSync(to) && fs.readdirSync(to).length > 0) throw new Error(`${to} already exists and is not empty.`);
  const result: BackupResult = { databases: 0, files: 0, bytes: 0 };
  walk(from, to, result, true);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node dist/backup.js <target directory>   (data directory: LAGER_DATA_DIR, default ./data)');
    process.exit(2);
  }
  // A backup holds what the data directory holds: nothing in it is created readable by other accounts, not even for a moment.
  process.umask(0o077);
  try {
    const r = backup(process.env.LAGER_DATA_DIR?.trim() || './data', target);
    console.log(`Backup written to ${path.resolve(target)}: ${r.databases} databases, ${r.files} files, ${(r.bytes / 1024 / 1024).toFixed(1)} MiB.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
