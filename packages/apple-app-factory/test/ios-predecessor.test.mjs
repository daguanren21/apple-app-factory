import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigSchema, SpecSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { prepareWorkspace, projectDirectory, sourceDigest } from '../dist/workspace.js';
import { dependencyDigest } from '../dist/dependencies.js';
import { scanInbox } from '../dist/inbox.js';

function file(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-ios-predecessor-'));
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    verification: { checks: [['unused']], runtime: [['unused']] } });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const spec = { id: 'ios-continuation', name: 'Owned iOS application', purpose: 'Keep local user records', audience: 'Existing application users', framework: 'flutter', platform: 'ios', channel: 'app-store', version: '1.0.0',
    differentiators: ['Offline owned records'], acceptance: ['Preserve existing records and features'], apple: { appId: '123456', bundleId: 'org.example.owned', manualSetupConfirmed: true, buildNumber: '1' } };
  function finish(job, status = 'built') {
    const directory = job.spec.project?.directory ?? '.';
    file(job.workspace, join(directory, 'lib/model.dart'), 'int total(int a, int b) => a + b;\n');
    file(job.workspace, join(directory, 'build/stale-artifact'), 'old generated output');
    return store.update(job.id, { status, stage: 'package', verifiedDigest: sourceDigest(job.workspace, true, job.spec.framework, directory), verifiedDependencyDigest: dependencyDigest(job.workspace, job.spec.framework, directory) });
  }
  return { root, config, store, spec, finish };
}

test('first iOS App Store intake starts new and the next intake copies its pinned source in isolation', t => {
  const { config, store, spec, finish } = fixture(t);
  const first = store.enqueue(spec, config);
  assert.equal(first.baseJobId, undefined);
  assert.equal(first.automaticBase, undefined);
  const base = finish(first);
  const input = { ...spec, version: '1.1.0', apple: { buildNumber: '2' } };
  const before = structuredClone(input);
  const next = store.enqueue(input, config);
  assert.deepEqual(input, before);
  assert.equal(next.baseJobId, base.id);
  assert.equal(next.baseDigest, base.verifiedDigest);
  assert.equal(next.automaticBase, true);
  assert.deepEqual(next.requestSpec, SpecSchema.parse(input));
  assert.equal(next.config.allowCloudBuild, false);
  assert.deepEqual(next.receipt, {});
  assert.equal(existsSync(next.workspace), false);
  prepareWorkspace(store, next);
  assert.equal(store.get(next.id).basePrepared, true);
  assert.equal(sourceDigest(next.workspace, true, 'flutter'), base.verifiedDigest);
  assert.equal(existsSync(join(next.workspace, 'build/stale-artifact')), false);
  file(next.workspace, 'lib/model.dart', 'changed successor source');
  assert.equal(readFileSync(join(base.workspace, 'lib/model.dart'), 'utf8'), 'int total(int a, int b) => a + b;\n');
  prepareWorkspace(store, store.get(next.id));
  assert.equal(readFileSync(join(next.workspace, 'lib/model.dart'), 'utf8'), 'changed successor source');
});

test('automatic reuse inherits the nested project without rewriting original intake', t => {
  const { config, store, spec, finish } = fixture(t);
  const base = finish(store.enqueue({ ...spec, project: { directory: 'apps/ios' } }, config));
  const input = { ...spec, version: '2.0.0' };
  const next = store.enqueue(input, config);
  assert.equal(next.requestSpec.project, undefined);
  assert.deepEqual(next.spec.project, { directory: 'apps/ios' });
  assert.equal(projectDirectory(next), join(next.workspace, 'apps/ios'));
  prepareWorkspace(store, next);
  assert.equal(readFileSync(join(next.workspace, 'apps/ios/lib/model.dart'), 'utf8'), 'int total(int a, int b) => a + b;\n');
  assert.equal(existsSync(join(next.workspace, 'apps/ios/build')), false);
  assert.equal(sourceDigest(next.workspace, true, 'flutter', 'apps/ios'), base.verifiedDigest);
  assert.equal(store.checkIngest(input).id, next.id);
  for (const directory of ['.', 'apps/other']) {
    assert.throws(() => store.enqueue({ ...spec, version: `different-${directory}`, project: { directory } }, config), /project.directory/);
  }
});

