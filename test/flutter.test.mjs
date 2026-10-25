import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { prepareFlutter } from '../dist/flutter.js';
import { executeStep } from '../dist/runner.js';
import { Store } from '../dist/store.js';

const example = JSON.parse(readFileSync(new URL('../examples/factory.json', import.meta.url)));
const product = JSON.parse(readFileSync(new URL('../examples/luggage.json', import.meta.url)));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-flutter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'factory.json');
  writeFileSync(path, JSON.stringify({ ...example, allowLocalExecution: true, toolchain: { flutterSdk: 'sdk' } }));
  return { root, path, config: loadConfig(path) };
}

test('trusted verification cannot select a workspace-owned SDK directly or through a symlink', t => {
  const f = fixture(t);
  const local = join(f.config.workspaceRoot, 'user-sdk');
  mkdirSync(local, { recursive: true });
  const linked = join(f.root, 'linked-sdk');
  symlinkSync(local, linked);
  for (const flutterSdk of [local, linked]) {
    writeFileSync(f.path, JSON.stringify({ ...example, toolchain: { flutterSdk } }));
    assert.throws(() => loadConfig(f.path));
  }
});

test('an unavailable configured SDK blocks without consuming work or model budgets', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  const store = new Store(f.config.stateDir);
  try {
    const job = store.enqueue(product, f.config);
    const result = await executeStep(store, store.update(job.id, { stage: 'build' }));
    assert.equal(result.status, 'blocked');
    assert.equal(result.blockedReason.kind, 'prerequisite');
    assert.equal(result.blockedReason.prerequisite.reason, 'missing-sdk');
    assert.deepEqual(result.attempts, {});
    assert.equal(result.agentCalls, 0);
    store.update(job.id, { nextAt: Date.now() - 1 });
    const retry = store.next();
    assert.equal(retry.id, job.id);
    assert.equal(retry.blockedReason, null);
    const again = await executeStep(store, retry);
    assert.equal(again.agentCalls, 0);
    assert.deepEqual(again.attempts, {});
  } finally { store.close(); }
});

test('SDK preparation never overwrites an unmanaged cache', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  mkdirSync(join(f.config.toolchain.flutterSdk, 'bin'), { recursive: true });
  writeFileSync(join(f.config.toolchain.flutterSdk, 'bin', 'flutter'), 'must not execute');
  const workspace = join(f.config.workspaceRoot, 'fixture');
  const unmanaged = join(workspace, '.factory-cache', 'flutter');
  mkdirSync(unmanaged, { recursive: true });
  const data = join(unmanaged, 'user-data');
  writeFileSync(data, 'preserved');
  await assert.rejects(prepareFlutter({ config: f.config, workspace, spec: product, stage: 'build' }, { run: async () => assert.fail('No command may run before ownership is established') }), error => error.code === 'PREREQUISITE_FAILED' && error.prerequisite.reason === 'cache-conflict');
  assert.equal(readFileSync(data, 'utf8'), 'preserved');
});

test('a cache symlink cannot redirect preparation writes outside its workspace', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  mkdirSync(join(f.config.toolchain.flutterSdk, 'bin'), { recursive: true });
  writeFileSync(join(f.config.toolchain.flutterSdk, 'bin', 'flutter'), 'must not execute');
  const workspace = join(f.config.workspaceRoot, 'fixture');
  const outside = join(f.root, 'outside');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(workspace, '.factory-cache'));
  await assert.rejects(prepareFlutter({ config: f.config, workspace, spec: product, stage: 'build' }, { run: async () => assert.fail('No command may run for an escaping cache') }));
  assert.equal(existsSync(join(outside, '.gitignore')), false);
  assert.equal(existsSync(join(outside, 'flutter')), false);
});

