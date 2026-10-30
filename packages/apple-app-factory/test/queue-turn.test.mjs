import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { nextTurn, nextQueueTurn } from '../dist/runner.js';
import { runStep } from '../dist/scheduler.js';
import { projectDirectory, sourceDigest } from '../dist/workspace.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const success = [process.execPath, '-e', 'process.exit(0)'];

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-queue-'));
  const config = ConfigSchema.parse({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    allowLocalExecution: true, pollMs: 25,
    verification: { prerequisites: [], checks: [success], runtime: [success] },
    ...overrides,
  });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return {
    root, config, store,
    enqueue(name, stage = 'research', nextAt = 0, jobConfig = config, specExtra = {}) {
      const job = store.enqueue({
        id: `queue-${name}`, name: `Queue ${name}`, framework: 'flutter', platform: 'ios', channel: 'app-store', version: '1.0.0',
        purpose: `Coordinate ${name} work`, audience: 'Factory maintainers',
        differentiators: ['Explicit queue-wide stage execution'], acceptance: ['Preserve stage ownership'],
        ...specExtra,
      }, jobConfig);
      return store.update(job.id, { stage, nextAt });
    },
  };
}

test('nextQueueTurn returns the earliest-due host task without touching deferred siblings', async t => {
  const f = fixture(t);
  const deferred = f.enqueue('deferred', 'research', Date.now() + 3600000);
  const due = f.enqueue('due', 'research', 0);
  const result = await nextQueueTurn(f.store);
  assert.equal(result.action, 'host');
  assert.equal(result.job.id, due.id);
  assert.equal(result.turn.stage, 'research');
  assert.deepEqual(result.turn.role, ['product-analyst']);
  assert.deepEqual(f.store.get(deferred.id), deferred);
});

test('build turns carry the developer role by default and config roles override it', async t => {
  const f = fixture(t);
  const job = f.enqueue('roles-build', 'build', 0);
  const claim = await nextTurn(f.store, job.id);
  assert.equal(claim.action, 'host');
  assert.deepEqual(claim.turn.role, ['developer']);
  const custom = fixture(t, { roles: { research: ['product-analyst', 'requirement-groomer'], build: ['senior-developer', 'junior-developer'], review: ['architect-review'] } });
  const job2 = custom.enqueue('roles-custom', 'build', 0);
  const claim2 = await nextTurn(custom.store, job2.id);
  assert.deepEqual(claim2.turn.role, ['senior-developer', 'junior-developer']);
  assert.match(claim2.turn.prompt, /senior-developer/);
});

test('roles config fills default role lists per stage', () => {
  const base = { stateDir: '/tmp/roles-state', workspaceRoot: '/tmp/roles-workspaces', packageTarget: 'simulator', verification: { prerequisites: [], checks: [success], runtime: [success] } };
  const parsed = ConfigSchema.parse({ ...base, roles: {} });
  assert.deepEqual(parsed.roles.research, ['product-analyst']);
  assert.deepEqual(parsed.roles.build, ['developer']);
  assert.deepEqual(parsed.roles.review, ['architect-review', 'qa-engineer', 'acceptance-reviewer']);
});

test('nextQueueTurn drives a single-job queue exactly like next <id>', async t => {
  const f = fixture(t);
  const job = f.enqueue('single', 'research', 0);
  const result = await nextQueueTurn(f.store);
  assert.equal(result.action, 'host');
  assert.equal(result.job.id, job.id);
});

test('nextQueueTurn returns step for the earliest-due deterministic stage', async t => {
  const f = fixture(t);
  const deferred = f.enqueue('host-first', 'research', Date.now() + 3600000);
  const due = f.enqueue('deterministic', 'verify', 0);
  const result = await nextQueueTurn(f.store);
  assert.equal(result.action, 'step');
  assert.equal(result.job.id, due.id);
  assert.deepEqual(f.store.get(deferred.id), deferred);
});

