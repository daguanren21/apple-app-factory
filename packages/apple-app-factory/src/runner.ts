import { mkdirSync, readFileSync, readdirSync, lstatSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, resolve, delimiter, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { run, executionEnvironment, inspectProcess, processIsAlive, processGroupAlive, terminateOwnedProcessGroup } from './process.js';
import { canonicalPath, inside, expandArgv } from './config.js';
import { checkPrerequisites } from './preflight.js';
import { flutterEnvironment, prepareFlutter } from './flutter.js';
import { prepareExportOptions, prepareNativeExportCommands } from './export-options.js';
import { dependencyDigest, generatedModulePaths, isGeneratedPath } from './dependencies.js';
import { ReviewSchema, SpecSchema, WorkflowPlanSchema, WorkflowNodeResultSchema, toError, validateJobConfig } from './schemas.js';
import type { Config, Job, HostStage, HostTurn, RoleSeat, Stage, WorkflowPhase, WorkflowNodeState, WorkflowNode, WorkflowNodeResult, WorkflowState } from './schemas.js';
import type { Run, RunOptions, RunResult } from './process.js';
import type { Store } from './store.js';
import { sourceDigest, prepareWorkspace, projectDirectory, artifactOutputPath } from './workspace.js';
import { parseResearch, researchPrompt, reviewInstructions } from './policy.js';
import { assertProject, buildInstructions } from './project-profiles.js';
import { closestOwnedGoWorkspace } from './go-dependencies.js';
import { validateMacOSArtifact } from './macos.js';
import { validateMyGoPackaging, validateMyGoCommand } from './mygo-build.js';
import { invalidateVerification, verificationProofDigest } from './proof.js';
import { scanInbox } from './inbox.js';
import { prepareIsolatedCommand, type IsolatedCommand, type IsolationCapabilities } from './isolation.js';
import { activeWorkflowNodes, applyWorkflowPlan, newWorkflowPhase, readyWorkflowNodes, workflowTurnBudget, workflowTurnDigest } from './workflow.js';

function requireDependencyProof(job: Job): void {
  if (!job.verifiedDependencyDigest) throw Object.assign(new Error('Dependency resolution proof is missing; retry this stopped task to re-run verification'), { code: 'SETUP_REQUIRED' });
  const current = dependencyDigest(job.workspace, job.spec.framework, job.spec.project?.directory);
  if (current !== job.verifiedDependencyDigest) throw Object.assign(new Error(`Dependency resolution changed since verification (dependency digest current=${current.slice(0, 16)} recorded=${job.verifiedDependencyDigest.slice(0, 16)}); re-verification is required`), { code: 'EVIDENCE_CHANGED' });
}

function taskPrompt(job: Job): string {
  const autopilot = job.config.autopilot === true
    ? `AUTOPILOT MODE — owner-preauthorized execution within frozen scope, permissions and budgets. Do not ask routine confirmation questions for already authorized work. Let the model plan the work graph, record material decisions, and execute only claimed nodes. When a local deterministic check fails, inspect its recorded evidence and repair the cause through the returned build planner; never weaken checks or replay the same failure blindly. Wait for due work and collect this controller's live workers before exiting. Missing prerequisites, permissions, independent-review capability, uncertain external effects, cancellation or exhausted budgets are honest stopped states: report them and continue other eligible jobs. Only an explicit owner action can change configuration/budgets or retry stopped work. Never re-enqueue the same requirement as a new version to reset its limits. Review must use a genuinely fresh non-implementer context; a disclosure or a self-reported identity is not a substitute. Never fabricate results, screenshots, model identity or completion, and never publish or expand permissions.\n`
    : '';
  return `${autopilot}You are the native host of an embedded multi-stack app Harness. Use your own context, tools and native delegation in ${projectDirectory(job)}; never launch another coding-agent CLI. Preserve the requested framework and existing architecture. Implement only this product. Never hide functionality from users or reviewers. Do not upload, submit, push, read publisher credentials or change factory state. Remote build commands belong only to the explicitly authorized Harness packaging profile, not host turns. The workspace is not a security sandbox. Complete real implementations, not placeholders.\nImmutable product requirements:\n${JSON.stringify(job.spec, null, 2)}\nPrevious verification/review failure (repair the mechanism, never weaken acceptance):\n${job.feedback ?? job.error ?? 'none'}\nPersisted execution logs:\n${JSON.stringify(job.logs.slice(-3))}\nContinue existing work. Only actual deterministic checks performed by the Harness establish verification; host claims do not.\n`;
}

export interface TurnOptions { buildOnly?: boolean; ownerPid?: number; resumeActive?: boolean }
export interface HostAction {
  job: Job;
  action: 'host' | 'step' | 'wait' | 'done';
  turn?: { id: string; stage: HostStage; prompt: string; cwd: string; environment: Record<string, string>; role: string[];
    kind?: 'plan' | 'node'; workflow?: { phase: HostStage; revision: number; nodeId?: string; node?: WorkflowNode; dependencies?: Array<{ id: string; result?: WorkflowNodeResult }>; planSchema?: unknown } };
}

export interface DriveOptions { once?: boolean; maxRounds?: number; strict?: boolean; buildOnly?: boolean; ownerPid?: number; signal?: AbortSignal }
export type JobView = {
  id: string; product: string; framework: string; platform: string; channel: string; version: string;
  priority: Job['spec']['priority']; stage: Job['stage']; status: Job['status']; hostTurns: number;
  attempts: Job['attempts']; workspace: string; artifact: Job['artifact']; error: string | null;
};
export interface DriveResult {
  action: 'host' | 'step' | 'wait' | 'done';
  job?: JobView;
  turn?: NonNullable<HostAction['turn']>;
  result?: JobView;
  nextDueAt?: number;
  rounds: number;
  failed?: Array<{ id: string; error: string | null }>;
  pendingErrors?: Array<{ id: string; error: string }>;
  /** Idle audit for `wait`/`done` returns so a scheduler can decide without another status call. */
  summary?: QueueSummary;
  /** Inbox intake performed at the start of this drive (only when an inbox is configured). */
  intake?: { accepted: number; errors?: Array<{ source: string; error: string }> };
}

function jobView(job: Job): JobView {
  return {
    id: job.id, product: job.spec.id, framework: job.spec.framework, platform: job.spec.platform, channel: job.spec.channel,
    version: job.spec.version, priority: job.spec.priority, stage: job.stage, status: job.status, hostTurns: job.hostTurns,
    attempts: job.attempts, workspace: job.workspace, artifact: job.artifact ?? null, error: job.error ?? null,
  };
}

const DEFAULT_ROLES: Record<HostStage, string[]> = {
  research: ['product-analyst'],
  build: ['ui-designer', 'developer'],
  review: ['architect-review', 'qa-engineer', 'acceptance-reviewer'],
};

const BUILD_PRINCIPLES = 'Work test-first: write a failing test before the implementation and never add tests after the fact just to pass acceptance. Enumerate every state machine in docs/architecture.md explicitly (states, transitions, events), and make each UI loading/empty/error/success state traceable to it.';

function assertTurnPermission(_job: Job, _options: TurnOptions): void {
  // No publication permission exists in this build; the flag remains accepted for CLI compatibility.
}

function contextDigest(job: Job): string {
  return createHash('sha256').update(JSON.stringify({
    spec: job.spec, requestSpec: job.requestSpec, config: job.config, workspace: job.workspace,
    stage: job.stage, research: job.research, feedback: job.feedback, logs: job.logs,
    verifiedDigest: job.verifiedDigest, verifiedDependencyDigest: job.verifiedDependencyDigest,
    screenshotDigest: job.screenshotDigest, verifiedAt: job.verifiedAt,
  })).digest('hex');
}

function deadlineExpired(job: Job): boolean {
  return Date.now() - job.createdAt > job.config.maxJobHours * 3600000;
}

function remainingJobTime(job: Job): number {
  const remaining = job.createdAt + job.config.maxJobHours * 3600000 - Date.now();
  if (remaining <= 0) throw Object.assign(new Error('Task wall-clock limit reached; no further command or success may be committed'), { code: 'BUDGET' });
  return remaining;
}

function hostOwner(ownerPid: number): Pick<HostTurn, 'ownerPid' | 'ownerIdentity'> {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !processIsAlive(ownerPid)) throw new Error('Host owner must identify a live process');
  return { ownerPid, ownerIdentity: inspectProcess(ownerPid)?.identity };
}


function liveHostTurn(turn: NonNullable<Job['turn']>): boolean {
  return turn.ownerPid !== undefined && processIsAlive(turn.ownerPid, turn.ownerIdentity);
}

/** Adopt a dead/legacy host claim without incrementing host-turn or attempt budgets. */
function adoptHostTurn(store: Store, job: Job, ownerPid: number): Job {
  const turnId = job.turn?.id;
  if (!turnId) return job;
  return store.transition(job.id, current => {
    if (!current.turn || current.turn.id !== turnId) return {};
    if (current.status !== 'running' || current.stage !== current.turn.stage || contextDigest(current) !== current.turn.contextDigest) {
      throw new Error('Active host turn context changed; abandon its token before requesting another turn');
    }
    if (liveHostTurn(current.turn)) return {};
    return { turn: { ...current.turn, ...hostOwner(ownerPid) } };
  });
}

function requireReviewProof(job: Job): void {
  try {
    if (!job.verifiedDigest) throw new Error('Source changed since verification; stale evidence cannot approve a handoff');
    const currentSource = sourceDigest(job.workspace, true, job.spec.framework, job.spec.project?.directory);
    if (currentSource !== job.verifiedDigest) throw new Error(`Source changed since verification (source digest current=${currentSource.slice(0, 16)} recorded=${job.verifiedDigest.slice(0, 16)}); stale evidence cannot approve a handoff`);
    requireDependencyProof(job);
    if (job.spec.screenshotsDir) {
      const screenshots = inside(projectDirectory(job), job.spec.screenshotsDir);
      const currentScreenshots = sourceDigest(screenshots, false);
      const recordedScreenshots = job.screenshotDigest ?? '';
      if (currentScreenshots !== job.screenshotDigest) throw new Error(`Screenshots changed since runtime verification (screenshot digest current=${currentScreenshots.slice(0, 16)} recorded=${recordedScreenshots.slice(0, 16)}); stale evidence cannot approve a handoff`);
    }
  } catch (cause) {
    const error = toError(cause);
    if (error.code !== 'SETUP_REQUIRED') error.code = 'EVIDENCE_CHANGED';
    throw error;
  }
}