test('automatic reuse copies the prior workspace, not its original imported source directory', t => {
  const { root, config, store, spec, finish } = fixture(t);
  const source = join(root, 'original-source');
  file(source, 'apps/ios/lib/model.dart', 'original imported code');
  const imported = store.enqueue({ ...spec, project: { sourceDir: source, directory: 'apps/ios' } }, config);
  prepareWorkspace(store, imported);
  const base = finish(store.get(imported.id));
  file(source, 'apps/ios/lib/model.dart', 'unverified edits outside the predecessor workspace');
  const next = store.enqueue({ ...spec, version: '2.0.0' }, config);
  assert.equal(next.baseJobId, base.id);
  assert.equal(next.sourceDirectory, undefined);
  assert.deepEqual(next.spec.project, { directory: 'apps/ios' });
  assert.equal(next.requestSpec.project, undefined);
  prepareWorkspace(store, next);
  assert.equal(readFileSync(join(next.workspace, 'apps/ios/lib/model.dart'), 'utf8'), 'int total(int a, int b) => a + b;\n');
  assert.equal(sourceDigest(next.workspace, true, 'flutter', 'apps/ios'), base.verifiedDigest);
});

test('automatic intake stays idempotent after newer history and cannot be replaced by an explicit base', t => {
  const { config, store, spec, finish } = fixture(t);
  const base = finish(store.enqueue(spec, config));
  const input = { ...spec, version: '2.0.0' };
  delete input.apple;
  const accepted = store.ingest('second.json', 'second-digest', input, config);
  const next = store.get(accepted.jobId);
  const latest = finish(store.enqueue({ ...spec, version: '3.0.0' }, config));
  assert.equal(latest.baseJobId, base.id);
  file(base.workspace, 'lib/model.dart', 'base changed after later intake');
  const pinned = store.checkIngest(input);
  assert.equal(pinned.id, next.id);
  assert.equal(pinned.baseJobId, base.id);
  assert.equal(store.ingest('second.json', 'same-content-new-digest', input, config).jobId, next.id);
  assert.throws(() => store.checkIngest(input, base.id), /immutable/);
  assert.throws(() => store.checkIngest(input, latest.id), /immutable/);
  assert.throws(() => store.checkIngest({ ...input, acceptance: ['Different requirements'] }), /immutable/);
  assert.throws(() => store.update(next.id, { automaticBase: undefined }), /Pinned/);
  assert.throws(() => store.update(next.id, { baseJobId: latest.id }), /Pinned/);
  assert.throws(() => store.update(next.id, { baseDigest: '0'.repeat(64) }), /Pinned/);
  assert.throws(() => store.update(next.id, { requestSpec: { ...next.requestSpec, name: 'Rewritten intake' } }), /Original intake/);
  const reopened = new Store(config.stateDir);
  try {
    assert.equal(reopened.checkIngest(input).baseJobId, base.id);
    assert.equal(reopened.get(next.id).automaticBase, true);
    assert.deepEqual(reopened.get(next.id).requestSpec, SpecSchema.parse(input));
  } finally { reopened.close(); }
});

for (const status of ['built', 'ready']) {
  test(`automatic predecessor accepts finished ${status} history`, t => {
    const { config, store, spec, finish } = fixture(t);
    const base = finish(store.enqueue(spec, config), status);
    assert.equal(store.enqueue({ ...spec, version: '2.0.0' }, config).baseJobId, base.id);
  });
}

