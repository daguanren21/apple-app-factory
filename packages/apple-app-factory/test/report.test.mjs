import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../dist/config.js';
import { Store } from '../dist/store.js';
import { buildReport } from '../dist/report.js';
import { run } from '../dist/process.js';

const cli = resolve('dist/cli.js');

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apphx-report-'));
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
  return { root, configPath, config, store };
}

const spec = {
  id: 'report-fixture', name: 'Report fixture', purpose: 'Exercise report handoff deliverables', audience: 'Harness maintainers',
  framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0',
  differentiators: ['Deterministic handoff'], acceptance: ['Retain existing behavior', 'Handle the next requirement'],
};

function digest64(prefix) { return prefix.repeat(64); }

function reviewFor(acceptance, patch = {}) {
  return { approved: true, findings: [], acceptanceEvidence: acceptance.map(requirement => ({ requirement, evidence: `Observed evidence for ${requirement}` })), ...patch };
}

async function reportCLI(f, id, extra = []) {
  return run([process.execPath, cli, 'report', id, '--out', join(f.root, 'out'), '--config', f.configPath, ...extra]);
}

test('built job report matches verbatim acceptance evidence and writes JSON + Markdown', async t => {
  const f = fixture(t);
  const job = f.store.enqueue(spec, f.config);
  const artifactPath = join(f.root, 'Runner.app');
  writeFileSync(artifactPath, 'controlled artifact bytes');
  f.store.update(job.id, {
    status: 'built', stage: 'package',
    verifiedDigest: digest64('a'), verifiedDependencyDigest: digest64('b'), screenshotDigest: digest64('c'), verifiedAt: new Date().toISOString(),
    review: reviewFor(spec.acceptance.slice(0, 1)),
    artifact: { kind: 'ios-simulator', path: artifactPath, digest: digest64('d'), createdAt: new Date().toISOString() },
  });

  const result = await reportCLI(f, job.id);
  assert.equal(result.code, 0, result.stderr);

  const reportPath = join(f.root, 'out', `${job.id}-report.json`);
  const markdownPath = join(f.root, 'out', `${job.id}-report.md`);
  assert.equal(existsSync(reportPath), true);
  assert.equal(existsSync(markdownPath), true);

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.job.id, job.id);
  assert.equal(report.job.product, spec.id);
  assert.equal(report.artifact.kind, 'ios-simulator');
  assert.equal(report.verified.sourceDigest, digest64('a'));
  assert.deepEqual(report.checklist.map(entry => entry.status), ['passed', 'uncovered']);
  assert.equal(report.checklist[0].requirement, 'Retain existing behavior');
  assert.equal(report.checklist[0].evidence, 'Observed evidence for Retain existing behavior');
  assert.equal(report.checklist[0].reason, null);
  assert.equal(report.checklist[1].requirement, 'Handle the next requirement');
  assert.equal(report.checklist[1].evidence, null);
  assert.equal(report.checklist[1].reason, '评审证据未覆盖该验收项');
  assert.equal(report.failures.length, 0);

  const markdown = readFileSync(markdownPath, 'utf8');
  assert.match(markdown, /\| 验收项 \| 状态 \| 证据 \/ 原因 \|/);
  assert.match(markdown, /## 不通过项与原因/);
  assert.match(markdown, /✅ 通过/);
  assert.match(markdown, /❌ 未覆盖/);
});

test('rejected review surfaces blocking findings and job error in checklist and failures', async t => {
  const f = fixture(t);
  const job = f.store.enqueue(spec, f.config);
  f.store.update(job.id, {
    status: 'failed', stage: 'review',
    verifiedDigest: digest64('a'), verifiedDependencyDigest: digest64('b'),
    error: 'Independent review rejected the handoff',
    review: reviewFor(spec.acceptance.slice(0, 1), { approved: false, findings: ['Handle the next requirement is broken'] }),
  });

  const report = buildReport(f.store.get(job.id));
  assert.deepEqual(report.checklist.map(entry => entry.status), ['passed', 'failed']);
  assert.equal(report.checklist[1].reason, 'Handle the next requirement is broken');
  assert.equal(report.failures.some(failure => failure.item === 'review-finding' && failure.detail === 'Handle the next requirement is broken'), true);
  assert.equal(report.failures.some(failure => failure.item === 'job-error' && failure.detail === 'Independent review rejected the handoff'), true);
  assert.equal(report.failures.some(failure => failure.item === 'acceptance' && failure.requirement === 'Handle the next requirement'), true);
});

