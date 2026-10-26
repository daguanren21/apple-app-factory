import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store } from '../dist/store.js';
import { loadConfig } from '../dist/config.js';
import { nextTurn } from '../dist/runner.js';

const example = JSON.parse(readFileSync(new URL('../examples/factory.json', import.meta.url)));
const product = JSON.parse(readFileSync(new URL('../examples/luggage.json', import.meta.url)));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const storeModule = new URL('../dist/store.js', import.meta.url).href;
const digest = 'a'.repeat(64);
const policyA = { prerequisites: [], checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] };
const policyB = { ...policyA, checks: [[process.execPath, '-e', 'process.exit(23)']] };
const publishable = {
  ...product,
  apple: {
    ...product.apple, appId: '123', description: 'Offline packing and luggage weight planning.', keywords: 'packing,luggage',
    supportUrl: 'https://example.org/support', privacyPolicyUrl: 'https://example.org/privacy',
    reviewNotes: 'Controlled local metadata fixture.', copyright: 'Example Publisher', storefrontCountry: 'US',
    contact: { firstName: 'Review', lastName: 'Contact', email: 'review@example.org', phone: '+12025550123' },
    manualSetupConfirmed: true,
  },
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-admin-transition-'));
  const path = join(root, 'config.json');
  const input = { ...example, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), verification: policyA };
  writeFileSync(path, JSON.stringify(input));
  const config = loadConfig(path);
  const store = new Store(config.stateDir);
  const feedback = join(root, 'feedback.txt');
  writeFileSync(feedback, 'Controlled local feedback fixture; no Apple submission occurred.');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, config, store, feedback, changeConfig(patch) { writeFileSync(path, JSON.stringify({ ...input, ...patch })); } };
}

function invoke(f, action, id, { barrier, buildOnly = false, release = false } = {}) {
  const imports = [];
  const snapshot = join(f.root, 'barrier.json');
  if (barrier) {
    const hook = join(f.root, 'barrier.mjs');
    writeFileSync(hook, `import { Store } from ${JSON.stringify(storeModule)};
import { writeFileSync } from 'node:fs';
const transaction = Store.prototype.transaction;
let fired = false;
Store.prototype.transaction = function (action) {
  if (!fired) {
    fired = true;
    const other = new Store(${JSON.stringify(f.config.stateDir)});
    try {
      const id = ${JSON.stringify(id)};
      const snapshot = (() => { ${barrier} })();
      writeFileSync(${JSON.stringify(snapshot)}, JSON.stringify(snapshot));
    } finally { other.close(); }
  }
  return transaction.call(this, action);
};
`);
    imports.push('--import', hook);
  }
  const result = spawnSync(process.execPath, [...imports, cli, action, id,
    ...(action === 'feedback' ? [f.feedback] : action === 'authorize' ? ['--submit', ...(release ? ['--release'] : [])] : []),
    ...(buildOnly ? ['--build-only'] : []), '--config', f.path], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { ...result, snapshot: barrier ? JSON.parse(readFileSync(snapshot, 'utf8')) : undefined };
}

function blocked(f, stage = 'verify', patch = {}) {
  const job = f.store.enqueue(publishable, f.config);
  return f.store.update(job.id, {
    stage, status: 'blocked', nextAt: 0,
    blockedReason: { kind: 'prerequisite', stage, prerequisite: { reason: 'Controlled transaction boundary' } },
    attempts: { verify: 2 }, hostTurns: 3, ...patch,
  });
}

function rejected(f) {
  return blocked(f, 'monitor', { appleReview: { status: 'rejected', detail: 'Controlled local review rejection' } });
}

test('transition locks before reading and rolls back rejected changes without nested transactions', t => {
  const f = fixture(t), other = new Store(f.config.stateDir);
  t.after(() => other.close());
  const job = blocked(f);
  other.db.exec('PRAGMA busy_timeout=0');
  const events = f.store.events(job.id).length;
  const saved = f.store.transition(job.id, current => {
    assert.equal(current.status, 'blocked');
    assert.throws(() => other.update(job.id, { status: 'running' }), /locked/);
    return { status: 'ready' };
  });
  assert.equal(saved.status, 'ready');
  assert.equal(f.store.events(job.id).length, events + 1);
  assert.throws(() => f.store.transition(job.id, () => { throw new Error('Controlled rejected transition'); }), /Controlled rejected transition/);
  assert.equal(other.get(job.id).status, 'ready');
  assert.equal(f.store.events(job.id).length, events + 1);
});

test('retry cannot queue policy B while deterministic execution owns its policy A snapshot', t => {
  const f = fixture(t), job = blocked(f);
  f.changeConfig({ verification: policyB });
  const result = invoke(f, 'retry', job.id, { barrier: 'return other.next();' });
  assert.equal(result.snapshot.status, 'running');
  assert.deepEqual(result.snapshot.config.verification, policyA);
  assert.notEqual(result.status, 0);
  const running = f.store.get(job.id);
  assert.equal(running.status, 'running');
  assert.deepEqual(running.config.verification, policyA);
  assert.deepEqual(running.attempts, job.attempts);
  assert.equal(running.hostTurns, job.hostTurns);
  f.store.update(job.id, { status: 'ready', verifiedDigest: digest });
  const resumed = invoke(f, 'retry', job.id);
  assert.equal(resumed.status, 0, resumed.stderr);
  const queued = f.store.get(job.id);
  assert.equal(queued.stage, 'verify');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.verifiedDigest, null);
  assert.deepEqual(queued.config.verification, policyB);
  assert.deepEqual(queued.attempts, job.attempts);
  assert.equal(queued.hostTurns, job.hostTurns);
});

