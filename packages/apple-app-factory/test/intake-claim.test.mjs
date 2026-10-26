import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../dist/store.js';
import { loadConfig } from '../dist/config.js';
import { scanInbox } from '../dist/inbox.js';
import { run } from '../dist/process.js';
import { createHash } from 'node:crypto';

const example = JSON.parse(readFileSync(new URL('../examples/factory.json', import.meta.url)));
const product = JSON.parse(readFileSync(new URL('../examples/luggage.json', import.meta.url)));
const cli = resolve('dist/cli.js');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-claim-boundary-'));
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify(example));
  const config = loadConfig(path);
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, config, open() { const store = new Store(config.stateDir); stores.push(store); return store; } };
}

function beforeFirstTransaction(store, action) {
  const transaction = store.transaction.bind(store);
  let fired = false;
  store.transaction = work => {
    if (!fired) { fired = true; action(); }
    return transaction(work);
  };
}

function prerequisiteJob(store, config) {
  const job = store.enqueue(product, config);
  return store.update(job.id, { status: 'blocked', blockedReason: { kind: 'prerequisite', stage: 'research', prerequisite: { reason: 'Controlled missing tool' } } });
}

test('claim validates the final permissions under the same transaction that marks running', t => {
  const f = fixture(t), first = f.open(), other = f.open();
  const job = prerequisiteJob(first, f.config);
  beforeFirstTransaction(first, () => other.update(job.id, { config: { ...f.config, packageTarget: 'ipa', allowSubmit: true } }));
  const claimed = first.next(candidate => !candidate.config.allowSubmit);
  assert.equal(claimed, undefined);
  const saved = other.get(job.id);
  assert.equal(saved.status, 'blocked');
  assert.equal(saved.config.allowSubmit, true);
  assert.equal(saved.hostTurns, 0);
  assert.deepEqual(saved.attempts, {});
});

test('a stage changed after candidate selection cannot bypass shared-resource admission', t => {
  const f = fixture(t), first = f.open(), other = f.open();
  const job = prerequisiteJob(first, f.config);
  beforeFirstTransaction(first, () => other.update(job.id, { stage: 'verify' }));
  assert.equal(first.next(candidate => candidate.stage !== 'verify'), undefined);
  assert.equal(other.get(job.id).status, 'blocked');
  assert.equal(other.get(job.id).stage, 'verify');
});

test('a candidate made terminal or deferred before claim is not restarted', t => {
  for (const patch of [{ status: 'failed' }, { nextAt: Date.now() + 60000 }]) {
    const f = fixture(t), first = f.open(), other = f.open();
    const job = prerequisiteJob(first, f.config);
    beforeFirstTransaction(first, () => other.update(job.id, patch));
    assert.equal(first.next(), undefined);
    assert.equal(other.get(job.id).status, patch.status ?? 'blocked');
  }
});

test('feedback changes operational build identity without changing original intake identity', async t => {
  const f = fixture(t), store = f.open();
  mkdirSync(f.config.inbox.directory, { recursive: true });
  const input = join(f.config.inbox.directory, 'request.json');
  writeFileSync(input, JSON.stringify(product));
  const intake = await scanInbox(store, f.config);
  const id = intake.entries[0].jobId;
  store.update(id, { stage: 'monitor', status: 'blocked', appleReview: { status: 'rejected', detail: 'Controlled rejection used only for local repair verification' } });
  const feedbackPath = join(f.root, 'feedback.txt');
  writeFileSync(feedbackPath, 'Controlled feedback: preserve backup data when import is corrupt. No Apple submission occurred.');
  const feedback = await run([process.execPath, cli, 'feedback', id, feedbackPath, '--config', f.path]);
  assert.equal(feedback.code, 0, feedback.stderr);
  const repaired = store.get(id);
  assert.equal(repaired.spec.apple.buildNumber, String(BigInt(product.apple.buildNumber) + 1n));
  assert.deepEqual(repaired.requestSpec, product);
  const observed = await scanInbox(store, f.config, { observe: true });
  assert.equal(observed.entries[0].status, 'accepted');
  assert.equal(observed.entries[0].jobId, id);
  const renamed = join(f.config.inbox.directory, 'renamed.json');
  renameSync(input, renamed);
  writeFileSync(renamed, JSON.stringify(Object.fromEntries(Object.entries(product).reverse()), null, 2));
  const restarted = f.open();
  const replayed = await scanInbox(restarted, f.config);
  assert.equal(replayed.entries[0].status, 'accepted');
  assert.equal(replayed.entries[0].jobId, id);
  assert.equal(restarted.list().length, 1);
  writeFileSync(renamed, JSON.stringify({ ...product, name: 'Genuinely different same-version requirement' }));
  const conflict = await scanInbox(restarted, f.config);
  assert.equal(conflict.entries[0].status, 'error');
  assert.deepEqual(restarted.get(id).requestSpec, product);
  assert.throws(() => restarted.update(id, { requestSpec: { ...product, name: 'Attempted snapshot rewrite' } }));
});

test('legacy persisted tasks gain intake snapshots once without changing jobs or budgets', async t => {
  const f = fixture(t), store = f.open();
  const job = store.enqueue(product, f.config);
  const legacy = { ...job, attempts: { build: 2 }, hostTurns: 3 };
  delete legacy.requestSpec;
  store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(legacy), job.id);
  store.db.exec('PRAGMA user_version=0');
  const restarted = f.open();
  const migrated = restarted.get(job.id);
  assert.deepEqual(migrated.requestSpec, product);
  assert.deepEqual(migrated.spec, legacy.spec);
  assert.deepEqual(migrated.attempts, { build: 2 });
  assert.equal(migrated.hostTurns, 3);
  assert.equal(restarted.checkIngest(product).id, job.id);
  const before = restarted.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id).data;
  const reopened = f.open();
  assert.equal(reopened.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id).data, before);
});