test('failed job before review marks every acceptance item unreviewed with the error', async t => {
  const f = fixture(t);
  const job = f.store.enqueue(spec, f.config);
  f.store.update(job.id, { status: 'failed', stage: 'build', error: 'Verification failed' });

  const report = buildReport(f.store.get(job.id));
  assert.deepEqual(report.checklist.map(entry => entry.status), ['unreviewed', 'unreviewed']);
  assert.equal(report.checklist[0].evidence, null);
  assert.match(report.checklist[0].reason, /Verification failed/);
  assert.match(report.checklist[1].reason, /Verification failed/);
  assert.equal(report.failures.some(failure => failure.item === 'job-error' && failure.detail === 'Verification failed'), true);
});

test('--collect copies source and artifact without touching the source workspace', async t => {
  const f = fixture(t);
  const job = f.store.enqueue(spec, f.config);
  mkdirSync(join(job.workspace, 'lib'), { recursive: true });
  mkdirSync(join(job.workspace, 'build'), { recursive: true });
  const sourceFile = join(job.workspace, 'lib', 'model.dart');
  writeFileSync(sourceFile, 'int total(int a, int b) => a + b;\n');
  writeFileSync(join(job.workspace, 'build', 'stale-artifact'), 'generated output must be skipped');
  const artifactPath = join(f.root, 'Runner.app');
  writeFileSync(artifactPath, 'controlled artifact bytes');
  const beforeMtime = statSync(sourceFile).mtimeMs;
  const beforeHash = createHash('sha256').update(readFileSync(sourceFile)).digest('hex');
  f.store.update(job.id, {
    status: 'built', stage: 'package',
    verifiedDigest: digest64('a'), verifiedDependencyDigest: digest64('b'),
    review: reviewFor(spec.acceptance),
    artifact: { kind: 'ios-simulator', path: artifactPath, digest: digest64('d'), createdAt: new Date().toISOString() },
  });

  const result = await reportCLI(f, job.id, ['--collect']);
  assert.equal(result.code, 0, result.stderr);
  const collectedSource = join(f.root, 'out', job.id, 'source', 'lib', 'model.dart');
  const collectedArtifact = join(f.root, 'out', job.id, 'Runner.app');
  assert.equal(existsSync(collectedSource), true);
  assert.equal(readFileSync(collectedSource, 'utf8'), 'int total(int a, int b) => a + b;\n');
  assert.equal(existsSync(join(f.root, 'out', job.id, 'source', 'build', 'stale-artifact')), false);
  assert.equal(existsSync(collectedArtifact), true);
  assert.equal(readFileSync(collectedArtifact, 'utf8'), 'controlled artifact bytes');
  assert.ok(statSync(collectedArtifact).size > 0);
  assert.equal(statSync(sourceFile).mtimeMs, beforeMtime);
  assert.equal(createHash('sha256').update(readFileSync(sourceFile)).digest('hex'), beforeHash);
});

test('report rejects an unknown task like status', async t => {
  const f = fixture(t);
  const result = await run([process.execPath, cli, 'report', 'missing-id', '--out', join(f.root, 'out'), '--config', f.configPath]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown task missing-id/);
});

test('report build-only rejects removed publication permissions in configuration', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apphx-report-'));
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
  const result = await run([process.execPath, cli, 'report', 'controlled-id', '--build-only', '--config', configPath]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /allowSubmit/);
});
