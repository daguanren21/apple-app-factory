import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { runWorker } from '../dist/scheduler.js';
import { run, processGroupAlive, signalOwnedProcessGroup } from '../dist/process.js';

const emptyScan = { entries: [], error: null, observed: false };
const posix = { skip: process.platform === 'win32', timeout: 15000 };

async function until(action, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = action();
    if (value) return value;
    await sleep(5);
  } while (Date.now() < deadline);
  assert.fail('Scheduler did not reach the expected state before the deadline');
}

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-scheduler-'));
  const config = ConfigSchema.parse({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'),
    maxConcurrentJobs: 2, pollMs: 25,
    builder: { kind: 'codex' }, reviewer: { kind: 'codex' },
    verification: { checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] },
    ...overrides,
  });
  const store = new Store(config.stateDir);
  const controller = new AbortController();
  const gates = [], pending = [], commands = [];
  const track = promise => {
    pending.push(promise);
    promise.catch(() => {});
    return promise;
  };
  t.after(async () => {
    controller.abort();
    for (const command of commands) command.abort();
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(pending);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, config, store, controller,
    gate() {
      const gate = Promise.withResolvers();
      gates.push(gate);
      return gate;
    },
    enqueue(name, stage = 'research', jobConfig = config) {
      const job = store.enqueue({
        id: `scheduler-${name}`, name: `Scheduler ${name}`, framework: 'flutter',
        purpose: `Coordinate ${name} work`, audience: 'Factory maintainers',
        differentiators: ['Independent stage scheduling'], acceptance: ['Preserve stage ownership'],
      }, jobConfig);
      return store.update(job.id, { stage, nextAt: 0 });
    },
    start(options = {}) {
      return track(runWorker(store, config, { signal: controller.signal, scan: async () => emptyScan, ...options }));
    },
    async command(resistTerm = false) {
      const ready = join(root, `command-${commands.length}.ready`);
      const abort = new AbortController();
      commands.push(abort);
      let pid, metadata;
      const done = track(run([process.execPath, '-e', `
        ${resistTerm ? "process.on('SIGTERM',()=>{});" : ''}
        require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');
        setInterval(()=>{},1000);
      `], {
        signal: abort.signal, timeoutMs: 20000,
        onSpawn(value, command) { pid = value; metadata = command; },
      }).then(result => ({ result }), error => ({ error })));
      await until(() => existsSync(ready));
      return { pid, metadata, done, abort };
    },
  };
}

test('bounded stages exclude early-queued active jobs and give another job its turn', async t => {
  const f = fixture(t);
  const a = f.enqueue('first'), b = f.enqueue('second'), c = f.enqueue('third');
  const first = f.gate(), second = f.gate(), third = f.gate(), successor = f.gate();
  const starts = [], inFlight = new Set(), results = [];
  let peak = 0;
  const worker = f.start({
    onResult: job => results.push(job),
    step: async (store, job) => {
      assert.equal(inFlight.has(job.id), false, 'A successor must not overlap its previous stage');
      inFlight.add(job.id);
      peak = Math.max(peak, inFlight.size);
      starts.push([job.id, job.stage]);
      if (job.id === a.id && job.stage === 'research') {
        store.update(job.id, { stage: 'build', status: 'queued', nextAt: 0 });
        await first.promise;
        inFlight.delete(job.id);
        return store.get(job.id);
      }
      await (job.id === b.id ? second : job.id === c.id ? third : successor).promise;
      inFlight.delete(job.id);
      return store.update(job.id, { status: 'ready' });
    },
  });
  await until(() => starts.length >= 2);
  assert.deepEqual(starts, [[a.id, 'research'], [b.id, 'research']]);
  assert.equal(f.store.get(a.id).status, 'queued');
  first.resolve();
  await until(() => starts.length >= 3);
  assert.deepEqual(starts[2], [c.id, 'research'], 'An immediate successor cannot monopolize equal-priority queue rows');
  second.resolve();
  await until(() => starts.length >= 4);
  assert.deepEqual(starts[3], [a.id, 'build']);
  third.resolve();
  successor.resolve();
  await until(() => results.length === 4);
  f.controller.abort();
  await worker;
  assert.equal(peak, 2);
  assert.equal(inFlight.size, 0);
});

