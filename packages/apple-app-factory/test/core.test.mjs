import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { generateKeyPairSync } from 'node:crypto';
import { Store } from '../dist/store.js';
import { run, executionEnvironment } from '../dist/process.js';
import { expandArgv, loadConfig, inside } from '../dist/config.js';
import { executeStep, nextTurn } from '../dist/runner.js';
import { sourceDigest } from '../dist/workspace.js';

const cli = resolve('dist/cli.js');
const example = JSON.parse(readFileSync(new URL('../examples/factory.json', import.meta.url)));
const product = JSON.parse(readFileSync(new URL('../examples/luggage.json', import.meta.url)));

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apphx-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'factory.json');
  writeFileSync(path, JSON.stringify({ ...example, ...overrides, packageTarget: overrides.packageTarget ?? (overrides.allowSubmit ? 'ipa' : example.packageTarget) }));
  return { root, path, config: loadConfig(path) };
}

function database(t, config) {
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  return store;
}

test('queue survives process restart and blocks execution without its upfront permission', async t => {
  const f = fixture(t);
  const specPath = join(f.root, 'product.json');
  writeFileSync(specPath, JSON.stringify(product));
  const queued = await run([process.execPath, cli, 'enqueue', specPath, '--config', f.path]);
  assert.equal(queued.code, 0, queued.stderr);
  const id = JSON.parse(queued.stdout).id;
  const store = database(t, f.config);
  store.update(id, { stage: 'verify' });
  const worked = await run([process.execPath, cli, 'step', id, '--config', f.path]);
  assert.notEqual(worked.code, 0);
  assert.equal(JSON.parse(worked.stdout).status, 'blocked');
  const status = await run([process.execPath, cli, 'status', id, '--config', f.path]);
  const job = JSON.parse(status.stdout);
  assert.equal(job.hostTurns, 0);
  assert.equal(job.stage, 'verify');
  assert.equal(job.status, 'blocked');
  assert.equal(existsSync(job.workspace), false);
  assert.equal(existsSync(join(f.config.stateDir, 'queue.sqlite')), true);
});

test('queue identity is product, platform, channel and version rather than purpose or label', t => {
  const f = fixture(t);
  const store = database(t, f.config);
  const first = store.enqueue(product, f.config);
  assert.throws(() => store.enqueue(product, f.config));
  const independent = store.enqueue({ ...product, id: 'independent-product', name: 'Independent label' }, f.config);
  assert.equal(independent.spec.purpose, first.spec.purpose);
  const local = store.enqueue({ ...product, channel: 'local' }, f.config);
  const android = store.enqueue({ ...product, platform: 'android', channel: 'local' }, { ...f.config, packageTarget: 'apk' });
  const update = store.enqueue({ ...product, version: '1.1.0' }, f.config);
  assert.equal(new Set([first, independent, local, android, update].map(job => job.workspace)).size, 5);
  assert.equal(update.spec.version, '1.1.0');
});

test('one execution owns a queue and a restart preserves attempt and host-turn budgets', t => {
  const f = fixture(t);
  const first = database(t, f.config);
  const second = database(t, f.config);
  const job = first.enqueue(product, f.config);
  first.acquire();
  assert.throws(() => second.acquire());
  first.update(job.id, { status: 'running', attempts: { research: 2 }, hostTurns: 2 });
  first.release();
  second.acquire();
  const resumed = second.next();
  assert.equal(resumed.id, job.id);
  assert.equal(resumed.hostTurns, 2);
  assert.deepEqual(resumed.attempts, { research: 2 });
  second.release();
});

test('wall-clock exhaustion terminates work without another host turn', async t => {
  const f = fixture(t, { allowLocalExecution: true });
  const store = database(t, f.config);
  const job = store.enqueue(product, f.config);
  store.update(job.id, { createdAt: Date.now() - 25 * 3600000 });
  const { job: result, action } = await nextTurn(store, job.id);
  assert.equal(action, 'done');
  assert.equal(result.status, 'failed');
  assert.equal(result.hostTurns, 0);
  assert.equal(existsSync(result.workspace), false);
});

test('verification runs real commands and invalidates a source revision mutated by those commands', async t => {
  const f = fixture(t, {
    allowLocalExecution: true,
    verification: {
      checks: [[process.execPath, '-e', "require('node:fs').writeFileSync('model.dart', 'changed')"]],
      runtime: [[process.execPath, '-e', 'process.exit(0)']],
    },
  });
  const store = database(t, f.config);
  const job = store.enqueue(product, f.config);
  mkdirSync(job.workspace, { recursive: true });
  writeFileSync(join(job.workspace, 'model.dart'), 'original');
  const result = await executeStep(store, store.update(job.id, { stage: 'verify' }));
  assert.equal(result.status, 'waiting');
  assert.equal(result.stage, 'build');
  assert.equal(result.verifiedDigest, null);
  assert.equal(readFileSync(join(job.workspace, 'model.dart'), 'utf8'), 'changed');
  assert.equal(result.hostTurns, 0);
});