for (const action of ['authorize', 'feedback']) {
  test(`${action} cannot overwrite a stage claimed before its transaction`, t => {
    const f = fixture(t), job = action === 'feedback' ? rejected(f) : blocked(f, 'research');
    const result = invoke(f, action, job.id, { barrier: 'return other.next();' });
    assert.equal(result.snapshot.status, 'running');
    assert.notEqual(result.status, 0);
    assert.deepEqual(f.store.get(job.id), result.snapshot);
  });
}

test('build-only retry checks the current permission snapshot inside its transaction', t => {
  const f = fixture(t), job = blocked(f);
  const result = invoke(f, 'retry', job.id, { buildOnly: true, barrier: "return other.update(id, { config: { ...other.get(id).config, packageTarget: 'ipa', allowSubmit: true } });" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.store.get(job.id), result.snapshot);
});

for (const action of ['retry', 'authorize']) {
  test(`${action} checks a remote intent committed before its transaction`, t => {
    const f = fixture(t), job = blocked(f);
    if (action === 'retry') f.changeConfig({ verification: policyB });
    const result = invoke(f, action, job.id, { barrier: "return other.update(id, { receipt: { upload: { status: 'intent' } } });" });
    assert.notEqual(result.status, 0);
    assert.deepEqual(f.store.get(job.id), result.snapshot);
  });
}

test('feedback cannot erase a changed remote intent and stage using an old rejection', t => {
  const f = fixture(t), job = rejected(f);
  const result = invoke(f, 'feedback', job.id, { barrier: "return other.update(id, { stage: 'publish', receipt: { pending: { key: 'controlled-local-intent', method: 'POST' } } });" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.store.get(job.id), result.snapshot);
});

for (const action of ['retry', 'feedback']) {
  test(`${action} preserves publication permission granted before its transaction`, t => {
    const f = fixture(t), job = action === 'feedback' ? rejected(f) : blocked(f);
    const result = invoke(f, action, job.id, { barrier: "return other.update(id, { config: { ...other.get(id).config, packageTarget: 'ipa', allowSubmit: true, allowRelease: true } });" });
    assert.equal(result.status, 0, result.stderr);
    const saved = f.store.get(job.id);
    assert.equal(saved.status, 'queued');
    assert.equal(saved.config.packageTarget, 'ipa');
    assert.equal(saved.config.allowSubmit, true);
    assert.equal(saved.config.allowRelease, true);
    assert.deepEqual(saved.requestSpec, job.requestSpec);
    if (action === 'retry') {
      assert.deepEqual(saved.attempts, job.attempts);
      assert.equal(saved.hostTurns, job.hostTurns);
    } else {
      assert.equal(saved.spec.apple.buildNumber, String(BigInt(job.spec.apple.buildNumber) + 1n));
      assert.deepEqual(saved.attempts, {});
      assert.equal(saved.hostTurns, 0);
    }
  });
}

for (const status of ['ready', 'built', 'blocked', 'queued']) {
  test(`authorize preserves the existing ${status} eligibility contract`, t => {
    const f = fixture(t), job = blocked(f, 'package', { status, blockedReason: null });
    const result = invoke(f, 'authorize', job.id, { release: true });
    const saved = f.store.get(job.id);
    if (status === 'queued') {
      assert.notEqual(result.status, 0);
      assert.deepEqual(saved, job);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(saved.status, status === 'blocked' ? 'blocked' : 'queued');
      assert.equal(saved.config.allowSubmit, true);
      assert.equal(saved.config.allowRelease, true);
      assert.equal(saved.config.packageTarget, 'ipa');
      assert.deepEqual(saved.attempts, job.attempts);
      assert.equal(saved.hostTurns, job.hostTurns);
    }
  });
}

test('manual retry still clears explicit recovery acknowledgement without resetting budgets or unchanged evidence', t => {
  const f = fixture(t);
  const artifact = { kind: 'ios-simulator', path: join(f.root, 'controlled-artifact'), digest, createdAt: new Date().toISOString() };
  const job = blocked(f, 'package', { blockedReason: null, manualRecovery: 'Controlled ownership issue already inspected', error: 'Controlled stop', verifiedDigest: digest, verifiedDependencyDigest: digest, artifact });
  const result = invoke(f, 'retry', job.id, { buildOnly: true });
  assert.equal(result.status, 0, result.stderr);
  const saved = f.store.get(job.id);
  assert.equal(saved.status, 'queued');
  assert.equal(saved.stage, 'package');
  assert.equal(saved.manualRecovery, null);
  assert.equal(saved.error, null);
  assert.deepEqual(saved.attempts, job.attempts);
  assert.equal(saved.hostTurns, job.hostTurns);
  assert.equal(saved.verifiedDigest, digest);
  assert.deepEqual(saved.artifact, artifact);
  assert.deepEqual(saved.receipt, job.receipt);
  assert.deepEqual(saved.requestSpec, job.requestSpec);
});

test('FIFO review feedback is rejected without blocking the queue or changing the rejected task', t => {
  const f = fixture(t), job = rejected(f);
  rmSync(f.feedback);
  execFileSync('mkfifo', [f.feedback]);
  const before = f.store.get(job.id);
  const result = spawnSync(process.execPath, [cli, 'feedback', job.id, f.feedback, '--config', f.path], { encoding: 'utf8', timeout: 1500 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.store.get(job.id), before);
  const other = f.store.enqueue({ ...publishable, apple: { ...publishable.apple, version: '1.0.1' } }, f.config);
  f.store.update(other.id, { error: 'Independent task persisted after invalid feedback' });
  assert.equal(f.store.get(other.id).error, 'Independent task persisted after invalid feedback');
});

test('retry re-verifies legacy source proof lacking an effective dependency snapshot without resetting budgets', t => {
  const f = fixture(t);
  const job = blocked(f, 'package', { verifiedDigest: digest, review: { approved: true, findings: [], acceptanceEvidence: [] } });
  const result = invoke(f, 'retry', job.id);
  assert.equal(result.status, 0, result.stderr);
  const resumed = f.store.get(job.id);
  assert.equal(resumed.stage, 'verify');
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.verifiedDigest, null);
  assert.equal(resumed.verifiedDependencyDigest, null);
  assert.equal(resumed.review, null);
  assert.deepEqual(resumed.attempts, job.attempts);
  assert.equal(resumed.hostTurns, job.hostTurns);
});

for (const action of ['retry', 'authorize', 'feedback']) {
  test(`${action} cannot alter an active native-host turn`, async t => {
    const f = fixture(t);
    const job = blocked(f, 'build', { status: 'queued', blockedReason: null });
    const next = await nextTurn(f.store, job.id);
    assert.equal(next.action, 'host');
    const before = f.store.get(job.id);
    const result = invoke(f, action, job.id);
    assert.notEqual(result.status, 0);
    assert.deepEqual(f.store.get(job.id), before);
    assert.equal(f.store.get(job.id).turn.id, next.turn.id);
  });
}
