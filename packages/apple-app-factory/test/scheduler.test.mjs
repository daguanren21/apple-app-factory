import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { nextTurn } from '../dist/runner.js';
import { runStep } from '../dist/scheduler.js';
import { processGroupAlive } from '../dist/process.js';

const posix = { skip: process.platform === 'win32', timeout: 15000 };
const success = [process.execPath, '-e', 'process.exit(0)'];

async function until(action, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = action();
    if (value) return value;
    await sleep(5);
  } while (Date.now() < deadline);
  assert.fail('Step did not reach the expected state before the deadline');
}

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-scheduler-'));
  const config = ConfigSchema.parse({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'),
    allowLocalExecution: true, pollMs: 25,
    verification: { prerequisites: [], checks: [success], runtime: [success] },
    ...overrides,
  });
  const store = new Store(config.stateDir);
  const controller = new AbortController();
  const pending = [];
  t.after(async () => {
    controller.abort();
    await Promise.allSettled(pending);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, config, store, controller,
    enqueue(name, stage = 'verify', jobConfig = config) {
      const job = store.enqueue({
        id: `scheduler-${name}`, name: `Scheduler ${name}`, framework: 'flutter',
        purpose: `Coordinate ${name} work`, audience: 'Factory maintainers',
        differentiators: ['Explicit deterministic stage execution'], acceptance: ['Preserve stage ownership'],
      }, jobConfig);
      return store.update(job.id, { stage, nextAt: 0 });
    },
    start(id, options = {}) {
      const promise = runStep(store, config, id, { signal: controller.signal, ...options });
      pending.push(promise);
      promise.catch(() => {});
      return promise;
    },
  };
}

function assertUnlocked(store) {
  assert.deepEqual(store.db.prepare('SELECT * FROM worker').all(), []);
}

test('step executes only the selected deterministic stage and leaves its successor to the host', async t => {
  const f = fixture(t);
  const sibling = f.enqueue('earlier-sibling');
  const selected = f.enqueue('selected');
  const result = await f.start(selected.id);
  assert.equal(result.id, selected.id);
  assert.equal(result.stage, 'review');
  assert.equal(result.status, 'queued');
  assert.deepEqual(result.attempts, { verify: 1 });
  assert.equal(result.hostTurns, 0);
  assert.equal(result.turn ?? null, null);
  assert.match(result.verifiedDigest, /^[a-f0-9]{64}$/);
  assert.match(result.verifiedDependencyDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.store.get(sibling.id), sibling);
  assertUnlocked(f.store);
});

for (const stage of ['research', 'build', 'review']) {
  test(`step refuses the host-owned ${stage} stage without consuming a budget`, async t => {
    const f = fixture(t);
    const job = f.enqueue(`host-${stage}`, stage);
    await assert.rejects(f.start(job.id), /host|next|deterministic/i);
    assert.deepEqual(f.store.get(job.id), job);
    assertUnlocked(f.store);
  });
}

test('step refuses an active host turn without clearing or charging it', async t => {
  const f = fixture(t);
  const job = f.enqueue('active-turn', 'build');
  const claim = await nextTurn(f.store, job.id);
  assert.equal(claim.action, 'host');
  const before = f.store.get(job.id);
  await assert.rejects(f.start(job.id), /host|turn|deterministic/i);
  assert.deepEqual(f.store.get(job.id), before);
  assert.equal((await nextTurn(f.store, job.id)).turn.id, claim.turn.id);
  assertUnlocked(f.store);
});

test('step honors a future due time without waiting, executing or charging attempts', async t => {
  const f = fixture(t);
  const job = f.enqueue('future');
  const waiting = f.store.update(job.id, { status: 'waiting', nextAt: Date.now() + 3600000 });
  assert.deepEqual(await f.start(job.id), waiting);
  assert.deepEqual(f.store.get(job.id), waiting);
  assertUnlocked(f.store);
});

