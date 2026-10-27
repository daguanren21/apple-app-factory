import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { sourceDigest } from '../dist/workspace.js';
import { dependencyDigest } from '../dist/dependencies.js';
import { scanInbox, submitRequirement } from '../dist/inbox.js';
import { parseRequirement } from '../dist/requirements.js';

const example = JSON.parse(readFileSync(new URL('../examples/factory.json', import.meta.url)));
const product = JSON.parse(readFileSync(new URL('../examples/luggage.json', import.meta.url)));

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-inbox-'));
  const config = ConfigSchema.parse({ ...example, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), inbox: { directory: join(root, 'inbox'), pollMs: 25 }, ...overrides });
  let store;
  const f = {
    root,
    config,
    open() { return store ??= new Store(config.stateDir); },
    close() { if (store) { store.close(); store = undefined; } },
    put(name, value) {
      mkdirSync(config.inbox.directory, { recursive: true });
      const path = join(config.inbox.directory, name);
      writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
      return path;
    },
  };
  t.after(() => { f.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

function changes(store) {
  return store.db.prepare('SELECT total_changes() AS count').get().count;
}

function finishBase(store, job) {
  mkdirSync(job.workspace, { recursive: true });
  writeFileSync(join(job.workspace, 'model.dart'), 'verified predecessor fixture');
  return store.update(job.id, { status: 'built', stage: 'package', verifiedDigest: sourceDigest(job.workspace), verifiedDependencyDigest: dependencyDigest(job.workspace, job.spec.framework) });
}

test('requirements reject permission injection and malformed predecessor IDs', () => {
  for (const patch of [{ config: {} }, { allowSubmit: true }, { allowRelease: true }, { permissions: {} }, { baseJobId: '' }, { baseJobId: '  ' }, { baseJobId: 1 }, { baseJobId: 'task\0id' }, { baseJobId: 'previous-task' }]) {
    assert.throws(() => parseRequirement({ ...product, ...patch }));
  }
  for (const value of [null, [], 'request', {}]) assert.throws(() => parseRequirement(value));
});

test('accepted requests deduplicate after restart, rename, formatting changes and repeated scans', async t => {
  const f = fixture(t);
  const submitted = submitRequirement(f.config, product);
  const first = await scanInbox(f.open(), f.config);
  assert.equal(first.error, null);
  assert.equal(first.entries[0].status, 'accepted');
  assert.equal(first.entries[0].source, submitted.path);
  const id = first.entries[0].jobId;
  const before = changes(f.open());
  assert.deepEqual(await scanInbox(f.open(), f.config), first);
  assert.equal(changes(f.open()), before);
  f.close();
  const renamed = join(f.config.inbox.directory, 'renamed.json');
  renameSync(submitted.path, renamed);
  const reversed = Object.fromEntries(Object.entries(product).reverse());
  writeFileSync(renamed, JSON.stringify(reversed, null, 2));
  const restarted = await scanInbox(f.open(), f.config);
  assert.equal(restarted.entries[0].status, 'accepted');
  assert.equal(restarted.entries[0].jobId, id);
  assert.equal(f.open().list().length, 1);
  assert.equal(f.open().inboxEntries().length, 2);
  const noChurn = changes(f.open());
  await scanInbox(f.open(), f.config);
  assert.equal(changes(f.open()), noChurn);
});

test('same-version edits cannot mutate an accepted job and unchanged conflicts do not churn records', async t => {
  const f = fixture(t);
  const path = f.put('product.json', product);
  const accepted = await scanInbox(f.open(), f.config);
  const original = f.open().get(accepted.entries[0].jobId);
  writeFileSync(path, JSON.stringify({ ...product, name: 'Changed same-version requirement' }));
  const rejected = await scanInbox(f.open(), f.config);
  assert.equal(rejected.entries[0].status, 'error');
  assert.match(rejected.entries[0].error, /version|immutable|conflict|different/i);
  assert.deepEqual(f.open().get(original.id), original);
  assert.equal(f.open().list().length, 1);
  const before = changes(f.open());
  assert.deepEqual(await scanInbox(f.open(), f.config), rejected);
  assert.equal(changes(f.open()), before);
  writeFileSync(path, JSON.stringify(product));
  const restored = await scanInbox(f.open(), f.config);
  assert.equal(restored.entries[0].status, 'accepted');
  assert.equal(restored.entries[0].jobId, original.id);
  assert.equal(f.open().list().length, 1);
});

test('a new version links its verified predecessor and semantic errors are retried without file edits', async t => {
  const f = fixture(t);
  f.put('base.json', product);
  const first = await scanInbox(f.open(), f.config);
  const base = f.open().get(first.entries[0].jobId);
  const next = { ...product, version: '2.0.0', baseJobId: base.id };
  f.put('next.json', next);
  const pending = await scanInbox(f.open(), f.config);
  assert.equal(pending.entries.find(entry => entry.source.endsWith('next.json')).status, 'error');
  finishBase(f.open(), base);
  const completed = await scanInbox(f.open(), f.config);
  const entry = completed.entries.find(entry => entry.source.endsWith('next.json'));
  assert.equal(entry.status, 'accepted', entry.error);
  const successor = f.open().get(entry.jobId);
  assert.equal(successor.baseJobId, base.id);
  assert.equal(successor.baseDigest, f.open().get(base.id).verifiedDigest);
  assert.equal(successor.spec.version, '2.0.0');
  assert.notEqual(successor.workspace, base.workspace);
  assert.equal(f.open().list().length, 2);
  f.close();
  const restarted = await scanInbox(f.open(), f.config);
  assert.equal(restarted.entries.find(item => item.source.endsWith('next.json')).jobId, successor.id);
  assert.equal(f.open().list().length, 2);
});

test('malformed, oversized, symlink and nonregular files are isolated from valid requirements', async t => {
  const f = fixture(t);
  f.put('a-corrupt.json', '{broken');
  f.put('b-oversized.json', ' '.repeat(1024 * 1024 + 1));
  const target = join(f.root, 'outside.json');
  writeFileSync(target, JSON.stringify(product));
  mkdirSync(f.config.inbox.directory, { recursive: true });
  symlinkSync(target, join(f.config.inbox.directory, 'c-symlink.json'));
  mkdirSync(join(f.config.inbox.directory, 'd-directory.json'));
  f.put('e-invalid.json', { ...product, allowSubmit: true });
  f.put('z-valid.json', product);
  f.put('ignored.tmp', '{');
  const result = await scanInbox(f.open(), f.config);
  assert.equal(result.error, null);
  assert.equal(result.entries.length, 6);
  assert.equal(result.entries.filter(entry => entry.status === 'error').length, 5);
  assert.equal(result.entries.at(-1).status, 'accepted');
  assert.match(result.entries.find(entry => entry.source.endsWith('b-oversized.json')).error, /exceeds.*bytes/);
  assert.match(result.entries.find(entry => entry.source.endsWith('c-symlink.json')).error, /symbolic link/);
  assert.match(result.entries.find(entry => entry.source.endsWith('d-directory.json')).error, /regular file/);
  assert.equal(f.open().list().length, 1);
  const before = changes(f.open());
  assert.deepEqual(await scanInbox(f.open(), f.config), result);
  assert.equal(changes(f.open()), before);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), product);
});