test('a failed external runtime scenario cannot be replaced by successful static checks', async t => {
  const f = fixture(t, {
    allowLocalExecution: true,
    verification: { checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(17)']] },
  });
  const store = database(t, f.config);
  const job = store.enqueue(product, f.config);
  const result = await executeStep(store, store.update(job.id, { stage: 'verify' }));
  assert.equal(result.status, 'waiting');
  assert.equal(result.stage, 'build');
  assert.equal(result.verifiedDigest, null);
});

test('timing out a command also terminates its descendants', async t => {
  const f = fixture(t);
  const started = join(f.root, 'started');
  const leaked = join(f.root, 'leaked');
  const grandchild = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(leaked)},'leak'),1500)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(started)},'started');setInterval(()=>{},1000)`;
  await assert.rejects(run([process.execPath, '-e', parent], { timeoutMs: 700 }));
  assert.equal(existsSync(started), true);
  await sleep(1700);
  assert.equal(existsSync(leaked), false);
});

test('execution environments exclude publisher and unlisted variables even when requested', () => {
  const source = {
    PATH: '/bin', HOME: '/executor', FACTORY_ALLOWED: 'allowed', UNLISTED_SYNTHETIC: 'secret',
    ASC_SYNTHETIC: 'secret', APPLE_SYNTHETIC: 'secret', FASTLANE_SYNTHETIC: 'secret', MATCH_SYNTHETIC: 'secret',
    ASC_PRIVATE_KEY_PATH: '/private/publisher.p8',
  };
  const forbidden = ['ASC_SYNTHETIC', 'APPLE_SYNTHETIC', 'FASTLANE_SYNTHETIC', 'MATCH_SYNTHETIC', 'ASC_PRIVATE_KEY_PATH'];
  const result = executionEnvironment({ executionEnv: ['FACTORY_ALLOWED', ...forbidden] }, source);
  assert.equal(result.PATH, '/bin');
  assert.equal(result.FACTORY_ALLOWED, 'allowed');
  assert.equal(result.UNLISTED_SYNTHETIC, undefined);
  for (const key of forbidden) assert.equal(result[key], undefined, key);
});

test('verification resolves environment arguments without a shell and fails closed on absent values or publisher secrets', () => {
  assert.deepEqual(expandArgv(['flutter', '-d', '${IOS_DEVICE_ID}'], { IOS_DEVICE_ID: 'device; echo unsafe' }), ['flutter', '-d', 'device; echo unsafe']);
  assert.throws(() => expandArgv(['${IOS_DEVICE_ID}'], {}));
  assert.throws(() => expandArgv(['${ASC_KEY_ID}'], { ASC_KEY_ID: 'secret' }));
});

test('source fingerprints ignore generated build artifacts, reject escaping symlinks and change with source', t => {
  const f = fixture(t);
  const root = join(f.root, 'source');
  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(join(root, 'main.dart'), 'original');
  const original = sourceDigest(root);
  writeFileSync(join(root, 'build', 'artifact'), 'generated');
  assert.equal(sourceDigest(root), original);
  writeFileSync(join(root, 'main.dart'), 'changed');
  assert.notEqual(sourceDigest(root), original);
  mkdirSync(join(root, 'lib', 'build'), { recursive: true });
  writeFileSync(join(root, 'lib', 'build', 'calculations.dart'), 'verified');
  const nested = sourceDigest(root);
  writeFileSync(join(root, 'lib', 'build', 'calculations.dart'), 'unverified');
  assert.notEqual(sourceDigest(root), nested);
  symlinkSync(f.path, join(root, 'outside'));
  assert.throws(() => sourceDigest(root));
  assert.throws(() => inside(root, '../outside'));
  assert.throws(() => inside(root, 'outside'));
});

test('ordinary retry cannot escalate permissions or rewrite an existing manual-release intent', async t => {
  const f = fixture(t);
  const store = database(t, f.config);
  const job = store.enqueue(product, f.config);
  store.update(job.id, { status: 'blocked' });
  writeFileSync(f.path, JSON.stringify({ ...example, packageTarget: 'ipa', allowSubmit: true, allowRelease: true }));
  const retried = await run([process.execPath, cli, 'retry', job.id, '--config', f.path]);
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(store.get(job.id).config.allowSubmit, false);
  assert.equal(store.get(job.id).config.allowRelease, false);
  const pending = store.update(job.id, { stage: 'monitor', status: 'blocked', config: { ...f.config, packageTarget: 'ipa', allowSubmit: true, allowRelease: false }, receipt: { versionId: 'version', buildId: 'build' } });
  const observed = await run([process.execPath, cli, 'retry', job.id, '--config', f.path]);
  assert.notEqual(observed.code, 0);
  assert.deepEqual(store.get(job.id), pending);
  assert.equal(store.get(job.id).config.allowRelease, false);
  assert.deepEqual(store.get(job.id).receipt, { versionId: 'version', buildId: 'build' });
});

test('cancellation before dispatch preserves the last available attempt', async t => {
  const f = fixture(t, { allowLocalExecution: true, maxAttempts: 1 });
  const store = database(t, f.config);
  const job = store.enqueue(product, f.config);
  const controller = new AbortController();
  controller.abort();
  const result = await executeStep(store, store.update(job.id, { stage: 'verify' }), { signal: controller.signal });
  assert.equal(result.status, 'waiting');
  assert.deepEqual(result.attempts, {});
  assert.equal(result.hostTurns, 0);
  assert.equal(existsSync(result.workspace), false);
});

test('interruption during verification is resumable without erasing completed failures or spending a call', async t => {
  const f = fixture(t, { allowLocalExecution: true, maxAttempts: 2, verification: { checks: [[process.execPath, '-e', "require('node:fs').writeFileSync('started','yes');setInterval(()=>{},1000)"]], runtime: [[process.execPath, '-e', 'process.exit(0)']] } });
  const store = database(t, f.config);
  const spec = structuredClone(product);
  delete spec.screenshotsDir;
  const job = store.enqueue(spec, f.config);
  const controller = new AbortController();
  const active = executeStep(store, store.update(job.id, { stage: 'verify', attempts: { verify: 1 } }), { signal: controller.signal });
  const deadline = Date.now() + 5000;
  while (!existsSync(join(job.workspace, 'started')) && Date.now() < deadline) await sleep(10);
  assert.equal(existsSync(join(job.workspace, 'started')), true);
  controller.abort();
  const stopped = await active;
  assert.equal(stopped.status, 'waiting');
  assert.equal(stopped.attempts.verify, 1);
  assert.equal(stopped.hostTurns, 0);
  assert.deepEqual(stopped.groups, []);
  const resumedConfig = { ...f.config, verification: { checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] } };
  const resumed = await executeStep(store, store.update(job.id, { config: resumedConfig }));
  assert.equal(resumed.stage, 'review');
  assert.equal(resumed.verifiedDigest, sourceDigest(job.workspace));
});

test('a changed nested source cannot reach publication with a stale digest', async t => {
  const f = fixture(t, { allowLocalExecution: true, allowSubmit: true });
  const store = database(t, f.config);
  const job = store.enqueue(product, f.config);
  mkdirSync(join(job.workspace, 'lib', 'build'), { recursive: true });
  const path = join(job.workspace, 'lib', 'build', 'calculations.dart');
  writeFileSync(path, 'verified');
  const verifiedDigest = sourceDigest(job.workspace);
  writeFileSync(path, 'changed after review');
  const result = await executeStep(store, store.update(job.id, { stage: 'publish', verifiedDigest }));
  assert.equal(result.status, 'waiting');
  assert.deepEqual(result.receipt, {});
  assert.equal(result.hostTurns, 0);
  assert.notEqual(sourceDigest(job.workspace), result.verifiedDigest);
});

test('temporary Apple monitoring outages do not abandon an already submitted build', async t => {
  const f = fixture(t, { allowLocalExecution: true, allowSubmit: true });
  const store = database(t, f.config);
  const privateKey = join(f.root, 'key.p8');
  writeFileSync(privateKey, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const credentials = { ASC_KEY_ID: 'TESTKEY', ASC_ISSUER_ID: 'test-issuer', ASC_PRIVATE_KEY_PATH: privateKey };
  const original = Object.fromEntries(Object.keys(credentials).map(key => [key, process.env[key]]));
  Object.assign(process.env, credentials);
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let outages = true;
  t.mock.method(globalThis, 'fetch', async url => {
    if (outages) return Response.json({ errors: [{ code: 'TEMPORARY', detail: 'Try later' }] }, { status: 503 });
    if (new URL(url).pathname.endsWith('/build')) return Response.json({ data: { type: 'builds', id: 'build' } });
    return Response.json({ data: [{ id: 'version', attributes: { appVersionState: 'PENDING_DEVELOPER_RELEASE' } }] });
  });
  const spec = { ...product, apple: { ...product.apple, appId: '123' } };
  let job = store.enqueue(spec, f.config);
  job = store.update(job.id, { stage: 'monitor', receipt: { versionId: 'version', buildId: 'build' } });
  for (let attempt = 0; attempt < 4; attempt++) {
    job = await executeStep(store, job);
    assert.equal(job.status, 'waiting');
    assert.equal(job.stage, 'monitor');
  }
  outages = false;
  const recovered = await executeStep(store, job);
  assert.equal(recovered.status, 'approved');
  assert.deepEqual(recovered.receipt, { versionId: 'version', buildId: 'build' });
  assert.equal(recovered.hostTurns, 0);
});