test('inbox polling continues at full capacity without repeating unchanged scan output', async t => {
  const f = fixture(t, { inbox: { directory: '/unused-scheduler-inbox', pollMs: 15 } });
  const a = f.enqueue('occupied-first'), b = f.enqueue('occupied-second');
  const hold = f.gate();
  const starts = [], scans = [];
  let count = 0, incoming;
  const worker = f.start({
    scan: async store => {
      count++;
      if (count === 2) incoming = f.enqueue('incoming');
      return incoming ? {
        error: null, observed: false,
        entries: [{ source: join(f.root, 'request.json'), digest: 'intake-digest', status: 'accepted', jobId: incoming.id, error: null, observedAt: count }],
      } : emptyScan;
    },
    onScan: scan => scans.push(scan),
    step: async (store, job) => {
      starts.push(job.id);
      await hold.promise;
      return store.update(job.id, { status: 'ready' });
    },
  });
  await until(() => count >= 3);
  assert.deepEqual(starts, [a.id, b.id]);
  assert.equal(f.store.get(incoming.id).status, 'queued');
  assert.equal(scans.length, 2, 'Changing only observation time must not print an identical scan again');
  f.controller.abort();
  hold.resolve();
  await worker;
  assert.deepEqual(starts, [a.id, b.id], 'Aborting a full worker must not dispatch its newly ingested job');
});

test('scan rejection is reported once while healthy work keeps running', async t => {
  const f = fixture(t, { inbox: { directory: '/unused-scheduler-inbox', pollMs: 15 } });
  const job = f.enqueue('healthy-intake-error');
  const hold = f.gate();
  let count = 0, started = false;
  const reports = [], results = [];
  const worker = f.start({
    scan: async () => { count++; throw new Error('Inbox is temporarily unreadable'); },
    onScan: scan => reports.push(scan),
    onResult: result => { results.push(result); f.controller.abort(); },
    step: async store => {
      started = true;
      await hold.promise;
      return store.update(job.id, { status: 'ready' });
    },
  });
  await until(() => count >= 3 && started);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].error, 'Inbox is temporarily unreadable');
  assert.equal(f.store.get(job.id).status, 'running');
  hold.resolve();
  await worker;
  assert.equal(results[0].status, 'ready');
});

test('verify and package serialize while independent build stages overlap', async t => {
  const f = fixture(t, { maxConcurrentJobs: 3 });
  const verify = f.enqueue('verify', 'verify');
  const packaging = f.enqueue('package', 'package');
  const build = f.enqueue('build', 'build');
  const verifyDone = f.gate(), packageDone = f.gate(), buildDone = f.gate();
  const starts = [];
  let tooling = 0, peak = 0;
  const worker = f.start({
    step: async (store, job) => {
      const exclusive = ['verify', 'package'].includes(job.stage);
      if (exclusive) { tooling++; peak = Math.max(peak, tooling); }
      starts.push(job.id);
      await (job.id === verify.id ? verifyDone : job.id === packaging.id ? packageDone : buildDone).promise;
      if (exclusive) tooling--;
      return store.update(job.id, { status: 'ready' });
    },
  });
  await until(() => starts.length >= 2);
  assert.deepEqual(starts, [verify.id, build.id]);
  verifyDone.resolve();
  await until(() => starts.includes(packaging.id));
  assert.equal(peak, 1);
  f.controller.abort();
  packageDone.resolve();
  buildDone.resolve();
  await worker;
});

test('persisted orphan tooling groups exclude Apple work even after the job moves to repair', posix, async t => {
  const f = fixture(t);
  const orphan = f.enqueue('orphan-repair', 'build');
  const command = await f.command();
  f.store.update(orphan.id, {
    status: 'blocked', blockedReason: null, recoveryStage: 'verify',
    groups: [command.pid], commands: { [command.pid]: command.metadata },
  });
  const packaging = f.enqueue('orphan-waiter', 'package');
  const build = f.enqueue('orphan-independent', 'build');
  const hold = f.gate();
  const starts = [];
  const worker = f.start({
    step: async (store, job) => {
      starts.push(job.id);
      await hold.promise;
      return store.update(job.id, { status: 'ready' });
    },
  });
  await until(() => starts.includes(build.id));
  assert.deepEqual(starts, [build.id]);
  assert.equal(processGroupAlive(command.pid), true);
  assert.equal(f.store.get(packaging.id).status, 'queued');
  command.abort.abort();
  await command.done;
  assert.equal(processGroupAlive(command.pid), false);
  await until(() => starts.includes(packaging.id));
  assert.deepEqual(f.store.get(orphan.id).groups, [command.pid], 'Inspecting a stopped job must not rewrite its recovery ownership');
  f.controller.abort();
  hold.resolve();
  await worker;
});