test('selection uses enqueue order among finished versions, not version order or newest unfinished work', t => {
  const { config, store, spec, finish } = fixture(t);
  const older = finish(store.enqueue({ ...spec, version: '9.0.0' }, config));
  const latest = finish(store.enqueue({ ...spec, version: '1.1.0' }, config));
  store.update(older.id, { createdAt: Date.now() + 10000 });
  store.enqueue({ ...spec, version: 'unfinished' }, config);
  const next = store.enqueue({ ...spec, version: '1.2.0' }, config);
  assert.equal(next.baseJobId, latest.id);
});

for (const kind of ['source', 'dependencies']) {
  test(`stale newest predecessor ${kind} rejects instead of falling back or creating fresh source`, t => {
    const { config, store, spec, finish } = fixture(t);
    finish(store.enqueue(spec, config));
    const latest = finish(store.enqueue({ ...spec, version: '2.0.0' }, config));
    if (kind === 'source') file(latest.workspace, 'lib/model.dart', 'unverified change');
    else file(latest.workspace, '.dart_tool/package_config.json', JSON.stringify({ configVersion: 2, packages: [] }));
    assert.throws(() => store.enqueue({ ...spec, version: '3.0.0' }, config), /changed after verification/);
    assert.equal(store.list().length, 2);
  });
}

test('source changed after automatic intake is refused by the existing copy gate', t => {
  const { config, store, spec, finish } = fixture(t);
  const base = finish(store.enqueue(spec, config));
  const next = store.enqueue({ ...spec, version: '2.0.0' }, config);
  file(base.workspace, 'lib/model.dart', 'changed between intake and prepare');
  assert.throws(() => prepareWorkspace(store, next), /changed since intake/);
  assert.equal(existsSync(next.workspace), false);
  assert.notEqual(store.get(next.id).basePrepared, true);
});

test('unfinished history and unverified newest finished history refuse a fresh application', t => {
  const { config, store, spec, finish } = fixture(t);
  const first = store.enqueue(spec, config);
  assert.throws(() => store.enqueue({ ...spec, version: '2.0.0' }, config), /none is finished/);
  finish(first);
  const latest = finish(store.enqueue({ ...spec, version: '2.0.0' }, config));
  store.update(latest.id, { verifiedDigest: null });
  assert.throws(() => store.enqueue({ ...spec, version: '3.0.0' }, config), /finished, verified/);
  store.update(latest.id, { verifiedDigest: sourceDigest(latest.workspace, true, 'flutter'), manualRecovery: 'uncertain external work' });
  assert.throws(() => store.enqueue({ ...spec, version: '3.0.0' }, config), /no active work/);
});

test('framework mismatch in newest finished history is not skipped', t => {
  const { config, store, spec, finish } = fixture(t);
  finish(store.enqueue(spec, config));
  const swiftConfig = { ...config, packaging: { commands: [['unused']], artifactPath: 'build/app' } };
  assert.throws(() => store.enqueue({ ...spec, version: '2.0.0', framework: 'swift' }, swiftConfig), /same product, platform, channel and framework/);
  assert.equal(store.list().length, 1);
});

test('explicit import and explicit base keep precedence over automatic history', t => {
  const { root, config, store, spec, finish } = fixture(t);
  const older = finish(store.enqueue(spec, config));
  const latest = finish(store.enqueue({ ...spec, version: '2.0.0' }, config));
  file(latest.workspace, 'lib/model.dart', 'stale latest source');
  const explicit = store.enqueue({ ...spec, version: '3.0.0' }, config, older.id);
  assert.equal(explicit.baseJobId, older.id);
  assert.equal(explicit.automaticBase, undefined);
  assert.equal(store.checkIngest(explicit.requestSpec, older.id).id, explicit.id);
  assert.throws(() => store.checkIngest(explicit.requestSpec), /immutable/);
  const importedRoot = join(root, 'imported');
  file(importedRoot, 'lib/model.dart', 'explicit imported revision');
  const input = { ...spec, version: '4.0.0', project: { sourceDir: importedRoot } };
  const imported = store.enqueue(input, config);
  assert.equal(imported.baseJobId, undefined);
  assert.equal(imported.automaticBase, undefined);
  assert.equal(imported.sourceDirectory, realpathSync(importedRoot));
  prepareWorkspace(store, imported);
  assert.equal(readFileSync(join(imported.workspace, 'lib/model.dart'), 'utf8'), 'explicit imported revision');
  assert.throws(() => store.enqueue({ ...input, version: '5.0.0' }, config, older.id), /mutually exclusive/);
});

