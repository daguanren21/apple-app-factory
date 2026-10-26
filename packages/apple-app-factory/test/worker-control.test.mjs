import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../dist/store.js';
import { loadConfig } from '../dist/config.js';
import { run, processGroupAlive } from '../dist/process.js';

const cli = resolve('dist/cli.js');
const success = [process.execPath, '-e', 'process.exit(0)'];
const product = {
  id: 'step-control', name: 'Step control', framework: 'flutter',
  purpose: 'Exercise explicit host and deterministic stage boundaries', audience: 'Factory maintainers',
  differentiators: ['One requested stage per invocation'], acceptance: ['Preserve queue and process ownership'],
};

async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(20);
  }
}

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-step-control-'));
  const path = join(root, 'factory.json');
  writeFileSync(path, JSON.stringify({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'),
    allowLocalExecution: true,
    verification: { prerequisites: [], checks: [success], runtime: [success] },
    ...overrides,
  }));
  const config = loadConfig(path);
  const store = new Store(config.stateDir);
  const children = [];
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(item => item.done));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, path, config, store,
    invoke(...args) { return run([process.execPath, cli, ...args, '--config', path]); },
    start(id) {
      const child = spawn(process.execPath, [cli, 'step', id, '--build-only', '--config', path], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
      const owned = { child, done };
      children.push(owned);
      return owned;
    } };
}

test('CLI next resumes one host turn and step cannot execute or clear that turn', async t => {
  const f = fixture(t);
  const job = f.store.enqueue(product, f.config);
  f.store.update(job.id, { stage: 'build', nextAt: 0 });
  const first = await f.invoke('next', job.id);
  assert.equal(first.code, 0, first.stderr);
  const claim = JSON.parse(first.stdout);
  assert.equal(claim.action, 'host');
  assert.equal(claim.job.id, job.id);
  assert.equal(claim.turn.stage, 'build');
  assert.equal(claim.turn.cwd, job.workspace);
  assert.equal(typeof claim.turn.prompt, 'string');
  assert.equal(typeof claim.turn.environment, 'object');
  const before = f.store.get(job.id);
  const resumed = await f.invoke('next', job.id);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).turn.id, claim.turn.id);
  assert.equal(f.store.get(job.id).hostTurns, 1);
  const refused = await f.invoke('step', job.id);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /host|turn|deterministic/i);
  assert.deepEqual(f.store.get(job.id), before);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM worker').all(), []);
});

test('CLI next identifies deterministic work and step returns after verification only', async t => {
  const f = fixture(t);
  const job = f.store.enqueue(product, f.config);
  f.store.update(job.id, { stage: 'verify', nextAt: 0 });
  const next = await f.invoke('next', job.id);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).action, 'step');
  assert.equal(JSON.parse(next.stdout).turn, undefined);
  const step = await f.invoke('step', job.id, '--build-only');
  assert.equal(step.code, 0, step.stderr);
  const result = JSON.parse(step.stdout);
  assert.equal(result.id, job.id);
  assert.equal(result.stage, 'review');
  assert.equal(result.status, 'queued');
  assert.deepEqual(result.attempts, { verify: 1 });
  assert.equal(result.hostTurns, 0);
  assert.equal(result.turn ?? null, null);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM worker').all(), []);
});

test('CLI step exits nonzero for blocked execution without consuming a stage attempt', async t => {
  const f = fixture(t, { allowLocalExecution: false });
  const job = f.store.enqueue(product, f.config);
  f.store.update(job.id, { stage: 'verify', nextAt: 0 });
  const result = await f.invoke('step', job.id);
  assert.notEqual(result.code, 0);
  assert.equal(f.store.get(job.id).status, 'blocked');
  assert.deepEqual(f.store.get(job.id).attempts, {});
  assert.deepEqual(f.store.db.prepare('SELECT * FROM worker').all(), []);
});

test('CLI next reports future work as waiting without claiming a host turn', async t => {
  const f = fixture(t);
  const job = f.store.enqueue(product, f.config);
  const waiting = f.store.update(job.id, { stage: 'verify', status: 'waiting', nextAt: Date.now() + 3600000 });
  const next = await f.invoke('next', job.id);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).action, 'wait');
  assert.deepEqual(f.store.get(job.id), waiting);
});

test('CLI step owns the queue through signal-driven cleanup and a competing step cannot steal it', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const f = fixture(t);
  const marker = join(f.root, 'running-command.json');
  const command = [process.execPath, '-e', `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`];
  const job = f.store.enqueue(product, { ...f.config, verification: { prerequisites: [], checks: [command], runtime: [success] } });
  f.store.update(job.id, { stage: 'verify', nextAt: 0 });
  const step = f.start(job.id);
  await until(() => existsSync(marker), 'Step never started the verification command');
  const commandPid = JSON.parse(readFileSync(marker, 'utf8')).pid;
  assert.equal(f.store.db.prepare('SELECT pid FROM worker').get().pid, step.child.pid);
  const rival = await f.invoke('step', job.id, '--build-only');
  assert.notEqual(rival.code, 0);
  assert.equal(f.store.db.prepare('SELECT pid FROM worker').get().pid, step.child.pid);
  step.child.kill('SIGTERM');
  await step.done;
  assert.equal(processGroupAlive(commandPid), false);
  const saved = f.store.get(job.id);
  assert.equal(saved.status, 'waiting');
  assert.equal(saved.stage, 'verify');
  assert.equal(saved.attempts.verify, 0);
  assert.equal(saved.hostTurns, 0);
  assert.deepEqual(saved.groups, []);
  assert.deepEqual(saved.commands, {});
  assert.deepEqual(f.store.db.prepare('SELECT * FROM worker').all(), []);
});

for (const removed of ['run', 'service', 'worker', 'stop']) {
  test(`CLI rejects removed ${removed} daemon interface without claiming work`, async t => {
    const f = fixture(t);
    const job = f.store.enqueue(product, f.config);
    const result = await f.invoke(removed);
    assert.notEqual(result.code, 0);
    assert.deepEqual(f.store.get(job.id), job);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM worker').all(), []);
  });
}
