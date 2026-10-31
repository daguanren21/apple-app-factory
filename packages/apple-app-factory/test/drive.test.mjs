import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { driveQueue, completeTurn } from '../dist/runner.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const success = [process.execPath, '-e', 'process.exit(0)'];

const research = { viable: true, distinctness: 'Unattended drive fixture', risks: [], plan: ['Implement the requested workflow'] };
const spec = {
  id: 'drive-fixture', name: 'Drive fixture', purpose: 'Exercise unattended queue driving', audience: 'Harness maintainers',
  framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0',
  differentiators: ['Deterministic loop advancement'], acceptance: ['Configured deterministic commands gate progress'],
};

function reviewFor(job) {
  return { approved: true, findings: [], acceptanceEvidence: job.spec.acceptance.map(requirement => ({ requirement, evidence: 'Deterministic drive evidence' })) };
}

function baseConfig(root, overrides = {}) {
  return ConfigSchema.parse({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    allowLocalExecution: true, retryDelayMs: 1,
    verification: { checks: [success], runtime: [success] },
    ...overrides,
  });
}

function fixture(t, overrides = {}, product = spec) {
  const root = mkdtempSync(join(tmpdir(), 'factory-drive-'));
  const config = baseConfig(root, overrides);
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue(product, config);
  return { root, config, store, job };
}

async function driveToBuild(f) {
  const researchTurn = await driveQueue(f.store, f.config, { once: true });
  assert.equal(researchTurn.action, 'host');
  assert.equal(researchTurn.turn.stage, 'research');
  const researched = completeTurn(f.store, f.job.id, researchTurn.turn.id, research);
  assert.equal(researched.stage, 'build');
  const buildTurn = await driveQueue(f.store, f.config, { once: true });
  assert.equal(buildTurn.action, 'host');
  assert.equal(buildTurn.turn.stage, 'build');
  writeFileSync(join(buildTurn.turn.cwd, 'pubspec.yaml'), 'name: drive_fixture\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(buildTurn.turn.cwd, 'main.dart'), 'void main() {}\n');
  completeTurn(f.store, f.job.id, buildTurn.turn.id);
  return buildTurn;
}

test('drive --once advances the research/build/review/package loop without asking the host to drive deterministic stages', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'flutter'), `#!${process.execPath}\nimport {mkdirSync,writeFileSync} from 'node:fs';\nmkdirSync('build/ios/iphonesimulator/Runner.app',{recursive:true});writeFileSync('build/ios/iphonesimulator/Runner.app/Runner','controlled compiler output');\n`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });

  await driveToBuild(f);

  const afterVerify = await driveQueue(f.store, f.config, { once: true });
  assert.equal(afterVerify.action, 'step');
  assert.equal(afterVerify.result.stage, 'review');
  assert.match(f.store.get(f.job.id).verifiedDigest, /^[a-f0-9]{64}$/);

  const reviewDrive = await driveQueue(f.store, f.config, { once: true });
  assert.equal(reviewDrive.action, 'host');
  assert.equal(reviewDrive.turn.stage, 'review');

  const approved = completeTurn(f.store, f.job.id, reviewDrive.turn.id, reviewFor(f.store.get(f.job.id)));
  assert.equal(approved.stage, 'package');

  const afterPackage = await driveQueue(f.store, f.config, { once: true });
  assert.equal(afterPackage.action, 'step');
  assert.equal(afterPackage.result.status, 'built');
  assert.ok(afterPackage.result.artifact);
  assert.equal(existsSync(afterPackage.result.artifact.path), true);
});

