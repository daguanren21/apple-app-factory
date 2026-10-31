import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobSchema, WorkflowNodeSchema, WorkflowPhaseSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { completeTurn, nextTurn } from '../dist/runner.js';
import {
  activeWorkflowNodes, applyWorkflowPlan, newWorkflowPhase, readyWorkflowNodes,
  workflowNodeConflict, workflowProgress, workflowTurnBudget, workflowTurnDigest,
} from '../dist/workflow.js';

function fixture(config = {}, overrides = {}) {
  return JobSchema.parse({
    id: 'workflow-fixture',
    spec: {
      id: 'workflow-fixture', name: 'Workflow fixture', purpose: 'Exercise durable work graphs',
      audience: 'Harness maintainers', framework: 'flutter', platform: 'ios',
      differentiators: ['Dynamic work allocation'], acceptance: ['All graph work is joined and evidenced'],
    },
    requestSpec: null,
    config: {
      stateDir: '/owned/state', workspaceRoot: '/owned/workspaces', packageTarget: 'simulator',
      verification: { checks: [['check']], runtime: [['runtime']] }, workflow: {}, ...config,
    },
    workspace: '/owned/workspaces/workflow-fixture', stage: 'build', status: 'queued',
    createdAt: 1, updatedAt: 1, nextAt: 0, attempts: {}, hostTurns: 0, groups: [], receipt: {}, logs: [],
    ...overrides,
  });
}

function node(id, overrides = {}) {
  return WorkflowNodeSchema.parse({
    id, role: 'specialist', instructions: `Complete ${id}`, acceptance: [`Observed ${id}`],
    readPaths: [], ...overrides,
  });
}

function plan(nodes, overrides = {}) {
  return { rationale: 'Allocate joined work from the current facts', nodes, final: nodes.at(-1).id, ...overrides };
}

function fork() {
  return plan([
    node('left', { writePaths: ['src/left'] }),
    node('right', { writePaths: ['src/right'] }),
    node('final', { dependsOn: ['left', 'right'] }),
  ]);
}

function install(job, phase, stage = 'build') {
  job.workflow ??= { cancelled: false, phases: {} };
  job.workflow.phases[stage] = phase;
  return phase;
}

function state(phase, id) {
  return phase.nodes.find(value => value.definition.id === id);
}

function complete(phase, id, status = 'passed', attempts = 1) {
  const current = state(phase, id);
  current.status = status;
  current.attempts = attempts;
  current.turn = null;
  current.completedAt = 100;
  current.result = {
    outcome: status, summary: `Observed ${id} result`,
    evidence: current.definition.acceptance.map(requirement => ({ requirement, evidence: 'Observed execution output' })),
    result: { id, output: ['durable', 'structured'] },
  };
  return current;
}

function claim(current, stage = 'build') {
  current.status = 'running';
  current.turn = {
    id: '00000000-0000-4000-8000-000000000001', stage, kind: 'node', nodeId: current.definition.id,
    planRevision: 1, createdAt: 10, ownerPid: 1, contextDigest: 'a'.repeat(64),
  };
  return current;
}

