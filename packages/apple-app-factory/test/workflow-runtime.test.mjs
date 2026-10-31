import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { driveQueue, completeTurn, requestWorkflowReplan, cancelWorkflow } from '../dist/runner.js';
import { runStep } from '../dist/scheduler.js';

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apphx-dynamic-runtime-'));
  const check = [process.execPath, '-e', 'require("node:fs").accessSync("main.dart")'];
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'work'), packageTarget: 'simulator', allowLocalExecution: true,
    maxHostTurns: 64, retryDelayMs: 1, workflow: {}, verification: { checks: [check], runtime: [check] }, ...overrides });
  const stores = [];
  const open = () => { const store = new Store(config.stateDir); stores.push(store); return store; };
  const store = open();
  const job = store.enqueue({ id: 'dynamic-runtime', name: 'Dynamic runtime', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', purpose: 'Exercise durable graph contracts', audience: 'Harness maintainers', differentiators: ['Observable graph recovery'], acceptance: ['Persist accepted work and enforce evidence'] }, config);
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, store, job, open };
}

const node = (id, dependsOn = [], extra = {}) => ({ id, role: id, instructions: `Perform ${id} within its declared scope`, dependsOn, readPaths: ['.'], writePaths: [], acceptance: [`${id} observed`], ...extra });
const graph = (nodes, final, invalidate = []) => ({ rationale: 'The declared dependencies join every result at a typed policy checkpoint', nodes, final, invalidate });
const verdict = { viable: true, distinctness: 'A controlled durable-graph fixture', plan: ['Exercise actual persisted state and verification'] };
const pass = (packet, result) => ({ outcome: 'passed', summary: 'The fixture observed the declared state transition', evidence: packet.turn.workflow.node.acceptance.map(requirement => ({ requirement, evidence: 'Actual Store/runner operations and assertions observed this fixture boundary' })), ...(result === undefined ? {} : { result }) });
const take = (f, store = f.store, extra = {}) => driveQueue(store, f.config, { once: true, ...extra });
async function submitPlan(f, plan) {
  const packet = await take(f);
  assert.equal(packet.turn.kind, 'plan');
  completeTurn(f.store, f.job.id, packet.turn.id, plan);
}
async function toBuild(f) {
  await submitPlan(f, graph([node('research')], 'research'));
  const packet = await take(f);
  completeTurn(f.store, f.job.id, packet.turn.id, pass(packet, verdict));
}
async function toReview(f) {
  await toBuild(f);
  await submitPlan(f, graph([node('implementation', [], { writePaths: ['.'] })], 'implementation'));
  const packet = await take(f);
  writeFileSync(join(packet.turn.cwd, 'pubspec.yaml'), 'name: dynamic_runtime\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(packet.turn.cwd, 'main.dart'), 'void main() {}\n');
  completeTurn(f.store, f.job.id, packet.turn.id, pass(packet));
  assert.equal((await runStep(f.store, f.config, f.job.id)).stage, 'review');
}

async function holder(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } });
  return child;
}

test('maxParallel fences live claims and a real dead parent recovers the same token after reopening the store', async t => {
  const f = fixture(t, { workflow: { maxParallel: 1 } });
  await submitPlan(f, graph([node('left'), node('right'), node('join', ['left', 'right'])], 'join'));
  const owner = await holder(t);
  const first = await take(f, f.store, { ownerPid: owner.pid });
  assert.equal(first.turn.workflow.nodeId, 'left');
  const before = f.store.get(f.job.id);
  assert.equal((await take(f)).action, 'wait');
  const exited = once(owner, 'exit'); owner.kill('SIGTERM'); await exited;
  const recovered = await take(f, f.open());
  assert.equal(recovered.turn.id, first.turn.id);
  assert.equal(f.store.get(f.job.id).hostTurns, before.hostTurns);
  assert.equal(f.store.get(f.job.id).workflow.phases.research.nodes[0].attempts, 1);
  completeTurn(f.store, f.job.id, recovered.turn.id, pass(recovered));
  const right = await take(f);
  assert.equal(right.turn.workflow.nodeId, 'right');
  completeTurn(f.store, f.job.id, right.turn.id, pass(right));
  const final = await take(f);
  assert.equal(final.turn.workflow.nodeId, 'join');
  assert.equal(completeTurn(f.store, f.job.id, final.turn.id, pass(final, verdict)).stage, 'build');
});