test('observe detects canonical conflicts and invalid predecessors without creating jobs or inbox records', async t => {
  const f = fixture(t);
  f.put('a-new.json', product);
  const initial = changes(f.open());
  const preview = await scanInbox(f.open(), f.config, { observe: true });
  assert.equal(preview.observed, true);
  assert.equal(preview.entries[0].status, 'accepted');
  assert.equal(preview.entries[0].jobId, null);
  assert.equal(changes(f.open()), initial);
  assert.deepEqual(f.open().list(), []);
  assert.deepEqual(f.open().inboxEntries(), []);
  const accepted = await scanInbox(f.open(), f.config);
  const id = accepted.entries[0].jobId;
  f.put('a-new.json', { ...product, name: 'Conflicting edit' });
  f.put('b-invalid-base.json', { ...product, version: '2.0.0', baseJobId: 'unknown-task' });
  f.put('c-corrupt.json', '{');
  f.put('d-duplicate.json', product);
  const before = changes(f.open());
  const records = f.open().inboxEntries();
  const jobs = f.open().list();
  const observed = await scanInbox(f.open(), f.config, { observe: true });
  assert.equal(observed.entries.filter(entry => entry.status === 'error').length, 3);
  assert.equal(observed.entries.find(entry => entry.source.endsWith('d-duplicate.json')).jobId, id);
  assert.equal(changes(f.open()), before);
  assert.deepEqual(f.open().inboxEntries(), records);
  assert.deepEqual(f.open().list(), jobs);
});

test('observe admits independent products with the same purpose and audience without durable writes', async t => {
  const f = fixture(t);
  f.open().enqueue(product, f.config);
  f.put('independent-product.json', { ...product, id: 'another-product', name: 'Another label' });
  const before = changes(f.open());
  const preview = await scanInbox(f.open(), f.config, { observe: true });
  assert.equal(preview.entries[0].status, 'accepted');
  assert.equal(changes(f.open()), before);
  assert.deepEqual(f.open().inboxEntries(), []);
});

test('observe detects conflicts between new files in the same scan without durable writes', async t => {
  const f = fixture(t);
  f.put('a-original.json', product);
  f.put('b-identical.json', Object.fromEntries(Object.entries(product).reverse()));
  f.put('c-conflict.json', { ...product, name: 'Conflicting pending request' });
  f.put('d-renamed-product.json', { ...product, id: 'another-product', name: 'Same purpose under another label' });
  const before = changes(f.open());
  const preview = await scanInbox(f.open(), f.config, { observe: true });
  assert.deepEqual(preview.entries.map(entry => entry.status), ['accepted', 'accepted', 'error', 'accepted']);
  assert.equal(changes(f.open()), before);
  assert.deepEqual(f.open().list(), []);
  assert.deepEqual(f.open().inboxEntries(), []);
});