for (const status of ['blocked', 'failed', 'built']) {
  test(`step leaves a ${status} task stopped`, async t => {
    const f = fixture(t);
    const job = f.enqueue(`stopped-${status}`);
    const stopped = f.store.update(job.id, { status, blockedReason: null, error: 'Explicit operator action required' });
    assert.deepEqual(await f.start(job.id), stopped);
    assert.deepEqual(f.store.get(job.id), stopped);
    assertUnlocked(f.store);
  });
}

for (const permission of ['allowSubmit', 'allowRelease']) {
  test(`build-only rejects snapshotted ${permission} before changing the selected job`, async t => {
    const f = fixture(t);
    const job = f.enqueue('authorized-task', 'verify', { ...f.config, packageTarget: 'ipa', allowSubmit: true, [permission]: true });
    const events = f.store.events(job.id);
    await assert.rejects(f.start(job.id, { buildOnly: true }), /build-only refuses/);
    assert.deepEqual(f.store.get(job.id), job);
    assert.deepEqual(f.store.events(job.id), events);
    assertUnlocked(f.store);
  });
}

test('build-only rejects current configuration publication permission', async t => {
  const f = fixture(t, { packageTarget: 'ipa', allowSubmit: true });
  const job = f.enqueue('configuration-permission', 'verify', { ...f.config, allowSubmit: false });
  await assert.rejects(f.start(job.id, { buildOnly: true }), /build-only refuses/);
  assert.deepEqual(f.store.get(job.id), job);
  assertUnlocked(f.store);
});

test('disabled local execution blocks without starting commands or consuming attempts', async t => {
  const f = fixture(t, { allowLocalExecution: false });
  const job = f.enqueue('local-permission');
  const result = await f.start(job.id);
  assert.equal(result.status, 'blocked');
  assert.equal(result.stage, 'verify');
  assert.deepEqual(result.attempts, {});
  assert.deepEqual(result.groups, []);
  assert.equal(result.hostTurns, 0);
  assertUnlocked(f.store);
});

test('a failed verification queues host repair but never executes it or another job', async t => {
  const f = fixture(t, { verification: { prerequisites: [], checks: [[process.execPath, '-e', 'process.exit(7)']], runtime: [success] } });
  const job = f.enqueue('failed-check'), sibling = f.enqueue('untouched-sibling');
  const result = await f.start(job.id);
  assert.equal(result.stage, 'build');
  assert.equal(result.status, 'waiting');
  assert.deepEqual(result.attempts, { verify: 1 });
  assert.equal(result.hostTurns, 0);
  assert.match(result.error, /Verification failed \(7\)/);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.commands, {});
  assert.deepEqual(f.store.get(sibling.id), sibling);
  assertUnlocked(f.store);
});

test('abort retains the queue lock until the real TERM-resistant stage is retired', posix, async t => {
  const f = fixture(t);
  const marker = join(f.root, 'active.json');
  const command = [process.execPath, '-e', `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`];
  const job = f.enqueue('real-drain', 'verify', { ...f.config, verification: { prerequisites: [], checks: [command], runtime: [success] } });
  const sibling = f.enqueue('competing');
  let settled = false;
  const completion = f.start(job.id);
  completion.then(() => { settled = true; }, () => { settled = true; });
  await until(() => existsSync(marker));
  const { pid } = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(f.store.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
  await assert.rejects(f.start(sibling.id), /owns|lock|already/i);
  assert.equal(f.store.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
  assert.deepEqual(f.store.get(sibling.id), sibling);
  f.controller.abort();
  assert.equal(settled, false);
  assert.equal(f.store.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
  const result = await completion;
  assert.equal(processGroupAlive(pid), false);
  assert.equal(result.stage, 'verify');
  assert.equal(result.status, 'waiting');
  assert.equal(result.attempts.verify, 0);
  assert.equal(result.hostTurns, 0);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.commands, {});
  assertUnlocked(f.store);
});