function rejectsUnchanged(job, stage, input, now = 200) {
  const before = structuredClone(job);
  assert.throws(() => applyWorkflowPlan(job, stage, input, now));
  assert.deepEqual(job, before);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('new phases start planning with no claims, revisions or shared arrays', () => {
  const phase = newWorkflowPhase('Owner requested a new graph');
  assert.deepEqual(phase, {
    status: 'planning', revision: 0, reason: 'Owner requested a new graph', nodes: [], history: [],
  });
  assert.deepEqual(WorkflowPhaseSchema.parse(phase), phase);
  const other = newWorkflowPhase('Another phase');
  phase.nodes.push({});
  assert.deepEqual(other.nodes, []);
  assert.deepEqual(other.history, []);
});

test('the first plan returns normalized persistable state without mutating its inputs', () => {
  const job = fixture();
  install(job, newWorkflowPhase('New implementation facts'));
  const input = plan([{ id: 'only', role: 'chosen-by-model', instructions: 'Do the work', acceptance: ['Observed work'] }]);
  const before = structuredClone(input);
  freeze(job);
  freeze(input);
  const next = applyWorkflowPlan(job, 'build', input, 42);
  assert.equal(next.status, 'running');
  assert.equal(next.revision, 1);
  assert.equal(next.final, 'only');
  assert.equal(next.reason, 'New implementation facts');
  assert.deepEqual(next.nodes[0], {
    definition: { ...input.nodes[0], dependsOn: [], readPaths: ['.'], writePaths: [], fresh: false },
    status: 'pending', attempts: 0, turn: null,
  });
  assert.deepEqual(next.history, [{ revision: 1, at: 42, reason: next.reason, plan: { ...input, nodes: [next.nodes[0].definition], invalidate: [] } }]);
  assert.deepEqual(WorkflowPhaseSchema.parse(next), next);
  assert.deepEqual(input, before);
  assert.equal(job.workflow.phases.build.revision, 0);
});

test('invalid DAGs are rejected without changing persisted graph or budgets', () => {
  const job = fixture();
  install(job, applyWorkflowPlan(job, 'build', fork(), 10));
  const invalid = [
    plan([node('duplicate'), node('duplicate')]),
    plan([node('final', { dependsOn: ['missing'] })]),
    plan([node('final', { dependsOn: ['final'] })]),
    plan([node('left'), node('final', { dependsOn: ['left', 'left'] })]),
    plan([node('left', { dependsOn: ['final'] }), node('final', { dependsOn: ['left'] })]),
    plan([node('orphan'), node('final')]),
    plan([node('cycle-a', { dependsOn: ['cycle-b'] }), node('cycle-b', { dependsOn: ['cycle-a'] }), node('final')]),
    plan([node('only')], { final: 'missing' }),
  ];
  for (const input of invalid) rejectsUnchanged(job, 'build', input);
});

test('strict plan schemas cannot change permissions, config or ownership rules', () => {
  const job = fixture();
  const input = plan([node('final')]);
  for (const extra of [
    { config: { allowLocalExecution: true } }, { allowCloudBuild: true }, { maxParallel: 100 }, { commands: [['publish']] },
  ]) rejectsUnchanged(job, 'build', { ...input, ...extra });
  for (const extra of [{ permissions: ['publish'] }, { allowLocalExecution: true }, { config: {} }]) {
    rejectsUnchanged(job, 'build', plan([{ ...node('final'), ...extra }]));
  }
  for (const acceptance of [[], [''], ['   ']]) {
    rejectsUnchanged(job, 'build', plan([{ ...node('final'), acceptance }]));
  }
});

test('read and write declarations reject traversal, absolute paths and wildcard syntax', () => {
  const job = fixture();
  for (const path of ['../secret', 'src/../secret', '/absolute', 'C:\\secret', 'src\\secret', 'src/*', 'src/**', 'src/?.ts', 'src/[ab]', './src', 'src//file', 'src/']) {
    for (const field of ['readPaths', 'writePaths']) {
      rejectsUnchanged(job, 'build', plan([{ ...node('final'), [field]: [path] }]));
    }
  }
  assert.equal(applyWorkflowPlan(job, 'build', plan([node('final', { readPaths: ['.'], writePaths: ['src/file.ts'] })])).nodes.length, 1);
});

test('configured node and replan limits include the initial revision exactly once', () => {
  const job = fixture({ workflow: { maxNodes: 2, maxReplans: 1 } });
  rejectsUnchanged(job, 'build', fork());
  const input = plan([node('first'), node('final', { dependsOn: ['first'] })]);
  install(job, applyWorkflowPlan(job, 'build', input, 1));
  assert.equal(job.workflow.phases.build.revision, 1);
  install(job, applyWorkflowPlan(job, 'build', input, 2));
  assert.equal(job.workflow.phases.build.revision, 2);
  rejectsUnchanged(job, 'build', input);
  const noReplans = fixture({ workflow: { maxReplans: 0 } });
  install(noReplans, applyWorkflowPlan(noReplans, 'build', input));
  rejectsUnchanged(noReplans, 'build', input);
});

test('turn reservations cover each future planner and distinct configured seat, but not speculative retries', () => {
  const job = fixture({ maxHostTurns: 12, roles: {
    build: ['developer', 'developer', { name: 'designer', provider: 'chosen' }],
    review: [{ name: 'qa', fresh: true }, { name: 'qa', fresh: true }],
  } }, { hostTurns: 4 });
  assert.deepEqual(workflowTurnBudget(job, 'research'), { consumed: 4, remaining: 8, reserved: 7 });
  assert.deepEqual(workflowTurnBudget(job, 'build'), { consumed: 4, remaining: 8, reserved: 3 });
  assert.deepEqual(workflowTurnBudget(job, 'review'), { consumed: 4, remaining: 8, reserved: 0 });
  for (const roles of [undefined, { build: [], review: [] }]) {
    const minimal = fixture({ roles });
    assert.equal(workflowTurnBudget(minimal, 'research').reserved, 4);
    assert.equal(workflowTurnBudget(minimal, 'build').reserved, 2);
  }
  const review = install(job, applyWorkflowPlan(job, 'review', plan([
    node('qa-a', { role: 'qa', fresh: true }),
    node('qa-b', { role: 'qa', fresh: true, dependsOn: ['qa-a'] }),
  ])), 'review');
  for (const current of review.nodes) complete(review, current.definition.id);
  review.status = 'complete';
  assert.equal(workflowTurnBudget(job, 'build').reserved, 3, 'a repair still needs a fresh review checkpoint');
  job.hostTurns = 13;
  assert.deepEqual(workflowTurnBudget(job, 'review'), { consumed: 13, remaining: 0, reserved: 0 });
});

test('six pending nodes cannot fit a six-turn job after its planner claim', () => {
  const input = plan(Array.from({ length: 6 }, (_, index) => node(`node-${index}`, {
    dependsOn: index ? [`node-${index - 1}`] : [], fresh: true,
  })));
  for (const [stage, reserved] of [['research', 4], ['build', 2], ['review', 0]]) {
    const job = fixture({ maxHostTurns: 6 }, { hostTurns: 1 });
    install(job, newWorkflowPhase('Plan within the remaining host budget'), stage);
    job.turn = { ...claim({ definition: node('planner') }, stage).turn, kind: 'plan', planRevision: 0 };
    const before = structuredClone(job);
    assert.throws(() => applyWorkflowPlan(job, stage, input), /host-turn budget.*6 pending.*5 remain/);
    assert.deepEqual(job, before);
    const exact = fixture({ maxHostTurns: 7 + reserved }, { hostTurns: 1 });
    assert.equal(applyWorkflowPlan(exact, stage, input).nodes.length, 6);
    const short = fixture({ maxHostTurns: 6 + reserved }, { hostTurns: 1 });
    rejectsUnchanged(short, stage, input);
  }
});

test('budget admission counts retained proof once and reserves invalidation-dependent work again', () => {
  const job = fixture({ maxHostTurns: 8 });
  const input = fork();
  const phase = install(job, applyWorkflowPlan(job, 'build', input));
  complete(phase, 'left', 'passed', 2);
  complete(phase, 'right');
  phase.status = 'planning';
  job.hostTurns = 5;
  const accepted = applyWorkflowPlan(job, 'build', input);
  assert.deepEqual(accepted.nodes.map(current => current.status), ['passed', 'passed', 'pending']);
  assert.equal(state(accepted, 'left').attempts, 2);
  rejectsUnchanged(job, 'build', { ...input, invalidate: ['left'] });
  complete(phase, 'right', 'failed', 2);
  rejectsUnchanged(job, 'build', input);
});

test('budget rejection rolls back the real planner transaction and keeps its token across reopening', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apphx-workflow-budget-'));
  const sample = fixture({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'work'), maxHostTurns: 6, allowLocalExecution: true });
  let store = new Store(sample.config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue(sample.spec, sample.config);
  const packet = await nextTurn(store, job.id);
  assert.equal(packet.action, 'host');
  assert.equal(packet.turn.kind, 'plan');
  const input = plan(Array.from({ length: 6 }, (_, index) => node(`node-${index}`, {
    dependsOn: index ? [`node-${index - 1}`] : [],
  })));
  const before = store.get(job.id);
  assert.equal(before.hostTurns, 1);
  assert.throws(() => completeTurn(store, job.id, packet.turn.id, input), /host-turn budget/);
  assert.deepEqual(store.get(job.id), before);
  store.close();
  store = new Store(sample.config.stateDir);
  assert.deepEqual(store.get(job.id), before);
  const resumed = await nextTurn(store, job.id);
  assert.equal(resumed.turn.id, packet.turn.id);
  assert.equal(resumed.job.hostTurns, before.hostTurns);
  const accepted = completeTurn(store, job.id, resumed.turn.id, plan([node('only')]));
  assert.equal(accepted.turn, null);
  assert.equal(accepted.hostTurns, 1);
  assert.equal(accepted.workflow.phases.research.revision, 1);
  assert.deepEqual(accepted.workflow.phases.research.nodes.map(current => current.definition.id), ['only']);
});

