import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { ConfigSchema, SpecSchema, validateJobConfig } from '../dist/schemas.js';
import { loadConfig, validateProjectSource } from '../dist/config.js';
import { dependencyDigest } from '../dist/dependencies.js';
import { submitRequirement, scanInbox } from '../dist/inbox.js';
import { parseRequirement } from '../dist/requirements.js';
import { Store } from '../dist/store.js';
import { runStep } from '../dist/scheduler.js';
import { prepareWorkspace, sourceDigest } from '../dist/workspace.js';

const digest = 'a'.repeat(64);
const product = { id: 'neutral-product', name: 'Neutral product', purpose: 'Preserve an existing project', audience: 'Project maintainers', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Owner-controlled checks'], acceptance: ['Preserve source and enforce configured checks'] };
const checks = { checks: [[process.execPath, '--version']], runtime: [[process.execPath, '--version']] };
const packaging = { commands: [[process.execPath, '--version']], artifactPath: 'build/app.apk' };

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-multistack-contract-'));
  const config = ConfigSchema.parse({ configPath: join(root, 'factory.json'), stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator', verification: checks, inbox: { directory: join(root, 'inbox') }, ...overrides });
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  const open = () => { const store = new Store(config.stateDir); stores.push(store); return store; };
  return { root, config, open };
}

function legacyQueue(t, version = 2, patch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-v3-migration-'));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  const id = randomUUID(), now = Date.now();
  const spec = { id: 'legacy-product', name: 'Legacy product', purpose: 'Retain a saved Apple task', audience: 'Existing owners', framework: 'flutter', differentiators: ['Saved receipts and budgets'], acceptance: ['Reverify before reuse'], apple: { version: '2.4.0', screenshotsDir: 'screenshots', buildNumber: '7' } };
  const config = { stateDir, workspaceRoot: join(root, 'workspaces'), verification: checks, allowSubmit: false };
  const saved = { id, spec, requestSpec: structuredClone(spec), config, stage: 'package', status: 'ready', createdAt: now - 1000, updatedAt: now - 500, nextAt: now + 1000, attempts: { build: 2, verify: 1 }, hostTurns: 5, turn: null, groups: [], commands: {}, receipt: {}, logs: ['retained history'], workspace: join(config.workspaceRoot, id), verifiedDigest: digest, verifiedDependencyDigest: digest, screenshotDigest: digest, verifiedAt: new Date(now).toISOString(), review: { approved: true, findings: [], acceptanceEvidence: [] }, artifact: { kind: 'ios-simulator', path: join(root, 'old.app'), digest, createdAt: new Date(now).toISOString() }, ...patch };
  if (version === 1) {
    saved.agentCalls = saved.hostTurns;
    delete saved.hostTurns;
    saved.config.agentEnv = ['OWNER_CHECK_SETTING'];
    saved.config.maxAgentCalls = 12;
    saved.config.builder = { kind: 'codex' };
  }
  const text = JSON.stringify(saved);
  const db = new DatabaseSync(join(stateDir, 'queue.sqlite'));
  db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, product TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, next_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(product,version));
    CREATE TABLE events (seq INTEGER PRIMARY KEY, job TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE worker (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);
    CREATE TABLE inbox (source TEXT PRIMARY KEY, digest TEXT, data TEXT NOT NULL);
    PRAGMA user_version=${version};`);
  db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(id, spec.id, spec.apple.version, saved.status, saved.nextAt, text);
  db.prepare('INSERT INTO events(job,at,data) VALUES(?,?,?)').run(id, now, JSON.stringify({ status: 'saved', detail: 'Do not rewrite history during migration' }));
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, stateDir, id, saved, text, db, open() { const store = new Store(stateDir); stores.push(store); return store; } };
}

async function pauseMigrationBeforeLock(t, f, version) {
  const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { DatabaseSync } from 'node:sqlite';
    const { Store } = await import(workerData.module);
    const original = DatabaseSync.prototype.exec;
    let paused = false;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'BEGIN IMMEDIATE' && !paused) {
        paused = true;
        parentPort.postMessage({ version: Number(this.prepare('PRAGMA user_version').get().user_version) });
        Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      }
      return original.call(this, sql);
    };
    let result;
    try {
      const store = new Store(workerData.directory);
      try { result = { job: store.get(workerData.id) }; }
      finally { store.close(); }
    } catch (error) {
      result = { error: error.message };
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    parentPort.postMessage(result);
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { workerData: { gate: gate.buffer, directory: f.stateDir, id: f.id, module: new URL('../dist/store.js', import.meta.url).href } });
  t.after(async () => { await worker.terminate(); });
  assert.deepEqual((await once(worker, 'message', { signal: AbortSignal.timeout(10000) }))[0], { version });
  return async () => {
    const completed = once(worker, 'message', { signal: AbortSignal.timeout(10000) });
    const exited = once(worker, 'exit', { signal: AbortSignal.timeout(10000) });
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const [result] = await completed;
    assert.equal((await exited)[0], 0);
    return result;
  };
}

function migratedQueueSnapshot(db) {
  return {
    version: db.prepare('PRAGMA user_version').get().user_version,
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
    jobs: db.prepare('SELECT * FROM jobs ORDER BY rowid').all(),
    events: db.prepare('SELECT * FROM events ORDER BY seq').all(),
    worker: db.prepare('SELECT * FROM worker ORDER BY id').all(),
    inbox: db.prepare('SELECT * FROM inbox ORDER BY source').all(),
    migrations: db.prepare('SELECT * FROM snapshot_migrations ORDER BY job,version').all(),
  };
}

test('all supported stacks declare a platform and retain neutral release identities', () => {
  for (const framework of ['flutter', 'android-java', 'swift', 'react-native', 'expo', 'uni-app']) {
    for (const platform of ['ios', 'android']) {
      const value = { ...product, framework, platform };
      if ((framework === 'android-java' && platform === 'ios') || (framework === 'swift' && platform === 'android')) assert.throws(() => SpecSchema.parse(value));
      else assert.equal(SpecSchema.parse(value).framework, framework);
    }
  }
  const { platform, channel, version, ...missingPlatform } = product;
  assert.throws(() => SpecSchema.parse(missingPlatform));
  assert.deepEqual({ channel: SpecSchema.parse({ ...missingPlatform, platform }).channel, version: SpecSchema.parse({ ...missingPlatform, platform }).version }, { channel: 'local', version: '1.0.0' });
  for (const apple of [{ version: '1.0.0' }, { screenshotsDir: 'screenshots' }]) assert.throws(() => SpecSchema.parse({ ...product, apple }));
  assert.throws(() => SpecSchema.parse({ ...product, channel: 'google-play' }));
  assert.throws(() => SpecSchema.parse({ ...product, platform: 'android', channel: 'app-store' }));
});

test('requirements reject path traversal and command or permission injection', () => {
  assert.equal(parseRequirement({ ...product, project: { sourceDir: 'existing' } }).spec.project.directory, '.');
  assert.equal(parseRequirement({ ...product, project: { directory: 'apps/mobile' }, baseJobId: randomUUID() }).spec.project.directory, 'apps/mobile');
  for (const directory of ['/tmp/app', '../app', 'app/../../outside', 'C:\\app', '..\\outside', 'app/../other']) assert.throws(() => parseRequirement({ ...product, project: { directory } }));
  assert.throws(() => parseRequirement({ ...product, project: { sourceDir: 'existing' }, baseJobId: randomUUID() }));
  for (const patch of [{ packaging }, { allowCloudBuild: true }, { hiddenFeatures: true }, { reviewBypass: true }]) assert.throws(() => parseRequirement({ ...product, ...patch }));
});

test('packager configuration is explicit, strict, owner-controlled and cloud opt-in', t => {
  const f = fixture(t);
  const { packageTarget, ...missingTarget } = f.config;
  assert.throws(() => ConfigSchema.parse(missingTarget));
  for (const artifactPath of ['/tmp/app.apk', '../app.apk', 'build/../app.apk', 'build/*.apk', 'build/app?.apk', 'C:\\build\\app.apk', '.']) assert.throws(() => ConfigSchema.parse({ ...f.config, packaging: { ...packaging, artifactPath } }));
  for (const commands of [[], [[]], [[' ']]]) assert.throws(() => ConfigSchema.parse({ ...f.config, packaging: { ...packaging, commands } }));
  assert.throws(() => ConfigSchema.parse({ ...f.config, packaging: { ...packaging, plugin: 'untrusted-module' } }));
  assert.throws(() => ConfigSchema.parse({ ...f.config, packaging: { ...packaging, provider: 'cloud' } }));
  const allowed = ConfigSchema.parse({ ...f.config, allowCloudBuild: true, packaging: { ...packaging, provider: 'cloud' } });
  assert.equal(allowed.packaging.provider, 'cloud');
  assert.equal(ConfigSchema.parse({ ...f.config, packaging }).packaging.provider, 'local');
  assert.throws(() => ConfigSchema.parse({ ...f.config, allowSubmit: true }));
  assert.throws(() => ConfigSchema.parse({ ...f.config, allowRelease: true }));
  assert.throws(() => ConfigSchema.parse({ ...f.config, verification: { checks: [], runtime: checks.runtime } }));
  assert.throws(() => ConfigSchema.parse({ ...f.config, verification: { checks: checks.checks, runtime: [] } }));
});

test('spec and configuration cross-validation never assumes an Apple workflow', t => {
  const f = fixture(t);
  validateJobConfig(SpecSchema.parse(product), f.config);
  for (const framework of ['android-java', 'swift', 'react-native', 'expo', 'uni-app']) {
    const platform = framework === 'swift' ? 'ios' : 'android';
    const spec = SpecSchema.parse({ ...product, framework, platform });
    const config = ConfigSchema.parse({ ...f.config, packageTarget: platform === 'ios' ? 'ipa' : 'apk' });
    assert.throws(() => validateJobConfig(spec, config), /packaging/);
    validateJobConfig(spec, ConfigSchema.parse({ ...config, packaging }));
    assert.throws(() => validateJobConfig(spec, ConfigSchema.parse({ ...config, packaging, toolchain: { flutterSdk: '/owner/flutter' } })), /flutterSdk/);
  }
  const android = SpecSchema.parse({ ...product, platform: 'android' });
  assert.throws(() => validateJobConfig(android, f.config), /does not match/);
  const apk = ConfigSchema.parse({ ...f.config, packageTarget: 'apk' });
  validateJobConfig(android, apk);
  assert.throws(() => validateJobConfig(SpecSchema.parse({ ...android, channel: 'google-play' }), apk), /aab/);
  validateJobConfig(SpecSchema.parse({ ...android, channel: 'google-play' }), ConfigSchema.parse({ ...apk, packageTarget: 'aab' }));
  validateJobConfig(SpecSchema.parse({ ...product, channel: 'app-store' }), ConfigSchema.parse({ ...f.config, packageTarget: 'ipa' }));
});

test('queue uniqueness uses product/platform/channel/version, not framework or purpose', t => {
  const f = fixture(t), store = f.open();
  const first = store.enqueue(product, f.config);
  assert.equal(store.checkIngest(product).id, first.id);
  store.enqueue({ ...product, id: 'same-audience' }, f.config);
  store.enqueue({ ...product, channel: 'app-store' }, f.config);
  store.enqueue({ ...product, platform: 'android' }, { ...f.config, packageTarget: 'apk' });
  store.enqueue({ ...product, version: '2.0.0' }, f.config);
  assert.equal(store.list().length, 5);
  assert.throws(() => store.enqueue({ ...product, framework: 'expo' }, { ...f.config, packaging }), /immutable requirements/);
  assert.throws(() => store.enqueue({ ...product, name: 'Changed requirements' }, f.config), /immutable requirements/);
  for (const patch of [{ platform: 'android' }, { channel: 'app-store' }, { version: '9.0.0' }, { framework: 'expo' }]) assert.throws(() => store.update(first.id, { spec: { ...first.spec, ...patch } }));
});

test('predecessors require a current proof and the same stack, platform and channel', t => {
  const f = fixture(t), store = f.open();
  const base = store.enqueue(product, f.config);
  mkdirSync(base.workspace, { recursive: true });
  writeFileSync(join(base.workspace, 'pubspec.yaml'), 'name: predecessor_fixture\n');
  writeFileSync(join(base.workspace, 'main.dart'), 'void main() {}\n');
  const next = { ...product, version: '2.0.0' };
  assert.throws(() => store.enqueue(next, f.config, base.id), /finished, verified/);
  store.update(base.id, { status: 'built', stage: 'package', verifiedDigest: sourceDigest(base.workspace, true, 'flutter'), verifiedDependencyDigest: dependencyDigest(base.workspace, 'flutter') });
  const successor = store.enqueue(next, f.config, base.id);
  assert.equal(successor.baseDigest, store.get(base.id).verifiedDigest);
  for (const spec of [{ ...next, version: '3.0.0', channel: 'app-store' }, { ...next, version: '3.0.0', platform: 'android' }, { ...next, version: '3.0.0', framework: 'expo' }]) assert.throws(() => store.enqueue(spec, { ...f.config, packageTarget: spec.platform === 'android' ? 'apk' : 'simulator', ...(spec.framework === 'expo' ? { packaging } : {}) }, base.id), /same product, platform, channel and framework/);
  writeFileSync(join(base.workspace, 'main.dart'), 'void main() { print("changed"); }\n');
  assert.throws(() => store.enqueue({ ...next, version: '4.0.0' }, f.config, base.id), /source changed/);
});

test('imports resolve relative to config, pin canonical source, and never create an unpinned workspace', t => {
  const f = fixture(t), store = f.open();
  const source = join(f.root, 'existing');
  mkdirSync(join(source, 'apps', 'mobile'), { recursive: true });
  writeFileSync(join(source, 'apps', 'mobile', 'pubspec.yaml'), 'name: imported_fixture\n');
  writeFileSync(join(source, 'owned.txt'), 'original source\n');
  const spec = { ...product, project: { sourceDir: 'existing', directory: 'apps/mobile' } };
  const before = sourceDigest(source, true, 'flutter', 'apps/mobile');
  const job = store.enqueue(spec, f.config);
  assert.equal(job.sourceDirectory, realpathSync(source));
  assert.equal(job.importDigest, before);
  assert.equal(job.importPrepared, false);
  assert.equal(job.requestSpec.project.sourceDir, 'existing');
  assert.equal(existsSync(job.workspace), false);
  assert.equal(sourceDigest(source, true, 'flutter', 'apps/mobile'), before);
  assert.throws(() => store.update(job.id, { importDigest: digest }), /Pinned project/);
  assert.throws(() => store.update(job.id, { config: { ...job.config, workspaceRoot: source } }), /Pinned project source/);
  assert.throws(() => store.update(job.id, { config: { ...job.config, stateDir: source } }), /Pinned project source/);
  writeFileSync(join(source, 'owned.txt'), 'changed after intake\n');
  assert.throws(() => prepareWorkspace(store, store.get(job.id)), /source changed/i);
  assert.equal(existsSync(job.workspace), false);
  assert.equal(readFileSync(join(source, 'owned.txt'), 'utf8'), 'changed after intake\n');
});

test('read-only import preflight rejects source/state/workspace overlaps in both directions', t => {
  const f = fixture(t);
  const source = join(f.root, 'existing');
  mkdirSync(source);
  for (const config of [
    { ...f.config, stateDir: join(source, 'state') },
    { ...f.config, stateDir: f.root },
    { ...f.config, workspaceRoot: join(source, 'workspaces') },
    { ...f.config, workspaceRoot: f.root },
  ]) assert.throws(() => validateProjectSource(SpecSchema.parse({ ...product, project: { sourceDir: source } }), config), /must not overlap/);
  assert.equal(existsSync(join(source, 'state')), false);
  assert.equal(existsSync(join(source, 'workspaces')), false);
  assert.equal(existsSync(f.config.stateDir), false);
});

test('imports reject root symlinks and escaping source links without enqueueing', t => {
  const f = fixture(t), store = f.open();
  const source = join(f.root, 'existing'), external = join(f.root, 'external');
  mkdirSync(source); mkdirSync(external);
  writeFileSync(join(source, 'pubspec.yaml'), 'name: symlink_fixture\n');
  writeFileSync(join(external, 'secret.txt'), 'outside source\n');
  symlinkSync(source, join(f.root, 'source-link'));
  assert.throws(() => store.enqueue({ ...product, project: { sourceDir: 'source-link' } }, f.config), /symlink/);
  symlinkSync(join(external, 'secret.txt'), join(source, 'escape.txt'));
  assert.throws(() => store.enqueue({ ...product, project: { sourceDir: 'existing' } }, f.config), /symlink/);
  assert.equal(store.list().length, 0);
});

test('config loading rejects nested state/workspace ownership in either direction', t => {
  const f = fixture(t);
  for (const [stateDir, workspaceRoot] of [['owned', 'owned/workspaces'], ['owned/state', 'owned']]) {
    writeFileSync(f.config.configPath, JSON.stringify({ ...f.config, stateDir, workspaceRoot }));
    assert.throws(() => loadConfig(f.config.configPath), /must not overlap/);
  }
});

test('inbox filenames include platform and channel while local intake needs no Apple metadata', async t => {
  const f = fixture(t), store = f.open();
  const first = submitRequirement(f.config, product);
  const appStore = submitRequirement(f.config, { ...product, channel: 'app-store' });
  const android = submitRequirement({ ...f.config, packageTarget: 'apk' }, { ...product, platform: 'android' });
  assert.equal(new Set([first.path, appStore.path, android.path]).size, 3);
  assert.equal(submitRequirement(f.config, product).path, first.path);
  const scan = await scanInbox(store, f.config);
  assert.equal(scan.entries.filter(entry => entry.status === 'accepted').length, 2);
  assert.equal(scan.entries.filter(entry => entry.status === 'error').length, 1, 'an iOS owner profile must reject the Android target mismatch');
  assert.equal(store.list().length, 2);
});

for (const version of [1, 2]) test(`v${version} migration is transactional, snapshots original bytes and replaces legacy Apple identities`, t => {
  const f = legacyQueue(t, version);
  const events = f.db.prepare('SELECT seq,at,data FROM events ORDER BY seq').all();
  const store = f.open(), job = store.get(f.id);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(job.spec.framework, 'flutter');
  assert.equal(job.spec.platform, 'ios');
  assert.equal(job.spec.channel, 'app-store');
  assert.equal(job.spec.version, '2.4.0');
  assert.equal(job.spec.screenshotsDir, 'screenshots');
  assert.equal(Object.hasOwn(job.spec.apple, 'version'), false);
  assert.equal(Object.hasOwn(job.spec.apple, 'screenshotsDir'), false);
  assert.deepEqual(job.requestSpec, job.spec);
  assert.equal(job.config.packageTarget, 'simulator');
  assert.equal(job.hostTurns, 5);
  assert.deepEqual(job.attempts, f.saved.attempts);
  assert.equal(job.createdAt, f.saved.createdAt);
  assert.equal(job.nextAt, f.saved.nextAt);
  assert.equal(job.stage, 'verify');
  assert.equal(job.status, 'blocked');
  assert.equal(job.verifiedDigest, null);
  assert.equal(job.verifiedDependencyDigest, null);
  assert.equal(job.screenshotDigest, null);
  assert.equal(job.review, null);
  assert.equal(job.artifact, null);
  assert.equal(job.verifiedAt, undefined);
  assert.equal(store.db.prepare('SELECT data FROM snapshot_migrations WHERE job=? AND version=?').get(f.id, version).data, f.text);
  assert.deepEqual(store.db.prepare('SELECT seq,at,data FROM events ORDER BY seq').all(), events);
  const persisted = store.db.prepare('SELECT data FROM jobs WHERE id=?').get(f.id).data;
  assert.equal(f.open().db.prepare('SELECT data FROM jobs WHERE id=?').get(f.id).data, persisted);
  if (version === 1) {
    assert.equal(Object.hasOwn(job.config, 'builder'), false);
    assert.deepEqual(job.config.executionEnv, ['OWNER_CHECK_SETTING']);
    assert.equal(job.config.maxHostTurns, 12);
  }
});

for (const active of ['none', 'owner', 'turn']) test(`competing constructors preserve fresh v3 proof and all queue data (${active})`, async t => {
  const f = legacyQueue(t);
  const resume = await pauseMigrationBeforeLock(t, f, 2);
  const store = f.open();
  const expected = store.update(f.id, {
    stage: 'review', status: 'waiting', error: null,
    verifiedDigest: 'b'.repeat(64), verifiedDependencyDigest: 'c'.repeat(64), screenshotDigest: 'd'.repeat(64),
    verifiedAt: new Date().toISOString(), review: f.saved.review,
    artifact: { ...f.saved.artifact, digest: 'e'.repeat(64) },
    receipt: { buildId: 'fresh-build' }, hostTurns: f.saved.hostTurns + 1,
    logs: [...f.saved.logs, 'Fresh verification completed after migration'],
    ...(active === 'turn' ? { turn: { id: randomUUID(), stage: 'review', createdAt: Date.now(), contextDigest: digest } } : {}),
  });
  if (active === 'owner') f.db.prepare('INSERT INTO worker VALUES(1,?)').run(process.pid);
  const source = join(f.root, 'requirements.json');
  const inbox = { source, digest, status: 'accepted', jobId: f.id, error: null, observedAt: Date.now() };
  f.db.prepare('INSERT INTO inbox VALUES(?,?,?)').run(source, digest, JSON.stringify(inbox));
  const before = migratedQueueSnapshot(f.db);
  assert.deepEqual(await resume(), { job: expected });
  assert.deepEqual(migratedQueueSnapshot(f.db), before);
  assert.deepEqual(before.migrations.map(row => ({ ...row })), [{ job: f.id, version: 2, data: f.text }]);
});

test('a constructor rejects a newer schema reached while waiting without mutating the queue', async t => {
  const f = legacyQueue(t);
  const resume = await pauseMigrationBeforeLock(t, f, 2);
  const store = f.open();
  store.update(f.id, { stage: 'review', status: 'queued', verifiedDigest: 'b'.repeat(64), verifiedDependencyDigest: 'c'.repeat(64) });
  f.db.exec('CREATE TABLE newer_schema_data (data TEXT NOT NULL); PRAGMA user_version=4;');
  f.db.prepare('INSERT INTO newer_schema_data VALUES(?)').run('Preserve data owned by the newer factory');
  const before = migratedQueueSnapshot(f.db);
  const result = await resume();
  assert.match(result.error, /Queue schema 4 is newer than this factory supports/);
  assert.deepEqual(migratedQueueSnapshot(f.db), before);
  assert.equal(f.db.prepare('SELECT data FROM newer_schema_data').get().data, 'Preserve data owned by the newer factory');
});

test('a constructor snapshots the actual intermediate legacy version and bytes found under lock', async t => {
  const f = legacyQueue(t, 1);
  const resume = await pauseMigrationBeforeLock(t, f, 1);
  const text = JSON.stringify({ ...f.saved, logs: [...f.saved.logs, 'Updated by the v2 migrator'] });
  f.db.exec('BEGIN IMMEDIATE');
  f.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(text, f.id);
  f.db.exec('PRAGMA user_version=2; COMMIT;');
  const result = await resume();
  assert.equal(result.error, undefined);
  assert.equal(result.job.stage, 'verify');
  assert.equal(result.job.hostTurns, f.saved.agentCalls);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.deepEqual(f.db.prepare('SELECT * FROM snapshot_migrations').all().map(row => ({ ...row })), [{ job: f.id, version: 2, data: text }]);
});

test('migrated publication receipts block only their task while independent local verification runs', async t => {
  const receipt = { versionId: 'saved-version', buildId: 'saved-build' };
  const f = legacyQueue(t, 2, { stage: 'publish', status: 'waiting', receipt, ipaPath: '/saved/archive.ipa', archiveDigest: digest });
  const store = f.open(), job = store.get(f.id);
  assert.deepEqual(job.receipt, receipt);
  assert.equal(job.ipaPath, '/saved/archive.ipa');
  assert.equal(job.archiveDigest, digest);
  assert.equal(job.stage, 'package');
  assert.equal(job.status, 'blocked');
  assert.equal(job.manualRecovery ?? null, null);
  assert.equal(job.artifact, null);
  assert.equal(job.verifiedDigest, null);
  assert.equal(job.verifiedDependencyDigest, null);
  assert.equal(job.screenshotDigest, null);
  assert.equal(job.verifiedAt, undefined);
  assert.equal(job.review, null);
  const config = ConfigSchema.parse({ ...job.config, allowLocalExecution: true, packageTarget: 'apk', packaging });
  const unrelated = store.enqueue({ ...product, id: 'independent-android', platform: 'android', framework: 'android-java' }, config);
  mkdirSync(unrelated.workspace, { recursive: true });
  writeFileSync(join(unrelated.workspace, 'settings.gradle'), "rootProject.name = 'independent'\n");
  writeFileSync(join(unrelated.workspace, 'build.gradle'), '// owner-controlled verification\n');
  mkdirSync(join(unrelated.workspace, 'src/main'), { recursive: true });
  writeFileSync(join(unrelated.workspace, 'src/main/AndroidManifest.xml'), '<manifest package="test.independent"><application /></manifest>\n');
  store.update(unrelated.id, { stage: 'verify' });
  const verified = await runStep(store, config, unrelated.id);
  assert.equal(verified.stage, 'review', verified.error);
  assert.equal(verified.verifiedDigest, sourceDigest(unrelated.workspace, true, 'android-java'));
  assert.deepEqual(store.get(f.id), job, 'independent verification must not change the blocked receipt task');
});

test('receipt migration preserves genuine preexisting process recovery requirements', t => {
  const manualRecovery = 'Command group 123 has no verifiable ownership and deadline; inspect before retrying';
  const receipt = { buildId: 'saved-build' };
  const f = legacyQueue(t, 2, { stage: 'publish', status: 'waiting', receipt, manualRecovery });
  const job = f.open().get(f.id);
  assert.equal(job.manualRecovery, manualRecovery);
  assert.equal(job.status, 'blocked');
  assert.deepEqual(job.receipt, receipt);
  assert.equal(job.verifiedDigest, null);
});

test('migration refuses active owner and active host turns without altering the old queue', t => {
  for (const active of ['owner', 'turn']) {
    const f = legacyQueue(t);
    let original = f.text;
    if (active === 'owner') f.db.prepare('INSERT INTO worker VALUES(1,?)').run(process.pid);
    else {
      original = JSON.stringify({ ...f.saved, turn: { id: randomUUID(), stage: 'build', createdAt: Date.now(), contextDigest: digest } });
      f.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(original, f.id);
    }
    assert.throws(() => f.open(), active === 'owner' ? /Stop the previous factory execution/ : /Abandon the active host turn/);
    assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(f.db.prepare('SELECT data FROM jobs WHERE id=?').get(f.id).data, original);
  }
});

test('a bad legacy row rolls back migrated data, table identity and schema version together', t => {
  const f = legacyQueue(t);
  const invalid = { ...f.saved, id: randomUUID(), spec: { ...f.saved.spec, id: 'bad-legacy-product' }, config: { ...f.saved.config, verification: { checks: [], runtime: [] } } };
  const invalidText = JSON.stringify(invalid);
  f.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(invalid.id, invalid.spec.id, invalid.spec.apple.version, invalid.status, invalid.nextAt, invalidText);
  assert.throws(() => f.open(), /No migration was committed/);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(f.db.prepare('SELECT data FROM jobs WHERE id=?').get(f.id).data, f.text);
  assert.equal(f.db.prepare('SELECT data FROM jobs WHERE id=?').get(invalid.id).data, invalidText);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='jobs_v3'").get(), undefined);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='snapshot_migrations'").get(), undefined);
  assert.equal(f.db.prepare('PRAGMA table_info(jobs)').all().some(row => row.name === 'platform'), false);
});

test('newer schema versions are rejected without rewriting task data', t => {
  const f = legacyQueue(t);
  f.db.exec('PRAGMA user_version=4;');
  assert.throws(() => f.open(), /newer than this factory supports/);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(f.db.prepare('SELECT data FROM jobs WHERE id=?').get(f.id).data, f.text);
});
