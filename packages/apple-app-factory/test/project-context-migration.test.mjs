import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConfigSchema } from '../dist/contracts/schemas.js';
import { Store } from '../dist/state/store.js';
import { claimNotification } from '../dist/delivery/notifications.js';
import { dependencyDigest } from '../dist/projects/dependencies.js';
import { prepareExecutionWorkspace, prepareWorkspace, sourceDigest } from '../dist/projects/workspace.js';

const spec = {
  id: 'saved-project', name: 'Saved project', framework: 'flutter', platform: 'android', channel: 'local',
  version: '1.0.0', purpose: 'Retain saved source ownership and delivery history', audience: 'Existing owners',
  differentiators: ['Persisted source and receipts'], acceptance: ['Upgrade never moves or resends existing work'],
};

function legacyFixture(t, notification, active = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apphx-project-migration-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = ConfigSchema.parse({
    projectMode: 'isolated', stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'apk',
    verification: { checks: [[process.execPath, '--version']], runtime: [[process.execPath, '--version']] },
  });
  const store = new Store(config.stateDir);
  const job = store.enqueue(spec, config);
  mkdirSync(join(job.workspace, 'build'), { recursive: true });
  writeFileSync(join(job.workspace, 'owner.txt'), 'Keep this exact project at this exact path.');
  const artifact = join(job.workspace, 'build', 'historical.apk');
  const bytes = Buffer.from('opaque historical artifact fixture');
  writeFileSync(artifact, bytes);
  const saved = {
    ...job, status: active ? 'running' : 'built', stage: active ? 'research' : 'package',
    artifact: { kind: 'apk', path: artifact, digest: createHash('sha256').update(bytes).digest('hex'), createdAt: '2026-01-01T00:00:00.000Z' },
    legacyOwnerNote: 'Retain unknown historical fields', ...notification,
    config: { ...job.config, notify: { email: { from: 'factory@fixture.invalid', to: 'owner@fixture.invalid', smtpHost: 'unused.fixture.invalid', smtpPort: 465, secure: true } } },
  };
  delete saved.projectRoot;
  delete saved.projectDigest;
  delete saved.projectDependencyDigest;
  delete saved.notifications;
  delete saved.config.projectMode;
  delete saved.config.projectRoot;
  if (active) saved.turn = { id: randomUUID(), stage: 'research', createdAt: Date.now(), ownerPid: process.pid };
  const original = JSON.stringify(saved);
  store.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run(saved.status, original, job.id);
  store.db.exec('PRAGMA user_version=3;');
  const events = store.db.prepare('SELECT seq,job,at,data FROM events ORDER BY seq').all();
  store.close();
  return { root, config, job, saved, original, events };
}

for (const [name, notification, expected] of [
  ['accepted', { notifiedAt: '2026-01-01T00:00:00.000Z', notifiedTo: 'owner@fixture.invalid' }, 'accepted'],
  ['in-flight', { notifySendingAt: '2026-01-01T00:00:00.000Z', notifiedTo: 'owner@fixture.invalid' }, 'unknown'],
]) test(`saved v3 ${name} delivery migrates without moving source or authorizing a new send`, t => {
  const f = legacyFixture(t, notification);
  const upgraded = new Store(f.config.stateDir);
  const migrated = upgraded.get(f.job.id);
  assert.equal(migrated.projectRoot, f.job.workspace);
  assert.equal(migrated.workspace, f.job.workspace);
  assert.equal(migrated.config.projectMode, 'isolated');
  assert.equal(migrated.config.notify, undefined);
  assert.equal(migrated.config.notifications, undefined);
  assert.equal(migrated.legacyOwnerNote, f.saved.legacyOwnerNote);
  assert.deepEqual(migrated.artifact, f.saved.artifact);
  assert.equal(migrated.notifications[0].status, expected);
  assert.equal(migrated.notifications[0].target.destination, 'owner@fixture.invalid');
  assert.equal(migrated.notifications[0].receipt?.messageId, undefined);
  assert.throws(() => claimNotification(upgraded, migrated.id, migrated.notifications[0].target.id));
  assert.equal(upgraded.get(migrated.id).status, 'built');
  assert.equal(upgraded.db.prepare('SELECT data FROM snapshot_migrations WHERE job=? AND version=3').get(migrated.id).data, f.original);
  assert.deepEqual(upgraded.db.prepare('SELECT seq,job,at,data FROM events ORDER BY seq').all(), f.events);
  assert.equal(readFileSync(join(migrated.projectRoot, 'owner.txt'), 'utf8'), 'Keep this exact project at this exact path.');
  const persisted = upgraded.db.prepare('SELECT data FROM jobs WHERE id=?').get(migrated.id).data;
  upgraded.close();
  const restarted = new Store(f.config.stateDir);
  try {
    assert.equal(restarted.db.prepare('SELECT data FROM jobs WHERE id=?').get(migrated.id).data, persisted);
    assert.throws(() => restarted.update(migrated.id, { projectRoot: f.root }));
    assert.equal(restarted.get(migrated.id).projectRoot, migrated.projectRoot);
  } finally { restarted.close(); }
});

test('an active v3 host claim blocks upgrade without rewriting its token or source', t => {
  const f = legacyFixture(t, {}, true);
  assert.throws(() => new Store(f.config.stateDir));
  const db = new DatabaseSync(join(f.config.stateDir, 'queue.sqlite'));
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(db.prepare('SELECT data FROM jobs WHERE id=?').get(f.job.id).data, f.original);
    assert.deepEqual(db.prepare('SELECT seq,job,at,data FROM events ORDER BY seq').all(), f.events);
    assert.equal(readFileSync(join(f.job.workspace, 'owner.txt'), 'utf8'), 'Keep this exact project at this exact path.');
  } finally { db.close(); }
});

for (const transformed of [false, true]) test(`live-project successors preserve owner edits and require fresh proof (${transformed ? 'private execution' : 'direct execution'})`, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apphx-live-successor-')));
  const projectRoot = join(root, 'project');
  mkdirSync(join(projectRoot, 'lib'), { recursive: true });
  writeFileSync(join(projectRoot, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(projectRoot, 'lib/main.dart'), 'void main() {}\n');
  const config = ConfigSchema.parse({ projectMode: 'project', projectRoot, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    verification: { checks: [[process.execPath, '--version']], runtime: [[process.execPath, '--version']] },
    ...(transformed ? { obfuscation: { options: { code: { removeComments: true } } } } : {}) });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const input = { ...spec, platform: 'ios', channel: 'app-store' };
  const previous = store.enqueue(input, config);
  const snapshot = prepareExecutionWorkspace(store, previous);
  store.update(previous.id, { ...snapshot, status: 'built', stage: 'package', verifiedDigest: sourceDigest(previous.workspace, true, 'flutter'), verifiedDependencyDigest: dependencyDigest(previous.workspace, 'flutter') });
  const edited = 'void main() => print("owner changes for the next version");\n';
  writeFileSync(join(projectRoot, 'lib/main.dart'), edited);
  const successor = store.enqueue({ ...input, version: '1.1.0' }, config);
  prepareWorkspace(store, successor);
  assert.equal(successor.projectRoot, projectRoot);
  assert.equal(successor.baseJobId, previous.id);
  assert.equal(readFileSync(join(projectRoot, 'lib/main.dart'), 'utf8'), edited);
  assert.equal(successor.stage, 'research');
  assert.equal(successor.verifiedDigest ?? null, null);
  assert.equal(successor.verifiedDependencyDigest ?? null, null);
  assert.throws(() => store.enqueue({ ...input, version: '1.2.0' }, { ...config, projectMode: 'isolated' }));
});