test('dynamic opt-in and cancellation remain owner controlled', () => {
  const input = plan([node('final')]);
  rejectsUnchanged(fixture({ workflow: undefined }), 'build', input);
  rejectsUnchanged(fixture({}, { workflow: { cancelled: true, phases: {} } }), 'build', input);
});

test('research and every review node are read-only, and every review node is fresh', () => {
  for (const stage of ['research', 'review']) {
    const job = fixture();
    rejectsUnchanged(job, stage, plan([
      node('worker', { fresh: true, writePaths: ['src/app'] }),
      node('final', { fresh: true, dependsOn: ['worker'] }),
    ]));
    const accepted = applyWorkflowPlan(job, stage, plan([
      node('worker', { fresh: true }), node('final', { fresh: true, dependsOn: ['worker'] }),
    ]));
    assert.equal(accepted.nodes.length, 2);
  }
  rejectsUnchanged(fixture(), 'review', plan([
    node('worker'), node('final', { fresh: true, dependsOn: ['worker'] }),
  ]));
  rejectsUnchanged(fixture(), 'review', plan([node('final')]));
  assert.equal(applyWorkflowPlan(fixture(), 'research', plan([node('final')])).nodes[0].definition.fresh, false);
});

test('without owner-configured roles each stage keeps the model-selected roles', () => {
  for (const stage of ['research', 'build', 'review']) {
    const accepted = applyWorkflowPlan(fixture(), stage, plan([node('final', { role: 'domain-specific-seat', fresh: true })]));
    assert.deepEqual(accepted.nodes.map(current => current.definition.role), ['domain-specific-seat']);
  }
});

