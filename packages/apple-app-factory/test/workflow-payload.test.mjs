import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { nextTurn, completeTurn, driveQueue, hostActionTransport, requestWorkflowReplan } from '../dist/runner.js';
import { runStep } from '../dist/scheduler.js';
import { MAX_HOST_PACKET_BYTES, MAX_INPUT_BYTES } from '../dist/input-limits.js';

const plan = (id, acceptance = ['Fixture inspected']) => ({ rationale: 'One bounded node before the policy checkpoint', nodes: [{ id, role: id, instructions: 'Inspect the controlled fixture', acceptance, fresh: true }], final: id });
const passed = (acceptance, result) => ({ outcome: 'passed', summary: 'Controlled contract fixture', evidence: acceptance.map(requirement => ({ requirement, evidence: 'x' })), ...(result === undefined ? {} : { result }) });

test('final review plan admission counts combined node and immutable product evidence before consuming its token', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apphx-combined-payload-'));
  const check = [process.execPath, '-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("main.dart","utf8"),"void main() {}")'];
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'work'), packageTarget: 'simulator', allowLocalExecution: true,
    workflow: { maxReplans: 0 }, maxHostTurns: 6, verification: { checks: [check], runtime: [check] } });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const productAcceptance = 'r'.repeat(1000000);
  const spec = { id: 'payload-boundary', name: 'Payload boundary', purpose: 'Check bounded result representability', audience: 'Harness maintainers', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Bounded exact evidence'], acceptance: [productAcceptance] };
  assert.ok(Buffer.byteLength(JSON.stringify(spec)) < MAX_INPUT_BYTES);
  const job = store.enqueue(spec, config);
  let packet = await nextTurn(store, job.id);
  completeTurn(store, job.id, packet.turn.id, plan('research'));
  packet = await nextTurn(store, job.id);
  completeTurn(store, job.id, packet.turn.id, passed(['Fixture inspected'], { viable: true, distinctness: 'A representability boundary, not product acceptance evidence', plan: ['Exercise exact source verification before the review payload boundary'] }));
  packet = await nextTurn(store, job.id);
  completeTurn(store, job.id, packet.turn.id, plan('build'));
  packet = await nextTurn(store, job.id);
  writeFileSync(join(packet.turn.cwd, 'pubspec.yaml'), 'name: payload_boundary\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(packet.turn.cwd, 'main.dart'), 'void main() {}');
  completeTurn(store, job.id, packet.turn.id, passed(['Fixture inspected']));
  assert.equal((await runStep(store, config, job.id)).stage, 'review');
  const planner = await nextTurn(store, job.id);
  const before = store.get(job.id);
  const criteria = Array.from({ length: 25 }, (_, index) => String(index).padStart(2, '0') + 'c'.repeat(1998));
  const review = { approved: true, findings: [], acceptanceEvidence: [{ requirement: productAcceptance, evidence: 'x' }] };
  assert.ok(Buffer.byteLength(JSON.stringify(plan('review', criteria))) < MAX_INPUT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(passed(criteria, review))) > MAX_INPUT_BYTES);
  assert.throws(() => completeTurn(store, job.id, planner.turn.id, plan('review', criteria)), /completion.*(limit|bytes)/i);
  assert.deepEqual(store.get(job.id), before, 'Impossible plan must retain the planner token and every consumed budget');
  const compactCriteria = ['Fixture inspected'];
  assert.ok(Buffer.byteLength(JSON.stringify(passed(compactCriteria, review))) <= MAX_INPUT_BYTES);
  completeTurn(store, job.id, planner.turn.id, plan('review', compactCriteria));
  const final = await nextTurn(store, job.id);
  const completed = completeTurn(store, job.id, final.turn.id, passed(compactCriteria, review));
  assert.equal(completed.stage, 'package');
  assert.equal(completed.hostTurns, 6);
  assert.equal(completed.artifact ?? null, null);
});

