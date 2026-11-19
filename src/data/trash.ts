import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 3600_000;
const STAMP_RE = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;

/** When the entry was trashed: the stamp at the end of its name (`<id>-<stamp>`), else the directory's mtime. */
function trashedAt(file: string, name: string): number {
  const m = STAMP_RE.exec(name);
  if (m) {
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
    if (!Number.isNaN(ms)) return ms;
  }
  return fs.lstatSync(file).mtimeMs;
}

/** Removes entries of `<dataDir>/trash` older than `days` days. 0 keeps everything. Returns how many entries were removed. */
export function purgeTrash(dataDir: string, days: number, now = Date.now()): number {
  if (days <= 0) return 0;
  const trash = path.join(dataDir, 'trash');
  let names: string[];
  try { names = fs.readdirSync(trash); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const file = path.join(trash, name);
    try {
      if (now - trashedAt(file, name) < days * DAY_MS) continue;
      fs.rmSync(file, { recursive: true, force: true });
      removed++;
    } catch (e) {
      console.error(`Could not purge trash entry ${name}:`, e);
    }
  }
  return removed;
}

/** Purges now and then once every 24 hours. The timer does not keep the process alive; call the returned function to stop it. */
export function startTrashPurge(dataDir: string, days: number, log: (line: string) => void = console.log): () => void {
  if (days <= 0) return () => {};
  const run = (): void => { log(`Trash purge: removed ${purgeTrash(dataDir, days)} entries older than ${days} days.`); };
  run();
  const timer = setInterval(run, DAY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