test('a running writer blocks overlapping readers while a disjoint writer completes without staling its sibling', async t => {
  const f = fixture(t);
  await toBuild(f);
  await submitPlan(f, graph([
    node('writer', [], { readPaths: ['src'], writePaths: ['src'] }),
    node('reader', [], { readPaths: ['src/value.dart'], writePaths: ['report.dart'] }),
    node('independent', [], { readPaths: ['independent.dart'], writePaths: ['independent.dart'] }),
    node('join', ['writer', 'reader', 'independent']),
  ], 'join'));
  const writer = await take(f);
  const independent = await take(f);
  assert.equal(writer.turn.workflow.nodeId, 'writer');
  assert.equal(independent.turn.workflow.nodeId, 'independent');
  assert.equal((await take(f)).action, 'wait');
  completeTurn(f.store, f.job.id, independent.turn.id, pass(independent));
  completeTurn(f.store, f.job.id, writer.turn.id, pass(writer));
  const reader = await take(f);
  assert.equal(reader.turn.workflow.nodeId, 'reader');
  assert.equal(f.store.get(f.job.id).workflow.phases.build.nodes.find(value => value.definition.id === 'independent').status, 'passed');
});

test('an invalidated review node needs a new distinct receipt while an unaffected passed node keeps its accepted proof', async t => {
  const f = fixture(t, { roles: { research: [], build: [], review: ['qa', 'qa'], receipt: true } });
  await toReview(f);
  const definition = graph([node('qa_a', [], { role: 'qa', fresh: true }), node('qa_b', ['qa_a'], { role: 'qa', fresh: true })], 'qa_b');
  await submitPlan(f, definition);
  const record = rationale => f.store.transition(f.job.id, current => ({ decisions: [...current.decisions, { at: 0, stage: 'review', role: 'qa', rationale }] }));
  const review = { approved: true, findings: [], acceptanceEvidence: f.job.spec.acceptance.map(requirement => ({ requirement, evidence: 'Actual configured check/runtime commands ran against main.dart' })) };
  const a = await take(f); record('First qa context observed its current node');
  completeTurn(f.store, f.job.id, a.turn.id, pass(a, { approved: true, findings: [], acceptanceEvidence: [] }));
  const acceptedA = f.store.get(f.job.id).workflow.phases.review.nodes[0];
  const b = await take(f); record('Second qa context observed the original final');
  requestWorkflowReplan(f.store, f.job.id, 'New fact requires the final review to run again');
  completeTurn(f.store, f.job.id, b.turn.id, pass(b, review));
  await submitPlan(f, { ...definition, invalidate: ['qa_b'] });
  assert.deepEqual(f.store.get(f.job.id).workflow.phases.review.nodes[0], acceptedA);
  const nextB = await take(f);
  assert.notEqual(nextB.turn.id, b.turn.id);
  assert.throws(() => completeTurn(f.store, f.job.id, nextB.turn.id, pass(nextB, review)), /receipts missing/);
  assert.equal(f.store.get(f.job.id).workflow.phases.review.nodes[1].turn.id, nextB.turn.id);
  record('A new distinct qa receipt committed after the replacement claim');
  assert.equal(completeTurn(f.store, f.job.id, nextB.turn.id, pass(nextB, review)).stage, 'package');
});