test('multi-node fan-in is rejected before claiming or consuming the aggregate node budget', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apphx-fan-in-payload-'));
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'work'), packageTarget: 'simulator', allowLocalExecution: true,
    workflow: {}, maxHostTurns: 16, verification: { checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] } });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue({ id: 'fan-in-boundary', name: 'Fan-in boundary', purpose: 'Bound aggregate dependency transport', audience: 'Harness maintainers', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Transactional payload admission'], acceptance: ['Keep claims bounded'] }, config);
  const definition = id => ({ id, role: id, instructions: `Inspect ${id}`, acceptance: [`${id} observed`], fresh: true });
  let packet = await nextTurn(store, job.id);
  completeTurn(store, job.id, packet.turn.id, {
    rationale: 'Three valid predecessor results feed one aggregate',
    nodes: [definition('left'), definition('middle'), definition('right'), { ...definition('aggregate'), dependsOn: ['left', 'middle', 'right'] }],
    final: 'aggregate',
  });
  for (const id of ['left', 'middle', 'right']) {
    packet = await nextTurn(store, job.id);
    assert.equal(packet.turn.workflow.nodeId, id);
    completeTurn(store, job.id, packet.turn.id, passed([`${id} observed`], { blob: id.repeat(120000) }));
  }
  const before = store.get(job.id);
  await assert.rejects(nextTurn(store, job.id), /dependency results.*aggregate limit/i);
  const after = store.get(job.id);
  assert.deepEqual(after, before);
  assert.equal(after.workflow.phases.research.nodes.find(node => node.definition.id === 'aggregate').attempts, 0);
  assert.equal(after.workflow.phases.research.nodes.find(node => node.definition.id === 'aggregate').turn, null);
  const driven = await driveQueue(store, config, { once: true });
  assert.equal(driven.action, 'wait');
  assert.equal(driven.pendingErrors?.length, 1);
  assert.match(driven.pendingErrors[0].error, /dependency results.*aggregate limit/i);
  assert.deepEqual(store.get(job.id), before, 'Queue-wide drive reports overflow without consuming a claim budget');
  requestWorkflowReplan(store, job.id, 'Split the oversized fan-in through compact aggregation nodes');
  const planner = await nextTurn(store, job.id);
  const claimed = store.get(job.id);
  assert.match(planner.turn.prompt, /bounded outcome references/);
  assert.equal(planner.turn.prompt.includes('left'.repeat(120000)), false, 'Replanning references persisted results instead of replaying them');
  assert.ok(Buffer.byteLength(JSON.stringify(hostActionTransport(planner), null, 2)) <= MAX_HOST_PACKET_BYTES);
  const resumed = await nextTurn(store, job.id);
  assert.equal(resumed.turn.id, planner.turn.id);
  assert.equal(store.get(job.id).hostTurns, claimed.hostTurns, 'Resuming a bounded planner packet does not consume another turn');
});

test('normal dependency output appears once in a bounded emitted host packet', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apphx-bounded-payload-'));
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'work'), packageTarget: 'simulator', allowLocalExecution: true,
    workflow: {}, maxHostTurns: 12, verification: { checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] } });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue({ id: 'bounded-packet', name: 'Bounded packet', purpose: 'Avoid duplicate dependency serialization', audience: 'Harness maintainers', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Single dependency representation'], acceptance: ['Keep packets bounded'] }, config);
  const marker = 'DEPENDENCY_RESULT_MARKER';
  let packet = await nextTurn(store, job.id);
  completeTurn(store, job.id, packet.turn.id, { rationale: 'One result feeds the final decision', nodes: [
    { id: 'source', role: 'source', instructions: 'Inspect source', acceptance: ['source observed'], fresh: true },
    { id: 'decision', role: 'decision', instructions: 'Decide', dependsOn: ['source'], acceptance: ['decision observed'], fresh: true },
  ], final: 'decision' });
  packet = await nextTurn(store, job.id);
  completeTurn(store, job.id, packet.turn.id, passed(['source observed'], { marker }));
  packet = await nextTurn(store, job.id);
  const transport = hostActionTransport(packet);
  assert.equal(packet.turn.workflow.dependencies[0].result.result.marker, marker);
  assert.equal(packet.turn.prompt.includes(marker), false);
  assert.equal((JSON.stringify(transport).match(new RegExp(marker, 'g')) ?? []).length, 1);
  assert.equal((JSON.stringify(packet).match(new RegExp(marker, 'g')) ?? []).length, 1, 'Default host-action serialization uses the bounded transport view');
  assert.equal('workflow' in transport.job, false, 'The emitted job field is the bounded summary, not persisted workflow state');
});