test('unconfigured scans are empty and unreadable inboxes return explicit errors', async t => {
  const f = fixture(t);
  const { inbox, ...withoutInbox } = f.config;
  assert.deepEqual(await scanInbox(f.open(), withoutInbox), { entries: [], error: null, observed: false });
  assert.deepEqual(await scanInbox(f.open(), withoutInbox, { observe: true }), { entries: [], error: null, observed: true });
  const before = changes(f.open());
  const missing = await scanInbox(f.open(), f.config);
  assert.match(missing.error, /Cannot read inbox/);
  assert.deepEqual(missing.entries, []);
  assert.equal(changes(f.open()), before);
  assert.throws(() => submitRequirement(withoutInbox, product), /No inbox is configured/);
});

test('submit is idempotent, bounds size and refuses nonregular or conflicting destinations', t => {
  const f = fixture(t);
  const first = submitRequirement(f.config, product);
  assert.deepEqual(submitRequirement(f.config, Object.fromEntries(Object.entries(product).reverse())), first);
  assert.throws(() => submitRequirement(f.config, { ...product, name: 'Conflicting replacement' }), /different content/);
  assert.deepEqual(JSON.parse(readFileSync(first.path, 'utf8')), product);
  assert.throws(() => submitRequirement(f.config, { ...product, purpose: 'x'.repeat(1024 * 1024) }), /exceeds.*bytes/);
  rmSync(first.path);
  const target = join(f.root, 'outside.json');
  writeFileSync(target, JSON.stringify(product));
  symlinkSync(target, first.path);
  assert.throws(() => submitRequirement(f.config, product), /symbolic link/);
  rmSync(first.path);
  mkdirSync(first.path);
  assert.throws(() => submitRequirement(f.config, product), /regular file/);
  assert.equal(readdirSync(f.config.inbox.directory).some(name => name.endsWith('.tmp')), false);
  assert.equal(existsSync(f.config.stateDir), false);
});

test('intake and submit reject automatic submission outside the App Store channel', async t => {
  const f = fixture(t, { allowSubmit: true, packageTarget: 'ipa' });
  const localProduct = { ...product, channel: 'local', apple: undefined };
  assert.throws(() => submitRequirement(f.config, localProduct), /channel|app-store/i);
  f.put('local.json', localProduct);
  const result = await scanInbox(f.open(), f.config);
  assert.equal(result.entries[0].status, 'error');
  assert.equal(f.open().list().length, 0);
  const accepted = await scanInbox(f.open(), { ...f.config, allowSubmit: false });
  assert.equal(accepted.entries[0].status, 'accepted');
});

async function submitTogether(t, config, values) {
  const moduleURL = new URL('../dist/inbox.js', import.meta.url).href;
  const code = `
    import { submitRequirement } from ${JSON.stringify(moduleURL)};
    process.send({ ready: true });
    process.once('message', ({ config, value }) => {
      try { process.send({ ok: true, ...submitRequirement(config, value) }); }
      catch (error) { process.send({ ok: false, error: error.message }); }
      process.disconnect();
    });
  `;
  const workers = values.map(value => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { stderr += text; });
    let readyResolve, readyReject, resultResolve, resultReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    let answer;
    child.on('message', message => {
      if (message.ready) readyResolve();
      else answer = message;
    });
    child.on('error', error => { readyReject(error); resultReject(error); });
    child.on('exit', code => {
      if (code !== 0 || !answer) {
        const error = new Error(`Submit child exited with ${code}: ${stderr}`);
        readyReject(error);
        resultReject(error);
      } else resultResolve({ ...answer, value });
    });
    return { child, value, ready, result };
  });
  const results = Promise.all(workers.map(worker => worker.result));
  await Promise.all(workers.map(worker => worker.ready));
  for (const worker of workers) worker.child.send({ config, value: worker.value });
  return results;
}

test('simultaneous submit processes cannot overwrite competing same-version requirements', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const alternatives = Array.from({ length: 8 }, (_, index) => ({ ...product, name: index % 2 ? 'Concurrent requirement A' : 'Concurrent requirement B' }));
  const outcomes = await submitTogether(t, f.config, alternatives);
  const successes = outcomes.filter(outcome => outcome.ok);
  const failures = outcomes.filter(outcome => !outcome.ok);
  assert.equal(successes.length, 4);
  assert.equal(failures.length, 4);
  assert.equal(new Set(successes.map(outcome => outcome.path)).size, 1);
  const winner = JSON.parse(readFileSync(successes[0].path, 'utf8'));
  for (const outcome of successes) assert.deepEqual(outcome.value, winner);
  for (const outcome of failures) {
    assert.notEqual(outcome.value.name, winner.name);
    assert.match(outcome.error, /different content/);
  }
  assert.deepEqual(readdirSync(f.config.inbox.directory), [successes[0].path.split('/').at(-1)]);
  assert.equal(existsSync(f.config.stateDir), false);
});

test('scanning yields between files so other scheduled work can run', async t => {
  const f = fixture(t);
  for (let index = 0; index < 8; index++) f.put(`${index}.json`, '{');
  let yielded = false;
  setImmediate(() => { yielded = true; });
  await scanInbox(f.open(), f.config);
  assert.equal(yielded, true);
});
