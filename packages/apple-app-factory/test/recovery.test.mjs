import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../dist/store.js';
import { run, processGroupAlive, signalOwnedProcessGroup } from '../dist/process.js';

const processModule = new URL('../dist/process.js', import.meta.url).href;
const storeModule = new URL('../dist/store.js', import.meta.url).href;
const posix = { skip: process.platform === 'win32', timeout: 15000 };

async function until(action, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = action();
    if (value) return value;
    await sleep(25);
  } while (Date.now() < deadline);
  assert.fail('Subprocess recovery did not finish within its bounded deadline');
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-recovery-'));
  const config = { stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspace'), packageTarget: 'simulator', pollMs: 25, verification: { checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] } };
  const stores = [], workers = [], groups = new Map(), pending = [];
  t.after(async () => {
    for (const worker of workers) {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    }
    for (const [pid, identity] of groups) {
      try { signalOwnedProcessGroup(pid, identity, 'SIGKILL'); } catch {}
    }
    await Promise.all(pending);
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, config, groups, pending,
    open() { const store = new Store(config.stateDir); stores.push(store); return store; },
    launch(source) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
      workers.push(child);
      let output = '';
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-262144); });
      child.stderr.on('data', chunk => { output = (output + chunk).slice(-262144); });
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, output }));
      });
      pending.push(done.catch(() => {}));
      return { child, done };
    },
  };
}

