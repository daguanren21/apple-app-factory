import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { runStep } from '../dist/scheduler.js';
import { inspectProcessGroup, processGroupAlive, run, signalOwnedProcessGroup } from '../dist/process.js';

const posix = { skip: process.platform === 'win32', timeout: 15000 };
const processModule = new URL('../dist/process.js', import.meta.url).href;
const storeModule = new URL('../dist/store.js', import.meta.url).href;

async function until(action, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = action();
    if (value) return value;
    await sleep(20);
  } while (Date.now() < deadline);
  assert.fail('Command cleanup did not reach its bounded readiness deadline');
}

async function bounded(promise, timeoutMs = 7000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Command cleanup remained pending')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-process-drain-'));
  const config = ConfigSchema.parse({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    allowLocalExecution: true, pollMs: 600000,
    verification: { checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] },
    ...overrides,
  });
  const stores = [], controllers = [], children = [], pending = [], escaped = [];
  const groups = new Map();
  const track = promise => { pending.push(promise); promise.catch(() => {}); return promise; };
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    for (const helper of escaped) {
      const saved = readJson(helper.path);
      if (saved) groups.set(saved.pid, helper.identity);
    }
    for (const [pid, identity] of groups) {
      try { signalOwnedProcessGroup(pid, identity, 'SIGKILL'); } catch {}
    }
    await bounded(Promise.allSettled(pending));
    for (const store of stores) { store.release(); store.close(); }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, config, groups, escaped, track,
    controller() { const controller = new AbortController(); controllers.push(controller); return controller; },
    open() { const store = new Store(config.stateDir); stores.push(store); return store; },
    enqueue(store, name) {
      return store.enqueue({
        id: `drain-${name}`, name: `Drain ${name}`, framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0',
        purpose: `Exercise ${name} cleanup`, audience: 'Factory maintainers',
        differentiators: ['Bounded owned-process cleanup'], acceptance: ['Never replay unresolved work'],
      }, config);
    },
    launch(source, options = {}) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'], ...options });
      if (!options.detached) children.push(child);
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-262144); });
      const done = track(new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, stderr }));
      }));
      return { child, done };
    },
  };
}

function detachedPipeCommand(f, exitLeader = false) {
  const identity = { token: randomUUID() };
  const path = join(f.root, `escaped-${f.escaped.length}.json`);
  const signaled = `${path}.signaled`;
  f.escaped.push({ path, identity });
  const helper = `
    const fs=require('node:fs');
    process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(signaled)},'received'));
    fs.writeFileSync(${JSON.stringify(path)},JSON.stringify({pid:process.pid}));
    process.send('ready');
    setInterval(()=>{},1000);
  `;
  const source = `
    const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{
      detached:true,env:{...process.env,APPLE_APP_FACTORY_COMMAND_TOKEN:${JSON.stringify(identity.token)}},
      stdio:['ignore',1,2,'ipc']
    });
    child.once('message',()=>{
      child.disconnect();child.unref();
      ${exitLeader ? 'process.exit(0)' : 'setInterval(()=>{},1000)'};
    });
  `;
  return {
    argv: [process.execPath, '-e', source], signaled, identity,
    async ready() {
      const saved = await until(() => readJson(path));
      f.groups.set(saved.pid, identity);
      return saved.pid;
    },
  };
}

async function ownedOrphan(f, label) {
  const identity = { token: randomUUID() };
  const ready = join(f.root, `${label}.ready`), signaled = join(f.root, `${label}.signaled`);
  const command = f.launch(`
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM',()=>writeFileSync(${JSON.stringify(signaled)},'received'));
    writeFileSync(${JSON.stringify(ready)},'ready');
    setInterval(()=>{},1000);
  `, { detached: true, env: { ...process.env, APPLE_APP_FACTORY_COMMAND_TOKEN: identity.token } });
  f.groups.set(command.child.pid, identity);
  await until(() => existsSync(ready));
  return { pid: command.child.pid, identity, signaled, deadline: Date.now() + 3600000 };
}

for (const mode of ['timeout', 'abort', 'abort-after-exit']) {
  test(`${mode} fails closed when a detached process retains command pipes`, posix, async t => {
    const f = fixture(t);
    const controller = f.controller();
    const command = detachedPipeCommand(f, mode === 'abort-after-exit');
    let pid;
    const completion = f.track(run(command.argv, {
      timeoutMs: mode === 'timeout' ? 2500 : 60000, signal: controller.signal,
      logPath: join(f.root, 'command.log'),
      onSpawn(value, metadata) { pid = value; f.groups.set(pid, metadata.identity); },
    }).then(result => ({ result }), error => ({ error })));
    const helperPid = await command.ready();
    if (mode === 'abort-after-exit') await until(() => !processGroupAlive(pid));
    if (mode.startsWith('abort')) controller.abort();
    const outcome = await bounded(completion);
    assert.equal(outcome.error?.code, 'PROCESS_CLEANUP_BLOCKED');
    assert.match(outcome.error.message, /stdout or stderr open/);
    assert.match(outcome.error.message, /outside that group were not signaled/);
    assert.equal(processGroupAlive(pid), false);
    assert.equal(inspectProcessGroup(helperPid, command.identity), 'owned');
    assert.equal(existsSync(command.signaled), false);
  });
}

