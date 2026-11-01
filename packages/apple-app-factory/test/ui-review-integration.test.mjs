import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../dist/contracts/schemas.js';
import { UI_QUALITY_CHECKS } from '../dist/contracts/ui-quality.js';
import { Store } from '../dist/state/store.js';
import { completeTurn, executeStep, nextTurn } from '../dist/workflow/runner.js';
import { buildReport } from '../dist/delivery/report.js';
import { sourceDigest } from '../dist/projects/workspace.js';
import { dependencyDigest } from '../dist/projects/dependencies.js';
import { buildPNG } from '../dist/vendor/obfuscator/dist/transforms/resources/png.js';

function fixture(t, dynamic = false, enabled = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apphx-ui-contract-'))), project = join(root, 'project');
  const captures = join(project, 'build/screenshots');
  mkdirSync(captures, { recursive: true });
  writeFileSync(join(project, 'pubspec.yaml'), 'name: ui_fixture\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(project, 'main.dart'), 'void main() {}\n');
  const config = ConfigSchema.parse({ projectMode: 'project', projectRoot: project, stateDir: join(root, 'state'), workspaceRoot: join(root, 'work'),
    packageTarget: 'apk', allowLocalExecution: true, uiQuality: enabled, retryDelayMs: 1,
    verification: { checks: [[process.execPath, '--version']], runtime: [[process.execPath, '--version']] },
    packaging: { provider: 'local', artifactPath: 'build/app.apk', commands: [[process.execPath, '-e', "require('node:fs').writeFileSync('build/app.apk','controlled artifact')"]] },
    ...(dynamic ? { workflow: {}, maxHostTurns: 32 } : {}) });
  const spec = { id: 'ui-review-fixture', name: 'UI review fixture', purpose: 'Refuse unsupported display and motion approval', audience: 'Maintainers', framework: 'flutter', platform: 'android',
    screenshotsDir: 'build/screenshots', differentiators: ['Real artifact validation'], acceptance: ['Retain required UI evidence'] };
  const store = new Store(config.stateDir), job = store.enqueue(spec, config);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const captureRows = [[320, 568], [1024, 768]].map(([width, height], index) => {
    const path = `build/screenshots/view-${index}.png`;
    const bytes = buildPNG({ width, height, pixels: new Uint8Array(width * height * 4).fill(255) });
    writeFileSync(join(project, path), bytes);
    return { path, kind: 'image', sha256: createHash('sha256').update(bytes).digest('hex'), viewport: { width, height }, device: 'Controlled schema fixture, not a native-device proof', state: 'Encoded image fixture for approval boundary regression' };
  });
  const tracePath = 'build/screenshots/motion.json';
  writeFileSync(join(project, tracePath), JSON.stringify({ fixture: true, observation: 'Protocol test only, no animation smoothness claim' }));
  captureRows.push({ path: tracePath, kind: 'trace', sha256: createHash('sha256').update(readFileSync(join(project, tracePath))).digest('hex'), viewport: { width: 320, height: 568 }, device: 'Controlled regression fixture', state: 'Trace receipt validation' });
  const uiQuality = { captures: captureRows, checks: UI_QUALITY_CHECKS.map(id => ({ id, status: 'passed', observation: `Controlled ${id} evidence binding test; not a real visual approval`, capturePaths: id === 'motion' ? [tracePath] : id === 'responsive-layout' ? captureRows.slice(0, 2).map(row => row.path) : [captureRows[0].path] })) };
  store.update(job.id, { stage: 'review', status: 'queued', verifiedDigest: sourceDigest(project, true, 'flutter'), verifiedDependencyDigest: dependencyDigest(project, 'flutter'), screenshotDigest: sourceDigest(captures, false), verifiedAt: new Date().toISOString() });
  const verdict = { approved: true, findings: [], acceptanceEvidence: [{ requirement: spec.acceptance[0], evidence: 'Controlled gate protocol observation; generated pixels are not product visual evidence' }], uiQuality };
  return { root, project, store, job: store.get(job.id), config, verdict, uiQuality };
}

test('approved legacy UI review needs complete hash-bound captures and retains its token on refusal', async t => {
  const f = fixture(t);
  const turn = await nextTurn(f.store, f.job.id);
  const { uiQuality, ...missing } = f.verdict;
  assert.throws(() => completeTurn(f.store, f.job.id, turn.turn.id, missing));
  assert.equal(f.store.get(f.job.id).turn.id, turn.turn.id);
  const bad = structuredClone(f.verdict);
  bad.uiQuality.captures[0].sha256 = '0'.repeat(64);
  assert.throws(() => completeTurn(f.store, f.job.id, turn.turn.id, bad));
  assert.equal(f.store.get(f.job.id).stage, 'review');
  const accepted = completeTurn(f.store, f.job.id, turn.turn.id, f.verdict);
  assert.equal(accepted.stage, 'package');
  assert.deepEqual(buildReport(accepted).uiQuality, f.uiQuality);
  writeFileSync(join(f.project, 'build/screenshots/view-0.png'), 'changed after approved review');
  const rejected = await executeStep(f.store, accepted);
  assert.equal(rejected.stage, 'build');
  assert.equal(rejected.artifact ?? null, null);
  assert.equal(rejected.verifiedDigest, null);
});

test('negative UI review can request repair without inventing complete positive evidence', async t => {
  const f = fixture(t);
  const turn = await nextTurn(f.store, f.job.id);
  const rejected = completeTurn(f.store, f.job.id, turn.turn.id, {
    approved: false, findings: ['Main action is hidden by the observed system bar'], acceptanceEvidence: f.verdict.acceptanceEvidence,
    uiQuality: { captures: [f.uiQuality.captures[0]], checks: [{ id: 'system-insets', status: 'failed', observation: 'Controlled negative verdict fixture', capturePaths: [f.uiQuality.captures[0].path] }] },
  });
  assert.equal(rejected.stage, 'build');
  assert.equal(rejected.verifiedDigest, null);
});

test('a failed legacy UI check cannot remain recorded as an approved review', async t => {
  const f = fixture(t);
  const turn = await nextTurn(f.store, f.job.id);
  f.verdict.uiQuality.checks[0].status = 'failed';
  const result = completeTurn(f.store, f.job.id, turn.turn.id, f.verdict);
  assert.equal(result.stage, 'build');
  assert.equal(result.review.approved, false);
  assert.equal(buildReport(result).uiQuality.checks[0].status, 'failed');
});

test('a dynamic final cannot erase a specialist UI defect', async t => {
  const f = fixture(t, true);
  const planner = await nextTurn(f.store, f.job.id);
  completeTurn(f.store, f.job.id, planner.turn.id, { rationale: 'Independent viewport inspection followed by final review', final: 'final-review', nodes: [
    { id: 'viewport-review', role: 'viewport-reviewer', instructions: 'Inspect system insets', fresh: true, dependsOn: [], readPaths: ['.'], writePaths: [], acceptance: ['Inspect system insets'] },
    { id: 'final-review', role: 'final-reviewer', instructions: 'Aggregate actual UI and product evidence', fresh: true, dependsOn: ['viewport-review'], readPaths: ['.'], writePaths: [], acceptance: ['Aggregate review evidence'] },
  ] });
  const specialist = await nextTurn(f.store, f.job.id);
  completeTurn(f.store, f.job.id, specialist.turn.id, { outcome: 'passed', summary: 'Completed the inspection and found a defect', evidence: [{ requirement: 'Inspect system insets', evidence: 'Controlled negative viewport observation' }], result: {
    approved: true, findings: [], acceptanceEvidence: [], uiQuality: { captures: [f.uiQuality.captures[0]], checks: [{ id: 'system-insets', status: 'failed', observation: 'Critical action obscured in the inspected fixture', capturePaths: [f.uiQuality.captures[0].path] }] },
  } });
  const final = await nextTurn(f.store, f.job.id);
  const result = completeTurn(f.store, f.job.id, final.turn.id, { outcome: 'passed', summary: 'Attempted final approval', evidence: [{ requirement: 'Aggregate review evidence', evidence: 'Controlled final observation' }], result: f.verdict });
  assert.equal(result.stage, 'build');
  assert.equal(result.review.approved, false);
  assert.equal(result.review.uiQuality.checks.find(check => check.id === 'system-insets').status, 'failed');
});

test('started UI tasks cannot disable the evidence gate while old headless contracts retain their behavior', async t => {
  const enabled = fixture(t);
  await nextTurn(enabled.store, enabled.job.id);
  assert.throws(() => enabled.store.update(enabled.job.id, { config: { ...enabled.job.config, uiQuality: false } }));
  assert.equal(enabled.store.get(enabled.job.id).config.uiQuality, true);
  const legacy = fixture(t, false, false);
  const turn = await nextTurn(legacy.store, legacy.job.id);
  const { uiQuality, ...verdict } = legacy.verdict;
  assert.equal(completeTurn(legacy.store, legacy.job.id, turn.turn.id, verdict).stage, 'package');
});