function enqueue(store, config) {
  return store.enqueue({ id: 'recovery-test', name: 'Recovery fixture', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Owned process recovery'], acceptance: ['Never replay live work'], purpose: 'Test command recovery', audience: 'Factory maintainers' }, config);
}

function descendantCommand(ready, exitParent) {
  const descendant = `process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)`;
  return `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',()=>{
      require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({parent:process.pid,child:child.pid}));
      child.disconnect();
      ${exitParent ? 'process.exit(0)' : 'setInterval(()=>{},1000)'};
    });`;
}

test('a killed worker restarts without replay until its orphan group is retired', posix, async t => {
  const f = fixture(t);
  const store = f.open();
  const job = enqueue(store, f.config);
  assert.deepEqual(job.commands, {});
  assert.equal(job.manualRecovery, null);
  const ready = join(f.root, 'descendant-ready');
  const worker = f.launch(`
    import { Store } from ${JSON.stringify(storeModule)};
    import { run } from ${JSON.stringify(processModule)};
    const store=new Store(${JSON.stringify(f.config.stateDir)});
    store.acquire();
    const job=store.next();
    await run([process.execPath,'-e',${JSON.stringify(descendantCommand(ready, true))}],{
      timeoutMs:2000,
      onSpawn(pid,metadata){store.update(job.id,{groups:[pid],commands:{[pid]:metadata}})}
    });
    store.release();
    store.close();
  `);
  await until(() => existsSync(ready));
  await until(() => {
    const pending = store.get(job.id);
    return pending.groups.length > 0 && pending.commands[pending.groups[0]] !== undefined;
  });
  const saved = store.get(job.id);
  const [pid] = saved.groups;
  const metadata = saved.commands[pid];
  f.groups.set(pid, metadata.identity);
  assert.equal(typeof pid, 'number');
  assert.equal(typeof metadata.identity.token, 'string');
  assert.equal(Number.isFinite(metadata.deadline), true);
  await sleep(100);
  assert.equal(processGroupAlive(pid), true);
  assert.equal(worker.child.exitCode, null);
  worker.child.kill('SIGKILL');
  assert.equal((await worker.done).signal, 'SIGKILL');

  const restarted = f.open();
  restarted.acquire();
  assert.equal(restarted.next(), undefined);
  assert.equal(restarted.get(job.id).status, 'waiting');
  const resumed = await until(() => {
    const next = restarted.next();
    if (next) assert.equal(processGroupAlive(pid), false, 'A surviving orphan group must prevent replay');
    else assert.notEqual(restarted.get(job.id).status, 'running');
    assert.notEqual(restarted.get(job.id).status, 'blocked', restarted.get(job.id).error);
    return next;
  });
  assert.equal(resumed.id, job.id);
  assert.deepEqual(resumed.groups, []);
  assert.deepEqual(resumed.commands, {});
  const phases = restarted.events(job.id).map(event => event.data.commands?.[pid]).filter(Boolean);
  assert.equal(phases.some(command => Number.isFinite(command.termAt)), true);
  assert.equal(phases.some(command => Number.isFinite(command.killAt)), true);
  restarted.release();
});

test('a one-shot worker waits for SIGTERM-resistant descendants after normal command exit', posix, async t => {
  const f = fixture(t);
  const ready = join(f.root, 'descendant-ready');
  const spawned = join(f.root, 'command-metadata');
  const worker = f.launch(`
    import { writeFileSync } from 'node:fs';
    import { run } from ${JSON.stringify(processModule)};
    const result=await run([process.execPath,'-e',${JSON.stringify(descendantCommand(ready, true))}],{
      timeoutMs:5000,
      onSpawn(pid,metadata){writeFileSync(${JSON.stringify(spawned)},JSON.stringify({pid,...metadata}))}
    });
    if(result.code!==0) process.exitCode=1;
  `);
  const metadata = await until(() => {
    try { return JSON.parse(readFileSync(spawned, 'utf8')); } catch { return undefined; }
  });
  f.groups.set(metadata.pid, metadata.identity);
  const result = await worker.done;
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(ready), true);
  assert.equal(processGroupAlive(metadata.pid), false, 'The one-shot worker must not exit before its forced cleanup');
});

for (const mode of ['timeout', 'abort']) {
  test(`${mode} waits for SIGTERM-resistant descendants before rejecting`, posix, async t => {
    const f = fixture(t);
    const ready = join(f.root, 'descendant-ready');
    const controller = new AbortController();
    let pid;
    const completion = run([process.execPath, '-e', descendantCommand(ready, false)], {
      timeoutMs: mode === 'timeout' ? 1500 : 5000,
      signal: controller.signal,
      onSpawn(value, metadata) { pid = value; f.groups.set(pid, metadata.identity); },
    }).then(result => ({ result }), error => ({ error }));
    f.pending.push(completion);
    await until(() => existsSync(ready));
    if (mode === 'abort') controller.abort();
    const outcome = await completion;
    assert.match(outcome.error?.message ?? '', mode === 'abort' ? /interrupted/ : /timed out/);
    assert.equal(processGroupAlive(pid), false, 'Rejection must wait until descendants stop executing');
  });
}

test('a live group with a different recorded identity blocks without receiving a signal', posix, async t => {
  const f = fixture(t);
  const store = f.open();
  const job = enqueue(store, f.config);
  const ready = join(f.root, 'ready');
  const signaled = join(f.root, 'signaled');
  const controller = new AbortController();
  let pid;
  const completion = run([process.execPath, '-e', `
    process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(signaled)},'received');process.exit(0)});
    require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');
    setInterval(()=>{},1000);
  `], {
    timeoutMs: 10000,
    signal: controller.signal,
    onSpawn(value, metadata) {
      pid = value;
      f.groups.set(pid, metadata.identity);
      store.update(job.id, { status: 'running', groups: [pid], commands: { [pid]: { ...metadata, deadline: Date.now() - 1, identity: { token: randomUUID() } } } });
    },
  }).then(result => ({ result }), error => ({ error }));
  f.pending.push(completion);
  await until(() => existsSync(ready));
  store.acquire();
  assert.equal(store.next(), undefined);
  assert.equal(store.get(job.id).status, 'blocked');
  assert.match(store.get(job.id).error, /different process identity/);
  assert.equal(store.get(job.id).manualRecovery, store.get(job.id).error);
  await sleep(100);
  assert.equal(processGroupAlive(pid), true);
  assert.equal(existsSync(signaled), false);
  controller.abort();
  await completion;
  store.release();
});

test('legacy live groups require explicit manual retry even after exit', posix, async t => {
  const f = fixture(t);
  const store = f.open();
  const job = enqueue(store, f.config);
  const ready = join(f.root, 'ready');
  const controller = new AbortController();
  let pid;
  const completion = run([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`], {
    timeoutMs: 10000,
    signal: controller.signal,
    onSpawn(value, metadata) {
      pid = value;
      f.groups.set(pid, metadata.identity);
      store.update(job.id, { status: 'running', groups: [pid], commands: undefined });
    },
  }).then(result => ({ result }), error => ({ error }));
  f.pending.push(completion);
  await until(() => existsSync(ready));
  store.acquire();
  assert.equal(store.next(), undefined);
  assert.equal(store.get(job.id).status, 'blocked');
  assert.match(store.get(job.id).error, /no verifiable ownership/);
  assert.equal(processGroupAlive(pid), true);
  controller.abort();
  await completion;
  assert.equal(processGroupAlive(pid), false);
  store.update(job.id, { status: 'waiting', nextAt: Date.now() });
  assert.equal(store.next(), undefined);
  assert.equal(store.get(job.id).status, 'blocked');
  assert.equal(store.get(job.id).blockedReason, null);
  assert.match(store.get(job.id).manualRecovery, /no verifiable ownership/);
  assert.deepEqual(store.get(job.id).groups, []);
  store.update(job.id, { status: 'queued', nextAt: Date.now(), manualRecovery: null });
  const resumed = store.next();
  assert.equal(resumed.id, job.id);
  assert.deepEqual(resumed.groups, []);
  assert.deepEqual(resumed.commands, {});
  store.release();
});

for (const ownership of ['unknown', 'mismatch']) {
  test(`mixed owned and ${ownership} groups retain a manual block after both disappear`, posix, async t => {
    const f = fixture(t);
    const store = f.open();
    const job = enqueue(store, f.config);
    const unknownReady = join(f.root, 'unknown-ready');
    const ownedReady = join(f.root, 'owned-ready');
    const releaseUnknown = join(f.root, 'release-unknown');
    const unknownSignaled = join(f.root, 'unknown-signaled');
    let unknownPid, ownedPid, unknownMetadata, ownedMetadata;
    const unknownCompletion = run([process.execPath, '-e', `
      const fs=require('node:fs');
      process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(unknownSignaled)},'received'));
      fs.writeFileSync(${JSON.stringify(unknownReady)},'ready');
      setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseUnknown)})) process.exit(0)},10);
    `], {
      timeoutMs: 10000,
      onSpawn(pid, metadata) {
        unknownPid = pid;
        unknownMetadata = metadata;
        f.groups.set(pid, metadata.identity);
      },
    }).then(result => ({ result }), error => ({ error }));
    const ownedCompletion = run([process.execPath, '-e', `
      process.on('SIGTERM',()=>{});
      require('node:fs').writeFileSync(${JSON.stringify(ownedReady)},'ready');
      setInterval(()=>{},1000);
    `], {
      timeoutMs: 10000,
      onSpawn(pid, metadata) {
        ownedPid = pid;
        ownedMetadata = metadata;
        f.groups.set(pid, metadata.identity);
      },
    }).then(result => ({ result }), error => ({ error }));
    f.pending.push(unknownCompletion, ownedCompletion);
    await until(() => existsSync(unknownReady) && existsSync(ownedReady));
    store.update(job.id, {
      status: 'blocked', stage: 'verify', attempts: { build: 1 },
      blockedReason: { kind: 'prerequisite', stage: 'verify', prerequisite: { reason: 'nonzero-exit' } },
      nextAt: 0, groups: [unknownPid, ownedPid],
      commands: {
        ...(ownership === 'mismatch' ? { [unknownPid]: { ...unknownMetadata, identity: { token: randomUUID() }, deadline: 0 } } : {}),
        [ownedPid]: { ...ownedMetadata, deadline: Date.now() + 1500 },
      },
    });
    assert.equal(store.next(), undefined);
    const recovering = store.get(job.id);
    assert.equal(recovering.status, 'waiting');
    assert.equal(recovering.blockedReason, null);
    assert.match(recovering.manualRecovery, ownership === 'mismatch' ? /different process identity/ : /no verifiable ownership/);
    assert.equal(existsSync(unknownSignaled), false);

    writeFileSync(releaseUnknown, 'release');
    const unknownOutcome = await unknownCompletion;
    assert.equal(unknownOutcome.result?.code, 0, unknownOutcome.error?.message);
    assert.equal(existsSync(unknownSignaled), false, 'Recovery must not signal the unverifiable group');
    assert.equal(processGroupAlive(unknownPid), false);
    assert.equal(processGroupAlive(ownedPid), true, 'Owned cleanup must still be pending when the unknown group disappears');

    const restarted = f.open();
    restarted.update(job.id, { nextAt: 0 });
    assert.equal(restarted.next(), undefined);
    assert.deepEqual(restarted.get(job.id).groups, [ownedPid]);
    assert.equal(restarted.get(job.id).manualRecovery, recovering.manualRecovery);
    await until(() => {
      assert.equal(restarted.next(), undefined, 'A manual ownership block must never replay the stage');
      return restarted.get(job.id).status === 'blocked';
    });
    await ownedCompletion;
    const blocked = restarted.get(job.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, null);
    assert.equal(blocked.manualRecovery, recovering.manualRecovery);
    assert.equal(blocked.error, recovering.manualRecovery);
    assert.deepEqual(blocked.groups, []);
    assert.deepEqual(blocked.commands, {});
    assert.equal(processGroupAlive(ownedPid), false);
    assert.equal(blocked.stage, 'verify');
    assert.deepEqual(blocked.attempts, { build: 1 });
    assert.equal(blocked.hostTurns, 0, 'Manual recovery must not spend host turns');
    assert.equal(restarted.next(), undefined);
    const phases = restarted.events(job.id).map(event => event.data.commands?.[ownedPid]).filter(Boolean);
    assert.equal(phases.some(command => Number.isFinite(command.termAt)), true);
    assert.equal(phases.some(command => Number.isFinite(command.killAt)), true);
    assert.equal(restarted.events(job.id).some(event => event.data.status === 'running'), false);
  });
}

test('a dead legacy group without a prior manual condition remains claimable', t => {
  const f = fixture(t);
  const store = f.open();
  const job = enqueue(store, f.config);
  store.update(job.id, { manualRecovery: undefined, groups: [0], commands: undefined });
  const resumed = store.next();
  assert.equal(resumed.id, job.id);
  assert.equal(resumed.manualRecovery, null);
  assert.deepEqual(resumed.groups, []);
  assert.deepEqual(resumed.commands, {});
});
