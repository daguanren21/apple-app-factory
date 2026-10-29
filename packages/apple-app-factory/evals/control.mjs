import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = dirname(EVAL_ROOT);
export const CLI = join(PACKAGE_ROOT, 'dist', 'cli.js');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function ownedPath(root, path) {
  const absolute = resolve(root, path);
  const child = relative(root, absolute);
  if (child === '..' || child.startsWith(`..${sep}`) || resolve(root) !== root) throw new Error('Path escapes the evaluation root');
  let current = root;
  if (lstatSync(root).isSymbolicLink()) throw new Error('Evaluation roots cannot be symlinks');
  for (const part of child.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`Evaluation symlink is forbidden: ${child}`);
  }
  return absolute;
}
export function text(path, limit = 8 * 1024 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error(`Expected bounded regular file: ${path}`);
  return readFileSync(path, 'utf8');
}
export const json = path => JSON.parse(text(path));
export function tree(root) {
  const files = {};
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = ownedPath(root, join(directory, name));
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files[relative(root, path)] = sha256(readFileSync(path));
      else throw new Error(`Non-regular evaluation input: ${path}`);
    }
  };
  visit(root);
  return files;
}
export function readState(caseRoot, jobId) {
  const dbPath = ownedPath(caseRoot, 'state/queue.sqlite');
  if (!existsSync(dbPath)) throw new Error('Prepared CLI database is missing');
  for (const suffix of ['', '-wal', '-shm']) {
    const path = ownedPath(caseRoot, `state/queue.sqlite${suffix}`);
    if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('CLI database must be a regular file');
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id,data FROM jobs').all();
    if (rows.length !== 1 || rows[0].id !== jobId) throw new Error('Expected exactly the original task in this isolated case');
    const job = JSON.parse(rows[0].data);
    if (job.id !== jobId) throw new Error('Task snapshot identity differs from its row');
    const events = db.prepare('SELECT seq,at,data FROM events WHERE job=? ORDER BY seq').all(jobId).map(row => ({ ...row, data: JSON.parse(row.data) }));
    return { job, events };
  } finally { db.close(); }
}
export function childEnvironment() {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), NODE_NO_WARNINGS: '1' };
}
export function cli(args, configPath) {
  if (!existsSync(CLI)) throw new Error('Build apphx first: dist/cli.js is missing. The evaluation never builds or installs tools.');
  const result = spawnSync(process.execPath, [CLI, ...args, '--config', configPath, '--build-only'], {
    cwd: dirname(configPath), env: childEnvironment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  return { status: result.status, signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
export function canonicalRoot(path) { return realpathSync(resolve(path)); }