for (const [platform, channel, packageTarget] of [['ios', 'local', 'simulator'], ['android', 'local', 'apk'], ['android', 'google-play', 'aab']]) {
  test(`${platform}/${channel} intake remains independent unless a base is explicit`, t => {
    const { config, store, spec, finish } = fixture(t);
    const input = { ...spec, platform, channel };
    const targetConfig = { ...config, packageTarget };
    const base = finish(store.enqueue(input, targetConfig));
    file(base.workspace, 'lib/model.dart', 'stale unrelated-channel history');
    const next = store.enqueue({ ...input, version: '2.0.0' }, targetConfig);
    assert.equal(next.baseJobId, undefined);
    assert.equal(next.automaticBase, undefined);
    assert.deepEqual(next.spec, SpecSchema.parse({ ...input, version: '2.0.0' }));
    assert.throws(() => store.enqueue({ ...input, version: '3.0.0' }, targetConfig, base.id), /changed after verification/);
    const appStore = store.enqueue({ ...spec, version: '2.0.0' }, config);
    if (channel === 'local' || platform === 'android') assert.equal(appStore.baseJobId, undefined);
  });
}

test('observed same-product version batches predict actual unfinished predecessor admission', async t => {
  const { root, config, store, spec } = fixture(t);
  const directory = join(root, 'inbox');
  file(directory, 'a.json', JSON.stringify(spec));
  file(directory, 'b.json', JSON.stringify({ ...spec, version: '2.0.0' }));
  file(directory, 'c.json', JSON.stringify({ ...spec, id: 'independent-product' }));
  file(directory, 'd.json', JSON.stringify(spec));
  const configured = { ...config, inbox: { directory, pollMs: 2000 } };
  const observed = await scanInbox(store, configured, { observe: true });
  assert.deepEqual(observed.entries.map(entry => entry.status), ['accepted', 'error', 'accepted', 'accepted']);
  assert.deepEqual(store.list(), []);
  const applied = await scanInbox(store, configured);
  assert.deepEqual(applied.entries.map(entry => entry.status), observed.entries.map(entry => entry.status));
  assert.equal(applied.entries[0].jobId, applied.entries[3].jobId);
  assert.deepEqual(store.list().map(job => job.spec.id), [spec.id, 'independent-product']);
});

test('a duplicate pending intake remains accepted after a later explicit imported version', async t => {
  const { root, config, store, spec } = fixture(t);
  const directory = join(root, 'inbox');
  const source = join(root, 'existing');
  file(source, 'lib/model.dart', 'explicitly selected source');
  file(directory, 'a.json', JSON.stringify(spec));
  file(directory, 'b.json', JSON.stringify({ ...spec, version: '2.0.0', project: { sourceDir: source } }));
  file(directory, 'c.json', JSON.stringify(spec));
  const configured = { ...config, inbox: { directory, pollMs: 2000 } };
  const observed = await scanInbox(store, configured, { observe: true });
  assert.deepEqual(observed.entries.map(entry => entry.status), ['accepted', 'accepted', 'accepted']);
  const applied = await scanInbox(store, configured);
  assert.deepEqual(applied.entries.map(entry => entry.status), observed.entries.map(entry => entry.status));
  assert.equal(applied.entries[0].jobId, applied.entries[2].jobId);
  assert.equal(store.list().length, 2);
});