test('a pinned task cannot reuse proof after its verifier SDK is replaced', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  const source = f.config.toolchain.flutterSdk;
  mkdirSync(join(source, 'bin', 'cache'), { recursive: true });
  writeFileSync(join(source, 'bin', 'flutter'), 'must not execute');
  writeFileSync(join(source, 'bin', 'cache', 'flutter.version.json'), JSON.stringify({ frameworkRevision: 'new-framework', engineRevision: 'engine' }));
  const workspace = join(f.config.workspaceRoot, 'fixture');
  const cache = join(workspace, '.factory-cache');
  mkdirSync(join(cache, 'flutter'), { recursive: true });
  const marker = join(cache, 'flutter.json');
  writeFileSync(marker, JSON.stringify({ source: realpathSync(source), frameworkRevision: 'old-framework', engineRevision: 'engine', ready: true }));
  await assert.rejects(prepareFlutter({ config: f.config, workspace, spec: product, stage: 'verify' }, { run: async () => assert.fail('A changed SDK must not execute under old proof') }), error => error.code === 'PREREQUISITE_FAILED' && error.prerequisite.reason === 'sdk-version-changed');
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).frameworkRevision, 'old-framework');
  rmSync(join(cache, 'flutter'), { recursive: true });
  await assert.rejects(prepareFlutter({ config: f.config, workspace, spec: product, stage: 'verify' }, { run: async () => assert.fail('A surviving marker must block initialization after clone deletion') }), error => error.code === 'PREREQUISITE_FAILED' && error.prerequisite.reason === 'sdk-version-changed');
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).frameworkRevision, 'old-framework');
  assert.equal(existsSync(join(cache, 'flutter')), false);
});

for (const removed of ['none', 'clone', 'cache']) {
  test(`a durable task pin survives ${removed} deletion without SDK initialization or repinning`, { skip: process.platform !== 'darwin' }, async t => {
    const f = fixture(t);
    const source = f.config.toolchain.flutterSdk;
    const invoked = join(f.root, 'sdk-invoked');
    mkdirSync(join(source, 'bin', 'cache'), { recursive: true });
    writeFileSync(join(source, 'bin', 'flutter'), `#!/bin/sh\n: > '${invoked}'\nexit 91\n`);
    chmodSync(join(source, 'bin', 'flutter'), 0o700);
    writeFileSync(join(source, 'bin', 'cache', 'flutter.version.json'), JSON.stringify({ frameworkRevision: 'new-framework', engineRevision: 'engine' }));
    const config = { ...f.config, packageTarget: 'ipa', allowSubmit: true, verification: { ...f.config.verification, prerequisites: [] } };
    const store = new Store(config.stateDir);
    try {
      const job = store.enqueue(product, config);
      const cache = join(job.workspace, '.factory-cache');
      const sdk = join(cache, 'flutter');
      const marker = join(cache, 'flutter.json');
      const toolchain = { source: realpathSync(source), frameworkRevision: 'old-framework', engineRevision: 'engine', ready: true };
      mkdirSync(sdk, { recursive: true });
      writeFileSync(marker, JSON.stringify(toolchain));
      if (removed === 'clone') rmSync(sdk, { recursive: true });
      if (removed === 'cache') rmSync(cache, { recursive: true });
      const pinned = store.update(job.id, { stage: 'package', toolchain });
      await assert.rejects(prepareFlutter(pinned, { run: async () => assert.fail('A changed SDK must not initialize, copy, or package') }), error => {
        assert.equal(error.code, 'PREREQUISITE_FAILED');
        assert.deepEqual(error.prerequisite, { reason: 'sdk-version-changed', path: realpathSync(source) });
        return true;
      });
      const result = await executeStep(store, pinned);
      assert.equal(result.status, 'blocked');
      assert.equal(result.stage, 'package');
      assert.deepEqual(result.blockedReason, { kind: 'prerequisite', stage: 'package', prerequisite: { reason: 'sdk-version-changed', path: realpathSync(source) } });
      assert.deepEqual(result.toolchain, toolchain);
      assert.deepEqual(store.get(job.id).toolchain, toolchain);
      assert.deepEqual(result.attempts, {});
      assert.equal(result.agentCalls, 0);
      assert.equal(existsSync(invoked), false);
      assert.equal(existsSync(sdk), removed === 'none');
      if (removed === 'cache') assert.equal(existsSync(marker), false);
      else assert.equal(readFileSync(marker, 'utf8'), JSON.stringify(toolchain));
    } finally { store.close(); }
  });
}

