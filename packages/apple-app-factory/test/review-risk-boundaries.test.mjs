import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ConfigSchema } from '../dist/contracts/schemas.js';
import { MAX_HOST_PACKET_BYTES } from '../dist/contracts/input-limits.js';
import { Store } from '../dist/state/store.js';
import { nextTurn, completeTurn, driveQueue, workflowRetryPatch } from '../dist/workflow/runner.js';
import { sourceDigest } from '../dist/projects/workspace.js';
import { dependencyDigest } from '../dist/projects/dependencies.js';

const cli = new URL('../dist/cli.js', import.meta.url).pathname;
function fixture(t, dynamic = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apphx-review-risk-')));
  const config = ConfigSchema.parse({ configPath: join(root, 'factory.json'), projectMode: 'isolated',
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'work'), packageTarget: 'simulator', allowLocalExecution: true,
    ...(dynamic ? { workflow: {}, maxHostTurns: 64 } : {}),
    verification: { checks: [[process.execPath, '--version']], runtime: [[process.execPath, '--version']] } });
  writeFileSync(config.configPath, JSON.stringify(config));
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const enqueue = (id = 'risk-subject', extra = {}) => store.enqueue({ id, name: id, purpose: 'Exercise real reviewed state boundaries', audience: 'Maintainers',
    framework: 'flutter', platform: 'ios', channel: 'local', differentiators: ['Auditable transitions'], acceptance: ['Preserve the actual outcome'], ...extra }, config);
  return { root, store, config, enqueue };
}
function project(job) {
  mkdirSync(job.workspace, { recursive: true });
  writeFileSync(join(job.workspace, 'pubspec.yaml'), 'name: risk_fixture\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(job.workspace, 'main.dart'), 'void main() {}\n');
}
const plan = { rationale: 'One real inspection', final: 'inspect', nodes: [{ id: 'inspect', role: 'observer', instructions: 'Inspect the actual fixture', dependsOn: [], readPaths: ['.'], writePaths: [], fresh: true, acceptance: ['Inspect fixture'] }] };

for (const mode of ['static', 'planner', 'node']) test(`a second live controller cannot receive a dispatchable ${mode} token`, async t => {
  const f = fixture(t, mode !== 'static'), job = f.enqueue();
  const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const closed = new Promise(resolve => owner.once('close', resolve));
  t.after(async () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGTERM'); await closed; });
  await new Promise((resolve, reject) => { owner.once('spawn', resolve); owner.once('error', reject); });
  let claimed = await nextTurn(f.store, job.id, { ownerPid: owner.pid });
  if (mode === 'node') {
    completeTurn(f.store, job.id, claimed.turn.id, plan);
    claimed = await nextTurn(f.store, job.id, { ownerPid: owner.pid });
  }
  const before = f.store.get(job.id);
  const inspected = await nextTurn(f.store, job.id, { ownerPid: process.pid });
  assert.equal(inspected.action, 'wait');
  assert.equal(inspected.turn, undefined);
  assert.equal(f.store.get(job.id).hostTurns, before.hostTurns);
  assert.deepEqual(f.store.get(job.id).attempts, before.attempts);
  const resumed = await nextTurn(f.store, job.id, { ownerPid: owner.pid });
  assert.equal(resumed.turn.id, claimed.turn.id);
});

test('deterministic and idle CLI work do not resolve a host owner, but host claiming still rejects PID 1', async t => {
  const f = fixture(t), job = f.enqueue();
  project(job);
  f.store.update(job.id, { stage: 'verify', status: 'queued' });
  const result = spawnSync(process.execPath, [cli, 'drive', '--once', '--host-pid', '1', '--config', f.config.configPath], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rounds, 1);
  const verified = f.store.get(job.id);
  assert.equal(verified.stage, 'review');
  assert.ok(verified.verifiedDigest);
  const before = f.store.get(job.id);
  const rejected = spawnSync(process.execPath, [cli, 'next', job.id, '--host-pid', '1', '--config', f.config.configPath], { encoding: 'utf8', timeout: 20000 });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /PID 1/);
  assert.equal(f.store.get(job.id).turn, null);
  assert.equal(f.store.get(job.id).hostTurns, before.hostTurns);
});

test('large queue failures remain lossless in storage while complete drive host and idle responses stay bounded', async t => {
  const f = fixture(t), fullError = '错误🙂'.repeat(150000);
  for (let index = 0; index < 70; index++) {
    const job = f.enqueue(`failed-${index}`);
    f.store.update(job.id, { status: 'needs-owner', error: index < 7 ? fullError : `failure ${index}` });
  }
  const subject = f.enqueue();
  const result = await driveQueue(f.store, f.config, { once: true });
  assert.equal(result.action, 'host');
  assert.equal(result.job.id, subject.id);
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) <= MAX_HOST_PACKET_BYTES);
  assert.equal(result.failed.length + result.omitted.failed, 70);
  assert.equal(result.failed[0].error.includes('\ufffd'), false);
  assert.equal(f.store.list().find(job => job.spec.id === 'failed-0').error, fullError);
  const idle = await driveQueue(f.store, f.config, { once: true });
  assert.equal(idle.action, 'wait');
  assert.ok(Buffer.byteLength(JSON.stringify(idle, null, 2)) <= MAX_HOST_PACKET_BYTES);
  assert.equal(idle.failed.length + idle.omitted.failed, 70);
});

