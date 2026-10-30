import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkPrerequisites } from '../dist/preflight.js';
import { run, processGroupAlive } from '../dist/process.js';
import { Store } from '../dist/store.js';
import { executeStep } from '../dist/runner.js';

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-preflight-'));
  const config = {
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspace'), packageTarget: 'simulator',
    allowLocalExecution: true,
    pollMs: 25, retryDelayMs: 25, timeoutMs: 5000,
    maxAttempts: 3, maxHostTurns: 3, maxJobHours: 1, executionEnv: [],
    verification: { prerequisites: [], checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] },
    ...overrides,
  };
  const store = new Store(config.stateDir);
  t.after(() => { store.release(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue({ id: 'preflight-test', name: 'Prerequisite fixture', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Configured environment checks'], acceptance: ['Resume only after readiness'], purpose: 'Test configured prerequisites', audience: 'Factory maintainers' }, config);
  return { root, config, store, job };
}

function prerequisiteBlock(argv = ['configured-check']) {
  return { kind: 'prerequisite', stage: 'verify', prerequisite: { argv, reason: 'nonzero-exit' } };
}

async function until(action, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = action();
    if (value) return value;
    await sleep(10);
  } while (Date.now() < deadline);
  assert.fail('The configured prerequisite did not reach its bounded readiness deadline');
}

test('configured prerequisite data cannot execute shell syntax', async t => {
  const f = fixture(t);
  const checked = join(f.root, 'checked');
  const escaped = join(f.root, 'shell-escaped');
  const env = { VALUE: `literal; touch ${JSON.stringify(escaped)}` };
  const command = [process.execPath, '-e', `require('node:assert/strict').equal(process.argv[1], process.env.VALUE);require('node:fs').writeFileSync(${JSON.stringify(checked)}, 'done')`, '${VALUE}'];
  await checkPrerequisites([command], { cwd: f.root, env });
  assert.equal(existsSync(checked), true);
  assert.equal(existsSync(escaped), false);
});

test('missing configured executables produce a typed prerequisite failure', async t => {
  const f = fixture(t);
  const argv = [join(f.root, 'not-installed'), '--version'];
  await assert.rejects(checkPrerequisites([argv], { cwd: f.root }), error => {
    assert.equal(error.code, 'PREREQUISITE_FAILED');
    assert.deepEqual(error.prerequisite, { argv, reason: 'missing-command' });
    assert.equal(error.cause.code, 'ENOENT');
    return true;
  });
});

test('nonzero configured checks are typed and stop the prerequisite list', async t => {
  const f = fixture(t);
  const forbidden = join(f.root, 'must-not-run');
  const argv = [process.execPath, '-e', 'process.exit(17)'];
  await assert.rejects(checkPrerequisites([
    argv,
    [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)}, 'ran')`],
  ], { cwd: f.root }), error => {
    assert.equal(error.code, 'PREREQUISITE_FAILED');
    assert.deepEqual(error.prerequisite, { argv, reason: 'nonzero-exit' });
    assert.match(error.message, /17/);
    return true;
  });
  assert.equal(existsSync(forbidden), false);
});

test('absent environment placeholders are typed and publisher secrets stay disallowed', async () => {
  for (const [key, env] of [['DEVICE_ID', {}], ['DEVICE_ID', { DEVICE_ID: '' }], ['ASC_KEY_ID', { ASC_KEY_ID: 'never-expanded' }]]) {
    const argv = [process.execPath, '${' + key + '}'];
    await assert.rejects(checkPrerequisites([argv], { env, run: () => assert.fail('Environment expansion must fail before spawning') }), error => {
      assert.equal(error.code, 'PREREQUISITE_FAILED');
      assert.deepEqual(error.prerequisite, { argv, reason: 'environment' });
      assert.equal(error.cause.code, 'SETUP_REQUIRED');
      assert.equal(error.message.includes('never-expanded'), false);
      return true;
    });
  }
});

test('ordinary permissions, cleanup failures, timeouts and non-spawn ENOENT errors retain their identity', async () => {
  for (const code of ['EACCES', 'EPERM', 'PROCESS_CLEANUP_BLOCKED', 'ENOENT', undefined]) {
    const failure = Object.assign(new Error('The command could not complete'), { code });
    await assert.rejects(checkPrerequisites([[process.execPath]], { run: async () => { throw failure; } }), error => error === failure);
  }
});

test('already-aborted prerequisites preserve the cancellation reason and never spawn', async () => {
  const controller = new AbortController();
  const reason = new Error('Worker stopped');
  controller.abort(reason);
  await assert.rejects(checkPrerequisites([[process.execPath]], { signal: controller.signal, run: () => assert.fail('An aborted prerequisite must not spawn') }), error => error === reason);
});

test('aborting an active prerequisite waits for supervised cleanup without becoming an environment block', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  let pid;
  await assert.rejects(checkPrerequisites([[process.execPath, '-e', 'setInterval(()=>{},1000)']], {
    signal: controller.signal,
    run: (argv, options) => run(argv, {
      ...options, timeoutMs: 3000,
      onSpawn(value) { pid = value; controller.abort(); },
    }),
  }), error => {
    assert.notEqual(error.code, 'PREREQUISITE_FAILED');
    assert.match(error.message, /interrupted/);
    return true;
  });
  assert.equal(processGroupAlive(pid), false);
});

test('an abort racing a failed check is not classified as a missing prerequisite', async () => {
  const controller = new AbortController();
  const reason = new Error('Worker stopped after the check');
  await assert.rejects(checkPrerequisites([[process.execPath]], {
    signal: controller.signal,
    run: async () => { controller.abort(reason); return { code: 1 }; },
  }), error => error === reason);
});

test('only due typed prerequisite blocks are claimable and claiming clears the reason', t => {
  const { store, job } = fixture(t);
  assert.equal(job.blockedReason, null);
  for (const blockedReason of [undefined, null]) {
    store.update(job.id, { status: 'blocked', nextAt: 0, blockedReason, error: 'Prerequisite failed; retry is not authorized by error text' });
    assert.equal(store.next(), undefined);
  }
  for (const blockedReason of [{ kind: 'permission' }, { kind: 'apple-write' }]) {
    assert.throws(() => store.update(job.id, { blockedReason }));
    assert.equal(store.get(job.id).status, 'blocked');
    assert.equal(store.next(), undefined);
  }
  store.update(job.id, { blockedReason: prerequisiteBlock(), nextAt: Date.now() + 60000 });
  assert.equal(store.next(), undefined);
  store.update(job.id, { nextAt: 0 });
  const claimed = store.next();
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.blockedReason, null);
  assert.equal(store.next(), undefined, 'A claimed prerequisite cannot be replayed concurrently');
});

test('real environmental readiness unblocks the same verification stage without charging attempts or host turns', { timeout: 15000 }, async t => {
  const f = fixture(t, { pollMs: 100 });
  const ready = join(f.root, 'environment-ready');
  const argv = [process.execPath, '-e', `process.exit(require('node:fs').existsSync(${JSON.stringify(ready)}) ? 0 : 23)`];
  f.store.update(f.job.id, {
    stage: 'verify', attempts: { build: 1 }, hostTurns: 1,
    config: { ...f.config, verification: { ...f.config.verification, prerequisites: [argv] } },
  });
  f.store.acquire();
  const first = await executeStep(f.store, f.store.next());
  assert.equal(first.status, 'blocked');
  assert.equal(first.stage, 'verify');
  assert.deepEqual(first.blockedReason, { kind: 'prerequisite', stage: 'verify', prerequisite: { argv, reason: 'nonzero-exit' } });
  assert.deepEqual(first.attempts, { build: 1 });
  assert.equal(first.hostTurns, 1);
  assert.equal(first.nextAt > Date.now() - f.config.pollMs, true);
  assert.equal(f.store.next(), undefined, 'A prerequisite must wait until its next polling time');
  const secondClaim = await until(() => f.store.next());
  assert.equal(secondClaim.blockedReason, null);
  const stillBlocked = await executeStep(f.store, secondClaim);
  assert.equal(stillBlocked.status, 'blocked');
  assert.equal(stillBlocked.stage, 'verify');
  assert.deepEqual(stillBlocked.attempts, { build: 1 });
  assert.equal(stillBlocked.hostTurns, 1);
  writeFileSync(ready, 'ready');
  const recoveredClaim = await until(() => f.store.next());
  assert.equal(recoveredClaim.id, f.job.id);
  assert.equal(recoveredClaim.stage, 'verify');
  assert.equal(recoveredClaim.blockedReason, null);
  const recovered = await executeStep(f.store, recoveredClaim);
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.stage, 'review');
  assert.deepEqual(recovered.attempts, { build: 1, verify: 1 });
  assert.equal(recovered.hostTurns, 1);
  assert.equal(typeof recovered.verifiedDigest, 'string');
  assert.deepEqual(recovered.groups, []);
  assert.deepEqual(recovered.commands, {});
});

test('permission-denied blocks never auto-retry', async t => {
  const { store, job } = fixture(t);
  for (const error of ['EACCES: permission denied', 'EPERM: operation not permitted']) {
    store.update(job.id, { status: 'blocked', nextAt: 0, blockedReason: null, error });
    assert.equal(store.next(), undefined, error);
    assert.equal(store.get(job.id).status, 'blocked');
  }
  const denied = await executeStep(store, store.update(job.id, {
    stage: 'verify', status: 'running', blockedReason: null,
    config: { ...job.config, allowLocalExecution: false, executionWarning: 'Local execution is disabled' },
  }));
  assert.equal(denied.status, 'blocked');
  assert.equal(denied.hostTurns, 0);
  assert.deepEqual(denied.attempts, {});
  assert.equal(store.next(), undefined);
});

test('worker recovery clears stale prerequisite classification and preserves the single-worker lock', t => {
  const { store, job, config } = fixture(t);
  const other = new Store(config.stateDir);
  t.after(() => other.close());
  store.update(job.id, { status: 'running', blockedReason: prerequisiteBlock(), attempts: { verify: 2 }, hostTurns: 2 });
  store.acquire();
  assert.throws(() => other.acquire(), /already owns this queue/);
  assert.equal(store.get(job.id).status, 'waiting');
  assert.equal(store.get(job.id).blockedReason, null);
  const claimed = store.next();
  assert.deepEqual(claimed.attempts, { verify: 2 });
  assert.equal(claimed.hostTurns, 2);
});

test('unverifiable process recovery clears typed prerequisite eligibility and never replays a live group', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const f = fixture(t);
  const ready = join(f.root, 'process-ready');
  const controller = new AbortController();
  let pid;
  const completion = run([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');setInterval(()=>{},1000)`], {
    timeoutMs: 5000, signal: controller.signal,
    onSpawn(value) { pid = value; },
  }).catch(error => error);
  try {
    await until(() => existsSync(ready));
    f.store.update(f.job.id, { status: 'blocked', nextAt: 0, blockedReason: prerequisiteBlock(), groups: [pid], commands: {} });
    assert.equal(f.store.next(), undefined);
    const blocked = f.store.get(f.job.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, null);
    assert.equal(processGroupAlive(pid), true);
    assert.equal(f.store.next(), undefined);
  } finally {
    controller.abort();
    await completion;
  }
  assert.equal(processGroupAlive(pid), false);
  assert.equal(f.store.next(), undefined, 'An unrelated process recovery block stays manual even after the group exits');
});

test('owned groups retain tokens and deadlines while prerequisite replay waits for cleanup', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const f = fixture(t);
  const ready = join(f.root, 'owned-process-ready');
  const controller = new AbortController();
  let pid, metadata;
  const completion = run([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');setInterval(()=>{},1000)`], {
    timeoutMs: 5000, signal: controller.signal,
    onSpawn(value, details) { pid = value; metadata = details; },
  }).catch(error => error);
  try {
    await until(() => existsSync(ready));
    f.store.update(f.job.id, { status: 'blocked', nextAt: 0, blockedReason: prerequisiteBlock(), groups: [pid], commands: { [pid]: metadata } });
    assert.equal(f.store.next(), undefined);
    const recovering = f.store.get(f.job.id);
    assert.equal(recovering.status, 'waiting');
    assert.equal(recovering.blockedReason, null);
    assert.deepEqual(recovering.commands[pid], metadata);
    assert.equal(processGroupAlive(pid), true);
    assert.equal(f.store.next(), undefined, 'An owned live group must prevent concurrent prerequisite replay');
  } finally {
    controller.abort();
    await completion;
  }
  assert.equal(processGroupAlive(pid), false);
  const resumed = await until(() => f.store.next());
  assert.equal(resumed.id, f.job.id);
  assert.equal(resumed.blockedReason, null);
  assert.deepEqual(resumed.groups, []);
  assert.deepEqual(resumed.commands, {});
});

for (const failure of ['permission', 'timeout']) {
  for (const previous of [false, true]) {
    test(`untyped prerequisite ${failure} failure stays manual with ${previous ? 'existing' : 'no'} attempts`, { skip: failure === 'permission' && process.platform === 'win32' }, async t => {
      const f = fixture(t, { timeoutMs: 100 });
      const executable = join(f.root, 'not-executable');
      writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
      const argv = failure === 'permission' ? [executable] : [process.execPath, '-e', 'setInterval(()=>{},1000)'];
      const attempts = previous ? { verify: 1 } : {};
      const config = { ...f.config, verification: { ...f.config.verification, prerequisites: [argv] } };
      const active = f.store.update(f.job.id, { config, stage: 'verify', status: 'running', attempts, hostTurns: 2 });
      const result = await executeStep(f.store, active);
      assert.equal(result.status, 'blocked');
      assert.equal(result.stage, 'verify');
      assert.equal(result.blockedReason, null);
      assert.deepEqual(result.attempts, attempts);
      assert.equal(result.hostTurns, 2);
      assert.equal(Number.isFinite(result.nextAt), true);
      assert.deepEqual(result.groups, []);
      assert.equal(f.store.next(), undefined);
    });
  }
}

for (const attempts of [{}, { verify: 1 }]) {
  test(`workspace preparation permission failure stays manual with ${JSON.stringify(attempts)}`, { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
    const f = fixture(t);
    mkdirSync(f.config.workspaceRoot, { recursive: true });
    chmodSync(f.config.workspaceRoot, 0o500);
    try {
      const active = f.store.update(f.job.id, { stage: 'verify', status: 'running', attempts, hostTurns: 2 });
      const result = await executeStep(f.store, active);
      assert.equal(result.status, 'blocked');
      assert.equal(result.stage, 'verify');
      assert.equal(result.blockedReason, null);
      assert.deepEqual(result.attempts, attempts);
      assert.equal(result.hostTurns, 2);
      assert.equal(Number.isFinite(result.nextAt), true);
      assert.match(result.error, /EACCES/);
      assert.equal(existsSync(f.job.workspace), false);
      assert.deepEqual(result.groups, []);
      assert.deepEqual(result.commands, {});
      assert.equal(f.store.next(), undefined);
      assert.equal(f.store.get(f.job.id).status, 'blocked');
    } finally { chmodSync(f.config.workspaceRoot, 0o700); }
  });
}
