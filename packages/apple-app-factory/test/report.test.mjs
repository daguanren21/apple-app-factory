import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, realpathSync, readdirSync, renameSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../dist/configuration/config.js';
import { Store } from '../dist/state/store.js';
import { buildReport, reportJob, renderMarkdown } from '../dist/delivery/report.js';
import { deliveryManifest } from '../dist/delivery/manifest.js';
import { prepareExecutionWorkspace, sourceDigest } from '../dist/projects/workspace.js';
import { dependencyDigest } from '../dist/projects/dependencies.js';
import { run } from '../dist/execution/process.js';
import { completeTurn, nextTurn, requestWorkflowReplan } from '../dist/workflow/runner.js';
import { runStep } from '../dist/workflow/scheduler.js';
import { verificationProofDigest } from '../dist/workflow/proof.js';

const cli = resolve('dist/cli.js');

function fixture(t, overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apphx-report-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'factory.json');
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  writeFileSync(configPath, JSON.stringify({
    stateDir: join(root, 'state'),
    workspaceRoot: join(root, 'workspaces'),
    projectRoot,
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

async function workflowReview(t) {
  const check = [process.execPath, '-e', 'require("node:fs").accessSync("main.dart")'];
  const f = fixture(t, { projectMode: 'isolated', workflow: {}, maxHostTurns: 64,
    verification: { prerequisites: [], checks: [check], runtime: [check] } });
  const job = f.store.enqueue(spec, f.config);
  const take = () => nextTurn(f.store, job.id, { ownerPid: process.pid });
  const node = (id, dependsOn = [], extra = {}) => ({ id, role: `${id}-reviewer`, instructions: `Perform ${id}`, dependsOn,
    readPaths: ['.'], writePaths: [], acceptance: [`${id} inspected`], ...extra });
  const graph = (nodes, final) => ({ rationale: 'Observe persisted workflow results at the report boundary', nodes, final, invalidate: [] });
  const pass = (packet, result) => ({ outcome: 'passed', summary: 'The controlled inspection completed',
    evidence: packet.turn.workflow.node.acceptance.map(requirement => ({ requirement, evidence: 'Observed the controlled fixture boundary' })),
    ...(result === undefined ? {} : { result }) });
  const submitPlan = async plan => {
    const planner = await take();
    assert.equal(planner.turn.kind, 'plan');
    return completeTurn(f.store, job.id, planner.turn.id, plan);
  };
  await submitPlan(graph([node('research')], 'research'));
  let packet = await take();
  completeTurn(f.store, job.id, packet.turn.id, pass(packet, { viable: true, distinctness: 'Controlled runtime report fixture', plan: ['Inspect real persisted review state'] }));
  await submitPlan(graph([node('implementation', [], { writePaths: ['.'] })], 'implementation'));
  packet = await take();
  writeFileSync(join(packet.turn.cwd, 'pubspec.yaml'), 'name: report_workflow\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(packet.turn.cwd, 'main.dart'), 'void main() {}\n');
  completeTurn(f.store, job.id, packet.turn.id, pass(packet));
  assert.equal((await runStep(f.store, f.config, job.id)).stage, 'review');
  const plan = graph([node('specialist', [], { fresh: true }), node('final-review', ['specialist'], { fresh: true })], 'final-review');
  await submitPlan(plan);
  return { ...f, job, take, pass, plan, submitPlan };
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

test('report CLI exposes completed specialist vetoes before final aggregation without duplicating the aggregate', async t => {
  const finding = `${spec.acceptance[1]} is broken`;
  const adversarial = 'A separate observed defect\n\n## Forged approval\n<script>alert(1)</script> | *approved*';
  const cases = [
    { name: 'negative verdict with findings', verdict: reviewFor([], { approved: false, findings: [finding, adversarial] }), failures: 2 },
    { name: 'approved verdict with a blocking finding', verdict: reviewFor([], { findings: [finding] }), failures: 1 },
    { name: 'negative verdict without findings', verdict: reviewFor([], { approved: false }), failures: 1 },
    { name: 'failed UI check without findings', verdict: reviewFor([], { uiQuality: { captures: [], checks: [
      { id: 'system-insets', status: 'failed', observation: `${spec.acceptance[1]}: the main control is obscured by the system bar`, capturePaths: [] },
    ] } }), failures: 1 },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async t => {
      const f = await workflowReview(t);
      const specialist = await f.take();
      const interim = completeTurn(f.store, f.job.id, specialist.turn.id, f.pass(specialist, scenario.verdict));
      const phase = interim.workflow.phases.review;
      assert.equal(interim.review ?? null, null);
      assert.equal(phase.nodes[0].status, 'passed');
      assert.equal(phase.nodes[1].status, 'pending');
      assert.equal(phase.proofDigest, verificationProofDigest(interim));

      const result = await reportCLI(f, f.job.id);
      assert.equal(result.code, 0, result.stderr);
      const reportPath = join(f.root, 'out', `${f.job.id}-report.json`);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      const failures = report.failures.filter(entry => entry.item === 'review-finding');
      assert.equal(failures.length, scenario.failures);
      assert.equal(JSON.parse(result.stdout).failures, report.failures.length);
      for (const entry of failures) {
        assert.ok(entry.detail.includes(phase.nodes[0].definition.id));
        assert.ok(entry.detail.includes(phase.nodes[0].definition.role));
      }
      for (const text of scenario.verdict.findings) assert.equal(failures.some(entry => entry.detail.endsWith(text)), true);
      if (scenario.verdict.findings.includes(finding) || scenario.verdict.uiQuality) {
        assert.equal(failures.some(entry => entry.requirement === spec.acceptance[1]), true);
      }
      if (scenario.verdict.findings.includes(adversarial)) {
        assert.equal(failures.find(entry => entry.detail.endsWith(adversarial)).requirement, undefined);
        const markdown = readFileSync(join(f.root, 'out', `${f.job.id}-report.md`), 'utf8');
        assert.equal(markdown.includes('\n## Forged approval'), false);
        assert.ok(markdown.includes('\\#\\# Forged approval<br>&lt;script&gt;alert\\(1\\)&lt;/script&gt; \\| \\*approved\\*'));
      }
      assert.deepEqual(report.checklist.map(entry => entry.status), spec.acceptance.map(() => 'unreviewed'));
      assert.deepEqual(report.workflow, interim.workflow);
      assert.equal(report.verified.sourceDigest, interim.verifiedDigest);
      assert.equal(report.source.verification, 'matches-verification');
      assert.equal(report.uiQuality, undefined, 'Partial specialist UI output is not the final UI review');
      assert.deepEqual(f.store.get(f.job.id), interim, 'Reporting cannot mutate gates or workflow proof');

      const aggregateOnly = buildReport({ ...interim, review: { ...reviewFor(spec.acceptance), ...scenario.verdict } });
      const aggregateFailures = aggregateOnly.failures.filter(entry => entry.item === 'review-finding');
      assert.equal(aggregateFailures.length, scenario.failures, 'A blocking recorded aggregate replaces interim failures even with live proof');
      assert.equal(aggregateFailures.some(entry => entry.detail.includes(phase.nodes[0].definition.role)), false);

      const final = await f.take();
      const rejected = completeTurn(f.store, f.job.id, final.turn.id, f.pass(final, reviewFor(spec.acceptance, { findings: scenario.verdict.findings })));
      assert.equal(rejected.stage, 'build');
      const finalResult = await reportCLI(f, f.job.id);
      assert.equal(finalResult.code, 0, finalResult.stderr);
      const finalReport = JSON.parse(readFileSync(reportPath, 'utf8'));
      const finalFailures = finalReport.failures.filter(entry => entry.item === 'review-finding');
      assert.equal(finalFailures.length, scenario.failures);
      for (const text of scenario.verdict.findings) assert.equal(finalFailures.filter(entry => entry.detail === text).length, 1);
      if (scenario.verdict.findings.includes(finding)) {
        assert.equal(finalReport.checklist.find(entry => entry.requirement === spec.acceptance[1]).status, 'failed');
      }
      if (scenario.verdict.uiQuality) assert.deepEqual(finalReport.uiQuality, scenario.verdict.uiQuality);
    });
  }
});

test('only completed typed inspections bound to the current verification generation contribute interim failures', async t => {
  const f = await workflowReview(t);
  const specialist = await f.take();
  const activeTurn = f.store.get(f.job.id).workflow.phases.review.nodes[0].turn;
  const interim = completeTurn(f.store, f.job.id, specialist.turn.id, f.pass(specialist, reviewFor([], { approved: false, findings: ['Observed blocker'] })));
  assert.equal(buildReport(interim).failures.filter(entry => entry.item === 'review-finding').length, 1);
  const phase = job => job.workflow.phases.review;
  const inspection = job => phase(job).nodes[0];
  const rebind = job => { phase(job).proofDigest = verificationProofDigest(job); };
  const cases = [
    ['missing phase proof', job => { delete phase(job).proofDigest; }],
    ['invalidated phase proof', job => { phase(job).proofDigest = null; }],
    ['prior phase proof', job => { phase(job).proofDigest = digest64('f'); }],
    ['new source proof', job => { job.verifiedDigest = digest64('e'); }],
    ['new dependency proof', job => { job.verifiedDependencyDigest = digest64('e'); }],
    ['new screenshot proof', job => { job.screenshotDigest = digest64('e'); }],
    ['same bytes, new verification timestamp', job => { job.verifiedAt = '2000-01-01T00:00:00.000Z'; }],
    ['same bytes, new verification attempt', job => { job.attempts.verify += 1; }],
    ['changed verification contract', job => { job.config.verification.runtime = [[process.execPath, '--version']]; }],
    ['invalidated source proof', job => { job.verifiedDigest = null; rebind(job); }],
    ['invalidated dependency proof', job => { job.verifiedDependencyDigest = null; rebind(job); }],
    ['missing verification timestamp', job => { delete job.verifiedAt; rebind(job); }],
    ['missing required screenshot proof', job => { job.spec.screenshotsDir = 'build/screenshots'; job.screenshotDigest = null; rebind(job); }],
    ['prior review checkpoint', job => { job.stage = 'build'; }],
    ['cancelled workflow', job => { job.workflow.cancelled = true; }],
    ['pending inspection', job => { inspection(job).status = 'pending'; }],
    ['running inspection', job => { inspection(job).status = 'running'; }],
    ['failed inspection', job => { inspection(job).status = 'failed'; }],
    ['unreleased inspection turn', job => { inspection(job).turn = activeTurn; }],
    ['failed execution output', job => { inspection(job).result.outcome = 'failed'; }],
    ['untyped output', job => { inspection(job).result.result = { findings: ['Observed blocker'], acceptanceEvidence: [] }; }],
    ['invalid approval value', job => { inspection(job).result.result.approved = 'false'; }],
    ['non-review output', job => { job.workflow.phases.build.nodes[0].result.result = inspection(job).result.result; delete job.workflow.phases.review; }],
    ['positive specialist', job => { inspection(job).result.result = reviewFor([]); }],
  ];
  for (const [name, change] of cases) {
    await t.test(name, () => {
      const snapshot = structuredClone(interim);
      change(snapshot);
      const before = structuredClone(snapshot);
      const report = buildReport(snapshot);
      assert.equal(report.failures.filter(entry => entry.item === 'review-finding').length, 0);
      assert.deepEqual(report.checklist.map(entry => entry.status), spec.acceptance.map(() => 'unreviewed'));
      assert.deepEqual(snapshot, before);
    });
  }
});

test('replans retain current accepted vetoes until explicit invalidation and fresh review replaces them', async t => {
  const f = await workflowReview(t);
  const specialist = await f.take();
  completeTurn(f.store, f.job.id, specialist.turn.id, f.pass(specialist, reviewFor([], { approved: false, findings: ['Observed blocker'] })));
  requestWorkflowReplan(f.store, f.job.id, 'Inspect an additional fact without invalidating the completed specialist');
  assert.equal(buildReport(f.store.get(f.job.id)).failures.filter(entry => entry.item === 'review-finding').length, 1);
  const retained = await f.submitPlan(f.plan);
  assert.equal(retained.workflow.phases.review.revision, 2);
  assert.equal(buildReport(retained).failures.filter(entry => entry.item === 'review-finding').length, 1);

  requestWorkflowReplan(f.store, f.job.id, 'The specialist must repeat its inspection');
  const invalidated = await f.submitPlan({ ...f.plan, invalidate: ['specialist'] });
  assert.equal(invalidated.workflow.phases.review.nodes[0].result, undefined);
  const report = buildReport(invalidated);
  assert.equal(report.failures.filter(entry => entry.item === 'review-finding').length, 0);
  assert.deepEqual(report.checklist.map(entry => entry.status), spec.acceptance.map(() => 'unreviewed'));

  const fresh = await f.take();
  completeTurn(f.store, f.job.id, fresh.turn.id, f.pass(fresh, reviewFor([])));
  assert.equal(buildReport(f.store.get(f.job.id)).failures.length, 0);
  const final = await f.take();
  const accepted = completeTurn(f.store, f.job.id, final.turn.id, f.pass(final, reviewFor(spec.acceptance)));
  assert.equal(accepted.stage, 'package');
  assert.equal(buildReport(accepted).failures.length, 0);
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

test('Markdown report renders multiline workflow data as inert readable text', t => {
  const f = fixture(t);
  const job = f.store.enqueue(spec, f.config);
  const adversarial = 'Observed detail\n\n## Forged verification\n<script>alert(1)</script> | *approved* ~~hidden~~ [link](https://example.invalid)';
  const definition = { id: 'audit', role: adversarial, instructions: adversarial, dependsOn: [], readPaths: ['.'], writePaths: [], acceptance: [adversarial], fresh: true };
  const result = { outcome: 'failed', summary: adversarial, evidence: [{ requirement: adversarial, evidence: adversarial }] };
  f.store.update(job.id, {
    status: 'needs-owner', error: adversarial, feedback: adversarial,
    workflow: { cancelled: false, phases: { research: {
      status: 'planning', revision: 1, reason: adversarial, final: 'audit',
      nodes: [{ definition, status: 'failed', attempts: 1, turn: null, result, completedAt: Date.now() }],
      history: [{ revision: 1, at: Date.now(), reason: adversarial, plan: { rationale: adversarial, nodes: [definition], final: 'audit', invalidate: [] } }],
    } } },
  });
  const report = buildReport(f.store.get(job.id));
  assert.equal(report.workflow.phases.research.reason, adversarial, 'The lossless JSON report data is unchanged');
  assert.equal(report.failures.find(failure => failure.item === 'job-error').detail, adversarial);
  const markdown = renderMarkdown(report);
  assert.equal(markdown.includes('\n## Forged verification'), false);
  assert.equal(markdown.includes('<script>'), false);
  assert.ok(markdown.includes('Observed detail<br><br>\\#\\# Forged verification<br>&lt;script&gt;alert\\(1\\)&lt;/script&gt;'));
  assert.ok(markdown.includes('\\| \\*approved\\* \\~\\~hidden\\~\\~ \\[link\\]\\(https://example.invalid\\)'));
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
    verifiedDigest: sourceDigest(job.projectRoot, true, spec.framework), verifiedDependencyDigest: digest64('b'),
    review: reviewFor(spec.acceptance),
    artifact: { kind: 'ios-simulator', path: artifactPath, digest: createHash('sha256').update(readFileSync(artifactPath)).digest('hex'), createdAt: new Date().toISOString() },
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

function packagedSource(f, directory = '.') {
  let job = f.store.enqueue({ ...spec, project: { directory } }, f.config);
  const app = join(job.projectRoot, directory);
  mkdirSync(join(app, 'lib'), { recursive: true });
  mkdirSync(join(app, 'build'), { recursive: true });
  writeFileSync(join(app, 'pubspec.yaml'), 'name: report_app\n');
  writeFileSync(join(app, 'lib', 'model.dart'), 'int meaningfulName(int value) => value + 1;\n');
  writeFileSync(join(app, 'build', 'generated.txt'), 'generated source output');
  writeFileSync(join(job.projectRoot, 'owner-notes.txt'), 'Maintain this project in place.');
  if (job.workspace !== job.projectRoot) {
    job = f.store.update(job.id, prepareExecutionWorkspace(f.store, job));
    writeFileSync(join(job.workspace, directory, 'lib', 'model.dart'), 'int a(int b) => b + 1;\n');
  }
  const artifactPath = join(job.workspace, directory, 'build', 'Runner.app');
  mkdirSync(artifactPath, { recursive: true });
  writeFileSync(join(artifactPath, 'Runner'), 'controlled binary bytes');
  return f.store.update(job.id, {
    status: 'built', stage: 'package',
    verifiedDigest: sourceDigest(job.workspace, true, job.spec.framework, directory),
    verifiedDependencyDigest: dependencyDigest(job.workspace, job.spec.framework, directory),
    verifiedAt: new Date().toISOString(),
    review: reviewFor(job.spec.acceptance),
    artifact: { kind: 'ios-simulator', path: artifactPath, digest: sourceDigest(artifactPath, false), createdAt: new Date().toISOString() },
  });
}

test('delivery exposes real monorepo paths and frozen runtime acceptance argv without environment values', t => {
  const runtime = [[process.execPath, 'tools/native-acceptance.mjs', '--device', '${REPORT_TEST_DEVICE}']];
  const f = fixture(t, {
    executionEnv: ['REPORT_TEST_DEVICE'],
    verification: { prerequisites: [], checks: [[process.execPath, '--version']], runtime },
  });
  const job = packagedSource(f, 'apps/mobile');
  const previous = process.env.REPORT_TEST_DEVICE;
  process.env.REPORT_TEST_DEVICE = 'private-device-value-not-for-delivery';
  t.after(() => { if (previous === undefined) delete process.env.REPORT_TEST_DEVICE; else process.env.REPORT_TEST_DEVICE = previous; });
  const delivery = deliveryManifest(job);
  assert.equal(delivery.projectRoot, f.config.projectRoot);
  assert.equal(delivery.sourcePath, join(job.projectRoot, 'apps/mobile'));
  assert.equal(delivery.executionPath, join(job.workspace, 'apps/mobile'));
  assert.equal(delivery.runtime.cwd, join(job.projectRoot, 'apps/mobile'));
  assert.deepEqual(delivery.runtime.commands, runtime);
  assert.deepEqual(delivery.runtime.environment, ['REPORT_TEST_DEVICE']);
  assert.equal(JSON.stringify(delivery).includes(process.env.REPORT_TEST_DEVICE), false);
  assert.equal(delivery.sourceDigest, sourceDigest(job.projectRoot, true, 'flutter', 'apps/mobile'));
  assert.equal(delivery.verifiedDigest, delivery.sourceDigest);
  assert.equal(delivery.artifact.path, join(job.workspace, 'apps/mobile/build/Runner.app'));
  assert.equal(delivery.artifact.digest, sourceDigest(delivery.artifact.path, false));

  const hotConfig = { ...f.config, verification: { ...f.config.verification, runtime: [[process.execPath, 'different-command']] } };
  const result = reportJob(f.store, job.id, { config: hotConfig });
  assert.deepEqual(result.delivery.runtime.commands, runtime);
  const report = JSON.parse(readFileSync(result.report, 'utf8'));
  assert.equal(report.source.verification, 'matches-verification');
  const markdown = readFileSync(result.markdown, 'utf8');
  assert.equal(markdown.includes(process.env.REPORT_TEST_DEVICE), false);
});

test('default report output is external state results and collection retains live monorepo source, not transformed execution', t => {
  const f = fixture(t, { obfuscation: { options: {} } });
  const job = packagedSource(f, 'apps/mobile');
  const live = join(job.projectRoot, 'apps/mobile/lib/model.dart');
  const execution = join(job.workspace, 'apps/mobile/lib/model.dart');
  const beforeSource = readFileSync(live, 'utf8');
  const beforeExecution = readFileSync(execution, 'utf8');
  assert.notEqual(beforeSource, beforeExecution);
  const result = reportJob(f.store, job.id, { collect: true });
  assert.equal(result.report, join(f.config.stateDir, 'results', `${job.id}-report.json`));
  assert.equal(result.markdown, join(f.config.stateDir, 'results', `${job.id}-report.md`));
  assert.equal(existsSync(join(job.projectRoot, 'results')), false);
  assert.equal(result.delivery.sourcePath, join(job.projectRoot, 'apps/mobile'));
  assert.equal(result.delivery.executionPath, join(job.workspace, 'apps/mobile'));
  assert.equal(result.delivery.sourceDigest, sourceDigest(job.projectRoot, true, 'flutter', 'apps/mobile'));
  assert.notEqual(result.delivery.sourceDigest, result.delivery.verifiedDigest);
  const report = JSON.parse(readFileSync(result.report, 'utf8'));
  assert.equal(report.source.verification, 'matches-execution-snapshot');
  assert.match(report.source.reason, /separate execution path/);
  assert.equal(result.collect.role, 'secondary-source-snapshot');
  assert.notEqual(result.collect.source, job.projectRoot);
  assert.equal(readFileSync(join(result.collect.source, 'apps/mobile/lib/model.dart'), 'utf8'), beforeSource);
  assert.equal(readFileSync(join(result.collect.source, 'owner-notes.txt'), 'utf8'), 'Maintain this project in place.');
  assert.equal(existsSync(join(result.collect.source, 'apps/mobile/build')), false);
  assert.equal(sourceDigest(result.collect.source, true, 'flutter', 'apps/mobile'), result.collect.sourceDigest);
  assert.equal(sourceDigest(result.collect.artifact, false), job.artifact.digest);
  assert.equal(readFileSync(live, 'utf8'), beforeSource);
  assert.equal(readFileSync(execution, 'utf8'), beforeExecution);
});

for (const isolatedExecution of [false, true]) {
  test(`changed live source is explicitly unverified with ${isolatedExecution ? 'separate' : 'shared'} execution`, t => {
    const f = fixture(t, isolatedExecution ? { obfuscation: { options: {} } } : {});
    const job = packagedSource(f);
    const recordedSource = deliveryManifest(job).sourceDigest;
    const live = join(job.projectRoot, 'lib/model.dart');
    writeFileSync(live, 'int newRequirement(int value) => value * 2;\n');
    const result = reportJob(f.store, job.id, { collect: true });
    const report = JSON.parse(readFileSync(result.report, 'utf8'));
    assert.equal(report.source.verification, 'unverified');
    assert.match(report.source.reason, /Live source changed/);
    assert.match(report.source.reason, /artifact and checklist evidence do not verify/);
    assert.equal(report.source.recordedDigest, recordedSource);
    assert.notEqual(report.source.currentDigest, recordedSource);
    assert.equal(report.source.currentDigest, sourceDigest(job.projectRoot, true, 'flutter'));
    assert.equal(report.delivery.sourceDigest, recordedSource);
    assert.equal(report.delivery.verifiedDigest, job.verifiedDigest);
    assert.equal(readFileSync(join(result.collect.source, 'lib/model.dart'), 'utf8'), readFileSync(live, 'utf8'));
    assert.equal(result.collect.sourceDigest, report.source.currentDigest);
    assert.equal(sourceDigest(result.collect.artifact, false), job.artifact.digest);
    assert.match(readFileSync(result.markdown, 'utf8'), /recorded review evidence for the execution source/);
  });
}

test('isolated mode reports its maintained snapshot root rather than the unused owner project root', t => {
  const f = fixture(t, { projectMode: 'isolated' });
  const job = packagedSource(f);
  assert.equal(job.projectRoot, job.workspace);
  const result = reportJob(f.store, job.id, { collect: true });
  assert.equal(result.delivery.projectRoot, job.workspace);
  assert.equal(result.delivery.sourcePath, job.workspace);
  assert.equal(result.delivery.executionPath, job.workspace);
  assert.equal(readFileSync(join(result.collect.source, 'lib/model.dart'), 'utf8'), readFileSync(join(job.workspace, 'lib/model.dart'), 'utf8'));
});

test('direct and aliased protected output roots are rejected before creating report files or directories', async t => {
  for (const target of ['source', 'execution', 'workspaces', 'state', 'inbox', 'ancestor']) {
    for (const aliased of [false, true]) {
      await t.test(`${target} ${aliased ? 'alias' : 'direct'}`, t => {
        const f = fixture(t, { obfuscation: { options: {} }, inbox: { directory: 'inbox' } });
        const job = packagedSource(f);
        const reserved = { source: job.projectRoot, execution: job.workspace, workspaces: f.config.workspaceRoot, state: f.config.stateDir, inbox: f.config.inbox.directory, ancestor: f.root }[target];
        mkdirSync(reserved, { recursive: true });
        const alias = join(f.root, 'output-alias');
        if (aliased) symlinkSync(reserved, alias, 'dir');
        const out = target === 'ancestor' ? (aliased ? alias : reserved) : join(aliased ? alias : reserved, 'unsafe-report-output');
        const sourceBefore = sourceDigest(job.projectRoot, true, 'flutter');
        const executionBefore = sourceDigest(job.workspace, true, 'flutter');
        const stateBefore = readFileSync(join(f.config.stateDir, 'queue.sqlite'));
        assert.throws(() => reportJob(f.store, job.id, { out, collect: true }), /Report output.*(?:overlap|stateDir|real directory)/);
        assert.equal(existsSync(join(out, `${job.id}-report.json`)), false);
        if (target !== 'ancestor') assert.equal(existsSync(join(reserved, 'unsafe-report-output')), false);
        assert.equal(sourceDigest(job.projectRoot, true, 'flutter'), sourceBefore);
        assert.equal(sourceDigest(job.workspace, true, 'flutter'), executionBefore);
        assert.deepEqual(readFileSync(join(f.config.stateDir, 'queue.sqlite')), stateBefore);
      });
    }
  }
});

test('output file and nested collection aliases cannot mutate live source before a report is written', async t => {
  for (const alias of ['json-symlink', 'markdown-hardlink', 'source-directory-symlink', 'source-file-hardlink', 'artifact-symlink']) {
    await t.test(alias, t => {
      const f = fixture(t);
      const job = packagedSource(f);
      const out = join(f.root, 'out');
      const destination = join(out, job.id);
      mkdirSync(join(destination, 'source/lib'), { recursive: true });
      const live = join(job.projectRoot, 'lib/model.dart');
      const before = readFileSync(live, 'utf8');
      const beforeMtime = statSync(live).mtimeMs;
      if (alias === 'json-symlink') symlinkSync(live, join(out, `${job.id}-report.json`));
      if (alias === 'markdown-hardlink') linkSync(live, join(out, `${job.id}-report.md`));
      if (alias === 'source-directory-symlink') symlinkSync(job.projectRoot, join(destination, 'source/alias'), 'dir');
      if (alias === 'source-file-hardlink') linkSync(live, join(destination, 'source/lib/model.dart'));
      if (alias === 'artifact-symlink') symlinkSync(job.artifact.path, join(destination, 'Runner.app'), 'dir');
      const beforeEntries = readdirSync(out);
      assert.throws(() => reportJob(f.store, job.id, { out, collect: true }), /(?:symlink|hard-linked)/);
      assert.deepEqual(readdirSync(out), beforeEntries);
      assert.equal(readFileSync(live, 'utf8'), before);
      assert.equal(statSync(live).mtimeMs, beforeMtime);
      assert.equal(existsSync(join(destination, 'source/owner-notes.txt')), false);
    });
  }
});

test('a state results alias cannot redirect the default output into source or queue storage', async t => {
  for (const target of ['project', 'state']) {
    await t.test(target, t => {
      const f = fixture(t);
      const job = packagedSource(f);
      const protectedPath = target === 'project' ? job.projectRoot : f.config.stateDir;
      symlinkSync(protectedPath, join(f.config.stateDir, 'results'), 'dir');
      assert.throws(() => reportJob(f.store, job.id, { collect: true }), /Report output.*(?:overlap|stateDir)/);
      assert.equal(existsSync(join(protectedPath, `${job.id}-report.json`)), false);
      assert.equal(existsSync(join(protectedPath, job.id)), false);
    });
  }
});

test('collection rejects changed, missing and symlinked artifacts before writing output', async t => {
  for (const failure of ['changed-file', 'changed-bundle', 'missing', 'nested-symlink']) {
    await t.test(failure, t => {
      const f = fixture(t);
      let job = packagedSource(f);
      if (failure === 'changed-file') {
        const path = join(job.projectRoot, 'build/package.ipa');
        writeFileSync(path, 'original bytes');
        job = f.store.update(job.id, { artifact: { kind: 'ipa', path, digest: createHash('sha256').update(readFileSync(path)).digest('hex'), createdAt: new Date().toISOString() } });
        writeFileSync(path, 'changed bytes');
      }
      if (failure === 'changed-bundle') writeFileSync(join(job.artifact.path, 'Runner'), 'changed binary bytes');
      if (failure === 'missing') rmSync(job.artifact.path, { recursive: true });
      if (failure === 'nested-symlink') symlinkSync(join(job.projectRoot, 'lib/model.dart'), join(job.artifact.path, 'source-alias'));
      const out = join(f.root, 'out');
      assert.throws(() => reportJob(f.store, job.id, { out, collect: true }), /(?:Artifact digest|Artifact is missing|symlink)/);
      assert.equal(existsSync(out), false);
    });
  }
});

test('collection rejects source aliases instead of following them into control state', t => {
  const f = fixture(t);
  const job = packagedSource(f);
  symlinkSync(f.config.stateDir, join(job.projectRoot, 'control-alias'), 'dir');
  const out = join(f.root, 'out');
  assert.throws(() => reportJob(f.store, job.id, { out, collect: true }), /Source symlink/);
  assert.equal(existsSync(out), false);
});

test('stale source exports are rejected before overwriting either previous report or collected files', t => {
  const f = fixture(t);
  const job = packagedSource(f);
  const out = join(f.root, 'out');
  const first = reportJob(f.store, job.id, { out, collect: true });
  const previousReport = readFileSync(first.report, 'utf8');
  const previousSource = readFileSync(join(first.collect.source, 'lib/model.dart'), 'utf8');
  rmSync(join(job.projectRoot, 'owner-notes.txt'));
  writeFileSync(join(job.projectRoot, 'lib/model.dart'), 'int changed(int value) => value - 1;\n');
  assert.throws(() => reportJob(f.store, job.id, { out, collect: true }), /stale files.*fresh --out/);
  assert.equal(readFileSync(first.report, 'utf8'), previousReport);
  assert.equal(readFileSync(join(first.collect.source, 'lib/model.dart'), 'utf8'), previousSource);
});

test('report-only output cannot follow a file alias into source', t => {
  const f = fixture(t);
  const job = packagedSource(f);
  const out = join(f.root, 'out');
  mkdirSync(out);
  const live = join(job.projectRoot, 'lib/model.dart');
  const before = readFileSync(live, 'utf8');
  symlinkSync(live, join(out, `${job.id}-report.md`));
  assert.throws(() => reportJob(f.store, job.id, { out }), /symlink/);
  assert.equal(existsSync(join(out, `${job.id}-report.json`)), false);
  assert.equal(readFileSync(live, 'utf8'), before);
});

test('a missing live project is reported as unverified and cannot produce an empty collected source', t => {
  const f = fixture(t);
  const job = f.store.enqueue(spec, f.config);
  rmSync(job.projectRoot, { recursive: true });
  const report = buildReport(job);
  assert.equal(report.source.verification, 'unverified');
  assert.equal(report.source.currentDigest, null);
  assert.match(report.source.reason, /could not be fingerprinted/);
  const out = join(f.root, 'out');
  assert.throws(() => reportJob(f.store, job.id, { out, collect: true }), /Live project is missing/);
  assert.equal(existsSync(out), false);
});

for (const target of ['live', 'execution']) {
  test(`report metadata survives a retargeted ${target} ancestor but collection never reads its replacement`, t => {
    const f = fixture(t, { obfuscation: { options: {} } });
    // Keep queue/config/output paths outside the ancestor that will be replaced.
    const parent = join(f.root, 'pinned');
    const config = { ...f.config, ...(target === 'live' ? { projectRoot: join(parent, 'project') } : { workspaceRoot: join(parent, 'workspaces') }) };
    const job = packagedSource({ ...f, config });
    renameSync(parent, `${parent}-original`);
    const replacement = join(f.root, 'replacement');
    const redirected = target === 'live' ? join(replacement, 'project') : join(replacement, 'workspaces', job.id);
    mkdirSync(join(redirected, 'lib'), { recursive: true });
    writeFileSync(join(redirected, 'lib/model.dart'), 'unrelated source must never be collected');
    symlinkSync(replacement, parent, 'dir');
    const report = buildReport(f.store.get(job.id));
    assert.equal(report.job.id, job.id);
    assert.equal(report.source.currentDigest, null);
    assert.equal(report.source.verification, 'unverified');
    assert.match(report.source.reason, /frozen.*(?:projectRoot|workspace)/i);
    const out = join(f.root, 'retargeted-collection');
    assert.throws(() => reportJob(f.store, job.id, { out, collect: true }), /frozen.*(?:projectRoot|workspace)/i);
    assert.equal(existsSync(out), false);
    const metadata = reportJob(f.store, job.id, { out: join(f.root, 'metadata-only') });
    assert.equal(JSON.parse(readFileSync(metadata.report, 'utf8')).source.currentDigest, null);
    assert.equal(readFileSync(join(redirected, 'lib/model.dart'), 'utf8'), 'unrelated source must never be collected');
  });
}

test('a broken ancestor still permits recorded monorepo metadata inspection, never collection', t => {
  const f = fixture(t);
  const parent = join(f.root, 'pinned');
  const job = packagedSource({ ...f, config: { ...f.config, projectRoot: join(parent, 'project') } }, 'apps/mobile');
  renameSync(parent, `${parent}-original`);
  symlinkSync(join(f.root, 'missing-target'), parent, 'dir');
  const saved = f.store.get(job.id);
  const report = buildReport(saved);
  assert.equal(report.delivery.sourcePath, join(job.projectRoot, 'apps/mobile'));
  assert.equal(report.delivery.executionPath, join(job.workspace, 'apps/mobile'));
  assert.equal(report.source.currentDigest, null);
  assert.equal(report.source.verification, 'unverified');
  assert.match(report.source.reason, /symlink/i);
  const out = join(f.root, 'broken-collection');
  assert.throws(() => reportJob(f.store, job.id, { out, collect: true }), /symlink/i);
  assert.equal(existsSync(out), false);
});