test('unexpected step rejection blocks only that job and preserves command ownership', async t => {
  const f = fixture(t);
  const bad = f.enqueue('unexpected-error', 'verify');
  const healthy = f.enqueue('error-sibling', 'build');
  const hold = f.gate();
  const groups = [2147483647];
  const commands = { 2147483647: { deadline: Date.now() + 10000, identity: { token: 'scheduler-retained-ownership' } } };
  const results = [];
  let healthyStarted = false, settled = false;
  const worker = f.start({
    onResult: job => results.push(job),
    step: async (store, job) => {
      if (job.id === bad.id) {
        store.update(job.id, { stage: 'build', status: 'queued', groups, commands, recoveryStage: 'verify' });
        throw new Error('Unexpected stage rejection');
      }
      healthyStarted = true;
      await hold.promise;
      return store.update(job.id, { status: 'ready' });
    },
  });
  worker.then(() => { settled = true; });
  await until(() => healthyStarted && results.some(job => job.id === bad.id));
  const blocked = f.store.get(bad.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stage, 'verify');
  assert.equal(blocked.blockedReason, null);
  assert.deepEqual(blocked.groups, groups);
  assert.deepEqual(blocked.commands, commands);
  assert.match(blocked.error, /Unexpected stage rejection/);
  assert.equal(settled, false);
  assert.equal(f.store.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
  hold.resolve();
  await until(() => f.store.get(healthy.id).status === 'ready');
  f.controller.abort();
  await worker;
  assert.equal(results.find(job => job.id === healthy.id).status, 'ready');
});

test('abort waits for every stage cleanup before releasing the queue lock', async t => {
  const f = fixture(t);
  const first = f.enqueue('drain-first'), second = f.enqueue('drain-second'), pending = f.enqueue('drain-pending');
  const firstDone = f.gate(), secondDone = f.gate();
  const starts = [], cleanup = [], results = [];
  let settled = false;
  const worker = f.start({
    onResult: job => results.push(job.id),
    step: async (store, job, { signal }) => {
      starts.push(job.id);
      const aborted = Promise.withResolvers();
      if (signal.aborted) aborted.resolve();
      else signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      await aborted.promise;
      cleanup.push(job.id);
      await (job.id === first.id ? firstDone : secondDone).promise;
      assert.equal(store.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
      return store.update(job.id, { status: 'waiting', nextAt: Date.now() });
    },
  });
  worker.then(() => { settled = true; });
  await until(() => starts.length === 2);
  f.controller.abort();
  await until(() => cleanup.length === 2);
  assert.equal(settled, false);
  firstDone.resolve();
  await until(() => results.includes(first.id));
  assert.equal(settled, false);
  assert.equal(f.store.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
  assert.equal(f.store.get(pending.id).status, 'queued');
  secondDone.resolve();
  await worker;
  assert.deepEqual(new Set(starts), new Set([first.id, second.id]));
  assert.deepEqual(f.store.db.prepare('SELECT * FROM worker').all(), []);
});

test('one-shot intake executes at most one stage even when that stage queues a successor', async t => {
  const f = fixture(t, { maxConcurrentJobs: 4 });
  let scans = 0;
  const starts = [];
  let first, second;
  await f.start({
    once: true,
    scan: async () => {
      scans++;
      first = f.enqueue('once-first');
      second = f.enqueue('once-second');
      return emptyScan;
    },
    step: async (store, job) => {
      starts.push(job.id);
      return store.update(job.id, { stage: 'build', status: 'queued', nextAt: 0 });
    },
  });
  assert.equal(scans, 1);
  assert.deepEqual(starts, [first.id]);
  assert.equal(f.store.get(first.id).stage, 'build');
  assert.equal(f.store.get(second.id).status, 'queued');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM worker').all(), []);
});

test('one-shot recovery waits for an owned orphan group before replaying one stage', posix, async t => {
  const f = fixture(t);
  const job = f.enqueue('once-recovery');
  const command = await f.command(true);
  signalOwnedProcessGroup(command.pid, command.metadata.identity, 'SIGTERM');
  f.store.update(job.id, {
    status: 'running', groups: [command.pid], recoveryStage: 'research',
    commands: { [command.pid]: { ...command.metadata, deadline: Date.now() - 1, termAt: Date.now() } },
  });
  let starts = 0, scans = 0;
  await f.start({
    once: true,
    scan: async () => { scans++; return emptyScan; },
    step: async (store, claimed) => {
      starts++;
      assert.equal(processGroupAlive(command.pid), false, 'The old command group must be gone before replay');
      assert.deepEqual(claimed.groups, []);
      return store.update(claimed.id, { stage: 'build', status: 'queued', nextAt: 0 });
    },
  });
  await command.done;
  assert.equal(starts, 1);
  assert.equal(scans, 1);
  assert.equal(f.store.get(job.id).stage, 'build');
  assert.equal(f.store.events(job.id).some(event => Number.isFinite(event.data.commands?.[command.pid]?.killAt)), true);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM worker').all(), []);
});

test('build-only preflight refuses authorized work before intake or queue mutation', async t => {
  const f = fixture(t);
  const job = f.enqueue('authorized-before-scan', 'research', { ...f.config, packageTarget: 'ipa', allowSubmit: true });
  const before = f.store.events(job.id).length;
  let scans = 0, steps = 0;
  await assert.rejects(f.start({
    once: true, buildOnly: true,
    scan: async () => { scans++; return emptyScan; },
    step: async () => { steps++; throw new Error('Publication work must not start'); },
  }), /build-only refuses/);
  assert.equal(scans, 0);
  assert.equal(steps, 0);
  assert.equal(f.store.get(job.id).status, 'queued');
  assert.equal(f.store.events(job.id).length, before);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM worker').all(), []);
});

test('build-only claim guard refuses authorization arriving after the preflight snapshot', async t => {
  const f = fixture(t);
  const next = f.store.next.bind(f.store);
  let injected, eventsBefore, steps = 0;
  f.store.next = (...args) => {
    if (!injected) {
      injected = f.enqueue('authorized-at-claim', 'research', { ...f.config, packageTarget: 'ipa', allowSubmit: true });
      eventsBefore = f.store.events(injected.id).length;
    }
    return next(...args);
  };
  await assert.rejects(f.start({
    once: true, buildOnly: true,
    step: async () => { steps++; throw new Error('Publication work must not start'); },
  }), /build-only refuses task/);
  assert.equal(steps, 0);
  assert.equal(f.store.get(injected.id).status, 'queued');
  assert.equal(f.store.events(injected.id).length, eventsBefore);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM worker').all(), []);
});

test('abort retains ownership until a real TERM-resistant command group is retired', posix, async t => {
  const f = fixture(t);
  const job = f.enqueue('real-drain', 'build');
  const ready = join(f.root, 'real-drain-ready');
  let pid, result, settled = false;
  const worker = f.start({
    onResult: current => {
      result = current;
      assert.equal(processGroupAlive(pid), false);
      assert.equal(f.store.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
    },
    step: async (store, claimed, { signal }) => {
      try {
        await run([process.execPath, '-e', `
          process.on('SIGTERM',()=>{});
          require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');
          setInterval(()=>{},1000);
        `], {
          signal, timeoutMs: 20000,
          onSpawn(value, metadata) {
            pid = value;
            store.update(claimed.id, { groups: [pid], commands: { [pid]: metadata }, recoveryStage: 'build' });
          },
        });
        assert.fail('The held command must be interrupted by worker shutdown');
      } catch (error) {
        assert.equal(signal.aborted, true);
        assert.equal(processGroupAlive(pid), false);
        return store.update(claimed.id, { status: 'waiting', groups: [], commands: {}, recoveryStage: undefined, error: error.message });
      }
    },
  });
  worker.then(() => { settled = true; });
  await until(() => existsSync(ready));
  f.controller.abort();
  assert.equal(settled, false);
  assert.equal(f.store.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
  await worker;
  assert.equal(result.id, job.id);
  assert.equal(result.status, 'waiting');
  assert.deepEqual(f.store.get(job.id).groups, []);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM worker').all(), []);
});

test('two orphan Apple stages recover without resource exclusion preventing their cleanup', posix, async t => {
  const f = fixture(t, { maxConcurrentJobs: 3 });
  const verify = f.enqueue('recover-verify', 'verify');
  const packaging = f.enqueue('recover-package', 'package');
  const commands = [await f.command(true), await f.command(true)];
  for (const [index, job] of [verify, packaging].entries()) {
    const command = commands[index];
    signalOwnedProcessGroup(command.pid, command.metadata.identity, 'SIGTERM');
    f.store.update(job.id, {
      status: 'running', groups: [command.pid], recoveryStage: job.stage,
      commands: { [command.pid]: { ...command.metadata, deadline: Date.now() - 1, termAt: Date.now() } },
    });
  }
  const build = f.enqueue('recover-independent', 'build');
  const verifyDone = f.gate(), packageDone = f.gate(), buildDone = f.gate();
  const starts = [];
  let tooling = 0, peak = 0;
  const worker = f.start({
    step: async (store, claimed) => {
      starts.push(claimed.id);
      const exclusive = ['verify', 'package'].includes(claimed.stage);
      if (exclusive) {
        tooling++;
        peak = Math.max(peak, tooling);
        for (const command of commands) assert.equal(processGroupAlive(command.pid), false);
      }
      await (claimed.id === verify.id ? verifyDone : claimed.id === packaging.id ? packageDone : buildDone).promise;
      if (exclusive) tooling--;
      return store.update(claimed.id, { status: 'ready' });
    },
  });
  await until(() => starts.includes(build.id));
  await until(() => starts.some(id => id !== build.id));
  assert.equal(starts.filter(id => id !== build.id).length, 1);
  const first = starts.find(id => id !== build.id);
  (first === verify.id ? verifyDone : packageDone).resolve();
  await until(() => starts.includes(verify.id) && starts.includes(packaging.id));
  assert.equal(peak, 1);
  f.controller.abort();
  verifyDone.resolve();
  packageDone.resolve();
  buildDone.resolve();
  await worker;
  await Promise.all(commands.map(command => command.done));
});