test('nextQueueTurn prefers the highest-priority lane among equally due jobs', async t => {
  const f = fixture(t);
  const low = f.enqueue('low', 'research', 0, f.config, { priority: 'P2' });
  const critical = f.enqueue('critical', 'research', 0, f.config, { priority: 'P0' });
  const result = await nextQueueTurn(f.store);
  assert.equal(result.action, 'host');
  assert.equal(result.job.id, critical.id);
  assert.equal(result.turn.stage, 'research');
  assert.equal(f.store.get(low.id).turn ?? null, null);
});

test('priority never overrides eligibility: a deferred P0 is skipped for a due lower lane', async t => {
  const f = fixture(t);
  const deferred = f.enqueue('critical-deferred', 'research', Date.now() + 3600000, f.config, { priority: 'P0' });
  const due = f.enqueue('background-due', 'research', 0, f.config, { priority: 'P2' });
  const result = await nextQueueTurn(f.store);
  assert.equal(result.action, 'host');
  assert.equal(result.job.id, due.id);
  assert.deepEqual(f.store.get(deferred.id), deferred);
});

test('nextQueueTurn reports stale turn context and keeps scanning the queue', async t => {
  const f = fixture(t);
  const stale = f.enqueue('stale', 'research', 0);
  const claim = await nextTurn(f.store, stale.id);
  assert.equal(claim.action, 'host');
  f.store.update(stale.id, { logs: [...stale.logs, 'context-changed'] });
  const future = f.enqueue('future', 'research', Date.now() + 3600000);
  const result = await nextQueueTurn(f.store);
  assert.equal(result.action, 'idle');
  assert.equal(result.nextAt, future.nextAt);
  assert.equal(result.pendingErrors.length, 1);
  assert.equal(result.pendingErrors[0].id, stale.id);
  assert.match(result.pendingErrors[0].error, /context changed|changed/);
  assert.deepEqual(result.summary, { total: 2, built: 0, failed: 0, blocked: 0, waiting: 0, queued: 1, running: 1 });
});

test('nextQueueTurn idles with the earliest future due time when nothing is actionable', async t => {
  const f = fixture(t);
  const soon = f.enqueue('soon', 'research', Date.now() + 3600000);
  f.enqueue('later', 'research', Date.now() + 7200000);
  const result = await nextQueueTurn(f.store);
  assert.equal(result.action, 'idle');
  assert.equal(result.nextAt, soon.nextAt);
  assert.deepEqual(result.pendingErrors, []);
  assert.deepEqual(result.summary, { total: 2, built: 0, failed: 0, blocked: 0, waiting: 0, queued: 2, running: 0 });
});

test('idle summary separates finished jobs from blocked ones for the terminal audit', async t => {
  const f = fixture(t);
  f.store.update(f.enqueue('built', 'package', 0).id, { status: 'built' });
  f.store.update(f.enqueue('failed', 'verify', 0).id, { status: 'failed' });
  f.store.update(f.enqueue('blocked', 'verify', 0).id, { status: 'blocked' });
  const result = await nextQueueTurn(f.store);
  assert.equal(result.action, 'idle');
  assert.equal(result.nextAt, null);
  assert.deepEqual(result.summary, { total: 3, built: 1, failed: 1, blocked: 1, waiting: 0, queued: 0, running: 0 });
});

test('obfuscate stage persists base digest, transformed digest and the typed report', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-obfuscate-'));
  const obConfigPath = join(root, 'obfuscator.json');
  writeFileSync(obConfigPath, JSON.stringify({ code: { removeComments: true } }));
  const config = ConfigSchema.parse({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    allowLocalExecution: true, pollMs: 25,
    verification: { prerequisites: [], checks: [success], runtime: [success] },
    obfuscation: { configPath: obConfigPath, seed: 'queue-test-seed' },
  });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue({
    id: 'queue-obfuscate', name: 'Queue Obfuscate', framework: 'flutter', platform: 'ios', channel: 'app-store', version: '1.0.0',
    purpose: 'Persist obfuscation evidence', audience: 'Factory maintainers',
    differentiators: ['Deterministic seeded obfuscation'], acceptance: ['Preserve obfuscation proof'],
  }, config);
  store.update(job.id, { stage: 'obfuscate', nextAt: 0 });
  const project = projectDirectory(store.get(job.id));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'main.dart'), '// gone\nvoid main() {}\n');
  const baseDigest = sourceDigest(store.get(job.id).workspace, true, 'flutter');
  const result = await runStep(store, config, job.id);
  assert.equal(result.stage, 'verify');
  assert.equal(result.status, 'queued');
  assert.equal(result.obfuscationBase.path, project);
  assert.equal(result.obfuscationBase.digest, baseDigest);
  assert.match(result.obfuscationDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(result.obfuscationDigest, baseDigest);
  assert.deepEqual(result.obfuscationReport, { changedFiles: 1, transforms: { code: 1 }, skipped: { generated: 0, unsupported: 0 } });
  assert.equal(readFileSync(join(project, 'main.dart'), 'utf8').includes('// gone'), false);
});

