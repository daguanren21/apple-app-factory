import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/store.js';
import { loadConfig } from '../dist/config.js';
import { inspectProcess } from '../dist/process.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const product = {
  id: 'workflow-cli', name: 'Workflow CLI', purpose: 'Exercise persisted native work graphs', audience: 'Harness maintainers',
  framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0',
  differentiators: ['Auditable model-generated work allocation'], acceptance: ['The frozen requirement is assessed before implementation'],
};
const research = { viable: true, distinctness: 'Research of the actual CLI workflow fixture', risks: [], plan: ['Implement the frozen requirement'] };

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apphx-workflow-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'factory.json');
  const f = { root, configPath };
  ok(f, 'init');
  changeConfig(f, { retryDelayMs: 1, ...overrides });
  return f;
}

function invoke(f, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--config', f.configPath, '--build-only'], {
    encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function ok(f, ...args) {
  // init deliberately does not accept --build-only.
  const result = args[0] === 'init'
    ? spawnSync(process.execPath, [cli, ...args, '--config', f.configPath], { encoding: 'utf8', timeout: 30000 })
    : invoke(f, ...args);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function changeConfig(f, patch) {
  const config = JSON.parse(readFileSync(f.configPath, 'utf8'));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete config[key];
    else config[key] = value;
  }
  writeFileSync(f.configPath, JSON.stringify(config));
}

function input(f, name, value) {
  const path = join(f.root, `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function enqueue(f) { return ok(f, 'enqueue', input(f, 'requirement', product)).id; }
function status(f, id) { return ok(f, 'status', id); }
function drive(f) { return ok(f, 'drive', '--once'); }
function complete(f, id, turn, result) { return ok(f, 'complete', id, turn.id, input(f, `result-${turn.id}`, result)); }
function phase(f, id) { return status(f, id).workflow.phases.research; }
function active(job) { return Object.values(job.workflow.phases).flatMap(value => value.nodes).filter(node => node.turn); }

function update(f, id, patch) {
  const store = new Store(loadConfig(f.configPath).stateDir);
  try { return store.update(id, patch); }
  finally { store.close(); }
}

function node(id, dependsOn = []) {
  return {
    id, role: `${id}-analyst`, instructions: `Assess ${id} against the actual frozen requirement`, dependsOn,
    readPaths: ['.'], writePaths: [], acceptance: [`${id} assessment has inspected evidence`], fresh: false,
  };
}

function graph() {
  return { rationale: 'Independent scope and risk findings join one research decision', nodes: [node('scope'), node('risk'), node('decision', ['scope', 'risk'])], final: 'decision', invalidate: [] };
}

function passed(definition, result = { inspected: definition.id }) {
  return {
    outcome: 'passed', summary: `Assessed ${definition.id}`,
    evidence: definition.acceptance.map(requirement => ({ requirement, evidence: `Inspected frozen requirement ${product.id} for ${definition.id}; recorded its requested behavior` })),
    result,
  };
}

function planned(f, id, plan = graph()) {
  const planner = drive(f);
  assert.equal(planner.action, 'host');
  assert.equal(planner.turn.kind, 'plan');
  complete(f, id, planner.turn, plan);
  return plan;
}

function rejectUnchanged(f, id, ...args) {
  const before = status(f, id);
  const events = ok(f, 'events', id);
  const result = invoke(f, ...args);
  assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(status(f, id), before);
  assert.deepEqual(ok(f, 'events', id), events);
  return result;
}

test('new init defaults to a persisted native planner without granting execution or rewriting existing configs', t => {
  const f = fixture(t);
  const configBytes = readFileSync(f.configPath, 'utf8');
  const raw = JSON.parse(configBytes);
  assert.deepEqual(raw.workflow, {});
  assert.equal(raw.maxHostTurns, 64);
  assert.equal(raw.allowLocalExecution, false);
  assert.equal(raw.allowCloudBuild, false);
  const id = enqueue(f);
  const planner = drive(f);
  assert.equal(planner.action, 'host');
  assert.equal(planner.turn.stage, 'research');
  assert.equal(planner.turn.kind, 'plan');
  assert.deepEqual(planner.turn.role, ['workflow-planner']);
  assert.ok(planner.turn.workflow.planSchema);
  assert.equal(planner.turn.workflow.phase, 'research');
  const claimed = status(f, id);
  assert.equal(claimed.turn.id, planner.turn.id);
  assert.equal(claimed.hostTurns, 1);
  assert.deepEqual(claimed.config.workflow, { maxNodes: 64, maxParallel: 4, maxReplans: 4 });
  const inspected = ok(f, 'next', id);
  assert.equal(inspected.turn.id, planner.turn.id);
  assert.equal(status(f, id).hostTurns, 1);
  const duplicateInit = spawnSync(process.execPath, [cli, 'init', '--config', f.configPath], { encoding: 'utf8' });
  assert.notEqual(duplicateInit.status, 0);
  assert.equal(readFileSync(f.configPath, 'utf8'), configBytes);
});

test('actual CLI rejects malformed, unsafe and unjoined plans transactionally while retaining the planner token', t => {
  const f = fixture(t);
  const id = enqueue(f);
  const planner = drive(f);
  const cases = [
    ['cycle', plan => { plan.nodes[0].dependsOn = ['decision']; }],
    ['dangling', plan => { plan.nodes[0].dependsOn = ['missing']; }],
    ['orphan', plan => { plan.nodes.push(node('unjoined')); }],
    ['traversal', plan => { plan.nodes[0].readPaths = ['../control']; }],
    ['absolute-path', plan => { plan.nodes[0].readPaths = ['/tmp']; }],
    ['permission-field', plan => { plan.allowLocalExecution = true; }],
    ['research-write', plan => { plan.nodes[0].writePaths = ['main.dart']; }],
  ];
  for (const [name, mutate] of cases) {
    const plan = graph();
    mutate(plan);
    rejectUnchanged(f, id, 'complete', id, planner.turn.id, input(f, name, plan));
  }
  complete(f, id, planner.turn, graph());
  assert.equal(phase(f, id).revision, 1);
  assert.equal(status(f, id).turn, null);
});

test('a review-only owner constraint does not inject a fixed research team', t => {
  const f = fixture(t, { roles: { review: [{ name: 'auditor', fresh: true }] } });
  const id = enqueue(f);
  const planner = drive(f);
  complete(f, id, planner.turn, {
    rationale: 'The requirement needs one domain assessment before implementation',
    nodes: [{ id: 'assessment', role: 'domain-expert', instructions: 'Assess this requirement without editing source', dependsOn: [], readPaths: ['.'], writePaths: [], acceptance: ['Requirement scope assessed'] }],
    final: 'assessment',
  });
  const claimed = drive(f);
  assert.equal(claimed.turn.kind, 'node');
  assert.equal(claimed.turn.workflow.nodeId, 'assessment');
  assert.deepEqual(claimed.turn.role, ['domain-expert']);
});

test('owner seat multiplicity and pins are checked by actual planner completion', t => {
  const f = fixture(t, { roles: { research: [{ name: 'assessor', provider: 'owner-model', fresh: true }, 'assessor'] } });
  const id = enqueue(f);
  const planner = drive(f);
  const plan = graph();
  plan.nodes[0].role = 'assessor';
  plan.nodes[0].provider = 'wrong-model';
  plan.nodes[0].fresh = true;
  rejectUnchanged(f, id, 'complete', id, planner.turn.id, input(f, 'wrong-pin', plan));
  plan.nodes[0].provider = 'owner-model';
  rejectUnchanged(f, id, 'complete', id, planner.turn.id, input(f, 'missing-seat', plan));
  plan.nodes[1].role = 'assessor';
  complete(f, id, planner.turn, plan);
  assert.equal(phase(f, id).nodes.filter(value => value.definition.role === 'assessor').length, 2);
});

test('drive allocates two distinct ready nodes, refuses incomplete evidence, then joins before the build planner', t => {
  const f = fixture(t, { workflow: { maxParallel: 2 } });
  const id = enqueue(f);
  const plan = planned(f, id);
  const left = drive(f), right = drive(f);
  assert.equal(left.turn.kind, 'node');
  assert.equal(right.turn.kind, 'node');
  assert.notEqual(left.turn.id, right.turn.id);
  assert.deepEqual(new Set([left.turn.workflow.nodeId, right.turn.workflow.nodeId]), new Set(['scope', 'risk']));
  const claimed = status(f, id);
  assert.equal(claimed.turn, null);
  assert.equal(active(claimed).length, 2);
  assert.equal(drive(f).action, 'wait');
  assert.equal(status(f, id).hostTurns, claimed.hostTurns);
  rejectUnchanged(f, id, 'complete', id, left.turn.id, input(f, 'missing-evidence', { outcome: 'passed', summary: 'No evidence', evidence: [] }));
  const definition = turn => plan.nodes.find(value => value.id === turn.workflow.nodeId);
  complete(f, id, left.turn, passed(definition(left.turn)));
  assert.equal(drive(f).action, 'wait');
  complete(f, id, right.turn, passed(definition(right.turn)));
  const final = drive(f);
  assert.equal(final.turn.workflow.nodeId, 'decision');
  assert.deepEqual(new Set(final.turn.workflow.dependencies.map(value => value.id)), new Set(['scope', 'risk']));
  assert.ok(final.turn.workflow.dependencies.every(value => value.result.outcome === 'passed'));
  complete(f, id, final.turn, passed(plan.nodes[2], research));
  const researched = status(f, id);
  assert.equal(researched.stage, 'build');
  assert.deepEqual(researched.research, research);
  assert.equal(researched.workflow.phases.research.status, 'complete');
  const build = drive(f);
  assert.equal(build.turn.kind, 'plan');
  assert.equal(build.turn.stage, 'build');
});

test('replan drains claims, preserves successful evidence across processes, and exposes the entire revised graph in reports', t => {
  const f = fixture(t);
  const id = enqueue(f);
  const plan = planned(f, id);
  const first = drive(f), second = drive(f);
  const firstDef = plan.nodes.find(value => value.id === first.turn.workflow.nodeId);
  const secondDef = plan.nodes.find(value => value.id === second.turn.workflow.nodeId);
  complete(f, id, first.turn, passed(firstDef));
  const preserved = phase(f, id).nodes.find(value => value.definition.id === firstDef.id);
  const reason = 'New accessibility facts require one additional assessment';
  ok(f, 'replan', id, reason);
  assert.equal(phase(f, id).status, 'planning');
  assert.equal(phase(f, id).reason, reason);
  assert.equal(drive(f).action, 'wait');
  complete(f, id, second.turn, passed(secondDef));
  const planner = drive(f);
  assert.equal(planner.turn.kind, 'plan');
  rejectUnchanged(f, id, 'replan', id, 'Do not replace an active planner');
  const revised = graph();
  revised.rationale = 'Preserve both completed assessments and join the new fact';
  revised.nodes.splice(2, 0, node('accessibility', ['scope']));
  revised.nodes.at(-1).dependsOn.push('accessibility');
  const dropped = structuredClone(revised);
  dropped.nodes = dropped.nodes.filter(value => value.id !== firstDef.id);
  for (const value of dropped.nodes) value.dependsOn = value.dependsOn.filter(id => id !== firstDef.id);
  rejectUnchanged(f, id, 'complete', id, planner.turn.id, input(f, 'dropped-success', dropped));
  complete(f, id, planner.turn, revised);
  const saved = status(f, id);
  const current = saved.workflow.phases.research;
  assert.equal(current.revision, 2);
  assert.deepEqual(current.nodes.find(value => value.definition.id === firstDef.id), preserved);
  assert.equal(current.history.length, 2);
  assert.equal(current.history[1].reason, reason);
  assert.equal(current.nodes.find(value => value.definition.id === 'decision').status, 'pending');
  const next = drive(f);
  assert.equal(next.turn.workflow.nodeId, 'accessibility');
  const report = ok(f, 'report', id, '--out', join(f.root, 'reports'));
  const full = JSON.parse(readFileSync(report.report, 'utf8'));
  assert.deepEqual(full.workflow, status(f, id).workflow);
  assert.deepEqual(full.workflow.phases.research.nodes.find(value => value.definition.id === firstDef.id).result, preserved.result);
  const markdown = readFileSync(report.markdown, 'utf8');
  for (const detail of [reason, 'revision 2', firstDef.id, firstDef.acceptance[0], preserved.result.evidence[0].evidence, revised.rationale, next.turn.id]) assert.ok(markdown.includes(detail), `Missing persisted graph detail: ${detail}`);
});

test('failed node completion records real failure and requests repair without discarding independent successes', t => {
  const f = fixture(t);
  const id = enqueue(f);
  const plan = planned(f, id);
  const first = drive(f), second = drive(f);
  const firstDef = plan.nodes.find(value => value.id === first.turn.workflow.nodeId);
  complete(f, id, first.turn, passed(firstDef));
  const before = phase(f, id).nodes.find(value => value.definition.id === firstDef.id);
  complete(f, id, second.turn, { outcome: 'failed', summary: 'A required runtime prerequisite is unavailable', evidence: [] });
  const failed = phase(f, id).nodes.find(value => value.definition.id === second.turn.workflow.nodeId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result.outcome, 'failed');
  assert.equal(failed.turn, null);
  assert.deepEqual(phase(f, id).nodes.find(value => value.definition.id === firstDef.id), before);
  const repair = drive(f);
  assert.equal(repair.turn.kind, 'plan');
  assert.equal(phase(f, id).revision, 1);
});

test('cancel revokes claims; stale results and replans fail; only a budget-eligible explicit retry clears cancellation', t => {
  const f = fixture(t);
  const id = enqueue(f);
  const plan = planned(f, id);
  const first = drive(f), second = drive(f);
  const definition = plan.nodes.find(value => value.id === first.turn.workflow.nodeId);
  complete(f, id, first.turn, passed(definition));
  const before = status(f, id);
  ok(f, 'cancel', id, 'Owner stops this graph pending a corrected prerequisite');
  const cancelled = status(f, id);
  assert.equal(cancelled.status, 'needs-owner');
  assert.equal(cancelled.workflow.cancelled, true);
  assert.equal(cancelled.turn, null);
  assert.equal(active(cancelled).length, 0);
  assert.equal(cancelled.hostTurns, before.hostTurns);
  assert.deepEqual(cancelled.attempts, before.attempts);
  assert.deepEqual(cancelled.workflow.phases.research.history, before.workflow.phases.research.history);
  rejectUnchanged(f, id, 'complete', id, second.turn.id, input(f, 'late-result', passed(plan.nodes.find(value => value.id === second.turn.workflow.nodeId))));
  rejectUnchanged(f, id, 'replan', id, 'Cancellation cannot be bypassed');
  changeConfig(f, { maxHostTurns: cancelled.hostTurns });
  const exhausted = ok(f, 'retry', id);
  assert.equal(exhausted.status, 'needs-owner');
  assert.equal(status(f, id).workflow.cancelled, true);
  changeConfig(f, { maxHostTurns: 64 });
  ok(f, 'retry', id);
  const resumed = status(f, id);
  assert.equal(resumed.workflow.cancelled, false);
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.workflow.phases.research.status, 'planning');
  assert.equal(resumed.hostTurns, before.hostTurns);
  assert.deepEqual(resumed.workflow.phases.research.nodes.find(value => value.definition.id === definition.id).result, before.workflow.phases.research.nodes.find(value => value.definition.id === definition.id).result);
  assert.equal(drive(f).turn.kind, 'plan');
});

test('retry guards node-level claims even in a stopped recovery state and cannot disable a progressed work graph', t => {
  const f = fixture(t);
  const id = enqueue(f);
  planned(f, id);
  const claimed = drive(f);
  // Recovery snapshots may be stopped while a native claim remains; job.turn is deliberately null.
  update(f, id, { status: 'blocked' });
  assert.equal(status(f, id).turn, null);
  rejectUnchanged(f, id, 'retry', id);
  assert.equal(active(status(f, id))[0].turn.id, claimed.turn.id);
  ok(f, 'cancel', id, 'Explicitly revoke outstanding native work');
  changeConfig(f, { workflow: undefined });
  rejectUnchanged(f, id, 'retry', id);
  assert.equal(status(f, id).workflow.cancelled, true);
});

test('replan/cancel reason arity, unsupported legacy jobs and publication permissions reject without graph mutation', t => {
  const f = fixture(t);
  const id = enqueue(f);
  for (const command of ['replan', 'cancel']) {
    rejectUnchanged(f, id, command, id);
    rejectUnchanged(f, id, command, id, '');
    rejectUnchanged(f, id, command, id, 'reason', 'extra');
  }
  const legacy = fixture(t, { workflow: undefined });
  const legacyId = enqueue(legacy);
  for (const command of ['replan', 'cancel']) rejectUnchanged(legacy, legacyId, command, legacyId, 'Legacy operation must not become dynamic implicitly');
  const turn = drive(legacy);
  assert.equal(turn.turn.kind, undefined);
  complete(legacy, legacyId, turn.turn, research);
  update(legacy, legacyId, { status: 'blocked' });
  changeConfig(legacy, { workflow: {} });
  rejectUnchanged(legacy, legacyId, 'retry', legacyId);

  const before = status(f, id);
  changeConfig(f, { allowSubmit: true });
  for (const command of ['replan', 'cancel']) {
    const result = invoke(f, command, id, 'Must not authorize publication');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /allowSubmit/);
  }
  changeConfig(f, { allowSubmit: undefined });
  assert.deepEqual(status(f, id), before);
});

test('CLI cancellation recovery invalidates actual deterministic proof before returning a review graph to verification', t => {
  const rootMarker = 'runtime-observed';
  const f = fixture(t, {
    allowLocalExecution: true, executionEnv: [], obfuscation: undefined,
    verification: { prerequisites: [], checks: [[process.execPath, '--check', 'model.mjs']], runtime: [[process.execPath, 'runtime.mjs']] },
  });
  const id = enqueue(f);
  const researchNode = node('research');
  planned(f, id, { rationale: 'One bounded fixture assessment suffices', nodes: [researchNode], final: 'research' });
  complete(f, id, drive(f).turn, passed(researchNode, research));

  const buildNode = { ...node('implementation'), role: 'fixture-implementer', writePaths: ['.'], acceptance: ['The controlled arithmetic fixture contains real executable assertions'] };
  const buildPlanner = drive(f);
  assert.equal(buildPlanner.turn.stage, 'build');
  complete(f, id, buildPlanner.turn, { rationale: 'One owner writes the complete controlled fixture', nodes: [buildNode], final: 'implementation' });
  const build = drive(f);
  writeFileSync(join(build.turn.cwd, 'pubspec.yaml'), 'name: workflow_cli_fixture\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(build.turn.cwd, 'model.mjs'), 'export function sum(values) { return values.reduce((total, value) => total + value, 0); }\n');
  const marker = join(f.root, rootMarker);
  writeFileSync(join(build.turn.cwd, 'runtime.mjs'), `import assert from 'node:assert/strict';\nimport {writeFileSync} from 'node:fs';\nimport {sum} from './model.mjs';\nassert.equal(sum([2,3,5]),10);\nassert.equal(sum([]),0);\nwriteFileSync(${JSON.stringify(marker)}, 'observed sum and empty-input behavior');\n`);
  complete(f, id, build.turn, {
    outcome: 'passed', summary: 'Created model and its executable runtime assertions',
    evidence: [{ requirement: buildNode.acceptance[0], evidence: 'model.mjs exports sum; runtime.mjs asserts sum([2,3,5])=10 and sum([])=0' }],
  });
  assert.equal(status(f, id).stage, 'verify');
  rejectUnchanged(f, id, 'replan', id, 'A graph cannot replace deterministic verification');
  ok(f, 'step', id);
  assert.equal(readFileSync(marker, 'utf8'), 'observed sum and empty-input behavior');
  const verified = status(f, id);
  assert.equal(verified.stage, 'review');
  assert.match(verified.verifiedDigest, /^[a-f0-9]{64}$/);
  assert.match(verified.verifiedDependencyDigest, /^[a-f0-9]{64}$/);

  const reviewNode = { ...node('independent-review'), fresh: true };
  const planner = drive(f);
  complete(f, id, planner.turn, { rationale: 'Review the actual deterministic evidence in a fresh context', nodes: [reviewNode], final: 'independent-review' });
  const review = drive(f);
  assert.equal(review.turn.stage, 'review');
  const claimed = status(f, id);
  ok(f, 'cancel', id, 'Owner requires a fresh review after the interrupted claim');
  rejectUnchanged(f, id, 'complete', id, review.turn.id, input(f, 'revoked-review', passed(reviewNode, {
    approved: true, findings: [], acceptanceEvidence: product.acceptance.map(requirement => ({ requirement, evidence: 'Controlled fixture runtime assertions completed' })),
  })));
  ok(f, 'retry', id);
  const resumed = status(f, id);
  assert.equal(resumed.stage, 'verify');
  assert.equal(resumed.workflow.cancelled, false);
  assert.equal(resumed.verifiedDigest, null);
  assert.equal(resumed.verifiedDependencyDigest, null);
  assert.equal(resumed.review, null);
  assert.equal(resumed.artifact, null);
  assert.equal(resumed.workflow.phases.review.status, 'planning');
  assert.deepEqual(resumed.workflow.phases.build, verified.workflow.phases.build);
  assert.equal(resumed.hostTurns, claimed.hostTurns);
  assert.deepEqual(resumed.attempts, claimed.attempts);
});

test('cancel also fences an active planner token without accepting its late plan', t => {
  const f = fixture(t);
  const id = enqueue(f);
  const planner = drive(f);
  const before = status(f, id);
  ok(f, 'cancel', id, 'Owner withdraws the current planning request');
  const cancelled = status(f, id);
  assert.equal(cancelled.turn, null);
  assert.equal(cancelled.workflow.cancelled, true);
  assert.equal(cancelled.hostTurns, before.hostTurns);
  rejectUnchanged(f, id, 'complete', id, planner.turn.id, input(f, 'revoked-plan', graph()));
});

test('next/drive host-pid accepts only live ancestry and explicit flags override inherited owner configuration', t => {
  const f = fixture(t);
  const id = enqueue(f);
  rejectUnchanged(f, id, 'next', id, '--host-pid', '0');
  rejectUnchanged(f, id, 'drive', '--once', '--host-pid', '1');
  const explicit = spawnSync(process.execPath, [cli, 'next', id, '--host-pid', String(process.pid), '--config', f.configPath], {
    env: { ...process.env, APPHX_HOST_PID: 'invalid' }, encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(explicit.error);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).action, 'host');
  assert.equal(status(f, id).turn.ownerPid, process.pid);
  assert.equal(status(f, id).turn.ownerIdentity, inspectProcess(process.pid).identity);
  assert.equal(ok(f, 'next', '--any', '--host-pid', String(process.pid)).action, 'idle');
  const other = fixture(t);
  const otherId = enqueue(other);
  const inherited = spawnSync(process.execPath, [cli, 'drive', '--once', '--config', other.configPath], {
    env: { ...process.env, APPHX_HOST_PID: String(process.pid) }, encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(inherited.error);
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.equal(JSON.parse(inherited.stdout).action, 'host');
  assert.equal(status(other, otherId).turn.ownerPid, process.pid);
  assert.equal(status(other, otherId).turn.ownerIdentity, inspectProcess(process.pid).identity);
  assert.match(invoke(f, 'status', id, '--host-pid', String(process.pid)).stderr, /does not accept --host-pid/);
});

test('actual installed pnpm wrappers cannot orphan or replay concurrent native claims', { skip: !['darwin', 'linux'].includes(process.platform), timeout: 120000 }, t => {
  const f = fixture(t, { workflow: { maxParallel: 2 } });
  // Invoke the already-built CLI through the real installed package manager.
  // No apphx installation, package fetch, synthetic pnpm script or native agent is involved.
  const { packageManager } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ private: true, packageManager }));
  const env = { ...process.env, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_ENABLE_AUTO_PIN: '0', npm_config_update_notifier: 'false' };
  delete env.APPHX_HOST_PID;
  delete env.npm_execpath;
  const wrapped = (...args) => spawnSync('pnpm', ['exec', process.execPath, cli, ...args, '--config', f.configPath, '--build-only'], {
    cwd: f.root, env, encoding: 'utf8', timeout: 30000,
  });
  const id = enqueue(f);
  planned(f, id);
  const before = status(f, id);
  const automatic = wrapped('drive', '--once');
  if (automatic.error?.code === 'ENOENT') { t.skip('The real pnpm executable is not installed; this regression never installs it'); return; }
  assert.ifError(automatic.error);
  assert.equal(automatic.signal, null, automatic.stderr);
  let left;
  if (automatic.status === 0) {
    left = JSON.parse(automatic.stdout);
    const owner = active(status(f, id)).find(node => node.turn.id === left.turn.id);
    assert.equal(owner.turn.ownerPid, process.pid, 'Automatic wrapper recognition must reach the persistent controller');
    assert.equal(owner.turn.ownerIdentity, inspectProcess(process.pid).identity);
  } else {
    // Ambiguous launchers may refuse; they must never commit an ephemeral owner.
    assert.match(automatic.stderr, /--host-pid/);
    assert.deepEqual(status(f, id), before);
  }
  const claim = () => {
    const result = wrapped('drive', '--once', '--host-pid', String(process.pid));
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  left ??= claim();
  const right = claim();
  assert.equal(left.action, 'host');
  assert.equal(right.action, 'host');
  assert.notEqual(left.turn.id, right.turn.id);
  assert.deepEqual(new Set([left.turn.workflow.nodeId, right.turn.workflow.nodeId]), new Set(['scope', 'risk']));
  const current = status(f, id);
  assert.equal(current.hostTurns, before.hostTurns + 2);
  const owned = active(current);
  assert.equal(owned.length, 2);
  for (const node of owned) {
    assert.equal(node.turn.ownerPid, process.pid, 'Exited pnpm wrappers must never own outstanding native work');
    assert.equal(node.turn.ownerIdentity, inspectProcess(process.pid).identity);
    assert.equal(node.attempts, 1);
  }
  assert.equal(claim().action, 'wait');
  const waited = status(f, id);
  assert.deepEqual(waited.workflow, current.workflow, 'Another wrapper invocation must not reclaim either live controller token');
  assert.equal(waited.hostTurns, current.hostTurns);
  assert.deepEqual(waited.attempts, current.attempts);
});