test('owner role seats form a minimum multiset, not a set or exact graph template', () => {
  const job = fixture({ roles: { build: ['developer', 'developer'] } });
  rejectsUnchanged(job, 'build', plan([node('final', { role: 'developer' })]));
  const accepted = applyWorkflowPlan(job, 'build', plan([
    node('first', { role: 'developer' }), node('second', { role: 'developer' }),
    node('extra', { role: 'specialist', dependsOn: ['first', 'second'] }),
  ]));
  assert.equal(accepted.nodes.length, 3);
});

test('seat matching handles overlapping freshness/provider pins without greedy false rejection', () => {
  const job = fixture({ roles: { build: [
    { name: 'developer', fresh: true }, { name: 'developer', provider: 'provider-a' },
  ] } });
  const accepted = applyWorkflowPlan(job, 'build', plan([
    node('first', { role: 'developer', provider: 'provider-a', fresh: true }),
    node('second', { role: 'developer', provider: 'provider-b', fresh: true, dependsOn: ['first'] }),
  ]));
  assert.equal(accepted.nodes.length, 2);
  rejectsUnchanged(job, 'build', plan([
    node('first', { role: 'developer', provider: 'provider-b', fresh: true }),
    node('second', { role: 'developer', provider: 'provider-b', fresh: true, dependsOn: ['first'] }),
  ]));
  rejectsUnchanged(job, 'build', plan([
    node('first', { role: 'developer', provider: 'provider-a' }),
    node('second', { role: 'developer', provider: 'provider-b', dependsOn: ['first'] }),
  ]));
});

test('one node cannot satisfy multiple identical provider-pinned review seats', () => {
  const job = fixture({ roles: { review: [
    { name: 'auditor', provider: 'independent', fresh: true },
    { name: 'auditor', provider: 'independent', fresh: true },
  ] } });
  rejectsUnchanged(job, 'review', plan([node('final', { role: 'auditor', provider: 'independent', fresh: true })]));
  const accepted = applyWorkflowPlan(job, 'review', plan([
    node('first', { role: 'auditor', provider: 'independent', fresh: true }),
    node('final', { role: 'auditor', provider: 'independent', fresh: true, dependsOn: ['first'] }),
  ]));
  assert.equal(accepted.nodes.length, 2);
});

test('replanning preserves independent passed definitions, results, attempts and completion evidence', () => {
  const job = fixture();
  const input = fork();
  const phase = install(job, applyWorkflowPlan(job, 'build', input, 1));
  const passed = complete(phase, 'left', 'passed', 2);
  complete(phase, 'right', 'failed', 3);
  state(phase, 'final').attempts = 1;
  phase.status = 'planning';
  phase.reason = 'Repair the failed right branch';
  phase.decisionsLengthAtClaim = 7;
  phase.proofDigest = 'a'.repeat(64);
  const before = structuredClone(job);
  const next = applyWorkflowPlan(job, 'build', input, 2);
  assert.deepEqual(state(next, 'left'), passed);
  assert.deepEqual(state(next, 'right'), { definition: input.nodes[1], status: 'pending', attempts: 3, turn: null });
  assert.equal(state(next, 'final').attempts, 1);
  assert.equal(next.decisionsLengthAtClaim, 7);
  assert.equal(next.proofDigest, phase.proofDigest);
  assert.equal(next.revision, 2);
  assert.equal(next.history.length, 2);
  assert.deepEqual(next.history[0], phase.history[0]);
  assert.equal(next.history[1].reason, phase.reason);
  assert.deepEqual(job, before);
});

test('passed definitions cannot be changed or removed without naming their invalidation', () => {
  const job = fixture();
  const input = fork();
  const phase = install(job, applyWorkflowPlan(job, 'build', input));
  complete(phase, 'left', 'passed', 2);
  const changed = structuredClone(input);
  changed.nodes[0].instructions = 'Use newly discovered facts';
  rejectsUnchanged(job, 'build', changed);
  const removed = plan([input.nodes[1], node('final', { dependsOn: ['right'] })]);
  rejectsUnchanged(job, 'build', removed);
  assert.equal(applyWorkflowPlan(job, 'build', { ...changed, invalidate: ['left'] }).nodes[0].attempts, 2);
  assert.deepEqual(applyWorkflowPlan(job, 'build', { ...removed, invalidate: ['left'] }).nodes.map(current => current.definition.id), ['right', 'final']);
});

