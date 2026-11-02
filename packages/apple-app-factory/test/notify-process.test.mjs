import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../dist/contracts/schemas.js';
import { Store } from '../dist/state/store.js';
import { listNotifications } from '../dist/delivery/notifications.js';

test('cross-process notification contenders share a start barrier and only one receives send authority', { timeout: 20000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-notify-process-')));
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  const target = { id: 'owner', channel: 'host-mail', destination: 'owner@host.invalid' };
  const config = ConfigSchema.parse({
    projectMode: 'project', projectRoot,
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    verification: { checks: [[process.execPath, '--version']], runtime: [[process.execPath, '--version']] },
    notifications: { targets: [target] },
  });
  const store = new Store(config.stateDir);
  const workers = [];
  t.after(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
    }
    await Promise.all(workers.map(worker => worker.closed));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const queued = store.enqueue({
    id: 'notify-process-race', name: 'Concurrent notification', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0',
    purpose: 'Reserve one durable host notification', audience: 'Factory maintainers',
    differentiators: ['Independent processes share one queue'], acceptance: ['Only one host may send'],
    authorEmail: 'not-authorized@fixture.invalid',
  }, config);
  const digest = 'a'.repeat(64);
  const job = store.update(queued.id, {
    status: 'built', verifiedDigest: digest,
    artifact: { kind: 'ios-simulator', path: join(projectRoot, 'build', 'App.app'), digest, createdAt: '2026-01-01T00:00:00.000Z' },
  });
  const source = `
    import { Store } from ${JSON.stringify(new URL('../dist/state/store.js', import.meta.url).href)};
    import { claimNotification, listNotifications } from ${JSON.stringify(new URL('../dist/delivery/notifications.js', import.meta.url).href)};
    const store = new Store(${JSON.stringify(config.stateDir)});
    const jobId = ${JSON.stringify(job.id)};
    const targetId = ${JSON.stringify(target.id)};
    process.once('message', action => {
      if (action !== 'claim') throw new Error('Unexpected barrier release');
      process.send({ phase: 'attempting', pid: process.pid });
      let result;
      try {
        result = { phase: 'result', ok: true, packet: claimNotification(store, jobId, targetId) };
      } catch (error) {
        result = { phase: 'result', ok: false, error: error.message };
      } finally {
        store.close();
      }
      process.send(result, () => process.disconnect());
    });
    process.send({ phase: 'ready', pid: process.pid, packet: listNotifications(store, jobId)[0] });
  `;
  for (let index = 0; index < 2; index++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const worker = { child, stderr: '', error: undefined, closed: undefined };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { worker.stderr += text; });
    child.on('error', error => { worker.error = error; });
    worker.closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    workers.push(worker);
  }
  const ready = await Promise.all(workers.map(worker => once(worker.child, 'message', { signal: t.signal })));
  assert.equal(new Set(ready.map(([message]) => message.pid)).size, 2);
  assert.notEqual(workers[0].child.pid, process.pid);
  assert.notEqual(workers[1].child.pid, process.pid);
  for (const [message] of ready) {
    assert.equal(message.phase, 'ready');
    assert.equal(message.packet.status, 'pending');
    assert.deepEqual(message.packet.target, target);
  }
  assert.equal(ready[0][0].packet.id, ready[1][0].packet.id);

  // Both real Store calls enter while this connection holds the writer lock.
  // IPC, rather than a sleep, confirms both contenders reached the claim boundary.
  store.db.exec('BEGIN IMMEDIATE');
  let responses;
  try {
    const attempting = Promise.all(workers.map(worker => once(worker.child, 'message', { signal: t.signal })));
    for (const worker of workers) worker.child.send('claim');
    for (const [message] of await attempting) assert.equal(message.phase, 'attempting');
    assert.deepEqual(store.get(job.id).notifications, []);
    responses = Promise.all(workers.map(worker => once(worker.child, 'message', { signal: t.signal })));
  } finally {
    store.db.exec('ROLLBACK');
  }
  const outcomes = (await responses).map(([message]) => message);
  const exits = await Promise.all(workers.map(worker => worker.closed));
  for (const [index, exit] of exits.entries()) {
    assert.equal(workers[index].error, undefined);
    assert.equal(exit.code, 0, workers[index].stderr);
    assert.equal(exit.signal, null, workers[index].stderr);
  }
  for (const outcome of outcomes) assert.equal(outcome.phase, 'result');
  const winners = outcomes.filter(outcome => outcome.ok);
  const losers = outcomes.filter(outcome => !outcome.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.match(losers[0].error, /claimed|uncertain|reconcile/i);
  assert.equal(losers[0].packet, undefined);
  const winner = winners[0].packet;
  assert.equal(winner.status, 'claimed');
  assert.equal(winner.id, ready[0][0].packet.id);
  assert.match(winner.claimId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(winner.target, target);
  assert.equal(winner.artifactDigest, job.artifact.digest);
  assert.equal(winner.artifactCreatedAt, job.artifact.createdAt);

  const reopened = new Store(config.stateDir);
  try {
    const saved = reopened.get(job.id);
    assert.equal(saved.status, 'built');
    assert.equal(saved.verifiedDigest, job.verifiedDigest);
    assert.deepEqual(saved.artifact, job.artifact);
    assert.equal(saved.notifications.length, 1);
    assert.equal(saved.notifications[0].id, winner.id);
    assert.equal(saved.notifications[0].claimId, winner.claimId);
    assert.equal(saved.notifications[0].status, 'claimed');
    assert.deepEqual(listNotifications(reopened, job.id), [winner]);
  } finally {
    reopened.close();
  }
});
