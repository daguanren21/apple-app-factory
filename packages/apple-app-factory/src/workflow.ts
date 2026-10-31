import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { HostStageSchema, WorkflowPlanSchema } from './schemas.js';
import type { HostStage, Job, RoleSeat, WorkflowNode, WorkflowNodeState, WorkflowPhase } from './schemas.js';
import { verificationProofDigest } from './proof.js';
import { MAX_INPUT_BYTES, minimumNodeResultBytes, minimumReviewBytes } from './input-limits.js';

const stages = HostStageSchema.options;

export function newWorkflowPhase(reason: string): WorkflowPhase {
  return { status: 'planning', revision: 0, reason, nodes: [], history: [] };
}

function validateGraph(nodes: WorkflowNode[], final: string): Map<string, WorkflowNode> {
  const definitions = new Map<string, WorkflowNode>();
  for (const node of nodes) {
    if (definitions.has(node.id)) throw new Error(`Duplicate workflow node: ${node.id}`);
    definitions.set(node.id, node);
  }
  if (!definitions.has(final)) throw new Error(`Workflow final node does not exist: ${final}`);
  for (const node of nodes) {
    const dependencies = new Set<string>();
    for (const id of node.dependsOn) {
      if (dependencies.has(id)) throw new Error(`Duplicate dependency ${id} on workflow node ${node.id}`);
      if (id === node.id) throw new Error(`Workflow node ${node.id} cannot depend on itself`);
      if (!definitions.has(id)) throw new Error(`Unknown dependency ${id} on workflow node ${node.id}`);
      dependencies.add(id);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`Workflow dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of definitions.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  visit(final);
  if (visited.size !== nodes.length) {
    // Check unjoined nodes too, so cycles cannot hide outside the terminal's ancestry.
    for (const node of nodes) visit(node.id);
    throw new Error('Every workflow node must contribute to the final node');
  }
  return definitions;
}

function seatMatches(seat: RoleSeat, node: WorkflowNode): boolean {
  if (typeof seat === 'string') return node.role === seat;
  return node.role === seat.name && (seat.provider === undefined || node.provider === seat.provider)
    && (!seat.fresh || node.fresh);
}

function validateSeats(seats: RoleSeat[], nodes: WorkflowNode[]): void {
  const assignments = new Map<number, number>();
  function assign(seatIndex: number, visited: Set<number>): boolean {
    for (let index = 0; index < nodes.length; index++) {
      if (visited.has(index) || !seatMatches(seats[seatIndex], nodes[index])) continue;
      visited.add(index);
      const previous = assignments.get(index);
      if (previous === undefined || assign(previous, visited)) {
        assignments.set(index, seatIndex);
        return true;
      }
    }
    return false;
  }
  for (let index = 0; index < seats.length; index++) {
    if (!assign(index, new Set())) throw new Error('Workflow must include a distinct matching node for every owner-configured role seat and pin');
  }
}

export function workflowTurnBudget(job: Job, stage: HostStage): { consumed: number; remaining: number; reserved: number } {
  let reserved = 0;
  // Every later policy checkpoint still needs a planner and its minimum distinct seats.
  // In particular, a build repair cannot reuse an old review of a different proof.
  for (let index = stages.indexOf(stage) + 1; index < stages.length; index++) {
    reserved += 1 + Math.max(1, job.config.roles?.[stages[index]]?.length ?? 0);
  }
  return { consumed: job.hostTurns, remaining: Math.max(0, job.config.maxHostTurns - job.hostTurns), reserved };
}

export function applyWorkflowPlan(job: Job, stage: HostStage, input: unknown, now = Date.now()): WorkflowPhase {
  const limits = job.config.workflow;
  if (!limits) throw new Error('Dynamic workflow is not configured for this job');
  if (job.workflow?.cancelled) throw new Error('Cancelled workflow requires an explicit owner retry');
  if (activeWorkflowNodes(job).length) throw new Error('Workflow node claims must drain before replanning');
  const current = job.workflow?.phases[stage] ?? newWorkflowPhase('Initial workflow plan');
  const revision = current.revision + 1;
  if (revision > limits.maxReplans + 1) throw new Error('Workflow replan limit reached');
  if (!Number.isFinite(now)) throw new Error('Workflow plan timestamp must be finite');
  const plan = WorkflowPlanSchema.parse(input);
  if (plan.nodes.length > limits.maxNodes) throw new Error('Workflow node limit reached');
  const definitions = validateGraph(plan.nodes, plan.final);
  for (const node of plan.nodes) {
    if (stage !== 'build' && node.writePaths.length) throw new Error(`${stage} workflow nodes must be read-only`);
    if (stage === 'review' && !node.fresh) throw new Error('Every review workflow node requires a fresh context');
    const resultBytes = stage === 'review' ? minimumReviewBytes(node.id === plan.final ? job.spec.acceptance : [])
      : stage === 'research' && node.id === plan.final ? Buffer.byteLength('{"viable":true,"distinctness":"x","plan":["x"]}') : undefined;
    const minimumBytes = minimumNodeResultBytes(node.acceptance, resultBytes);
    if (minimumBytes > MAX_INPUT_BYTES) throw new Error(`Workflow node ${node.id} requires at least ${minimumBytes} completion bytes, exceeding the ${MAX_INPUT_BYTES}-byte input limit; revise the plan without weakening frozen product acceptance`);
  }
  validateSeats(job.config.roles?.[stage] ?? [], plan.nodes);

  const previous = new Map(current.nodes.map(node => [node.definition.id, node]));
  for (const revision of current.history) {
    for (const node of revision.plan.nodes) {
      if (definitions.has(node.id) && !previous.has(node.id)) {
        throw new Error(`Retired workflow node ${node.id} cannot return; its attempt history must not reset`);
      }
    }
  }
  const invalidated = new Set<string>();
  for (const id of plan.invalidate) {
    if (invalidated.has(id)) throw new Error(`Duplicate workflow invalidation: ${id}`);
    if (!previous.has(id)) throw new Error(`Cannot invalidate unknown previous workflow node: ${id}`);
    invalidated.add(id);
  }
  const reset = new Set(invalidated);
  const dependents = new Map<string, string[]>();
  for (const node of current.nodes) {
    const id = node.definition.id;
    const next = definitions.get(id);
    if (!next || JSON.stringify(next) !== JSON.stringify(node.definition)) {
      if (node.status === 'passed' && !invalidated.has(id)) throw new Error(`Passed workflow node ${id} requires explicit invalidation before changing or removing its definition`);
      reset.add(id);
    }
    for (const dependency of node.definition.dependsOn) {
      const children = dependents.get(dependency) ?? [];
      children.push(id);
      dependents.set(dependency, children);
    }
  }
  // Follow the old graph: removing an edge must not retain proof based on invalidated work.
  const queue = [...reset];
  for (let index = 0; index < queue.length; index++) {
    for (const id of dependents.get(queue[index]) ?? []) {
      if (reset.has(id)) continue;
      reset.add(id);
      queue.push(id);
    }
  }
  const nodes: WorkflowNodeState[] = plan.nodes.map(definition => {
    const prior = previous.get(definition.id);
    if (prior?.status === 'passed' && !reset.has(definition.id)) return { ...prior };
    return { definition, status: 'pending', attempts: prior?.attempts ?? 0, turn: null };
  });
  if (nodes.find(node => node.definition.id === plan.final)!.status !== 'pending') {
    throw new Error('Workflow final node must be pending; explicitly invalidate completed work instead of replaying a passed final');
  }
  const pending = nodes.reduce((count, node) => count + Number(node.status === 'pending'), 0);
  const budget = workflowTurnBudget(job, stage);
  if (pending + budget.reserved > budget.remaining) {
    throw new Error(`Workflow host-turn budget cannot fit ${pending} pending node claims and ${budget.reserved} reserved future checkpoint turns; ${budget.remaining} remain after ${budget.consumed} consumed turns`);
  }
  return {
    ...current, status: 'running', revision, final: plan.final, nodes,
    history: [...current.history, { revision, at: now, reason: current.reason, plan }],
  };
}

function pathsOverlap(left: string, right: string): boolean {
  return left === '.' || right === '.' || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalizedPath(path: string): string {
  // Deliberately serialize case-distinct names even on case-sensitive volumes.
  // Canonical Unicode and case folding also fence aliases before either file exists.
  return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

interface PathResource {
  canonical: string;
  identity: string;
  suffix: string;
  directory?: string;
}

function resourcePathOverlap(workspace?: string): (left: string, right: string) => boolean {
  if (workspace === undefined) return (left, right) => pathsOverlap(normalizedPath(left), normalizedPath(right));
  // These observations live for one claim boundary only, never across workspace changes.
  const resources = new Map<string, PathResource | null>();
  const trees = new Map<string, Set<string> | null>();
  let root: string | undefined;
  function inspect(path: string): PathResource | null {
    if (resources.has(path)) return resources.get(path)!;
    let resource: PathResource | null = null;
    try {
      if (root === undefined) {
        const actual = realpathSync(workspace!);
        if (!statSync(actual).isDirectory()) return null;
        root = actual;
      }
      let existing = join(root, path);
      const missing: string[] = [];
      let info = lstatSync(existing, { bigint: true, throwIfNoEntry: false });
      while (!info) {
        if (existing === root) return null;
        const parent = dirname(existing);
        missing.unshift(relative(parent, existing));
        existing = parent;
        info = lstatSync(existing, { bigint: true, throwIfNoEntry: false });
      }
      const actual = realpathSync(existing);
      const within = relative(root, actual);
      if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) return null;
      info = statSync(actual, { bigint: true });
      if (!info.isDirectory() && (!info.isFile() || missing.length)) return null;
      resource = {
        canonical: normalizedPath(join(actual, ...missing).split(sep).join('/')),
        identity: `${info.dev}:${info.ino}`,
        suffix: missing.length ? normalizedPath(missing.join('/')) : '.',
        ...(info.isDirectory() && !missing.length ? { directory: actual } : {}),
      };
    } catch { /* Unreadable, disappearing, or unresolvable resources cannot prove independence. */ }
    resources.set(path, resource);
    return resource;
  }
  function descendants(resource: PathResource): Set<string> | null {
    const directory = resource.directory!;
    if (trees.has(directory)) return trees.get(directory)!;
    const identities = new Set([resource.identity]);
    const directories = [directory];
    try {
      while (directories.length) {
        const current = directories.pop()!;
        for (const name of readdirSync(current)) {
          const child = join(current, name);
          const info = lstatSync(child, { bigint: true });
          // Source proof rejects symlinks; do not traverse unknown trees to grant parallelism.
          if (!info.isDirectory() && !info.isFile()) {
            trees.set(directory, null);
            return null;
          }
          const identity = `${info.dev}:${info.ino}`;
          if (info.isDirectory() && !identities.has(identity)) directories.push(child);
          identities.add(identity);
        }
      }
      trees.set(directory, identities);
      return identities;
    } catch {
      trees.set(directory, null);
      return null;
    }
  }
  return (left, right) => {
    if (pathsOverlap(normalizedPath(left), normalizedPath(right))) return true;
    const a = inspect(left), b = inspect(right);
    if (!a || !b) return true;
    if (pathsOverlap(a.canonical, b.canonical)
      || a.identity === b.identity && pathsOverlap(a.suffix, b.suffix)) return true;
    // Directory ownership includes hardlinked descendants, not just its lexical prefix.
    const aTree = a.directory ? descendants(a) : undefined;
    if (aTree === null || aTree?.has(b.identity)) return true;
    const bTree = b.directory ? descendants(b) : undefined;
    if (bTree === null || bTree?.has(a.identity)) return true;
    if (aTree && bTree) {
      const [smaller, larger] = aTree.size <= bTree.size ? [aTree, bTree] : [bTree, aTree];
      for (const identity of smaller) if (larger.has(identity)) return true;
    }
    return false;
  };
}

function nodePathsConflict(left: WorkflowNode, right: WorkflowNode, overlap: (left: string, right: string) => boolean): boolean {
  return left.writePaths.some(path => right.writePaths.some(other => overlap(path, other))
      || right.readPaths.some(other => overlap(path, other)))
    || right.writePaths.some(path => left.readPaths.some(other => overlap(path, other)));
}

export function workflowNodeConflict(left: WorkflowNode, right: WorkflowNode, workspace?: string): boolean {
  return nodePathsConflict(left, right, resourcePathOverlap(workspace));
}

export function readyWorkflowNodes(phase: WorkflowPhase, workspace?: string): WorkflowNodeState[] {
  if (phase.status !== 'running') return [];
  const nodes = new Map(phase.nodes.map(node => [node.definition.id, node]));
  const active = phase.nodes.filter(node => node.turn !== null);
  const overlap = resourcePathOverlap(workspace);
  return phase.nodes.filter(node => node.status === 'pending' && node.turn === null
    && node.definition.dependsOn.every(id => nodes.get(id)?.status === 'passed')
    && !active.some(running => nodePathsConflict(node.definition, running.definition, overlap)));
}

export function workflowTurnDigest(job: Job, stage: HostStage, phase: WorkflowPhase, node?: WorkflowNodeState): string {
  const context = {
    spec: job.spec, requestSpec: job.requestSpec, config: job.config, workspace: job.workspace,
    stage, revision: phase.revision, final: phase.final,
    ...(stage === 'review' ? {
      proof: { phase: phase.proofDigest, current: verificationProofDigest(job) },
    } : {}),
  };
  const graph = node ? {
    definition: node.definition,
    dependencies: node.definition.dependsOn.map(id => ({
      id, result: phase.nodes.find(dependency => dependency.definition.id === id)?.result,
    })),
  } : {
    reason: phase.reason,
    nodes: phase.nodes.map(state => ({ definition: state.definition, status: state.status, result: state.result })),
  };
  return createHash('sha256').update(JSON.stringify({ ...context, ...graph })).digest('hex');
}

export function activeWorkflowNodes(job: Job): Array<{ stage: HostStage; node: WorkflowNodeState }> {
  const active: Array<{ stage: HostStage; node: WorkflowNodeState }> = [];
  for (const stage of stages) {
    for (const node of job.workflow?.phases[stage]?.nodes ?? []) {
      if (node.turn !== null) active.push({ stage, node });
    }
  }
  return active;
}

export function workflowProgress(job: Job): object | undefined {
  if (!job.workflow) return undefined;
  const phases: Partial<Record<HostStage, object>> = {};
  for (const stage of stages) {
    const phase = job.workflow.phases[stage];
    if (!phase) continue;
    const counts = { pending: 0, running: 0, passed: 0, failed: 0 };
    for (const node of phase.nodes) counts[node.status]++;
    phases[stage] = {
      status: phase.status, revision: phase.revision, reason: phase.reason, final: phase.final,
      total: phase.nodes.length, counts,
    };
  }
  return { cancelled: job.workflow.cancelled, phases };
}