test('expired workflow tokens are revoked without accepting their results or refunding consumed budgets', async t => {
  const f = fixture(t);
  await submitPlan(f, graph([node('research')], 'research'));
  const active = await take(f);
  const consumed = f.store.get(f.job.id).hostTurns;
  f.store.update(f.job.id, { createdAt: Date.now() - 48 * 3600000 });
  const stopped = completeTurn(f.store, f.job.id, active.turn.id, pass(active, verdict));
  assert.equal(stopped.status, 'needs-owner');
  assert.equal(stopped.hostTurns, consumed);
  assert.equal(stopped.workflow.phases.research.nodes[0].turn, null);
  assert.equal(stopped.workflow.phases.research.nodes[0].attempts, 1);
  assert.equal(stopped.research, undefined);
  assert.throws(() => completeTurn(f.store, f.job.id, active.turn.id, pass(active, verdict)), /Stale/);
});

test('changed verification proof invalidates completed review nodes even when source bytes are identical', async t => {
  const f = fixture(t, { maxAttempts: 1, packaging: { provider: 'local', commands: [[process.execPath, '-e', 'process.exit(23)']], artifactPath: 'build/Review.app' } });
  await toReview(f);
  const plan = graph([node('independent', [], { fresh: true }), node('verdict', ['independent'], { fresh: true })], 'verdict');
  await submitPlan(f, plan);
  const first = await take(f);
  completeTurn(f.store, f.job.id, first.turn.id, pass(first, { approved: true, findings: [], acceptanceEvidence: [] }));
  const final = await take(f);
  const approved = { approved: true, findings: [], acceptanceEvidence: f.job.spec.acceptance.map(requirement => ({ requirement, evidence: 'Configured check/runtime subprocesses read the actual source' })) };
  const accepted = completeTurn(f.store, f.job.id, final.turn.id, pass(final, approved));
  const source = accepted.verifiedDigest;
  const stopped = await runStep(f.store, f.config, f.job.id);
  assert.equal(stopped.status, process.platform === 'darwin' ? 'needs-owner' : 'blocked');
  const configPath = join(f.root, 'factory.json');
  const newCheck = [process.execPath, '-e', 'require("node:fs").accessSync("main.dart");console.log("new proof")'];
  writeFileSync(configPath, JSON.stringify({ ...f.config, maxAttempts: 8, verification: { checks: [newCheck], runtime: [newCheck] } }));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const retry = spawnSync(process.execPath, [cli, 'retry', f.job.id, '--config', configPath], { encoding: 'utf8' });
  assert.equal(retry.status, 0, retry.stderr);
  const resumed = f.store.get(f.job.id);
  assert.equal(resumed.stage, 'verify');
  const verified = await runStep(f.store, resumed.config, f.job.id);
  assert.equal(verified.stage, 'review');
  assert.equal(verified.verifiedDigest, source, 'This counterexample changes proof, not source bytes');
  const planner = await driveQueue(f.store, verified.config, { once: true });
  assert.equal(planner.turn.kind, 'plan');
  const current = f.store.get(f.job.id).workflow.phases.review;
  assert.equal(current.nodes[0].status, 'pending');
  assert.equal(current.nodes[0].result, undefined);
  assert.equal(current.nodes[0].decisionsLengthAtClaim, undefined);
  completeTurn(f.store, f.job.id, planner.turn.id, { ...plan, nodes: [...plan.nodes, node('fresh_final', ['verdict'], { fresh: true })], final: 'fresh_final' });
  const next = await driveQueue(f.store, verified.config, { once: true });
  assert.equal(next.turn.workflow.nodeId, 'independent', 'An appended final must not reuse earlier reviewers against the new runtime proof');
});