function hostEnvironment(job: Job): Record<string, string> {
  // Host-visible JSON carries task overrides, never inherited credential values.
  const environment = job.spec.framework === 'flutter' ? flutterEnvironment(job.config, job.workspace, { CI: '1' }) : { CI: '1' } as NodeJS.ProcessEnv;
  if (job.spec.framework === 'mygo') Object.assign(environment, { GOENV: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly', GOWORK: closestOwnedGoWorkspace(job.workspace, job.spec.project?.directory) ?? 'off' });
  if (job.spec.framework === 'flutter' && job.config.toolchain) {
    environment.FLUTTER_ROOT = job.config.toolchain.flutterSdk;
    environment.PATH = `${join(job.config.toolchain.flutterSdk, 'bin')}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ''}`;
  }
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function hostAction(store: Store, job: Job): HostAction {
  const turn = job.turn!;
  let instruction: string;
  if (turn.stage === 'research') {
    const portfolio = store.list().filter(value => value.id !== job.id && value.spec.channel === job.spec.channel && value.spec.id !== job.spec.id).map(value => ({ id: value.spec.id, purpose: value.spec.purpose, audience: value.spec.audience, differentiators: value.spec.differentiators }));
    instruction = researchPrompt(job, portfolio);
  } else if (turn.stage === 'build') {
    const uiDesignerFlow = job.spec.designRef
      ? `Build-stage role order: ui-designer first, then developer — the host adopts each through its native subagent facility with independent contexts. A design reference (designRef) is provided: ${job.spec.designRef}. The ui-designer reads the design reference and produces docs/ui-design.md (color/type/spacing/layout/component states extracted screen-by-screen), recording the actual design source URL it used. The developer must faithfully reproduce (忠实还原) that referenced design, never inventing unrequested visual decisions. If the design reference is inaccessible, record that honestly and fall back to the bundled ui-design-guide.md mode; never fabricate a design source you could not access.`
      : `Build-stage role order: ui-designer first, then developer — the host adopts each through its native subagent facility with independent contexts. No design reference was supplied, so the ui-designer produces docs/ui-design.md following the bundled resource ui-design-guide.md (design tokens, type scale, spacing/radius, component states including empty/loading/error/success, per-screen layout, accessibility, light/dark). The developer must implement strictly in line with docs/architecture.md and docs/ui-design.md, recording which UI decision maps to which section of the design spec.`;
    instruction = `Research plan: ${JSON.stringify(job.research)}\n${buildInstructions(job.spec)} ${BUILD_PRINCIPLES} ${uiDesignerFlow} Under autopilot the same holds: both roles run through the host's native subagents and never ask the user. Implement the entire requested product, accessibility and realistic empty/error states. Add genuine device/simulator acceptance workflows and real screenshots when requested; never fake screenshots or bypass tests. Do not add unrequested offline/backup/account features. Use the returned environment with your tools. Frozen verification and packaging: ${JSON.stringify({ verification: job.config.verification, packaging: job.config.packaging, packageTarget: job.config.packageTarget })}. Complete this turn without a result payload when source is ready; the Harness will then execute verification, not infer success.`;
  } else {
    instruction = reviewInstructions(job);
  }
  const seats: RoleSeat[] = [...(job.config.roles?.[turn.stage] ?? DEFAULT_ROLES[turn.stage])];
  const role = seats.map(seat => (typeof seat === 'string' ? seat : seat.name));
  const pins = seats.map(seat => (typeof seat === 'string' ? { name: seat } : { name: seat.name, ...(seat.provider ? { provider: seat.provider } : {}), ...(seat.fresh ? { fresh: seat.fresh } : {}) }));
  const pinnedSeats = seats.filter(seat => typeof seat !== 'string' && (seat.provider !== undefined || seat.fresh === true));
  const implementationProviders = new Set((['research', 'build'] as const).flatMap(stage => (job.config.roles?.[stage] ?? []).flatMap(seat => (typeof seat === 'string' ? [] : seat.provider ? [seat.provider] : []))));
  const reviewProviders = new Set((job.config.roles?.review ?? []).flatMap(seat => (typeof seat === 'string' ? [] : seat.provider ? [seat.provider] : [])));
  const sameProviderFamily = [...implementationProviders].some(provider => reviewProviders.has(provider));
  let roleLines = `Turn roles (adopt every role through your native delegation, with independent contexts where the skill requires them): ${JSON.stringify(role)}`;
  if (pinnedSeats.length) {
    roleLines += `\nSeat pins: ${JSON.stringify(pins)}`;
    roleLines += `\nSeats with fresh=true must run in a brand-new fresh-context subagent that shares no prior context with the implementing seats.`;
    if (sameProviderFamily) roleLines += `\nReview and implementation share the owner's pinned provider family. Keep those pins; use a different model family only when the owner constraints permit it. Disclose the shared-family limitation honestly, and still require a fresh non-implementer review context.`;
  }
  const prompt = `${taskPrompt(job)}${instruction}\n${roleLines}`;
  return { job, action: 'host', turn: { id: turn.id, stage: turn.stage, prompt, cwd: projectDirectory(job), environment: hostEnvironment(job), role } };
}

function repair(job: Job, message: string): Partial<Job> {
  const exhausted = (job.attempts[job.stage] ?? 0) >= job.config.maxAttempts;
  return {
    // Deferred-to-owner is the terminal state for exhausted budgets: the run
    // must not stop, so owner input is requested in the report, never in a
    // blocking question.
    stage: exhausted ? job.stage : 'build',
    status: exhausted ? 'needs-owner' : 'waiting',
    ...invalidateVerification(), turn: null,
    feedback: exhausted ? `Attempt budget exhausted; owner input is required to proceed: ${message}` : message,
    error: exhausted ? `Attempt budget exhausted; owner input is required to proceed: ${message}` : message,
    nextAt: Date.now() + job.config.retryDelayMs,
  };
}

function workflowState(job: Job, stage: HostStage, phase: WorkflowPhase): WorkflowState {
  return { cancelled: job.workflow?.cancelled ?? false, phases: { ...job.workflow?.phases, [stage]: phase } };
}

function pendingWorkflowNode(node: WorkflowNodeState): WorkflowNodeState {
  return { definition: node.definition, status: 'pending', attempts: node.attempts, turn: null };
}

function stopWorkflow(job: Job, reason: string, cancelled = false): Partial<Job> {
  const phases = { ...job.workflow?.phases };
  for (const stage of ['research', 'build', 'review'] as const) {
    const phase = phases[stage];
    if (phase && (stage === job.stage || phase.nodes.some(node => node.turn))) phases[stage] = { ...phase, status: 'planning', reason, nodes: phase.nodes.map(node => node.turn ? pendingWorkflowNode(node) : node) };
  }
  return { workflow: { cancelled, phases }, turn: null, status: 'needs-owner', error: reason, feedback: reason };
}

function workflowAction(store: Store, job: Job, claim: HostTurn, node?: WorkflowNodeState): HostAction {
  const phase = job.workflow!.phases[claim.stage]!;
  const dependencies = node?.definition.dependsOn.map(id => {
    const dependency = phase.nodes.find(value => value.definition.id === id)!;
    return { id, ...(dependency.result ? { result: dependency.result } : {}) };
  });
  const policy = claim.stage === 'research'
    ? researchPrompt(job, store.list().filter(value => value.id !== job.id && value.spec.channel === job.spec.channel && value.spec.id !== job.spec.id).map(value => ({ id: value.spec.id, purpose: value.spec.purpose, audience: value.spec.audience, differentiators: value.spec.differentiators })))
    : claim.stage === 'build' ? `${buildInstructions(job.spec)} Research decision: ${JSON.stringify(job.research)}. Reproduce a supplied designRef faithfully; otherwise make task-appropriate design choices. The frozen checks and runtime acceptance run after the whole build graph, never as a replacement for implementation.` : reviewInstructions(job);
  const phaseResult = claim.stage === 'research'
    ? 'The final node result field must contain the typed research verdict: {viable,distinctness,risks?,plan}.'
    : claim.stage === 'review' ? 'The final node result field must contain {approved,findings,acceptanceEvidence:[{requirement,evidence}]}, covering every immutable product acceptance requirement and the observations of all review nodes.'
      : 'Complete build nodes with observed evidence and optional structured result data. No node verdict substitutes for the Harness deterministic checks/runtime or packaging gate.';
  let instruction: string;
  if (node) {
    instruction = `DYNAMIC WORKFLOW NODE — execute only the persisted node ${node.definition.id}, not the whole checkpoint.\n${JSON.stringify(node.definition)}\nDependency results: ${JSON.stringify(dependencies)}\nRespect declared readPaths/writePaths; they coordinate shared-workspace ownership, not an OS sandbox. Never write outside your declared writePaths or begin unrelated pending nodes. ${node.definition.fresh || claim.stage === 'review' ? 'Use a brand-new independent native subagent context, not the implementing context.' : 'Use the host native context appropriate for this role.'} ${node.definition.provider ? `Run on provider/model family ${node.definition.provider}; disclose honestly if unavailable, never invent attestation.` : ''}\nReturn JSON {outcome:"passed"|"failed",summary,evidence:[{requirement,evidence}],result?}. A pass needs observed evidence for every node acceptance criterion. A failed outcome records the failure and invokes model replanning; do not weaken criteria. ${phase.final === node.definition.id ? phaseResult : 'Supply useful structured outputs for dependent nodes in result; do not finalize the checkpoint yourself.'}`;
    if (claim.stage === 'review' && job.config.roles?.receipt) instruction += `\nRecord a distinct apphx decide receipt with role ${JSON.stringify(node.definition.role)} after this node claim; a prior or another node's receipt cannot be reused.`;
    if (claim.stage === 'review') instruction += '\nEvery review node, including a specialist, must place a typed {approved,findings,acceptanceEvidence} verdict in result. Specialist product coverage may be partial; the final must cover all product criteria. A completed inspection that finds a blocker uses outcome=passed with approved=false and explicit findings; the Harness preserves that veto at the final checkpoint.';
  } else {
    instruction = `DYNAMIC WORKFLOW PLANNER — decide the work breakdown from the actual requirement, repository and current evidence. Do not mechanically copy a fixed role sequence. Produce a JSON DAG, not executable JavaScript and not a prose-only plan.\nCheckpoint: ${claim.stage}. Reason: ${phase.reason}. Limits: ${JSON.stringify(job.config.workflow)}. Minimum owner-configured seats: ${JSON.stringify(job.config.roles?.[claim.stage] ?? [])}.\nEach node names its role, instructions, dependencies, exact project-relative readPaths/writePaths and observable acceptance. Every node must join the final node. Parallelize only truly independent read/write ownership; '.' means the whole project. Research/review nodes cannot write; every review node must use fresh=true. Preserve required provider/fresh seat pins and duplicate seat counts.\nCurrent graph and outcomes: ${JSON.stringify(phase.nodes)}\nPreserve unaffected passed nodes and outputs. Explicit invalidate identifies completed work invalidated by new facts; dependents are also invalidated. Replace failed/pending work as needed, within budgets, and ensure the new final still requires actual work. Never alter frozen requirements, verification commands, permissions, or evidence gates. ${phaseResult}\nComplete this planning token with JSON matching: ${JSON.stringify(z.toJSONSchema(WorkflowPlanSchema))}`;
    instruction += `\nGlobal host-turn budget: ${JSON.stringify(workflowTurnBudget(job, claim.stage))}. Keep this plan plus mandatory later checkpoints within remaining turns; do not spend future repair budget speculatively. The complete JSON input must fit the 1 MiB transport limit.`;
  }
  return { job, action: 'host', turn: { id: claim.id, stage: claim.stage, kind: node ? 'node' : 'plan', prompt: `${taskPrompt(job)}${policy}\n${instruction}`, cwd: projectDirectory(job), environment: hostEnvironment(job), role: [node?.definition.role ?? 'workflow-planner'], workflow: { phase: claim.stage, revision: phase.revision, ...(node ? { nodeId: node.definition.id, node: node.definition, dependencies } : { planSchema: z.toJSONSchema(WorkflowPlanSchema) }) } } };
}

function nextWorkflowTurn(store: Store, initial: Job, options: TurnOptions): HostAction {
  if (initial.workflow?.cancelled || ['failed', 'needs-owner', 'ready', 'built'].includes(initial.status)) return { job: initial, action: 'done' };
  if (deadlineExpired(initial)) return { job: store.update(initial.id, stopWorkflow(initial, 'Task wall-clock limit reached; active workflow tokens were revoked')), action: 'done' };
  if (initial.groups.length && !initial.manualRecovery) return { job: initial, action: 'step' };
  if (initial.manualRecovery || initial.status === 'blocked' && initial.blockedReason?.kind !== 'prerequisite' || initial.nextAt > Date.now()) return { job: initial, action: 'wait' };
  const stage = initial.stage as HostStage;
  if (!initial.workflow?.phases[stage] || !existsSync(projectDirectory(initial)) || initial.baseJobId && !initial.basePrepared || initial.sourceDirectory && !initial.importPrepared) {
    try { prepareWorkspace(store, initial); mkdirSync(projectDirectory(initial), { recursive: true, mode: 0o700 }); }
    catch (cause) { return { job: store.update(initial.id, { status: 'blocked', error: toError(cause).message }), action: 'wait' }; }
  }
  let selected: string | undefined;
  const job = store.transition(initial.id, current => {
    if (current.stage !== stage || current.workflow?.cancelled || ['failed', 'needs-owner', 'ready', 'built'].includes(current.status)) return {};
    if (current.groups.length || current.manualRecovery || current.nextAt > Date.now()) return {};
    if (deadlineExpired(current)) return stopWorkflow(current, 'Task wall-clock limit reached; active workflow tokens were revoked');
    let phase = current.workflow?.phases[stage] ?? newWorkflowPhase(`Plan ${stage} work from the actual requirement and repository`);
    if (stage === 'review') {
      try { requireReviewProof(current); }
      catch (cause) {
        const error = toError(cause);
        const invalid = { ...phase, status: 'planning' as const, reason: error.message, nodes: phase.nodes.map(pendingWorkflowNode) };
        return { ...repair(current, error.message), workflow: workflowState(current, stage, invalid) };
      }
      const proofDigest = verificationProofDigest(current);
      if (phase.proofDigest !== proofDigest) phase = { ...phase, status: 'planning', reason: 'Plan independent review against the current verification proof', proofDigest, nodes: phase.nodes.map(pendingWorkflowNode), decisionsLengthAtClaim: undefined };
    }
    if (phase.status === 'complete') phase = { ...phase, status: 'planning', reason: current.feedback ?? `Replan ${stage} after a policy checkpoint requested repair`, decisionsLengthAtClaim: undefined };
    const ownerPid = options.ownerPid ?? process.pid;
    if (current.turn) {
      if (current.turn.kind !== 'plan' || current.turn.stage !== stage || current.turn.contextDigest !== workflowTurnDigest(current, stage, phase)) throw new Error('Workflow planner context changed; abandon its stale token before continuing');
      if (options.resumeActive === false && liveHostTurn(current.turn)) return {};
      const turn = liveHostTurn(current.turn) ? current.turn : { ...current.turn, ...hostOwner(ownerPid) };
      selected = turn.id;
      return { turn, workflow: workflowState(current, stage, phase), status: 'running' };
    }
    const active = phase.nodes.filter(node => node.turn);
    const resumable = active.find(node => options.resumeActive !== false || !liveHostTurn(node.turn!));
    if (resumable) {
      const claim = resumable.turn!;
      if (claim.stage !== stage || claim.planRevision !== phase.revision || claim.contextDigest !== workflowTurnDigest(current, stage, phase, resumable)) throw new Error('Workflow node context changed; abandon its stale token before continuing');
      const turn = liveHostTurn(claim) ? claim : { ...claim, ...hostOwner(ownerPid) };
      selected = turn.id;
      phase = { ...phase, nodes: phase.nodes.map(node => node === resumable ? { ...node, turn } : node) };
      return { workflow: workflowState(current, stage, phase), status: 'running' };
    }
    if (phase.status === 'planning' && active.length || phase.status === 'running' && active.length >= current.config.workflow!.maxParallel) return {};
    const exhausted = current.hostTurns >= current.config.maxHostTurns;
    if (phase.status === 'planning') {
      if (exhausted || (current.attempts[stage] ?? 0) >= current.config.maxAttempts || phase.revision > current.config.workflow!.maxReplans) {
        return { ...stopWorkflow(current, 'Workflow planning, host-turn or stage budget exhausted; raise the owner budget before retrying'), workflow: workflowState(current, stage, phase) };
      }
      const turn: HostTurn = { id: randomUUID(), stage, kind: 'plan', planRevision: phase.revision, createdAt: Date.now(), contextDigest: workflowTurnDigest(current, stage, phase), ...hostOwner(ownerPid) };
      selected = turn.id;
      return { workflow: workflowState(current, stage, phase), turn, status: 'running', hostTurns: current.hostTurns + 1, attempts: { ...current.attempts, [stage]: (current.attempts[stage] ?? 0) + 1 }, error: null, blockedReason: null };
    }
    const candidate = readyWorkflowNodes(phase, projectDirectory(current))[0];
    if (!candidate) return {};
    if (exhausted || candidate.attempts >= current.config.maxAttempts) {
      return active.length ? {} : stopWorkflow(current, `Workflow node ${candidate.definition.id} or host-turn budget exhausted; raise the owner budget before retrying`);
    }
    const turn: HostTurn = { id: randomUUID(), stage, kind: 'node', nodeId: candidate.definition.id, planRevision: phase.revision, createdAt: Date.now(), contextDigest: workflowTurnDigest(current, stage, phase, candidate), ...hostOwner(ownerPid), decisionsLengthAtClaim: current.decisions.length };
    selected = turn.id;
    phase = { ...phase, decisionsLengthAtClaim: phase.decisionsLengthAtClaim ?? current.decisions.length, nodes: phase.nodes.map(node => node === candidate ? { ...node, status: 'running', attempts: node.attempts + 1, turn, decisionsLengthAtClaim: current.decisions.length } : node) };
    return { ...(stage === 'build' && candidate.definition.writePaths.length ? invalidateVerification() : {}), workflow: workflowState(current, stage, phase), status: 'running', hostTurns: current.hostTurns + 1, error: null, blockedReason: null };
  });
  if (selected) {
    if (job.turn?.id === selected) return workflowAction(store, job, job.turn);
    const node = job.workflow?.phases[stage]?.nodes.find(value => value.turn?.id === selected);
    if (node?.turn) return workflowAction(store, job, node.turn, node);
  }
  if (['failed', 'needs-owner', 'built', 'ready'].includes(job.status)) return { job, action: 'done' };
  return { job, action: ['research', 'build', 'review'].includes(job.stage) ? 'wait' : 'step' };
}

export async function nextTurn(store: Store, id: string, options: TurnOptions = {}): Promise<HostAction> {
  store.acquire();
  try {
    let job = store.get(id);
    assertTurnPermission(job, options);
    if (job.config.workflow && ['research', 'build', 'review'].includes(job.stage)) return nextWorkflowTurn(store, job, options);
    if (job.turn) {
      const ownerLive = liveHostTurn(job.turn);
      if (options.resumeActive === false) {
        if (ownerLive) return { job, action: 'wait' };
        const ownerPid = options.ownerPid ?? process.pid;
        job = adoptHostTurn(store, job, ownerPid);
        if (!job.turn || job.turn.ownerPid !== ownerPid) return { job, action: 'wait' };
      } else if (!ownerLive) {
        job = adoptHostTurn(store, job, options.ownerPid ?? process.pid);
      }
      if (!job.turn || job.status !== 'running' || job.stage !== job.turn.stage || contextDigest(job) !== job.turn.contextDigest) throw new Error('Active host turn context changed; abandon its token before requesting another turn');
      if (deadlineExpired(job)) {
        const claimed = job.turn;
        job = store.transition(id, current => {
          assertTurnPermission(current, options);
          if (current.turn?.id !== claimed.id || contextDigest(current) !== claimed.contextDigest) throw new Error('Host turn changed while checking its deadline; inspect the current task');
          return { turn: null, status: 'needs-owner', error: 'Task wall-clock limit reached; the expired host turn cannot resume without owner intervention' };
        });
        return { job, action: 'done' };
      }
      return hostAction(store, job);
    }
    if (job.groups.length && !job.manualRecovery) return { job, action: 'step' };
    if (['failed', 'needs-owner', 'ready', 'built'].includes(job.status)) return { job, action: 'done' };
    const eligible = ['queued', 'waiting'].includes(job.status) || (job.status === 'blocked' && job.blockedReason?.kind === 'prerequisite');
    if (!eligible || job.nextAt > Date.now() || job.manualRecovery) return { job, action: 'wait' };
    if (!['research', 'build', 'review'].includes(job.stage)) return { job, action: 'step' };
    if (deadlineExpired(job) || job.hostTurns >= job.config.maxHostTurns || (job.attempts[job.stage] ?? 0) >= job.config.maxAttempts) {
      job = store.transition(id, current => {
        assertTurnPermission(current, options);
        return { status: 'needs-owner', error: 'Host turn, stage attempt or task wall-clock limit reached; owner input is required to proceed' };
      });
      return { job, action: 'done' };
    }
    try {
      if (job.stage === 'review') requireReviewProof(job);
      prepareWorkspace(store, job);
      mkdirSync(projectDirectory(job), { recursive: true, mode: 0o700 });
    } catch (cause) {
      const error = toError(cause);
      job = store.update(id, error.code === 'SETUP_REQUIRED' || job.stage !== 'review'
        ? { status: 'blocked', error: error.message }
        : repair(job, error.message));
      return { job, action: 'wait' };
    }
    job = store.transition(id, current => {
      assertTurnPermission(current, options);
      const eligible = ['queued', 'waiting'].includes(current.status) || (current.status === 'blocked' && current.blockedReason?.kind === 'prerequisite');
      if (current.turn || contextDigest(current) !== contextDigest(job) || current.nextAt > Date.now() || !eligible || current.groups.length || current.manualRecovery) throw new Error('Task changed before the host turn could be claimed');
      if (deadlineExpired(current) || current.hostTurns >= current.config.maxHostTurns || (current.attempts[current.stage] ?? 0) >= current.config.maxAttempts) return { status: 'needs-owner', error: 'Host turn, stage attempt or task wall-clock limit reached; owner input is required to proceed' };
      if (current.stage === 'review') requireReviewProof(current);
      const turn = {
        id: randomUUID(), stage: current.stage as HostStage, createdAt: Date.now(), contextDigest: contextDigest(current),
        decisionsLengthAtClaim: current.decisions.length, ...hostOwner(options.ownerPid ?? process.pid),
      };
      return { turn, hostTurns: current.hostTurns + 1, attempts: { ...current.attempts, [current.stage]: (current.attempts[current.stage] ?? 0) + 1 }, status: 'running', blockedReason: null, error: null };
    });
    return job.turn ? hostAction(store, job) : { job, action: 'done' };
  } finally { store.release(); }
}

export type QueueTurn =
  | HostAction
  | { action: 'idle'; nextAt: number | null; pendingErrors: Array<{ id: string; error: string }>; summary: QueueSummary };

export type QueueSummary = { total: number; built: number; failed: number; needsOwner: number; blocked: number; waiting: number; queued: number; running: number };

type QueuePick =
  | { action: 'host'; job: Job; turn: NonNullable<HostAction['turn']> }
  | { action: 'step'; job: Job }
  | { action: 'idle'; nextAt: number | null; pendingErrors: Array<{ id: string; error: string }>; summary: QueueSummary };

async function pickQueueTurn(store: Store, options: TurnOptions = {}): Promise<QueuePick> {
  const pendingErrors: Array<{ id: string; error: string }> = [];
  const queueOptions = { ...options, resumeActive: false };
  // Priority lanes order the scan (P0 > P1 > P2); within a lane, earliest due
  // time wins, then insertion order. Priority never overrides eligibility:
  // a deferred P0 job is skipped and the scan continues to the next safe action.
  const rank = (job: Job): number => job.spec.priority === 'P0' ? 0 : job.spec.priority === 'P2' ? 2 : 1;
  const jobs = [...store.list()].sort((left, right) => rank(left) - rank(right) || left.nextAt - right.nextAt);
  for (const job of jobs) {
    try {
      // The queue-only mode performs the live-owner check after acquiring the
      // short worker lock, so a concurrent initial claim cannot be replayed.
      const action = await nextTurn(store, job.id, queueOptions);
      if (action.action === 'host' && action.turn) return { action: 'host', job: action.job, turn: action.turn };
      if (action.action === 'step') return { action: 'step', job: action.job };
    } catch (cause) {
      pendingErrors.push({ id: job.id, error: toError(cause).message });
    }
  }
  // Re-read the queue so status counts reflect mutations made during the scan
  // (deadline expirations, budget deferrals); the pre-scan snapshot is stale.
  const current = store.list();
  const summary: QueueSummary = { total: current.length, built: 0, failed: 0, needsOwner: 0, blocked: 0, waiting: 0, queued: 0, running: 0 };
  for (const job of current) {
    const status = job.status;
    if (status === 'needs-owner') { summary.needsOwner += 1; continue; }
    if (status === 'built' || status === 'failed' || status === 'blocked' || status === 'waiting' || status === 'queued' || status === 'running') summary[status] += 1;
  }
  const due = current.map(job => job.nextAt).filter(nextAt => nextAt > Date.now());
  return { action: 'idle', nextAt: due.length ? Math.min(...due) : null, pendingErrors, summary };
}

/**
 * Pick the earliest-due actionable task in the whole queue for a host loop:
 * the first job (ordered by priority lane, then next_at, then insertion) whose
 * `next` returns a host turn or a deterministic step. Jobs that are deferred, stopped or still
 * owned by another execution are skipped; jobs whose persisted turn context no
 * longer matches are surfaced in `pendingErrors` instead of silently blocking
 * the queue. `idle` reports the earliest future due time plus a status summary
 * so the host can audit whether the queue is truly finished or merely blocked,
 * and knows when to wake again. Does not hold the queue worker lock across
 * calls; each host claim stays transactional inside `nextTurn`.
 */
export async function nextQueueTurn(store: Store, options: TurnOptions = {}): Promise<QueueTurn> {
  const pick = await pickQueueTurn(store, options);
  if (pick.action === 'idle') return pick;
  return { job: pick.job, action: pick.action, ...(pick.action === 'host' ? { turn: pick.turn } : {}) };
}

/**
 * A crashed invocation may still own child processes even though its queue
 * lock is free. Drain recorded command groups queue-wide before shared
 * Flutter/Apple tooling can be used by any new deterministic stage, so a
 * surviving group never runs alongside the new command.
 */
export async function drainCommandGroups(store: Store): Promise<void> {
  let failure: Error | undefined;
  for (const job of store.list()) {
    const groups: number[] = [], commands: Job['commands'] = {};
    let manualRecovery = job.manualRecovery ?? null;
    for (const pid of job.groups) {
      const command = job.commands[pid];
      try { await terminateOwnedProcessGroup(pid, command?.identity); }
      catch (cause) {
        const error = toError(cause);
        failure ??= error;
        manualRecovery ??= error.message;
        groups.push(pid);
        if (command) commands[pid] = command;
      }
    }
    if (job.groups.length || manualRecovery) {
      store.update(job.id, {
        groups, commands, recoveryStage: groups.length ? job.recoveryStage ?? job.stage : undefined,
        ...(manualRecovery ? { status: 'blocked', blockedReason: null, manualRecovery, error: manualRecovery } : {}),
      });
    }
    if (manualRecovery) failure ??= Object.assign(new Error(manualRecovery), { code: 'PROCESS_CLEANUP_BLOCKED' });
  }
  if (failure) throw failure;
}

/** Terminal failures already persisted in the queue, merged with the current invocation's failures (deduped by id). */
function queueFailures(store: Store, failed: Array<{ id: string; error: string | null }>): Array<{ id: string; error: string | null }> {
  const byId = new Map(failed.map(item => [item.id, item]));
  for (const job of store.list()) if ((job.status === 'failed' || job.status === 'needs-owner') && !byId.has(job.id)) byId.set(job.id, { id: job.id, error: job.error ?? null });
  return [...byId.values()];
}

/**
 * Drive the queue loop for unattended operation: execute due deterministic
 * stages (obfuscate/verify/package) automatically and claim the next host turn,
 * returning it for a host-side sub-agent. Stops as soon as a host turn is
 * claimed or the queue has no actionable work. `once` runs a single round,
 * `maxRounds` bounds deterministic steps, and `strict` reports failed jobs.
 */
export async function driveQueue(store: Store, config: Config, options: DriveOptions = {}): Promise<DriveResult> {
  const maxRounds = options.once ? 1 : options.maxRounds;
  const failed: Array<{ id: string; error: string | null }> = [];
  // Intake belongs to the loop (loopx-style frontier ingestion): every drive
  // sweeps the configured inbox first so submitted requirements join the
  // queue without the host remembering a separate scan command. Per-entry
  // intake errors are reported, never fatal to the loop itself.
  let intake: DriveResult['intake'];
  if (config.inbox) {
    const scan = await scanInbox(store, config);
    const errors = scan.entries.filter(entry => entry.status === 'error').map(entry => ({ source: entry.source, error: entry.error ?? 'requirement rejected' }));
    intake = { accepted: scan.entries.filter(entry => entry.status === 'accepted').length, ...(errors.length ? { errors } : {}) };
  }
  let rounds = 0;
  let lastResult: Job | undefined;
  while ((maxRounds === undefined || rounds < maxRounds) && !options.signal?.aborted) {
    const pick = await pickQueueTurn(store, { buildOnly: options.buildOnly, ownerPid: options.ownerPid });
    if (options.signal?.aborted) {
      if (pick.action === 'host') abandonTurn(store, pick.job.id, pick.turn.id, { buildOnly: options.buildOnly });
      break;
    }
    if (pick.action === 'idle') {
      const jobs = store.list();
      const pending = jobs.filter(job => !['built', 'failed', 'needs-owner'].includes(job.status)).length;
      const allFailed = queueFailures(store, failed);
      return {
        action: pending ? 'wait' : 'done',
        nextDueAt: pick.nextAt ?? undefined,
        rounds,
        ...(allFailed.length ? { failed: allFailed } : {}),
        ...(pick.pendingErrors.length ? { pendingErrors: pick.pendingErrors } : {}),
        summary: pick.summary,
        ...(intake ? { intake } : {}),
      };
    }
    if (pick.action === 'host') {
      const allFailed = queueFailures(store, failed);
      return { action: 'host', job: jobView(pick.job), turn: pick.turn, rounds, ...(allFailed.length ? { failed: allFailed } : {}), ...(intake ? { intake } : {}) };
    }
    let result: Job | undefined;
    store.acquire();
    try {
      // A crashed invocation may still own child processes; drain them before
      // shared Flutter/Apple tooling can be used by this new step.
      await drainCommandGroups(store);
      const claimed = store.next(current => current.id === pick.job.id && !current.workflow?.cancelled && !['research', 'build', 'review'].includes(current.stage));
      if (claimed) result = await executeStep(store, claimed, { signal: options.signal });
    } finally {
      try { await drainCommandGroups(store); }
      finally { store.release(); }
    }
    if (!result) continue; // A cancellation or eligibility change won the selection/claim race.
    rounds += 1;
    lastResult = result;
    if (result.status === 'failed' || result.status === 'needs-owner') failed.push({ id: result.id, error: result.error ?? null });
  }
  const allFailed = queueFailures(store, failed);
  return { action: options.signal?.aborted ? 'wait' : 'step', job: lastResult ? jobView(lastResult) : undefined, result: lastResult ? jobView(lastResult) : undefined, rounds, ...(allFailed.length ? { failed: allFailed } : {}), ...(intake ? { intake } : {}) };
}

function missingReviewReceipts(job: Job, boundary = job.turn?.decisionsLengthAtClaim): string[] {
  if (boundary === undefined || boundary > job.decisions.length) {
    throw new Error('Decision receipt boundary is unavailable for this persisted host turn; abandon this turn and reclaim it before recording receipts');
  }
  const available = new Map<string, number>();
  for (let index = boundary; index < job.decisions.length; index += 1) {
    const role = job.decisions[index].role;
    available.set(role, (available.get(role) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const seat of job.config.roles?.review ?? DEFAULT_ROLES.review) {
    const name = typeof seat === 'string' ? seat : seat.name;
    const count = available.get(name) ?? 0;
    if (count === 0) missing.push(name);
    else available.set(name, count - 1);
  }
  return missing;
}

function completeWorkflowTurn(store: Store, job: Job, token: string, value: unknown): Partial<Job> {
  if (job.workflow?.cancelled || !['research', 'build', 'review'].includes(job.stage) || job.status !== 'running') throw new Error('Stale, replayed or wrong-phase workflow token');
  if (job.groups.length || job.manualRecovery) throw new Error('Command recovery must finish before completing workflow work');
  const stage = job.stage as HostStage;
  const phase = job.workflow?.phases[stage];
  if (!phase) throw new Error('No persisted workflow phase owns this token');
  const planner = job.turn?.id === token && job.turn.kind === 'plan' ? job.turn : undefined;
  const node = phase.nodes.find(node => node.turn?.id === token);
  const claim = planner ?? node?.turn;
  if (!claim || claim.stage !== stage || claim.planRevision !== phase.revision) throw new Error('Stale, replayed or wrong-phase workflow token');
  if (claim.contextDigest !== workflowTurnDigest(job, stage, phase, planner ? undefined : node)) throw new Error('Workflow context changed; abandon this stale token before continuing');
  if (deadlineExpired(job)) return stopWorkflow(job, 'Task wall-clock limit reached; workflow result was not accepted');
  if (stage === 'review') {
    try { requireReviewProof(job); }
    catch (cause) {
      const reason = toError(cause).message;
      return { ...repair(job, reason), workflow: workflowState(job, stage, { ...phase, status: 'planning', reason, nodes: phase.nodes.map(pendingWorkflowNode) }) };
    }
  }
  if (planner) {
    if (phase.status !== 'planning' || activeWorkflowNodes(job).length) throw new Error('Drain active workflow nodes before accepting a revised plan');
    const accepted = applyWorkflowPlan(job, stage, value);
    store.event(job.id, { acceptedWorkflowPlan: accepted.revision, stage });
    return { workflow: workflowState(job, stage, { ...accepted, ...(stage === 'review' ? { proofDigest: verificationProofDigest(job) } : {}) }), turn: null, status: 'queued', error: null, nextAt: Date.now() };
  }
  if (!node || node.status !== 'running') throw new Error('Workflow node is not running under this token');
  const result = WorkflowNodeResultSchema.parse(value);
  if (result.outcome === 'passed' && !node.definition.acceptance.every(requirement => result.evidence.some(item => item.requirement === requirement))) throw new Error('Workflow node result must cover every declared acceptance criterion with observed evidence');
  if (stage === 'review' && result.outcome === 'passed') result.result = ReviewSchema.parse(result.result);
  const completed: WorkflowNodeState = { ...node, turn: null, status: result.outcome, result, completedAt: Date.now() };
  const nodes = phase.nodes.map(current => current === node ? completed : current);
  const nextPhase: WorkflowPhase = { ...phase, nodes, ...(result.outcome === 'failed' ? { status: 'planning', reason: `Node ${node.definition.id} failed: ${result.summary}` } : {}) };
  const workflow = workflowState(job, stage, nextPhase);
  store.event(job.id, { completedWorkflowNode: node.definition.id, token, revision: phase.revision, outcome: result.outcome });
  if (node.definition.id === phase.final && result.outcome === 'passed' && phase.status === 'running') {
    if (!nodes.every(current => current.status === 'passed' && !current.turn)) throw new Error('The workflow final node cannot bypass unfinished work');
    const finished = { ...nextPhase, status: 'complete' as const };
    let finalResult = result.result;
    if (stage === 'review') {
      const verdicts = nodes.map(current => ReviewSchema.parse(current.result?.result));
      const proposed = ReviewSchema.parse(result.result);
      finalResult = { ...proposed, approved: verdicts.every(verdict => verdict.approved), findings: [...new Set(verdicts.flatMap(verdict => verdict.findings))] };
    }
    return { workflow: workflowState(job, stage, finished), ...finishHostStage(store, { ...job, workflow }, token, stage === 'build' ? undefined : finalResult, phase.decisionsLengthAtClaim) };
  }
  return { workflow, status: nodes.some(current => current.turn) ? 'running' : 'queued', nextAt: Date.now(), ...(result.outcome === 'failed' ? { error: nextPhase.reason, feedback: nextPhase.reason } : {}) };
}

function abandonWorkflowTurn(store: Store, job: Job, token: string): Partial<Job> {
  if (job.groups.length || job.manualRecovery) throw new Error('Command recovery must finish before abandoning workflow work');
  if (job.turn?.id === token && job.turn.kind === 'plan') {
    store.event(job.id, { abandonedWorkflowPlanner: token, stage: job.turn.stage });
    return { turn: null, status: 'queued', nextAt: Date.now() };
  }
  const active = activeWorkflowNodes(job).find(entry => entry.node.turn?.id === token);
  if (!active) throw new Error('Stale or replayed workflow token; no active node was abandoned');
  const phase = job.workflow!.phases[active.stage]!;
  store.event(job.id, { abandonedWorkflowNode: active.node.definition.id, token, stage: active.stage });
  const nodes = phase.nodes.map(node => node === active.node ? pendingWorkflowNode(node) : node);
  return { workflow: workflowState(job, active.stage, { ...phase, nodes }), status: nodes.some(node => node.turn) ? 'running' : 'queued', nextAt: Date.now() };
}

function workflowReason(reason: string): string {
  if (!reason.trim() || reason.includes('\0') || reason.length > 20000) throw new Error('Workflow change requires a non-empty reason of at most 20000 characters');
  return reason;
}

export function requestWorkflowReplan(store: Store, id: string, reason: string): Job {
  workflowReason(reason);
  return store.transition(id, job => {
    if (!job.config.workflow || job.workflow?.cancelled) throw new Error('Replanning requires an enabled, non-cancelled dynamic workflow');
    if (!['research', 'build', 'review'].includes(job.stage) || ['built', 'ready', 'failed', 'needs-owner'].includes(job.status)) throw new Error('Replan host work only; stopped budgets require explicit owner retry and deterministic checks cannot be skipped');
    if (job.turn || job.groups.length || job.manualRecovery) throw new Error('Abandon the planner or finish command recovery before requesting another plan');
    const stage = job.stage as HostStage;
    const phase = job.workflow?.phases[stage] ?? newWorkflowPhase(reason);
    return { workflow: workflowState(job, stage, { ...phase, status: 'planning', reason }), status: activeWorkflowNodes(job).length ? 'running' : 'queued', feedback: reason, error: null, nextAt: Date.now() };
  });
}

export function cancelWorkflow(store: Store, id: string, reason: string): Job {
  workflowReason(reason);
  return store.transition(id, job => {
    if (!job.config.workflow) throw new Error('Cancellation requires an enabled dynamic workflow');
    if (['built', 'ready'].includes(job.status)) throw new Error('Cannot cancel an already delivered artifact');
    if (job.groups.length || job.manualRecovery || job.status === 'running' && !['research', 'build', 'review'].includes(job.stage)) throw new Error('Finish deterministic command recovery before cancelling the workflow');
    store.event(id, { cancelledWorkflow: reason });
    return { ...invalidateVerification(), ...stopWorkflow(job, `Workflow cancelled: ${reason}`, true) };
  });
}

/** Called only after the existing owner retry permission and budget checks pass. */
export function workflowRetryPatch(job: Job, resumedConfig: Config): Partial<Job> {
  if (!job.workflow?.cancelled) return {};
  if (!resumedConfig.workflow) throw new Error('Keep dynamic workflow mode enabled when retrying a cancelled task');
  const phases = { ...job.workflow.phases };
  const review = phases.review;
  if (review) phases.review = { ...review, status: 'planning', reason: 'Fresh review is required after cancellation', nodes: review.nodes.map(pendingWorkflowNode), decisionsLengthAtClaim: undefined, proofDigest: null };
  if (['research', 'build'].includes(job.stage)) {
    const stage = job.stage as 'research' | 'build';
    const phase = phases[stage];
    if (phase) phases[stage] = { ...phase, status: 'planning', reason: `Owner retry after cancellation: ${job.error ?? 'work was stopped'}` };
  }
  return { ...invalidateVerification(), workflow: { cancelled: false, phases }, ...(['review', 'package'].includes(job.stage) ? { stage: 'verify' as const } : {}) };
}

function missingWorkflowReceipts(job: Job, phase: WorkflowPhase): string[] {
  const available = new Map<string, number[]>();
  for (let index = 0; index < job.decisions.length; index += 1) {
    const role = job.decisions[index].role;
    const indices = available.get(role) ?? [];
    indices.push(index);
    available.set(role, indices);
  }
  const required = [...phase.nodes].sort((left, right) => (right.decisionsLengthAtClaim ?? 0) - (left.decisionsLengthAtClaim ?? 0));
  const missing = new Set<string>();
  for (const node of required) {
    const boundary = node.decisionsLengthAtClaim;
    if (boundary === undefined || boundary > job.decisions.length) throw new Error('Workflow receipt boundary is unavailable; replan and invalidate this review node before recording fresh receipts');
    const entries = available.get(node.definition.role);
    if (!entries?.length || entries[entries.length - 1] < boundary) missing.add(node.definition.id);
    else entries.pop();
  }
  return phase.nodes.filter(node => missing.has(node.definition.id)).map(node => node.definition.role);
}

function finishHostStage(store: Store, job: Job, turnId: string, result?: unknown, receiptBoundary?: number): Partial<Job> {
  let patch: Partial<Job>;
  if (job.stage === 'research') {
    const research = parseResearch(JSON.stringify(result), job.spec.channel);
    patch = research.viable ? { stage: 'build', research } : { status: 'needs-owner', research, error: 'Research rejected this product; owner input is required to revise the requirement or provide missing facts' };
  } else if (job.stage === 'build') {
    if (result !== undefined) throw new Error('Build completion accepts no result payload; actual deterministic verification is required');
    assertProject(projectDirectory(job), job.spec);
    patch = { ...invalidateVerification(), stage: job.config.obfuscation ? 'obfuscate' : 'verify' };
  } else {
    const review = ReviewSchema.parse(result);
    if (!job.spec.acceptance.every(requirement => review.acceptanceEvidence.some(item => item.requirement === requirement))) throw new Error('Review verdict must cover each acceptance requirement with concrete evidence');
    if (job.config.roles?.receipt) {
      const reviewPhase = job.workflow?.phases.review;
      const missing = reviewPhase ? missingWorkflowReceipts(job, reviewPhase) : missingReviewReceipts(job, receiptBoundary);
      if (missing.length) throw new Error(`Review seat receipts missing for: ${missing.join(', ')}; run each missing seat in its declared context, record it with apphx decide (role plus rationale), then complete this turn again`);
    }
    try { requireReviewProof(job); }
    catch (cause) { return { ...repair(job, toError(cause).message), review }; }
    if (!review.approved || review.findings.length) return { ...repair(job, `Independent review rejected the artifact: ${JSON.stringify(review)}`), review };
    patch = { stage: 'package', review };
  }
  store.event(job.id, { completedTurn: turnId, stage: job.stage });
  return { status: 'queued', nextAt: Date.now(), error: null, turn: null, ...patch };
}

export function completeTurn(store: Store, id: string, turnId: string, result?: unknown, options: TurnOptions = {}): Job {
  return store.transition(id, job => {
    assertTurnPermission(job, options);
    if (job.config.workflow) return completeWorkflowTurn(store, job, turnId, result);
    if (!job.turn || job.turn.id !== turnId || job.turn.stage !== job.stage || job.status !== 'running') throw new Error('Stale, replayed or wrong-phase host turn; use next to inspect the active token');
    if (contextDigest(job) !== job.turn.contextDigest) throw new Error('Host turn context changed; abandon this stale token before continuing');
    if (job.groups.length || job.manualRecovery) throw new Error('Command recovery must finish before completing a host turn');
    if (deadlineExpired(job)) return { turn: null, status: 'needs-owner', error: 'Task wall-clock limit reached; the expired host result was not accepted without owner intervention' };
    return finishHostStage(store, job, turnId, result);
  });
}

export function abandonTurn(store: Store, id: string, turnId: string, options: TurnOptions = {}): Job {
  return store.transition(id, job => {
    assertTurnPermission(job, options);
    if (job.config.workflow) return abandonWorkflowTurn(store, job, turnId);
    if (!job.turn || job.turn.id !== turnId) throw new Error('Stale or replayed host turn; no active claim was abandoned');
    if (job.groups.length || job.manualRecovery) throw new Error('Command recovery must finish before abandoning a host turn');
    store.event(id, { abandonedTurn: turnId, stage: job.turn.stage });
    return { turn: null, status: 'queued', nextAt: Date.now(), error: null };
  });
}

function next(store: Store, job: Job, stage: Stage, extra: Partial<Job> = {}): Job {
  remainingJobTime(job);
  return store.update(job.id, { stage, status: 'queued', nextAt: Date.now(), error: null, groups: [], ...extra });
}

export async function executeStep(store: Store, job: Job, { signal }: { signal?: AbortSignal } = {}): Promise<Job> {
  job = store.get(job.id);
  if (job.workflow?.cancelled || ['needs-owner', 'failed', 'ready', 'built'].includes(job.status)) return job;
  const config = job.config;
  let before: string | undefined;
  let dependenciesBefore: string | undefined;
  if (['research', 'build', 'review'].includes(job.stage) || job.turn || activeWorkflowNodes(job).length) throw new Error(`Stage ${job.stage} belongs to a native host turn; use next and complete`);
  if (signal?.aborted) return store.update(job.id, { status: 'waiting', nextAt: Date.now(), error: 'Worker was interrupted before this stage started' });
  if (!config.allowLocalExecution) return store.update(job.id, { status: 'blocked', error: config.executionWarning ?? 'Local execution is disabled. Explicitly enable allowLocalExecution only for trusted deterministic commands in a dedicated account or VM.' });
  if (deadlineExpired(job)) return store.update(job.id, { status: 'needs-owner', error: 'Task wall-clock limit reached; owner input is required to proceed' });
  const attemptNumber = (job.attempts[job.stage] ?? 0) + 1;
  let attempts = { ...job.attempts };
  let attemptCharged = false;
  const developerEnv = job.spec.framework === 'flutter' ? flutterEnvironment(config, job.workspace, executionEnvironment(config)) : executionEnvironment(config);
  const verifierEnv = job.spec.framework === 'flutter' ? flutterEnvironment(config, job.workspace, executionEnvironment(config), true) : developerEnv;
  const environment = ['verify', 'package'].includes(job.stage) ? verifierEnv : developerEnv;
  const logPath = join(config.stateDir, 'logs', job.id, `${job.stage}-${attemptNumber}-${Date.now()}.log`);
  store.update(job.id, { logs: [...job.logs, logPath] });
  const readableFiles = new Set<string>();
  const trackedRun = async (argv: string[], options: RunOptions = {}, capabilities: IsolationCapabilities = {}): Promise<RunResult> => {
    let pid: number | undefined;
    let isolated: IsolatedCommand | undefined;
    try {
      const effectiveEnv = options.env ?? environment;
      if (job.spec.framework === 'mygo') validateMyGoCommand(config, argv);
      const command = effectiveEnv.FLUTTER_ROOT && ['flutter', 'dart'].includes(argv[0]) ? [join(effectiveEnv.FLUTTER_ROOT, 'bin', argv[0]), ...argv.slice(1)] : argv;
      const cwd = options.cwd ?? projectDirectory(job);
      if (config.isolation && ['obfuscate', 'verify', 'package'].includes(job.stage)) {
        isolated = prepareIsolatedCommand(command, {
          config, workspace: job.workspace, cwd, env: effectiveEnv,
          readableFiles: [...readableFiles, ...(capabilities.readableFiles ?? [])],
          writableDirectories: capabilities.writableDirectories,
        });
      }
      const remaining = remainingJobTime(job);
      const result = await run(isolated?.argv ?? command, {
        signal, logPath, ...options, timeoutMs: Math.min(config.timeoutMs, options.timeoutMs ?? config.timeoutMs, remaining), cwd, env: isolated?.env ?? effectiveEnv,
        onSpawn: (value, metadata) => {
          pid = value;
          const current = store.get(job.id);
          store.update(job.id, { groups: [...current.groups, value], commands: { ...current.commands, [value]: metadata }, recoveryStage: job.stage });
          options.onSpawn?.(value, metadata);
        },
      });
      remainingJobTime(job);
      if (pid && processGroupAlive(pid)) {
        try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM'); } catch {}
        throw new Error('Command left background processes; termination was requested and replay will wait for the owned group to exit');
      }
      return result;
    } finally {
      try {
        const current = store.get(job.id);
        const groups = current.groups.filter(processGroupAlive);
        const commands = Object.fromEntries(Object.entries(current.commands ?? {}).filter(([pid]) => groups.includes(Number(pid))));
        store.update(job.id, { groups, commands, recoveryStage: groups.length ? current.recoveryStage ?? job.stage : undefined });
      } finally { isolated?.cleanup(); }
    }
  };
  const exec: Run = (argv, options) => trackedRun(argv, options);
  const utilityExec: Run = (argv, options) => {
    if (!config.isolation) return trackedRun(argv, options);
    if (argv[0] !== '/usr/bin/plutil') throw Object.assign(new Error('Unexpected isolated export utility'), { code: 'SETUP_REQUIRED' });
    const file = resolve(options?.cwd ?? projectDirectory(job), argv[argv.length - 1]!);
    const actual = canonicalPath(file), state = canonicalPath(config.stateDir), directory = dirname(actual);
    const within = (root: string, target: string): boolean => {
      const path = relative(root, target);
      return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    };
    if (within(job.workspace, file) && !within(job.workspace, actual)
      && !config.isolation.readOnlyPaths.some(root => within(root, actual))) throw Object.assign(new Error('Workspace export options cannot grant access to an unapproved external file'), { code: 'SETUP_REQUIRED' });
    const snapshot = dirname(directory) === state && basename(directory).startsWith('export-options-') && basename(actual) === 'ExportOptions.plist';
    if (within(state, actual) && !snapshot || within(canonicalPath(config.workspaceRoot), actual) && !within(job.workspace, actual)
      || config.configPath && actual === canonicalPath(config.configPath)) throw Object.assign(new Error('Export utility cannot read protected control state or another task'), { code: 'SETUP_REQUIRED' });
    const writing = argv[1] === '-convert' && argv[2] === 'xml1';
    if (writing && !snapshot) throw Object.assign(new Error('Export utility writes require a harness-owned snapshot'), { code: 'SETUP_REQUIRED' });
    return trackedRun([...argv.slice(0, -1), actual], options, {
      readableFiles: within(job.workspace, actual) ? [] : [actual],
      writableDirectories: writing ? [directory] : [],
    });
  };
  const removeArtifact = async (output: string): Promise<void> => {
    if (!config.isolation) { rmSync(output, { recursive: true, force: true }); return; }
    const result = await exec(['/bin/rm', '-rf', '--', output]);
    if (result.code !== 0) throw Object.assign(new Error(`Isolated artifact cleanup was denied: ${result.stderr || result.stdout}`), { code: 'SETUP_REQUIRED' });
  };
  try {
    validateJobConfig(job.spec, config);
    if (job.spec.framework === 'mygo') validateMyGoPackaging(config);
    prepareWorkspace(store, job);
    mkdirSync(projectDirectory(job), { recursive: true, mode: 0o700 });
    if (job.spec.framework === 'mygo') {
      Object.assign(developerEnv, {
        GOENV: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly',
        GOWORK: closestOwnedGoWorkspace(job.workspace, job.spec.project?.directory) ?? 'off',
        GOCACHE: developerEnv.GOCACHE ?? join(config.stateDir, 'verification-cache', 'go-build'),
        GOMODCACHE: developerEnv.GOMODCACHE ?? join(config.stateDir, 'verification-cache', 'go-mod'),
      });
      for (const key of ['MYGO_UPDATER_PRIVATE_KEY', 'MYGO_WINDOWS_CERTIFICATE_PASSWORD', 'MYGO_CLI_BINARY', 'MYGO_LDFLAGS', 'MYGO_GENERATE', 'MYGO_INSPECTOR']) delete developerEnv[key];
    }
    if (job.stage === 'verify' || job.stage === 'package') {
      await checkPrerequisites(config.verification.prerequisites ?? [], { cwd: projectDirectory(job), env: environment, run: exec, signal });
    }
    if ((job.attempts[job.stage] ?? 0) >= config.maxAttempts) return store.update(job.id, { status: 'needs-owner', error: `Attempt limit reached at ${job.stage}; owner input is required to proceed` });
    if (job.spec.framework === 'flutter' && config.toolchain && ['verify', 'package'].includes(job.stage)) {
      const toolchain = await prepareFlutter(job, { run: exec, env: developerEnv, signal });
      if (toolchain) store.update(job.id, { toolchain });
    }
    attempts = { ...attempts, [job.stage]: attemptNumber };
    store.update(job.id, { attempts });
    attemptCharged = true;
    if (job.stage === 'verify') {
      if (job.spec.framework === 'flutter' && config.toolchain) {
        const dependencies = await exec(['flutter', 'pub', 'get']);
        if (dependencies.code !== 0) throw new Error(`Verification dependency resolution failed: ${dependencies.stderr.slice(-4000)}`);
      }
      if (job.spec.screenshotsDir) {
        const screenshots = inside(projectDirectory(job), job.spec.screenshotsDir);
        if (existsSync(screenshots)) {
          for (const entry of readdirSync(screenshots)) rmSync(join(screenshots, entry), { recursive: true, force: true });
        }
      }
      before = sourceDigest(job.workspace, true, job.spec.framework, job.spec.project?.directory);
      dependenciesBefore = dependencyDigest(job.workspace, job.spec.framework, job.spec.project?.directory);
      for (const argv of [...config.verification.checks, ...config.verification.runtime]) {
        const result = await exec(expandArgv(argv, executionEnvironment(config)));
        if (result.code !== 0) throw new Error(`Verification failed (${result.code}) ${JSON.stringify(argv)}:\n${result.stderr.slice(-5000)}\n${result.stdout.slice(-5000)}`);
      }
      if (sourceDigest(job.workspace, true, job.spec.framework, job.spec.project?.directory) !== before) throw new Error('Verification changed source files; the new revision must be verified again');
      if (dependencyDigest(job.workspace, job.spec.framework, job.spec.project?.directory) !== dependenciesBefore) throw new Error('Verification changed dependency resolution; the new resolution must be verified again');
      const screenshotDigest = job.spec.screenshotsDir ? sourceDigest(inside(projectDirectory(job), job.spec.screenshotsDir), false) : null;
      return next(store, job, 'review', { verifiedDigest: before, verifiedDependencyDigest: dependenciesBefore, screenshotDigest, verifiedAt: new Date().toISOString() });
    }
    if (job.stage === 'obfuscate') {
      const obfuscation = job.config.obfuscation;
      if (!obfuscation) throw Object.assign(new Error('Obfuscation stage requires config.obfuscation'), { code: 'SETUP_REQUIRED' });
      const obfuscationBase = { digest: sourceDigest(job.workspace, true, job.spec.framework, job.spec.project?.directory), path: projectDirectory(job) };
      let configPath = obfuscation.configPath;
      let snapshot: string | undefined;
      if (!configPath) {
        // Inline rules are materialized as a harness-owned snapshot file; the
        // obfuscator validates them at run time, and the snapshot never becomes
        // part of the verified source.
        const directory = join(config.stateDir, 'obfuscation');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        snapshot = join(directory, `${job.id}-${Date.now()}.json`);
        writeFileSync(snapshot, `${JSON.stringify(obfuscation.options ?? {}, null, 2)}\n`, { mode: 0o600 });
        configPath = snapshot;
      }
      try {
        const expanded = expandArgv(obfuscation.command, environment);
        // The default command resolves to the private obfuscator bundled inside this package, so it
        // works for global installs, local dependency installs and the macOS sandbox alike.
        const bundled = fileURLToPath(new URL('./vendor/obfuscator/dist/cli.js', import.meta.url));
        const resolved = expanded[0] === 'obfuscator' && existsSync(bundled) ? [process.execPath, bundled, ...expanded.slice(1)] : expanded;
        const argv = [
          ...resolved,
          '--project', projectDirectory(job),
          '--config', configPath!,
          '--framework', job.spec.framework,
          ...(obfuscation.seed ? ['--seed', obfuscation.seed] : []),
        ];
        const result = await trackedRun(argv, {}, { readableFiles: [configPath!] });
        if (result.code !== 0) throw new Error(`Obfuscation failed (${result.code}) ${JSON.stringify(argv)}:\n${result.stderr.slice(-5000)}\n${result.stdout.slice(-5000)}`);
        let report: Job['obfuscationReport'];
        try {
          const parsed: unknown = JSON.parse(result.stdout);
          if (parsed && typeof parsed === 'object') {
            const value = parsed as Record<string, unknown>;
            const skipped = value.skipped && typeof value.skipped === 'object' ? value.skipped as Record<string, unknown> : {};
            if (Number.isSafeInteger(value.changedFiles) && value.transforms && typeof value.transforms === 'object' && !Array.isArray(value.transforms)) {
              report = {
                changedFiles: value.changedFiles as number,
                transforms: Object.fromEntries(Object.entries(value.transforms).filter(([key, count]) => typeof key === 'string' && Number.isSafeInteger(count)) as Array<[string, number]>),
                skipped: { generated: Number.isSafeInteger(skipped.generated) ? skipped.generated as number : 0, unsupported: Number.isSafeInteger(skipped.unsupported) ? skipped.unsupported as number : 0 },
              };
            }
          }
        } catch { /* report stays undefined */ }
        // The bundled obfuscator always prints a typed report; a custom command may not.
        if (!report && resolved[0] === process.execPath && resolved[1] === bundled) throw new Error('Bundled obfuscator produced no valid report; the transformed workspace cannot be evidenced');
        const obfuscationDigest = sourceDigest(job.workspace, true, job.spec.framework, job.spec.project?.directory);
        return next(store, job, 'verify', { obfuscationBase, obfuscationDigest, ...(report ? { obfuscationReport: report } : {}) });
      } finally {
        if (snapshot) rmSync(snapshot, { force: true });
      }
    }
    if (job.stage === 'package') {
      requireReviewProof(job);
      if (!job.review?.approved || job.review.findings.length) throw new Error('Packaging requires an approved host review');
      const target = config.packageTarget;
      const project = projectDirectory(job);
      const profile = config.packaging;
      if (job.cloudBuildPending) throw Object.assign(new Error('A previous cloud build may have remote effects. Reconcile it with the provider before creating a new task; this build will not be replayed.'), { code: 'SETUP_REQUIRED' });
      if (['ios', 'macos'].includes(job.spec.platform) && profile?.provider !== 'cloud' && process.platform !== 'darwin') throw Object.assign(new Error(`Local ${job.spec.platform} packaging requires a macOS worker`), { code: 'SETUP_REQUIRED' });
      let path: string;
      store.update(job.id, { artifact: null, ipaPath: null, archiveDigest: null });
      if (profile) {
        const output = artifactOutputPath(project, profile.artifactPath);
        const outputRelative = relative(job.workspace, output).split(sep).join('/');
        let generated = isGeneratedPath(profile.artifactPath, job.spec.framework);
        if (!generated) for (const module of generatedModulePaths(job.workspace, job.spec.framework, job.spec.project?.directory)) if (outputRelative.startsWith(`${module}/`)) { generated = true; break; }
        if (!generated || !/(?:^|\/)(?:build|dist|unpackage)(?:\/|$)/.test(profile.artifactPath) || /(?:^|\/)(?:node_modules|\.git|\.gradle|\.factory-cache|Pods)(?:\/|$)/.test(profile.artifactPath)) throw Object.assign(new Error('packaging.artifactPath must name an exact generated build/dist/unpackage artifact, never source or dependency caches'), { code: 'SETUP_REQUIRED' });
        if (!output.endsWith(target === 'simulator' || target === 'app' ? '.app' : `.${target}`)) throw Object.assign(new Error(`packaging.artifactPath must end in ${target === 'simulator' || target === 'app' ? '.app' : `.${target}`}`), { code: 'SETUP_REQUIRED' });
        const prepared = await prepareNativeExportCommands(profile.commands.map(argv => expandArgv(argv, executionEnvironment(config))), project, config.stateDir, utilityExec);
        try {
          for (const file of prepared.readableFiles) readableFiles.add(file);
          await removeArtifact(output);
          if (profile.provider === 'cloud') store.update(job.id, { cloudBuildPending: true });
          for (const argv of prepared.commands) {
            const result = await exec(argv);
            if (result.code !== 0) throw new Error(`Packaging failed (${result.code}) ${JSON.stringify(argv)}:\n${result.stderr.slice(-5000)}\n${result.stdout.slice(-5000)}`);
          }
          path = artifactOutputPath(project, profile.artifactPath);
        } finally {
          for (const file of prepared.readableFiles) readableFiles.delete(file);
          prepared.cleanup();
        }
      } else {
        const output = artifactOutputPath(project, target === 'ipa' ? 'build/ios/ipa' : target === 'simulator' ? 'build/ios/iphonesimulator' : target === 'apk' ? 'build/app/outputs/flutter-apk' : 'build/app/outputs/bundle/release');
        if (target === 'ipa' && !config.apple?.exportOptionsPlist) throw Object.assign(new Error('Configure apple.exportOptionsPlist and valid local signing before IPA packaging'), { code: 'SETUP_REQUIRED' });
        if (target === 'ipa' && !job.spec.apple?.buildNumber) throw Object.assign(new Error('apple.buildNumber is required for IPA signing'), { code: 'SETUP_REQUIRED' });
        let exportOptions: { directory: string; path: string } | undefined;
        try {
          if (target === 'ipa') {
            exportOptions = await prepareExportOptions(config.apple!.exportOptionsPlist!, config.stateDir, utilityExec);
            readableFiles.add(exportOptions.path);
          }
          await removeArtifact(output);
          const argv = target === 'ipa'
            ? ['flutter', 'build', 'ipa', '--release', '--build-name', job.spec.version, '--build-number', job.spec.apple!.buildNumber!, '--export-options-plist', exportOptions!.path]
            : target === 'simulator' ? ['flutter', 'build', 'ios', '--simulator', '--debug', '--no-pub']
              : ['flutter', 'build', target === 'apk' ? 'apk' : 'appbundle', '--release', '--no-pub', '--build-name', job.spec.version];
          const built = await exec(argv);
          if (built.code !== 0) throw new Error(`${job.spec.framework} ${target} build failed: ${built.stderr.slice(-5000)}`);
        } finally {
          if (exportOptions) {
            readableFiles.delete(exportOptions.path);
            rmSync(exportOptions.directory, { recursive: true, force: true });
          }
        }
        const products = readdirSync(output).filter(name => name.endsWith(target === 'simulator' ? '.app' : `.${target}`));
        if (products.length !== 1) throw new Error(`Expected exactly one ${target} artifact in ${relative(job.workspace, output)}`);
        path = artifactOutputPath(project, join(relative(project, output), products[0]));
      }
      requireReviewProof(job);
      const stat = lstatSync(path);
      const bundle = target === 'simulator' || target === 'app';
      if (stat.isSymbolicLink() || (bundle ? !stat.isDirectory() || readdirSync(path).length === 0 : !stat.isFile() || stat.size === 0)) throw new Error('Packaging did not produce a nonempty regular artifact of the requested kind');
      if (target === 'app' || target === 'dmg') await validateMacOSArtifact(path, target, exec);
      const digest = bundle ? sourceDigest(path, false) : createHash('sha256').update(readFileSync(path)).digest('hex');
      const artifact = { kind: target === 'simulator' ? 'ios-simulator' as const : target === 'app' ? 'macos-app' as const : target, path, digest, createdAt: new Date().toISOString() };
      remainingJobTime(job);
      return store.update(job.id, { status: 'built', artifact, cloudBuildPending: false, error: null });
    }
    throw new Error(`Unknown task stage ${job.stage}`);
  } catch (cause) {
    const error = toError(cause);
    if (store.get(job.id).cloudBuildPending) return store.update(job.id, { status: 'blocked', blockedReason: null, error: `Cloud build outcome requires provider reconciliation; automatic replay is forbidden. ${error.message}` });
    if (error.code === 'PROCESS_CLEANUP_BLOCKED') return store.update(job.id, { status: 'blocked', blockedReason: null, manualRecovery: error.message, error: error.message });
    if (error.code === 'BUDGET' || deadlineExpired(job)) return store.update(job.id, { status: 'needs-owner', ...invalidateVerification(), turn: null, error: 'Task wall-clock limit reached; owner input is required before any further execution', feedback: error.message });
    if (signal?.aborted) return store.update(job.id, { status: 'waiting', attempts: { ...attempts, [job.stage]: job.attempts[job.stage] ?? 0 }, nextAt: Date.now(), error: error.message });
    if (error.code === 'PREREQUISITE_FAILED' && error.prerequisite) return store.update(job.id, { status: 'blocked', blockedReason: { kind: 'prerequisite', stage: job.stage, prerequisite: error.prerequisite }, attempts: { ...job.attempts }, nextAt: Date.now() + config.pollMs, error: error.message });
    if (!attemptCharged) return store.update(job.id, { status: 'blocked', blockedReason: null, attempts: { ...job.attempts }, nextAt: Date.now(), error: error.message });
    const blocked = (error.code === 'ENOENT' && error.syscall?.startsWith('spawn')) || /SETUP_REQUIRED|UNSUPPORTED|PROCESS_CLEANUP_BLOCKED/.test(error.code ?? '');
    if (blocked) return store.update(job.id, { status: 'blocked', error: error.message });
    const charged = attempts[job.stage] ?? 0;
    const exhausted = error.code === 'BUDGET' || charged >= config.maxAttempts;
    if (config.workflow) {
      // Local deterministic failure is evidence for a bounded repair plan. The
      // model diagnoses source/tooling without changing frozen permissions or
      // commands; unknown external effects and prerequisites were fenced above.
      const build = job.workflow?.phases.build ?? newWorkflowPhase(error.message);
      const workflow = workflowState(job, 'build', { ...build, status: 'planning', reason: `${job.stage} failed: ${error.message}` });
      return store.update(job.id, { ...repair({ ...job, attempts }, error.message), workflow, status: exhausted ? 'needs-owner' : 'waiting', nextAt: Date.now() + config.retryDelayMs * charged });
    }
    if (job.stage === 'verify') {
      let changed = before === undefined || dependenciesBefore === undefined;
      if (!changed) {
        try {
          changed = sourceDigest(job.workspace, true, job.spec.framework, job.spec.project?.directory) !== before
            || dependencyDigest(job.workspace, job.spec.framework, job.spec.project?.directory) !== dependenciesBefore;
        } catch { changed = true; }
      }
      if (!changed) {
        return store.update(job.id, { stage: 'verify', status: exhausted ? 'needs-owner' : 'waiting', recoveryStage: 'verify', ...invalidateVerification(), turn: null, feedback: error.message, error: error.message, nextAt: Date.now() + config.retryDelayMs * charged });
      }
      return store.update(job.id, { ...repair({ ...job, attempts }, error.message), status: exhausted ? 'needs-owner' : 'waiting', nextAt: Date.now() + config.retryDelayMs * charged });
    }
    if (job.stage === 'package' && error.code === 'EVIDENCE_CHANGED') return store.update(job.id, { ...repair({ ...job, attempts }, error.message), status: exhausted ? 'needs-owner' : 'waiting', nextAt: Date.now() + config.retryDelayMs * charged });
    return store.update(job.id, { status: exhausted ? 'needs-owner' : 'waiting', error: error.message, feedback: error.message, nextAt: Date.now() + config.retryDelayMs * charged });
  }
}