test('workspace metadata cannot override the durable task pin', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  const source = f.config.toolchain.flutterSdk;
  mkdirSync(join(source, 'bin', 'cache'), { recursive: true });
  writeFileSync(join(source, 'bin', 'flutter'), 'must not execute');
  const version = { frameworkRevision: 'new-framework', engineRevision: 'engine' };
  writeFileSync(join(source, 'bin', 'cache', 'flutter.version.json'), JSON.stringify(version));
  const workspace = join(f.config.workspaceRoot, 'fixture');
  const cache = join(workspace, '.factory-cache');
  mkdirSync(join(cache, 'flutter'), { recursive: true });
  const metadata = JSON.stringify({ source: realpathSync(source), ...version, ready: true });
  const marker = join(cache, 'flutter.json');
  writeFileSync(marker, metadata);
  const toolchain = { source: realpathSync(source), frameworkRevision: 'old-framework', engineRevision: 'engine', ready: true };
  await assert.rejects(prepareFlutter({ config: f.config, workspace, spec: product, stage: 'verify', toolchain }, { run: async () => assert.fail('Workspace metadata must not repin the task') }), error => error.code === 'PREREQUISITE_FAILED' && error.prerequisite.reason === 'sdk-version-changed');
  assert.equal(readFileSync(marker, 'utf8'), metadata);
});

for (const failure of ['permission', 'timeout', 'escaping-cache']) {
  for (const priorAttempts of [{}, { verify: 1 }]) {
    test(`untyped SDK ${failure} failures block without charging ${JSON.stringify(priorAttempts)}`, { skip: process.platform !== 'darwin' || (failure === 'permission' && process.getuid?.() === 0), timeout: 10000 }, async t => {
      const f = fixture(t);
      const source = f.config.toolchain.flutterSdk;
      mkdirSync(join(source, 'bin'), { recursive: true });
      const flutter = join(source, 'bin', 'flutter');
      writeFileSync(flutter, '#!/bin/sh\nexec /bin/sleep 30\n');
      chmodSync(flutter, 0o700);
      const config = { ...f.config, timeoutMs: 100, verification: { ...f.config.verification, prerequisites: [] } };
      const store = new Store(config.stateDir);
      let cache;
      try {
        const job = store.enqueue(product, config);
        cache = join(job.workspace, '.factory-cache');
        mkdirSync(job.workspace, { recursive: true });
        if (failure === 'permission') {
          mkdirSync(cache);
          chmodSync(cache, 0o500);
        } else if (failure === 'escaping-cache') {
          const outside = join(f.root, 'outside');
          mkdirSync(outside);
          symlinkSync(outside, cache);
        }
        const result = await executeStep(store, store.update(job.id, { stage: 'verify', attempts: priorAttempts, agentCalls: 2 }));
        assert.equal(result.status, 'blocked');
        assert.equal(result.stage, 'verify');
        assert.equal(result.blockedReason, null);
        assert.deepEqual(result.attempts, priorAttempts);
        assert.equal(result.agentCalls, 2);
        assert.equal(Number.isFinite(result.nextAt), true);
        assert.deepEqual(result.groups, []);
        assert.deepEqual(result.commands, {});
        assert.equal(store.next(), undefined);
        assert.deepEqual(store.get(job.id).attempts, priorAttempts);
        if (failure === 'permission') assert.match(result.error, /EACCES/);
      } finally {
        if (failure === 'permission' && cache) chmodSync(cache, 0o700);
        store.close();
      }
    });
  }
}