test('drive --once auto-runs obfuscate before verification when configured', async t => {
  const marker = join(tmpdir(), `drive-obfuscated-${Date.now()}`);
  const configPath = join(tmpdir(), `drive-obfuscator-${Date.now()}.json`);
  writeFileSync(configPath, JSON.stringify({ code: { removeComments: true }, seed: 'drive-fixture' }));
  t.after(() => { rmSync(marker, { force: true }); rmSync(configPath, { force: true }); });
  const f = fixture(t, { obfuscation: { command: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'obfuscated')`, '--'], configPath } });

  await driveToBuild(f);
  assert.equal(f.store.get(f.job.id).stage, 'obfuscate');

  const obfuscated = await driveQueue(f.store, f.config, { once: true });
  assert.equal(obfuscated.action, 'step');
  assert.equal(obfuscated.result.stage, 'verify');
  assert.equal(readFileSync(marker, 'utf8'), 'obfuscated');
});

test('drive --once waits with the earliest future due time when nothing is due', async t => {
  const f = fixture(t);
  const future = Date.now() + 3600000;
  f.store.update(f.job.id, { nextAt: future });
  const result = await driveQueue(f.store, f.config, { once: true });
  assert.equal(result.action, 'wait');
  assert.equal(result.nextDueAt, future);
  assert.equal(f.store.get(f.job.id).turn ?? null, null);
});

test('drive --once reports done for an empty queue', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-drive-empty-'));
  const config = baseConfig(root);
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const result = await driveQueue(store, config, { once: true });
  assert.equal(result.action, 'done');
  assert.equal(result.rounds, 0);
});

test('drive --build-only rejects removed publication permissions before creating a queue', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-drive-build-only-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'factory.json');
  writeFileSync(configPath, JSON.stringify({
    stateDir: 'state', workspaceRoot: 'workspaces', packageTarget: 'simulator', allowLocalExecution: true,
    verification: { prerequisites: [], checks: [success], runtime: [success] }, allowSubmit: true,
  }));
  const result = spawnSync(process.execPath, [cli, 'drive', '--once', '--build-only', '--config', configPath], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /allowSubmit/);
  assert.equal(existsSync(join(root, 'state')), false);
});

test('--once processes exactly one due deterministic task per drive', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-drive-two-'));
  const config = baseConfig(root);
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const a = store.enqueue({ ...spec, id: 'drive-two-a' }, config);
  const b = store.enqueue({ ...spec, id: 'drive-two-b' }, config);
  store.update(a.id, { stage: 'verify', nextAt: 0 });
  store.update(b.id, { stage: 'verify', nextAt: 0 });

  const first = await driveQueue(store, config, { once: true });
  assert.equal(first.action, 'step');
  assert.equal(first.result.id, a.id);
  assert.equal(first.result.stage, 'review');

  const second = await driveQueue(store, config, { once: true });
  assert.equal(second.action, 'step');
  assert.equal(second.result.id, b.id);
  assert.equal(second.result.stage, 'review');
});

test('--strict reports terminal failed tasks with exit code 2', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-drive-strict-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'factory.json');
  const config = baseConfig(root);
  const store = new Store(config.stateDir);
  const job = store.enqueue(spec, config);
  store.update(job.id, { status: 'failed', error: 'controlled terminal failure' });
  store.close();
  writeFileSync(configPath, JSON.stringify({
    stateDir: 'state', workspaceRoot: 'workspaces', packageTarget: 'simulator', allowLocalExecution: true,
    verification: { prerequisites: [], checks: [success], runtime: [success] },
  }));
  const result = spawnSync(process.execPath, [cli, 'drive', '--strict', '--once', '--config', configPath], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.action, 'done');
  assert.equal(parsed.failed.length, 1);
  assert.equal(parsed.failed[0].id, job.id);
});

test('drive reports persisted terminal failures on every return', async t => {
  const f = fixture(t);
  // defer the fixture job so the doomed product is the only actionable one
  f.store.update(f.job.id, { nextAt: Date.now() + 3_600_000 });
  const doomed = f.store.enqueue({ ...spec, id: 'drive-doomed', version: '0.9.0' }, f.config);
  const doomTurn = await driveQueue(f.store, f.config, { once: true });
  assert.equal(doomTurn.action, 'host');
  assert.equal(doomTurn.job.id, doomed.id);
  const rejected = completeTurn(f.store, doomed.id, doomTurn.turn.id, { viable: false, distinctness: 'Dead on arrival', risks: ['Infeasible'], plan: ['Do not proceed'] });
  assert.equal(rejected.status, 'needs-owner');
  // a fresh due job's host return must carry the persisted failure
  f.store.enqueue({ ...spec, id: 'drive-fresh', version: '0.9.1' }, f.config);
  const host = await driveQueue(f.store, f.config, { once: true });
  assert.equal(host.action, 'host');
  assert.ok(host.failed, 'host return must report persisted terminal failures');
  assert.ok(host.failed.some(item => item.id === doomed.id), `failed must include ${doomed.id}: ${JSON.stringify(host.failed)}`);
});

test('drive surfaces pendingErrors when a persisted host turn context no longer matches', async t => {
  const f = fixture(t);
  const first = await driveQueue(f.store, f.config, { once: true });
  assert.equal(first.action, 'host');
  const job = f.store.get(f.job.id);
  // corrupt the persisted claim so the scan cannot complete it and must surface a reason
  f.store.update(f.job.id, { turn: { ...job.turn, contextDigest: 'deadbeef'.repeat(8) } });
  const next = await driveQueue(f.store, f.config, { once: true });
  assert.equal(next.action, 'wait');
  assert.ok(next.pendingErrors && next.pendingErrors.length > 0, 'pendingErrors must carry the context mismatch');
  assert.match(next.pendingErrors[0].error, /context changed/);
  assert.equal(next.pendingErrors[0].id, f.job.id);
});