test('a cancellation accepted between queue step selection and execution cannot run commands or overwrite terminal state', async t => {
  const marker = join(tmpdir(), `apphx-cancelled-command-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(marker, { force: true }));
  const command = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`];
  const f = fixture(t, { verification: { checks: [command], runtime: [command] } });
  await toBuild(f);
  await submitPlan(f, graph([node('implementation', [], { writePaths: ['.'] })], 'implementation'));
  const implement = await take(f);
  writeFileSync(join(implement.turn.cwd, 'pubspec.yaml'), 'name: cancelled_work\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(implement.turn.cwd, 'main.dart'), 'void main() {}\n');
  completeTurn(f.store, f.job.id, implement.turn.id, pass(implement));
  const driving = take(f); // Selection yields before the deterministic execution claim.
  const cancelled = cancelWorkflow(f.store, f.job.id, 'Owner cancels the selected deterministic step');
  assert.equal(cancelled.status, 'needs-owner');
  await driving;
  assert.equal(existsSync(marker), false);
  const current = f.store.get(f.job.id);
  assert.equal(current.status, 'needs-owner');
  assert.equal(current.workflow.cancelled, true);
  assert.equal(current.verifiedDigest ?? null, null);
  assert.equal(current.attempts.verify ?? 0, 0);
});

test('an ordinary deterministic source failure returns a bounded build repair claim and succeeds after repair', async t => {
  const check = [process.execPath, '--check', 'model.mjs'];
  const runtime = [process.execPath, '--input-type=module', '-e', 'import assert from "node:assert/strict";import {normalize} from "./model.mjs";assert.equal(normalize("  alpha   beta  "),"alpha beta")'];
  const f = fixture(t, { verification: { checks: [check], runtime: [runtime] } });
  await toBuild(f);
  const implementation = graph([node('implementation', [], { writePaths: ['.'] })], 'implementation');
  await submitPlan(f, implementation);
  const initial = await take(f);
  writeFileSync(join(initial.turn.cwd, 'pubspec.yaml'), 'name: repair_work\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(initial.turn.cwd, 'main.dart'), 'void main() {}\n');
  writeFileSync(join(initial.turn.cwd, 'model.mjs'), 'export const normalize = value => value.trim();\n');
  completeTurn(f.store, f.job.id, initial.turn.id, pass(initial));
  const failed = await runStep(f.store, f.config, f.job.id);
  assert.equal(failed.stage, 'build');
  assert.equal(failed.status, 'waiting');
  assert.equal(failed.attempts.verify, 1);
  assert.equal(failed.verifiedDigest, null);
  f.store.update(f.job.id, { nextAt: 0 });
  const planner = await take(f);
  assert.equal(planner.turn.kind, 'plan');
  assert.equal(planner.turn.stage, 'build');
  completeTurn(f.store, f.job.id, planner.turn.id, { ...implementation, invalidate: ['implementation'] });
  const repair = await take(f);
  writeFileSync(join(repair.turn.cwd, 'model.mjs'), 'export const normalize = value => value.trim().replace(/\\s+/g," ");\n');
  completeTurn(f.store, f.job.id, repair.turn.id, pass(repair));
  const verified = await runStep(f.store, f.config, f.job.id);
  assert.equal(verified.stage, 'review');
  assert.equal(verified.attempts.verify, 2, 'Repair must not refund the failed real verification attempt');
  assert.equal(verified.workflow.phases.build.nodes[0].attempts, 2);
  assert.deepEqual(verified.config.verification, f.config.verification, 'Frozen acceptance commands cannot be weakened by repair');
  assert.ok(verified.verifiedDigest);
});

test('a final aggregate cannot discard an explicit specialist review veto', async t => {
  const f = fixture(t);
  await toReview(f);
  await submitPlan(f, graph([node('specialist', [], { fresh: true }), node('aggregate', ['specialist'], { fresh: true })], 'aggregate'));
  const specialist = await take(f);
  assert.throws(() => completeTurn(f.store, f.job.id, specialist.turn.id, pass(specialist)), /approved|Invalid input/);
  assert.equal(f.store.get(f.job.id).workflow.phases.review.nodes[0].turn.id, specialist.turn.id);
  completeTurn(f.store, f.job.id, specialist.turn.id, pass(specialist, { approved: false, findings: ['Controlled blocking review finding'], acceptanceEvidence: [] }));
  const aggregate = await take(f);
  const proposed = { approved: true, findings: [], acceptanceEvidence: f.job.spec.acceptance.map(requirement => ({ requirement, evidence: 'Actual configured check/runtime execution observed source bytes' })) };
  const rejected = completeTurn(f.store, f.job.id, aggregate.turn.id, pass(aggregate, proposed));
  assert.equal(rejected.stage, 'build');
  assert.equal(rejected.review.approved, false);
  assert.deepEqual(rejected.review.findings, ['Controlled blocking review finding']);
  assert.equal(rejected.verifiedDigest, null);
  assert.equal(rejected.artifact, null);
});

test('dynamic configuration rejects impossible seat bounds before allocating a job or claim', t => {
  const f = fixture(t);
  assert.throws(() => f.store.enqueue({ ...f.job.spec, id: 'contradictory-seats' }, { ...f.config, workflow: { maxNodes: 1 }, roles: { research: ['analyst', 'risk'] } }), /maxNodes/);
  for (const seat of ['a'.repeat(201), { name: 'analyst', provider: 'p'.repeat(201) }]) {
    assert.throws(() => f.store.enqueue({ ...f.job.spec, id: 'unrepresentable-role' }, { ...f.config, roles: { research: [seat] } }), /200/);
  }
  assert.deepEqual(f.store.list().map(job => job.id), [f.job.id]);
  assert.equal(f.store.get(f.job.id).hostTurns, 0);
});

test('admission refuses immutable acceptance whose smallest completion exceeds bounded transport', t => {
  const f = fixture(t);
  const spec = { ...f.job.spec, id: 'unrepresentable-review', acceptance: Array.from({ length: 30000 }, (_, index) => `r${String(index).padStart(5, '0')}`) };
  assert.ok(Buffer.byteLength(JSON.stringify(spec)) < 1024 * 1024);
  assert.throws(() => f.store.enqueue(spec, f.config), /completion bytes.*input limit/);
  assert.deepEqual(f.store.list().map(job => job.id), [f.job.id]);
});

test('the absolute job deadline prevents delayed command effects and verification proof commit', async t => {
  const f = fixture(t, { maxJobHours: 1, timeoutMs: 10000, verification: {
    checks: [[process.execPath, '-e', 'require("node:fs").writeFileSync("started", "yes");setTimeout(()=>require("node:fs").writeFileSync("late", "no"),3000)']],
    runtime: [[process.execPath, '-e', 'require("node:fs").writeFileSync("runtime", "no")']],
  } });
  await toBuild(f);
  await submitPlan(f, graph([node('implementation', [], { writePaths: ['.'] })], 'implementation'));
  const implement = await take(f);
  writeFileSync(join(implement.turn.cwd, 'pubspec.yaml'), 'name: deadline_work\ndependencies:\n  flutter: {sdk: flutter}\n');
  completeTurn(f.store, f.job.id, implement.turn.id, pass(implement));
  f.store.update(f.job.id, { createdAt: Date.now() - 3600000 + 1000 });
  const result = await runStep(f.store, f.config, f.job.id);
  assert.equal(result.status, 'needs-owner');
  assert.equal(result.verifiedDigest, null);
  assert.equal(result.artifact, null);
  assert.equal(existsSync(join(implement.turn.cwd, 'late')), false);
  assert.equal(existsSync(join(implement.turn.cwd, 'runtime')), false);
  assert.deepEqual(result.groups, []);
});

test('aborting drive before delivering a host packet does not leave an undispatched live claim', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const pending = take(f, f.store, { signal: controller.signal });
  controller.abort();
  const stopped = await pending;
  assert.equal(stopped.action, 'wait');
  assert.equal(stopped.turn, undefined);
  assert.equal(f.store.get(f.job.id).turn, null);
  const resumed = await take(f);
  assert.equal(resumed.turn.kind, 'plan');
  assert.equal(f.store.get(f.job.id).hostTurns, 2, 'Abandonment must not refund a consumed claim');
});