test('obfuscate stage accepts inline options and leaves no snapshot behind', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-obfuscate-inline-'));
  const config = ConfigSchema.parse({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    allowLocalExecution: true, pollMs: 25,
    verification: { prerequisites: [], checks: [success], runtime: [success] },
    obfuscation: { options: { code: { removeComments: true } }, seed: 'inline-seed' },
  });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue({
    id: 'queue-obfuscate-inline', name: 'Queue Obfuscate Inline', framework: 'flutter', platform: 'ios', channel: 'app-store', version: '1.0.0',
    purpose: 'Persist inline obfuscation evidence', audience: 'Factory maintainers',
    differentiators: ['Deterministic seeded obfuscation'], acceptance: ['Preserve obfuscation proof'],
  }, config);
  store.update(job.id, { stage: 'obfuscate', nextAt: 0 });
  const project = projectDirectory(store.get(job.id));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'main.dart'), '// gone\nvoid main() {}\n');
  const baseDigest = sourceDigest(store.get(job.id).workspace, true, 'flutter');
  const result = await runStep(store, config, job.id);
  assert.equal(result.stage, 'verify');
  assert.equal(result.obfuscationBase.digest, baseDigest);
  assert.match(result.obfuscationDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(result.obfuscationDigest, baseDigest);
  assert.deepEqual(result.obfuscationReport, { changedFiles: 1, transforms: { code: 1 }, skipped: { generated: 0, unsupported: 0 } });
  assert.equal(readFileSync(join(project, 'main.dart'), 'utf8').includes('// gone'), false);
  const snapshots = join(config.stateDir, 'obfuscation');
  assert.equal(existsSync(snapshots) ? readdirSync(snapshots).length : 0, 0);
});

test('obfuscation config requires exactly one of configPath or inline options', () => {
  const base = { stateDir: '/tmp/obf-state', workspaceRoot: '/tmp/obf-workspaces', packageTarget: 'simulator', verification: { prerequisites: [], checks: [success], runtime: [success] } };
  assert.throws(() => ConfigSchema.parse({ ...base, obfuscation: { seed: 'x' } }), /configPath or inline options/);
  assert.throws(() => ConfigSchema.parse({ ...base, obfuscation: { configPath: 'obfuscator.json', options: { code: {} } } }), /not both/);
  const parsed = ConfigSchema.parse({ ...base, obfuscation: { options: { code: { removeComments: true } } } });
  assert.deepEqual(parsed.obfuscation.options, { code: { removeComments: true } });
});

test('next --any CLI picks the earliest-due task across the queue', async t => {
  const f = fixture(t);
  f.enqueue('future', 'research', Date.now() + 3600000);
  const due = f.enqueue('due', 'research', 0);
  const configPath = join(f.root, 'factory.json');
  writeFileSync(configPath, JSON.stringify({
    stateDir: 'state', workspaceRoot: 'workspaces', packageTarget: 'simulator',
    allowLocalExecution: true, pollMs: 25,
    verification: { prerequisites: [], checks: [success], runtime: [success] },
  }));
  const result = spawnSync(process.execPath, [cli, 'next', '--any', '--config', configPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.action, 'host');
  assert.equal(parsed.job.id, due.id);
  assert.equal(parsed.turn.stage, 'research');
  assert.deepEqual(parsed.turn.role, ['product-analyst']);
});
