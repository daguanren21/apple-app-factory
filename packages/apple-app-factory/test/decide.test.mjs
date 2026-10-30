import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { Store } from '../dist/store.js';
import { run } from '../dist/process.js';

const cli = resolve('dist/cli.js');

const spec = {
  id: 'decision-log-fixture', name: 'Decision log fixture', purpose: 'Exercise decision-log persistence', audience: 'Harness maintainers',
  framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0',
  differentiators: ['Persisted rationale'], acceptance: ['Decisions reach the report'],
};

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apphx-decide-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'factory.json');
  writeFileSync(configPath, JSON.stringify({
    stateDir: join(root, 'state'),
    workspaceRoot: join(root, 'workspaces'),
    packageTarget: 'simulator',
    allowLocalExecution: true,
    verification: { prerequisites: [], checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] },
    ...overrides,
  }));
  const config = loadConfig(configPath);
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  const job = store.enqueue(spec, config);
  return { root, configPath, config, store, job };
}

function decideCLI(f, id, input, extra = []) {
  return run([process.execPath, cli, 'decide', id, '-', '--config', f.configPath, ...extra], { input: JSON.stringify(input) });
}

test('decide appends single and array entries, keeps existing timestamps and does not mutate scheduling state', async t => {
  const f = fixture(t);
  const before = f.store.get(f.job.id);

  const first = await decideCLI(f, f.job.id, { stage: 'build', role: 'decision-maker', rationale: 'Use Flutter material scaffolding' });
  assert.equal(first.code, 0, first.stderr);
  const one = f.store.get(f.job.id);
  assert.equal(one.decisions.length, 1);
  assert.equal(one.decisions[0].stage, 'build');
  assert.equal(one.decisions[0].role, 'decision-maker');
  assert.equal(one.decisions[0].rationale, 'Use Flutter material scaffolding');
  assert.equal(Number.isFinite(one.decisions[0].at), true);
  const firstAt = one.decisions[0].at;
  assert.equal(one.stage, before.stage);
  assert.equal(one.status, before.status);
  assert.deepEqual(one.attempts, before.attempts);
  assert.equal(one.turn, before.turn);

  const second = await decideCLI(f, f.job.id, [
    { role: 'decision-maker', rationale: 'Local-only simulator target' },
    { stage: 'review', role: 'architect-review', rationale: 'Approved module boundary' },
  ]);
  assert.equal(second.code, 0, second.stderr);
  const all = f.store.get(f.job.id);
  assert.equal(all.decisions.length, 3);
  assert.equal(all.decisions[0].at, firstAt);
  assert.equal(all.decisions[0].rationale, 'Use Flutter material scaffolding');
  assert.equal(all.decisions[1].stage, '');
  assert.equal(all.decisions[1].role, 'decision-maker');
  assert.equal(all.decisions[1].rationale, 'Local-only simulator target');
  assert.equal(all.decisions[2].stage, 'review');
  assert.equal(all.decisions[2].role, 'architect-review');
  assert.equal(all.decisions[2].rationale, 'Approved module boundary');
  assert.ok(all.decisions.every(entry => Number.isFinite(entry.at)));
  assert.equal(all.stage, before.stage);
  assert.equal(all.status, before.status);
  assert.deepEqual(all.attempts, before.attempts);
  assert.equal(all.turn, before.turn);
});

test('decide rejects an unknown task like status', async t => {
  const f = fixture(t);
  const result = await decideCLI(f, 'missing-id', { role: 'decision-maker', rationale: 'controlled' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown task missing-id/);
});

test('decide never changes stage, status or attempts', async t => {
  const f = fixture(t);
  f.store.update(f.job.id, { stage: 'review', status: 'blocked', attempts: { research: 2 } });
  const before = f.store.get(f.job.id);
  const result = await decideCLI(f, f.job.id, { stage: 'review', role: 'decision-maker', rationale: 'Blocked pending owner evidence' });
  assert.equal(result.code, 0, result.stderr);
  const after = f.store.get(f.job.id);
  assert.equal(after.stage, 'review');
  assert.equal(after.status, 'blocked');
  assert.deepEqual(after.attempts, { research: 2 });
  assert.equal(after.decisions.length, 1);
});

test('report carries decisions in JSON and markdown, with an empty 决策日志 when none exist', async t => {
  const f = fixture(t);
  const job = f.store.get(f.job.id);

  let result = await run([process.execPath, cli, 'report', job.id, '--out', join(f.root, 'empty-out'), '--config', f.configPath]);
  assert.equal(result.code, 0, result.stderr);
  let report = JSON.parse(readFileSync(join(f.root, 'empty-out', `${job.id}-report.json`), 'utf8'));
  assert.deepEqual(report.decisions, []);
  let markdown = readFileSync(join(f.root, 'empty-out', `${job.id}-report.md`), 'utf8');
  assert.match(markdown, /## 决策日志/);
  assert.match(markdown, /无/);

  const decided = await decideCLI(f, job.id, { stage: 'build', role: 'decision-maker', rationale: 'Keep it deterministic' });
  assert.equal(decided.code, 0, decided.stderr);

  result = await run([process.execPath, cli, 'report', job.id, '--out', join(f.root, 'out'), '--config', f.configPath]);
  assert.equal(result.code, 0, result.stderr);
  report = JSON.parse(readFileSync(join(f.root, 'out', `${job.id}-report.json`), 'utf8'));
  assert.equal(report.decisions.length, 1);
  assert.equal(report.decisions[0].stage, 'build');
  assert.equal(report.decisions[0].role, 'decision-maker');
  assert.equal(report.decisions[0].rationale, 'Keep it deterministic');
  assert.equal(Number.isFinite(report.decisions[0].at), true);
  markdown = readFileSync(join(f.root, 'out', `${job.id}-report.md`), 'utf8');
  assert.match(markdown, /## 决策日志/);
  assert.match(markdown, /Keep it deterministic/);
  assert.match(markdown, /decision-maker/);
});

test('decide --build-only rejects removed publication permissions in configuration', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apphx-decide-buildonly-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'factory.json');
  writeFileSync(configPath, JSON.stringify({
    stateDir: join(root, 'state'),
    workspaceRoot: join(root, 'workspaces'),
    packageTarget: 'simulator',
    allowLocalExecution: true,
    verification: { prerequisites: [], checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] },
    allowSubmit: true,
    allowRelease: false,
  }));
  const result = await run([process.execPath, cli, 'decide', 'controlled-id', '-', '--build-only', '--config', configPath], { input: JSON.stringify({ stage: 'build', role: 'decision-maker', rationale: 'controlled' }) });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /allowSubmit/);
  assert.equal(existsSync(join(root, 'state')), false);
  assert.equal(existsSync(join(root, 'workspaces')), false);
});