test('large same-channel siblings cannot permanently prevent a subject from planning', async t => {
  const f = fixture(t), purpose = 'Research peer context '.repeat(35000);
  for (let index = 0; index < 7; index++) f.enqueue(`peer-${index}`, { purpose });
  const job = f.enqueue();
  const packet = await nextTurn(f.store, job.id);
  assert.equal(packet.action, 'host');
  assert.equal(packet.turn.kind, 'plan');
  assert.ok(Buffer.byteLength(JSON.stringify(packet, null, 2)) <= MAX_HOST_PACKET_BYTES);
  assert.equal(f.store.get(job.id).hostTurns, 1);
  assert.equal(f.store.list().find(peer => peer.spec.id === 'peer-0').spec.purpose, purpose);
});

for (const constraint of ['seats', 'maxNodes']) test(`owner retry replans a review graph invalidated by changed ${constraint}`, async t => {
  const f = fixture(t), job = f.enqueue();
  project(job);
  f.store.update(job.id, { stage: 'review', status: 'queued', verifiedDigest: sourceDigest(job.workspace, true, 'flutter'), verifiedDependencyDigest: dependencyDigest(job.workspace, 'flutter'), verifiedAt: new Date().toISOString() });
  const planner = await nextTurn(f.store, job.id);
  const accepted = constraint === 'seats' ? plan : { ...plan, nodes: [{ ...plan.nodes[0], id: 'support' }, { ...plan.nodes[0], dependsOn: ['support'] }] };
  completeTurn(f.store, job.id, planner.turn.id, accepted);
  f.store.update(job.id, { status: 'blocked', blockedReason: { kind: 'prerequisite', stage: 'review', prerequisite: { reason: 'Controlled prerequisite' } } });
  const resumed = ConfigSchema.parse({ ...f.config, ...(constraint === 'seats' ? { roles: { review: ['new-review-specialist'] } } : { workflow: { maxNodes: 1 } }) });
  f.store.transition(job.id, current => ({ ...workflowRetryPatch(current, resumed), config: resumed, status: 'queued' }));
  const after = await nextTurn(f.store, job.id);
  assert.equal(after.turn.kind, 'plan');
  assert.equal(f.store.get(job.id).review, null);
  assert.equal(f.store.get(job.id).artifact, null);
});

test('an oversized static host response cannot commit a token that the caller never receives', async t => {
  const f = fixture(t, false), job = f.enqueue();
  f.store.update(job.id, { feedback: 'failure context '.repeat(350000) });
  const before = f.store.get(job.id);
  const response = await driveQueue(f.store, f.config, { once: true });
  assert.equal(response.action, 'wait');
  assert.match(response.pendingErrors[0].error, /output limit|action limit/);
  const after = f.store.get(job.id);
  assert.equal(after.turn, null);
  assert.equal(after.hostTurns, before.hostTurns);
  assert.deepEqual(after.attempts, before.attempts);
});

for (const dynamic of [false, true]) test(`invalid owner cannot prepare an isolated ${dynamic ? 'dynamic' : 'static'} import`, t => {
  const f = fixture(t, dynamic), source = join(f.root, 'import-source');
  mkdirSync(source);
  writeFileSync(join(source, 'pubspec.yaml'), 'name: imported_app\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(source, 'main.dart'), 'void main() {}\n');
  const job = f.enqueue('unclaimed-import', { project: { sourceDir: source } });
  const before = f.store.get(job.id);
  const workspaceExisted = existsSync(job.workspace);
  const rejected = spawnSync(process.execPath, [cli, 'next', job.id, '--host-pid', '1', '--config', f.config.configPath], { encoding: 'utf8', timeout: 20000 });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /PID 1/);
  assert.deepEqual(f.store.get(job.id), before);
  assert.equal(existsSync(job.workspace), workspaceExisted);
});

test('large runtime metadata returns explicit persisted-job references after a deterministic step', async t => {
  const f = fixture(t, false);
  f.config.obfuscation = { command: ['obfuscator'], options: { code: { removeComments: true } } };
  f.config.verification.runtime = Array.from({ length: 70 }, () => [process.execPath, '-e', '/*' + 'x'.repeat(40000) + '*/']);
  const job = f.enqueue();
  project(job);
  f.store.update(job.id, { stage: 'obfuscate', status: 'queued' });
  const result = await driveQueue(f.store, f.config, { once: true });
  assert.equal(result.rounds, 1);
  assert.equal(f.store.get(job.id).stage, 'verify');
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) <= MAX_HOST_PACKET_BYTES);
  assert.equal(result.references.job, job.id);
  assert.equal(result.references.result, job.id);
  assert.equal(result.job, undefined);
  assert.equal(result.result, undefined);
  assert.equal(f.store.get(job.id).config.verification.runtime[0][2], f.config.verification.runtime[0][2]);
});

for (const selected of ['host', 'step']) test(`drive preserves earlier queue refusal diagnostics when selecting ${selected} work`, async t => {
  const f = fixture(t), staleIds = [];
  for (let index = 0; index < 3; index++) {
    const stale = f.enqueue(`stale-${index}`, { priority: 'P0' });
    await nextTurn(f.store, stale.id);
    f.store.update(stale.id, { config: { ...f.config, roles: { research: ['changed-after-claim'] } } });
    staleIds.push(stale.id);
  }
  const eligible = f.enqueue('eligible', { priority: 'P2' });
  if (selected === 'step') { project(eligible); f.store.update(eligible.id, { stage: 'verify', status: 'queued' }); }
  const response = await driveQueue(f.store, f.config, { once: true });
  assert.equal(response.action, selected);
  assert.deepEqual(new Set(response.pendingErrors.map(error => error.id)), new Set(staleIds));
  assert.equal(response.pendingErrors.every(error => /context changed/i.test(error.error)), true);
  assert.ok(Buffer.byteLength(JSON.stringify(response, null, 2)) <= MAX_HOST_PACKET_BYTES);
});