for (const mode of ['timeout', 'abort']) {
  test(`${mode} persists detached-pipe failure as manual recovery before replay`, posix, async t => {
    const f = fixture(t, { timeoutMs: mode === 'timeout' ? 2500 : 60000 });
    const store = f.open(), controller = f.controller();
    const command = detachedPipeCommand(f);
    const forbidden = join(f.root, 'must-not-run');
    const after = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'ran')`];
    const job = f.enqueue(store, `manual-${mode}`);
    store.update(job.id, {
      stage: 'verify', status: 'queued', attempts: { verify: 1 }, hostTurns: 2,
      config: { ...job.config, verification: { ...job.config.verification, prerequisites: [command.argv, after] } },
    });
    const completion = f.track(runStep(store, f.config, job.id, { signal: controller.signal }));
    const helperPid = await command.ready();
    const saved = store.get(job.id);
    for (const pid of saved.groups) f.groups.set(pid, saved.commands[pid].identity);
    if (mode === 'abort') controller.abort();
    await assert.rejects(bounded(completion), { code: 'PROCESS_CLEANUP_BLOCKED' });
    const result = store.get(job.id);
    assert.equal(result.status, 'blocked');
    assert.equal(result.stage, 'verify');
    assert.match(result.manualRecovery ?? '', /stdout or stderr open/);
    assert.equal(result.error, result.manualRecovery);
    assert.equal(result.blockedReason, null);
    assert.deepEqual(result.attempts, { verify: 1 });
    assert.equal(result.hostTurns, 2);
    assert.deepEqual(result.groups, []);
    assert.deepEqual(result.commands, {});
    assert.equal(existsSync(forbidden), false);
    assert.equal(store.next(), undefined);
    assert.equal(f.open().get(job.id).manualRecovery, result.manualRecovery);
    assert.equal(inspectProcessGroup(helperPid, command.identity), 'owned');
    assert.equal(existsSync(command.signaled), false);
    assert.deepEqual(store.db.prepare('SELECT * FROM worker').all(), []);
  });
}

test('a restarted step drains a distant-deadline TERM-resistant orphan before unlocking', posix, async t => {
  const f = fixture(t), store = f.open();
  const job = f.enqueue(store, 'restart');
  store.update(job.id, { stage: 'verify', attempts: { verify: 2 }, hostTurns: 3 });
  const ready = join(f.root, 'previous-command.ready');
  const command = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
  const previous = f.launch(`
    import { Store } from ${JSON.stringify(storeModule)};
    import { run } from ${JSON.stringify(processModule)};
    const store=new Store(${JSON.stringify(f.config.stateDir)});
    store.acquire();
    const job=store.next();
    await run([process.execPath,'-e',${JSON.stringify(command)}],{
      timeoutMs:3600000,
      onSpawn(pid,metadata){store.update(job.id,{groups:[pid],commands:{[pid]:metadata},recoveryStage:job.stage})}
    });
  `);
  await until(() => existsSync(ready));
  const owned = store.get(job.id), [pid] = owned.groups;
  f.groups.set(pid, owned.commands[pid].identity);
  previous.child.kill('SIGKILL');
  assert.equal((await bounded(previous.done)).signal, 'SIGKILL');
  const restarted = f.open(), controller = f.controller();
  const originalRelease = restarted.release.bind(restarted);
  let released = false;
  restarted.release = () => {
    assert.equal(processGroupAlive(pid), false, 'The orphan must be gone before its queue lock is released');
    assert.equal(restarted.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
    released = true;
    originalRelease();
  };
  try {
    controller.abort();
    const completion = f.track(runStep(restarted, f.config, job.id, { signal: controller.signal }));
    await bounded(completion);
    const result = restarted.get(job.id);
    assert.equal(released, true);
    assert.equal(result.stage, 'verify');
    assert.deepEqual(result.attempts, { verify: 2 });
    assert.equal(result.hostTurns, 3);
    assert.equal(result.manualRecovery, null);
    assert.deepEqual(result.groups, []);
    assert.deepEqual(result.commands, {});
    assert.deepEqual(restarted.db.prepare('SELECT * FROM worker').all(), []);
  } finally { restarted.release = originalRelease; }
});

for (const ownership of ['unknown', 'mismatch']) {
  test(`step preserves ${ownership} groups and reports failure while draining owned groups`, posix, async t => {
    const f = fixture(t), store = f.open();
    const unknown = await ownedOrphan(f, 'unverified');
    const owned = await ownedOrphan(f, 'owned');
    const metadata = { deadline: unknown.deadline, identity: { token: randomUUID() } };
    const job = f.enqueue(store, ownership);
    store.update(job.id, {
      stage: 'verify', status: 'blocked', blockedReason: null, attempts: { verify: 2 }, hostTurns: 3,
      groups: [unknown.pid, owned.pid], recoveryStage: 'verify',
      commands: {
        ...(ownership === 'mismatch' ? { [unknown.pid]: metadata } : {}),
        [owned.pid]: { deadline: owned.deadline, identity: owned.identity },
      },
    });
    const completion = f.track(runStep(store, f.config, job.id));
    await assert.rejects(bounded(completion), error => {
      assert.equal(error.code, 'PROCESS_CLEANUP_BLOCKED');
      assert.match(error.message, ownership === 'mismatch' ? /different process identity/ : /unverifiable ownership/);
      return true;
    });
    const result = store.get(job.id);
    assert.equal(processGroupAlive(owned.pid), false);
    assert.equal(inspectProcessGroup(unknown.pid, unknown.identity), 'owned');
    assert.equal(existsSync(unknown.signaled), false);
    assert.equal(result.status, 'blocked');
    assert.equal(result.error, result.manualRecovery);
    assert.match(result.manualRecovery, ownership === 'mismatch' ? /different process identity/ : /unverifiable ownership/);
    assert.deepEqual(result.groups, [unknown.pid]);
    assert.deepEqual(result.commands, ownership === 'mismatch' ? { [unknown.pid]: metadata } : {});
    assert.deepEqual(result.attempts, { verify: 2 });
    assert.equal(result.hostTurns, 3);
    assert.deepEqual(store.db.prepare('SELECT * FROM worker').all(), []);
    assert.equal(f.open().get(job.id).manualRecovery, result.manualRecovery);
  });
}

test('ordinary output still succeeds without a pipe-cleanup failure', async () => {
  const result = await run([process.execPath, '-e', `process.stdout.write('output');process.stderr.write('diagnostic')`]);
  assert.deepEqual(result, { code: 0, stdout: 'output', stderr: 'diagnostic' });
});

test('normal leader exit still retires a TERM-resistant original-group descendant successfully', posix, async t => {
  const f = fixture(t);
  const descendant = `process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)`;
  let pid;
  const completion = f.track(run([process.execPath, '-e', `
    const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2,'ipc']});
    child.once('message',()=>{child.disconnect();process.stdout.write('complete');process.exit(0)});
  `], { timeoutMs: 10000, onSpawn(value, metadata) { pid = value; f.groups.set(pid, metadata.identity); } }));
  const result = await bounded(completion);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'complete');
  assert.equal(processGroupAlive(pid), false);
});

test('a step with recovered groups only drains them and never replays its stage in the same call', posix, async t => {
  const f = fixture(t), store = f.open();
  const orphan = await ownedOrphan(f, 'target-recovery');
  const forbidden = join(f.root, 'replayed');
  const job = f.enqueue(store, 'explicit-recovery');
  store.update(job.id, {
    stage: 'verify', status: 'running', attempts: { verify: 2 }, hostTurns: 3,
    groups: [orphan.pid], commands: { [orphan.pid]: { deadline: orphan.deadline, identity: orphan.identity } },
    recoveryStage: 'verify',
    config: { ...job.config, verification: {
      prerequisites: [],
      checks: [[process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'replayed')`]],
      runtime: [[process.execPath, '-e', 'process.exit(0)']],
    } },
  });
  const result = await bounded(f.track(runStep(store, f.config, job.id)));
  assert.equal(processGroupAlive(orphan.pid), false);
  assert.equal(existsSync(forbidden), false);
  assert.equal(result.stage, 'verify');
  assert.deepEqual(result.attempts, { verify: 2 });
  assert.equal(result.hostTurns, 3);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.commands, {});
  assert.deepEqual(store.db.prepare('SELECT * FROM worker').all(), []);
});