test('explicit invalidation cascades through the old dependent closure and retains unrelated successes', () => {
  const job = fixture();
  const input = plan([
    node('left'), node('middle', { dependsOn: ['left'] }), node('right'),
    node('final', { dependsOn: ['middle', 'right'] }),
  ]);
  const phase = install(job, applyWorkflowPlan(job, 'build', input));
  for (const [index, current] of phase.nodes.entries()) complete(phase, current.definition.id, 'passed', index + 1);
  phase.status = 'complete';
  const next = applyWorkflowPlan(job, 'build', { ...input, invalidate: ['left'] });
  for (const id of ['left', 'middle', 'final']) {
    assert.equal(state(next, id).status, 'pending');
    assert.equal(state(next, id).attempts, state(phase, id).attempts);
    assert.equal(state(next, id).turn, null);
    assert.equal(Object.hasOwn(state(next, id), 'result'), false);
    assert.equal(Object.hasOwn(state(next, id), 'completedAt'), false);
  }
  assert.deepEqual(state(next, 'right'), state(phase, 'right'));
  assert.equal(next.status, 'running');
});

test('changing a failed definition also invalidates its prior dependents and records both normalized plans', () => {
  const job = fixture();
  const input = plan([
    node('first'), node('dependent', { dependsOn: ['first'] }), node('independent'),
    node('final', { dependsOn: ['dependent', 'independent'] }),
  ]);
  const phase = install(job, applyWorkflowPlan(job, 'build', input, 100));
  complete(phase, 'first', 'failed', 3);
  // Prior downstream proof cannot survive a repaired prerequisite definition.
  for (const id of ['dependent', 'independent', 'final']) complete(phase, id, 'passed', 2);
  const changed = structuredClone(input);
  changed.nodes[0].instructions = 'Repair the failed prerequisite from new facts';
  const next = applyWorkflowPlan(job, 'build', changed, 200);
  assert.deepEqual(next.nodes.map(current => current.status), ['pending', 'pending', 'passed', 'pending']);
  assert.equal(state(next, 'first').attempts, 3);
  assert.deepEqual(state(next, 'independent'), state(phase, 'independent'));
  for (const id of ['first', 'dependent', 'final']) {
    assert.equal(Object.hasOwn(state(next, id), 'result'), false);
    assert.equal(Object.hasOwn(state(next, id), 'completedAt'), false);
  }
  assert.equal(next.history[0].at, 100);
  assert.equal(next.history[0].plan.nodes[0].instructions, input.nodes[0].instructions);
  assert.equal(next.history[1].at, 200);
  assert.equal(next.history[1].plan.nodes[0].instructions, changed.nodes[0].instructions);
  assert.deepEqual(next.history[0].plan.invalidate, []);
  assert.deepEqual(next.history[1].plan.invalidate, []);
});

test('cascaded invalidation does not authorize changing another passed definition', () => {
  const job = fixture();
  const input = plan([node('first'), node('final', { dependsOn: ['first'] })]);
  const phase = install(job, applyWorkflowPlan(job, 'build', input));
  complete(phase, 'first');
  complete(phase, 'final');
  const changed = structuredClone(input);
  changed.nodes[1].acceptance.push('New observed obligation');
  rejectsUnchanged(job, 'build', { ...changed, invalidate: ['first'] });
  assert.deepEqual(applyWorkflowPlan(job, 'build', { ...changed, invalidate: ['first', 'final'] }).nodes.map(current => current.status), ['pending', 'pending']);
});

test('failed and pending nodes may be replaced or removed while accepted successes remain joined', () => {
  const job = fixture();
  const input = fork();
  const phase = install(job, applyWorkflowPlan(job, 'build', input));
  complete(phase, 'left', 'passed', 2);
  complete(phase, 'right', 'failed', 3);
  const replacement = plan([
    input.nodes[0], node('replacement', { dependsOn: ['left'] }),
    node('final', { dependsOn: ['replacement'] }),
  ]);
  const next = applyWorkflowPlan(job, 'build', replacement);
  assert.deepEqual(next.nodes.map(current => current.definition.id), ['left', 'replacement', 'final']);
  assert.deepEqual(state(next, 'left'), state(phase, 'left'));
  assert.equal(state(next, 'replacement').attempts, 0);
});

