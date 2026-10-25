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
const example = JSON.parse(readFileSync(new URL('../examples/factory.json', import.meta.url)));
const product = JSON.parse(readFileSync(new URL('../examples/luggage.json', import.meta.url)));

async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(20);
  }
}

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-worker-control-'));
  const path = join(root, 'factory.json');
  writeFileSync(path, JSON.stringify({ ...example, ...overrides }));
  const config = loadConfig(path);
  const store = new Store(config.stateDir);
  const children = [];
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(item => item.done));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, path, config, store,
    start() {
      const child = spawn(process.execPath, [cli, 'run', '--build-only', '--config', path], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', bytes => { output += bytes; });
      child.stderr.on('data', bytes => { output += bytes; });
      const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, output })); });
      const owned = { child, done };
      children.push(owned);
      return owned;
    } };
}

test('CLI stop drains its active command, preserves resume budgets and releases only its queue lock', async t => {
  const f = fixture(t, { allowLocalExecution: true });
  const marker = join(f.root, 'running-command.json');
  const config = { ...f.config, verification: { prerequisites: [], checks: [[process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`]], runtime: [[process.execPath, '-e', 'process.exit(0)']] } };
  const job = f.store.enqueue(product, config);
  f.store.update(job.id, { stage: 'verify' });
  const worker = f.start();
  await until(() => existsSync(marker), 'Worker never started the verification command');
  const commandPid = JSON.parse(readFileSync(marker)).pid;
  assert.equal(f.store.workerStatus().ownerPid, worker.child.pid);
  const stop = await run([process.execPath, cli, 'stop', '--build-only', '--config', f.path]);
  assert.equal(stop.code, 0, stop.stderr);
  assert.deepEqual(JSON.parse(stop.stdout), { ownerPid: worker.child.pid, stopRequested: true });
  const ended = await worker.done;
  assert.equal(ended.code, 0, ended.output);
  assert.equal(processGroupAlive(commandPid), false);
  const saved = f.store.get(job.id);
  assert.equal(saved.status, 'waiting');
  assert.equal(saved.stage, 'verify');
  assert.equal(saved.attempts.verify, 0);
  assert.equal(saved.agentCalls, 0);
  assert.deepEqual(saved.groups, []);
  assert.deepEqual(f.store.workerStatus(), { ownerPid: null, stopRequested: false });
  const stopped = await run([process.execPath, cli, 'stop', '--config', f.path]);
  assert.notEqual(stopped.code, 0);
});

test('a competing worker cannot steal ownership or erase its queued cooperative stop', async t => {
  const f = fixture(t);
  const worker = f.start();
  await until(() => f.store.workerStatus().ownerPid === worker.child.pid, 'Worker did not acquire the queue');
  const rival = await run([process.execPath, cli, 'run', '--once', '--build-only', '--config', f.path]);
  assert.notEqual(rival.code, 0);
  assert.equal(f.store.workerStatus().ownerPid, worker.child.pid);
  f.store.requestStop();
  const ended = await worker.done;
  assert.equal(ended.code, 0, ended.output);
  const restarted = await run([process.execPath, cli, 'run', '--once', '--build-only', '--config', f.path]);
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.deepEqual(f.store.workerStatus(), { ownerPid: null, stopRequested: false });
});