async function repairedLegacy(t) {
  const f = fixture(t), store = f.open();
  mkdirSync(f.config.inbox.directory, { recursive: true });
  const source = join(f.config.inbox.directory, 'original.json');
  writeFileSync(source, JSON.stringify(product));
  const intake = await scanInbox(store, f.config);
  const id = intake.entries[0].jobId;
  const spec = structuredClone(product);
  spec.apple.buildNumber = String(BigInt(spec.apple.buildNumber) + 1n);
  const legacy = store.update(id, { spec, status: 'blocked', stage: 'build', attempts: { build: 2 }, hostTurns: 3 });
  delete legacy.requestSpec;
  delete legacy.requestSpecError;
  store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(legacy), id);
  store.db.exec('PRAGMA user_version=0');
  return { ...f, source, id, store, spec };
}

test('edited legacy jobs require explicit original-input reconciliation even when accepted files remain', async t => {
  const f = await repairedLegacy(t);
  const migrated = f.open();
  assert.equal(migrated.get(f.id).requestSpec, null);
  assert.deepEqual(migrated.get(f.id).spec, f.spec);
  assert.match(migrated.get(f.id).requestSpecError, /reconcile-intake/);
  assert.equal((await scanInbox(migrated, f.config, { observe: true })).entries[0].status, 'error');
  assert.throws(() => migrated.reconcileIntake(f.id, { ...product, id: 'wrong-product' }));
  assert.throws(() => migrated.reconcileIntake(f.id, { ...product, apple: { ...product.apple, version: '9.9.9' } }));
  assert.throws(() => migrated.reconcileIntake(f.id, product, '00000000-0000-4000-8000-000000000000'));
  assert.equal(migrated.get(f.id).requestSpec, null);
  const reconciled = await run([process.execPath, cli, 'reconcile-intake', f.id, f.source, '--build-only', '--config', f.path]);
  assert.equal(reconciled.code, 0, reconciled.stderr);
  const restored = migrated.get(f.id);
  assert.deepEqual(restored.requestSpec, product);
  assert.equal(restored.requestSpecError, null);
  assert.deepEqual(restored.spec, f.spec);
  assert.equal(restored.status, 'blocked');
  assert.equal(restored.config.allowSubmit, false);
  assert.equal(restored.config.allowRelease, false);
  assert.throws(() => migrated.reconcileIntake(f.id, { ...product, name: 'Overwriting a known identity' }));
  const renamed = join(f.config.inbox.directory, 'renamed.json');
  renameSync(f.source, renamed);
  writeFileSync(renamed, JSON.stringify(Object.fromEntries(Object.entries(product).reverse()), null, 2));
  const restarted = f.open();
  const replayed = await scanInbox(restarted, f.config);
  assert.equal(replayed.entries[0].status, 'accepted');
  assert.equal(replayed.entries[0].jobId, f.id);
  assert.equal(restarted.get(f.id).hostTurns, 3);
  assert.deepEqual(restarted.get(f.id).attempts, { build: 2 });
  writeFileSync(renamed, JSON.stringify({ ...product, name: 'Different original request' }));
  assert.equal((await scanInbox(restarted, f.config)).entries[0].status, 'error');
});


for (const originalPresent of [true, false]) {
  test(`post-repair legacy acceptance cannot establish original identity with original present=${originalPresent}`, async t => {
    const f = await repairedLegacy(t);
    const later = join(f.config.inbox.directory, 'later-accepted.json');
    const bytes = JSON.stringify(f.spec);
    const digest = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(later, bytes);
    f.store.db.prepare('INSERT INTO inbox VALUES(?,?,?)').run(later, digest, JSON.stringify({ source: later, digest, status: 'accepted', jobId: f.id, error: null, observedAt: Date.now() }));
    const originalInput = join(f.root, 'original-input.json');
    writeFileSync(originalInput, JSON.stringify(product));
    if (!originalPresent) rmSync(f.source);
    const migrated = f.open();
    assert.equal(migrated.get(f.id).requestSpec, null);
    assert.match(migrated.get(f.id).requestSpecError, /reconcile-intake/);
    const reconciled = await run([process.execPath, cli, 'reconcile-intake', f.id, originalInput, '--build-only', '--config', f.path]);
    assert.equal(reconciled.code, 0, reconciled.stderr);
    const before = migrated.db.prepare('SELECT total_changes() AS count').get().count;
    const preview = await scanInbox(migrated, f.config, { observe: true });
    assert.equal(migrated.db.prepare('SELECT total_changes() AS count').get().count, before);
    assert.equal(preview.entries.find(entry => entry.source === later).status, 'error');
    const normal = await scanInbox(migrated, f.config);
    assert.equal(normal.entries.find(entry => entry.source === later).status, 'error');
    if (originalPresent) {
      assert.equal(preview.entries.find(entry => entry.source === f.source).status, 'accepted');
      assert.equal(normal.entries.find(entry => entry.source === f.source).status, 'accepted');
    } else {
      writeFileSync(f.source, JSON.stringify(product));
      const restored = await scanInbox(migrated, f.config);
      assert.equal(restored.entries.find(entry => entry.source === f.source).jobId, f.id);
    }
    assert.deepEqual(migrated.get(f.id).requestSpec, product);
    assert.deepEqual(migrated.get(f.id).spec, f.spec);
    assert.equal(migrated.get(f.id).hostTurns, 3);
    assert.equal(migrated.list().length, 1);
  });
}