test('x to y to x cannot resurrect retired IDs or reset their attempt budgets', () => {
  for (const status of ['pending', 'failed', 'passed']) {
    const job = fixture({ maxAttempts: 3 });
    const first = plan([node('x')]);
    const phase = install(job, applyWorkflowPlan(job, 'build', first, 1));
    if (status !== 'pending') complete(phase, 'x', status, 3);
    phase.status = 'planning';
    install(job, applyWorkflowPlan(job, 'build', plan([node('y')], { invalidate: status === 'passed' ? ['x'] : [] }), 2));
    const restored = JobSchema.parse(JSON.parse(JSON.stringify(job)));
    const before = structuredClone(restored);
    for (const input of [first, plan([node('x', { instructions: 'Try a different definition with the retired ID' })])]) {
      assert.throws(() => applyWorkflowPlan(restored, 'build', input, 3), /Retired workflow node x.*attempt history/);
      assert.deepEqual(restored, before);
    }
    assert.deepEqual(restored.workflow.phases.build.history.map(revision => revision.plan.nodes[0].id), ['x', 'y']);
    install(restored, applyWorkflowPlan(restored, 'build', plan([node('z')]), 3));
    rejectsUnchanged(restored, 'build', first, 4);
    assert.equal(applyWorkflowPlan(restored, 'research', first).nodes[0].attempts, 0, 'identifiers are phase-local');
  }
});

test('an already-passed final cannot complete a replan by replay, even when selected from another old node', () => {
  const job = fixture();
  const input = plan([node('first'), node('final', { dependsOn: ['first'] })]);
  const phase = install(job, applyWorkflowPlan(job, 'build', input));
  complete(phase, 'first');
  complete(phase, 'final', 'passed', 4);
  phase.status = 'complete';
  rejectsUnchanged(job, 'build', input);
  rejectsUnchanged(job, 'build', plan([input.nodes[0]], { invalidate: ['final'] }));
  const rerunFinal = applyWorkflowPlan(job, 'build', { ...input, invalidate: ['final'] });
  assert.deepEqual(rerunFinal.nodes.map(current => current.status), ['passed', 'pending']);
  assert.equal(state(rerunFinal, 'final').attempts, 4);
  const extended = applyWorkflowPlan(job, 'build', plan([...input.nodes, node('new-final', { dependsOn: ['final'] })]));
  assert.deepEqual(extended.nodes.map(current => current.status), ['passed', 'passed', 'pending']);
});

test('invalidations name distinct prior nodes and rejected metadata cannot alter phase history', () => {
  const job = fixture();
  const input = fork();
  install(job, applyWorkflowPlan(job, 'build', input));
  rejectsUnchanged(job, 'build', { ...input, invalidate: ['missing'] });
  rejectsUnchanged(job, 'build', { ...input, invalidate: ['left', 'left'] });
  rejectsUnchanged(job, 'build', input, NaN);
  rejectsUnchanged(job, 'build', input, Infinity);
  const next = applyWorkflowPlan(job, 'build', input, 300);
  input.nodes[0].instructions = 'Mutated caller-owned input';
  assert.notEqual(next.history[1].plan.nodes[0].instructions, input.nodes[0].instructions);
});

test('active claims across all phases fence replans, but the planner claim itself does not', () => {
  const job = fixture();
  const input = plan([node('final')]);
  install(job, applyWorkflowPlan(job, 'build', input));
  const research = install(job, applyWorkflowPlan(job, 'research', input), 'research');
  claim(state(research, 'final'), 'research');
  rejectsUnchanged(job, 'build', input);
  // Even an inconsistent node status cannot conceal a live token from guards.
  state(research, 'final').status = 'passed';
  rejectsUnchanged(job, 'build', input);
  state(research, 'final').turn = null;
  job.turn = { ...claim({ definition: node('planner') }).turn, kind: 'plan', stage: 'build' };
  assert.equal(applyWorkflowPlan(job, 'build', input).revision, 2);
});

test('conflict detection is symmetric, segment-safe, and never conflicts two readers', () => {
  const cases = [
    [{ writePaths: ['src/app'] }, { writePaths: ['src/app'] }, true],
    [{ writePaths: ['src'] }, { writePaths: ['src/app/file.ts'] }, true],
    [{ writePaths: ['src/app/file.ts'] }, { readPaths: ['src/app'] }, true],
    [{ writePaths: ['src/app'] }, { readPaths: ['src/app/file.ts'] }, true],
    [{ writePaths: ['.'] }, { readPaths: ['other'] }, true],
    [{ writePaths: ['other'] }, { readPaths: ['.'] }, true],
    [{ writePaths: ['src/app'] }, { writePaths: ['src/application'] }, false],
    [{ writePaths: ['src/app'] }, { readPaths: ['src/app.ts'] }, false],
    [{ writePaths: ['src/a'] }, { writePaths: ['src/b'] }, false],
    [{ readPaths: ['.'] }, { readPaths: ['.'] }, false],
    [{ writePaths: ['.'] }, {}, false],
  ];
  for (const [left, right, expected] of cases) {
    const a = node('left', left);
    const b = node('right', right);
    assert.equal(workflowNodeConflict(a, b), expected);
    assert.equal(workflowNodeConflict(b, a), expected);
  }
});