test('stopped orphan Apple tooling is retired before a different verification stage can start', posix, async t => {
  const f = fixture(t), store = f.open();
  const groups = [];
  for (const stage of ['verify', 'package']) {
    const command = await ownedOrphan(f, `stopped-${stage}`);
    groups.push(command.pid);
    const job = f.enqueue(store, `stopped-${stage}`);
    store.update(job.id, {
      stage: 'build', status: 'blocked', blockedReason: null, recoveryStage: stage,
      groups: [command.pid], commands: { [command.pid]: { deadline: command.deadline, identity: command.identity } },
    });
  }
  const marker = join(f.root, 'tooling-observation.json');
  const selected = f.enqueue(store, 'after-orphans');
  store.update(selected.id, {
    stage: 'verify',
    config: { ...selected.config, verification: {
      prerequisites: [],
      checks: [[process.execPath, '--input-type=module', '-e', `
        import { processGroupAlive } from ${JSON.stringify(processModule)};
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(marker)},JSON.stringify(${JSON.stringify(groups)}.map(processGroupAlive)));
      `]],
      runtime: [[process.execPath, '-e', 'process.exit(0)']],
    } },
  });
  const result = await bounded(f.track(runStep(store, f.config, selected.id)));
  assert.deepEqual(readJson(marker), [false, false], 'No verification command may overlap either orphan tooling group');
  assert.equal(result.stage, 'review');
  assert.deepEqual(result.attempts, { verify: 1 });
  for (const job of store.list()) {
    assert.deepEqual(job.groups, []);
    assert.deepEqual(job.commands, {});
  }
  assert.deepEqual(store.db.prepare('SELECT * FROM worker').all(), []);
});