test('ready nodes respect dependency completion, active read/write ownership and plan order', () => {
  const job = fixture();
  const input = plan([
    node('writer', { writePaths: ['src/app'] }),
    node('conflicting-reader', { readPaths: ['src/app/config'] }),
    node('prefix-sibling', { writePaths: ['src/application'] }),
    node('disjoint', { writePaths: ['test'] }),
    node('dependent', { dependsOn: ['writer'] }),
    node('final', { dependsOn: ['conflicting-reader', 'prefix-sibling', 'disjoint', 'dependent'] }),
  ]);
  const phase = applyWorkflowPlan(job, 'build', input);
  assert.deepEqual(readyWorkflowNodes(phase).map(current => current.definition.id), ['writer', 'conflicting-reader', 'prefix-sibling', 'disjoint']);
  claim(state(phase, 'writer'));
  assert.deepEqual(readyWorkflowNodes(phase).map(current => current.definition.id), ['prefix-sibling', 'disjoint']);
  complete(phase, 'writer');
  assert.deepEqual(readyWorkflowNodes(phase).map(current => current.definition.id), ['conflicting-reader', 'prefix-sibling', 'disjoint', 'dependent']);
  phase.status = 'planning';
  assert.deepEqual(readyWorkflowNodes(phase), []);
  phase.status = 'complete';
  assert.deepEqual(readyWorkflowNodes(phase), []);
});

test('running readers block writers but not independent readers, and failed dependencies block readiness', () => {
  const phase = applyWorkflowPlan(fixture(), 'build', plan([
    node('reader', { readPaths: ['src'] }), node('other-reader', { readPaths: ['src/app'] }),
    node('writer', { writePaths: ['src/app'] }), node('dependent', { dependsOn: ['reader'] }),
    node('final', { dependsOn: ['other-reader', 'writer', 'dependent'] }),
  ]));
  claim(state(phase, 'reader'));
  assert.deepEqual(readyWorkflowNodes(phase).map(current => current.definition.id), ['other-reader']);
  complete(phase, 'reader', 'failed');
  assert.deepEqual(readyWorkflowNodes(phase).map(current => current.definition.id), ['other-reader', 'writer']);
});

test('a disjoint sibling can complete without making another live node digest stale', () => {
  const job = fixture();
  const phase = install(job, applyWorkflowPlan(job, 'build', fork()));
  const left = claim(state(phase, 'left'));
  claim(state(phase, 'right'));
  const before = workflowTurnDigest(job, 'build', phase, left);
  assert.match(before, /^[a-f0-9]{64}$/);
  complete(phase, 'right');
  job.logs.push('A sibling emitted a log');
  job.decisions.push({ at: 200, stage: 'build', role: 'specialist', rationale: 'Recorded sibling evidence' });
  job.feedback = 'New observation for the planner';
  job.updatedAt++;
  job.hostTurns++;
  job.status = 'waiting';
  left.attempts++;
  left.turn.ownerPid = 2;
  left.turn.createdAt++;
  phase.reason = 'Pause new dispatch while existing claims drain';
  phase.status = 'planning';
  assert.equal(workflowTurnDigest(job, 'build', phase, left), before);
});

test('node digests bind immutable inputs, node definitions and direct dependency results', () => {
  const job = fixture();
  const phase = install(job, applyWorkflowPlan(job, 'build', plan([
    node('first'), node('final', { dependsOn: ['first'] }),
  ])));
  complete(phase, 'first');
  const before = workflowTurnDigest(job, 'build', phase, state(phase, 'final'));
  for (const change of [
    value => { value.spec.purpose = 'Different scope'; },
    value => { value.requestSpec = structuredClone(value.spec); },
    value => { value.config.maxAttempts++; },
    value => { value.workspace += '-other'; },
    value => { value.workflow.phases.build.revision++; },
    value => { state(value.workflow.phases.build, 'final').definition.instructions = 'Different work'; },
    value => { state(value.workflow.phases.build, 'first').result.result.output.push('new dependency output'); },
  ]) {
    const changed = structuredClone(job);
    change(changed);
    const changedPhase = changed.workflow.phases.build;
    assert.notEqual(workflowTurnDigest(changed, 'build', changedPhase, state(changedPhase, 'final')), before);
  }
  assert.notEqual(workflowTurnDigest(job, 'research', phase, state(phase, 'final')), before);
});

test('review planner and node digests fence every current proof input without staling build or research work', () => {
  const job = fixture();
  const phase = install(job, applyWorkflowPlan(job, 'review', plan([node('final', { fresh: true })])), 'review');
  phase.proofDigest = 'a'.repeat(64);
  job.verifiedDigest = 'a'.repeat(64);
  job.verifiedDependencyDigest = 'b'.repeat(64);
  job.screenshotDigest = 'c'.repeat(64);
  job.verifiedAt = '2026-10-31T00:00:00.000Z';
  for (const asNode of [false, true]) {
    const digests = Object.fromEntries(['research', 'build', 'review'].map(stage => [
      stage, workflowTurnDigest(job, stage, phase, asNode ? phase.nodes[0] : undefined),
    ]));
    for (const change of [
      value => { value.verifiedDigest = 'd'.repeat(64); },
      value => { value.verifiedDependencyDigest = 'd'.repeat(64); },
      value => { value.screenshotDigest = 'd'.repeat(64); },
      value => { value.verifiedAt = '2026-10-31T01:00:00.000Z'; },
      value => { value.workflow.phases.review.proofDigest = 'd'.repeat(64); },
    ]) {
      const changed = structuredClone(job);
      change(changed);
      const changedPhase = changed.workflow.phases.review;
      for (const stage of ['research', 'build', 'review']) {
        const digest = workflowTurnDigest(changed, stage, changedPhase, asNode ? changedPhase.nodes[0] : undefined);
        if (stage === 'review') assert.notEqual(digest, digests[stage]);
        else assert.equal(digest, digests[stage]);
      }
    }
  }
});

test('planner digests observe graph facts but ignore tokens, owner identity, attempts and timestamps', () => {
  const job = fixture();
  const phase = install(job, applyWorkflowPlan(job, 'build', fork()));
  const before = workflowTurnDigest(job, 'build', phase);
  const bookkeeping = structuredClone(job);
  const bookkeepingPhase = bookkeeping.workflow.phases.build;
  claim(state(bookkeepingPhase, 'left'));
  state(bookkeepingPhase, 'left').status = 'pending';
  state(bookkeepingPhase, 'left').attempts = 8;
  state(bookkeepingPhase, 'left').completedAt = 300;
  bookkeepingPhase.history[0].at++;
  bookkeeping.logs.push('Bookkeeping only');
  assert.equal(workflowTurnDigest(bookkeeping, 'build', bookkeepingPhase), before);
  for (const change of [
    value => { value.reason = 'New planning facts'; },
    value => { value.revision++; },
    value => { value.final = 'left'; },
    value => { state(value, 'left').status = 'failed'; },
    value => { state(value, 'left').definition.instructions = 'Changed task'; },
    value => { complete(value, 'left'); },
  ]) {
    const changed = structuredClone(phase);
    change(changed);
    assert.notEqual(workflowTurnDigest(job, 'build', changed), before);
  }
});

test('active node discovery includes every nonnull node turn in stable phase order, never job.turn', () => {
  const job = fixture();
  assert.deepEqual(activeWorkflowNodes(job), []);
  for (const stage of ['review', 'build', 'research']) {
    const phase = install(job, applyWorkflowPlan(job, stage, plan([node('final', { fresh: true })])), stage);
    // Assign after all plans: applying any plan while a node is active must be rejected.
    assert.equal(phase.nodes[0].turn, null);
  }
  for (const stage of ['review', 'build', 'research']) claim(job.workflow.phases[stage].nodes[0], stage);
  job.workflow.phases.review.nodes[0].status = 'failed';
  job.turn = { ...job.workflow.phases.build.nodes[0].turn, kind: 'plan' };
  const found = activeWorkflowNodes(job);
  assert.deepEqual(found.map(current => current.stage), ['research', 'build', 'review']);
  assert.equal(found.length, 3);
  assert.equal(found[2].node, job.workflow.phases.review.nodes[0]);
});

test('progress is a small phase-count audit summary without claim tokens or result payloads', () => {
  const job = fixture();
  assert.equal(workflowProgress(job), undefined);
  const phase = install(job, applyWorkflowPlan(job, 'build', plan([
    node('passed'), node('failed'), node('running'),
    node('final', { dependsOn: ['passed', 'failed', 'running'] }),
  ])));
  complete(phase, 'passed');
  complete(phase, 'failed', 'failed');
  claim(state(phase, 'running'));
  install(job, newWorkflowPhase('Start independent research'), 'research');
  assert.deepEqual(workflowProgress(job), {
    cancelled: false,
    phases: {
      research: {
        status: 'planning', revision: 0, reason: 'Start independent research', final: undefined,
        total: 0, counts: { pending: 0, running: 0, passed: 0, failed: 0 },
      },
      build: {
        status: 'running', revision: 1, reason: phase.reason, final: 'final', total: 4,
        counts: { pending: 1, running: 1, passed: 1, failed: 1 },
      },
    },
  });
});
