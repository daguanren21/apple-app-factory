import { mkdirSync, readFileSync, readdirSync, lstatSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, resolve, delimiter, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { run, executionEnvironment, processGroupAlive } from './process.js';
import { canonicalPath, inside, expandArgv } from './config.js';
import { checkPrerequisites } from './preflight.js';
import { flutterEnvironment, prepareFlutter } from './flutter.js';
import { prepareExportOptions, prepareNativeExportCommands } from './export-options.js';
import { dependencyDigest, generatedModulePaths, isGeneratedPath } from './dependencies.js';
import { ReviewSchema, SpecSchema, toError, validateJobConfig } from './schemas.js';
import type { Job, HostStage, Stage } from './schemas.js';
import type { Run, RunOptions, RunResult } from './process.js';
import type { Store } from './store.js';
import { sourceDigest, prepareWorkspace, projectDirectory, artifactOutputPath } from './workspace.js';
import { parseResearch, researchPrompt, reviewInstructions } from './policy.js';
import { assertProject, buildInstructions } from './project-profiles.js';
import { closestOwnedGoWorkspace } from './go-dependencies.js';
import { validateMacOSArtifact } from './macos.js';
import { validateMyGoPackaging, validateMyGoCommand } from './mygo-build.js';
import { invalidateVerification } from './proof.js';
import { prepareIsolatedCommand, type IsolatedCommand, type IsolationCapabilities } from './isolation.js';

function requireDependencyProof(job: Job): void {
  if (!job.verifiedDependencyDigest) throw Object.assign(new Error('Dependency resolution proof is missing; retry this stopped task to re-run verification'), { code: 'SETUP_REQUIRED' });
  if (dependencyDigest(job.workspace, job.spec.framework, job.spec.project?.directory) !== job.verifiedDependencyDigest) throw Object.assign(new Error('Dependency resolution changed since verification; re-verification is required'), { code: 'EVIDENCE_CHANGED' });
}

function taskPrompt(job: Job): string {
  const autopilot = job.config.autopilot === true
    ? `AUTOPILOT MODE — owner-preauthorized unattended execution. Never ask the user a question or wait for a reply. For every non-trivial decision point, dispatch a decision-maker sub-context using the host's native subagent capability to decide and record its rationale. When compilation, tests or verification fail, dispatch the failure evidence to a developer sub-context, fix the actual cause, and iterate until the checks pass; never weaken acceptance to make them pass. Independent review must still be performed by a brand-new sub-context that did not implement this change (use the host's native subagent facility); never self-review or impersonate an independent reviewer. Local execution is already pre-authorized by the owner: allowLocalExecution=true is the owner's explicit choice, so run deterministic configured commands directly. The honest-degradation path remains mandatory: never fabricate results, screenshots or evidence, and never bypass acceptance. The only permitted stop is a safety red line — leaking credentials, fabricating evidence, or bypassing acceptance — and that stop must be reported as an honest verdict, never as a question to the user.\n`
    : '';
  return `${autopilot}You are the native host of an embedded multi-stack app Harness. Use your own context, tools and native delegation in ${projectDirectory(job)}; never launch another coding-agent CLI. Preserve the requested framework and existing architecture. Implement only this product. Never hide functionality from users or reviewers. Do not upload, submit, push, read publisher credentials or change factory state. Remote build commands belong only to the explicitly authorized Harness packaging profile, not host turns. The workspace is not a security sandbox. Complete real implementations, not placeholders.\nImmutable product requirements:\n${JSON.stringify(job.spec, null, 2)}\nPrevious verification/review failure (repair the mechanism, never weaken acceptance):\n${job.feedback ?? job.error ?? 'none'}\nPersisted execution logs:\n${JSON.stringify(job.logs.slice(-3))}\nContinue existing work. Only actual deterministic checks performed by the Harness establish verification; host claims do not.\n`;
}

export interface TurnOptions { buildOnly?: boolean }
export interface HostAction {
  job: Job;
  action: 'host' | 'step' | 'wait' | 'done';
  turn?: { id: string; stage: HostStage; prompt: string; cwd: string; environment: Record<string, string>; role: string[] };
}

const DEFAULT_ROLES: Record<HostStage, string[]> = {
  research: ['product-analyst'],
  build: ['ui-designer', 'developer'],
  review: ['architect-review', 'qa-engineer', 'acceptance-reviewer'],
};

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

function requireReviewProof(job: Job): void {
  try {
    if (!job.verifiedDigest || sourceDigest(job.workspace, true, job.spec.framework, job.spec.project?.directory) !== job.verifiedDigest) throw new Error('Source changed since verification; stale evidence cannot approve a handoff');
    requireDependencyProof(job);
    if (job.spec.screenshotsDir && sourceDigest(inside(projectDirectory(job), job.spec.screenshotsDir), false) !== job.screenshotDigest) throw new Error('Screenshots changed since runtime verification; stale evidence cannot approve a handoff');
  } catch (cause) {
    const error = toError(cause);
    if (error.code !== 'SETUP_REQUIRED') error.code = 'EVIDENCE_CHANGED';
    throw error;
  }
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
    instruction = `Research plan: ${JSON.stringify(job.research)}\n${buildInstructions(job.spec)} ${uiDesignerFlow} Under autopilot the same holds: both roles run through the host's native subagents and never ask the user. Implement the entire requested product, accessibility and realistic empty/error states. Add genuine device/simulator acceptance workflows and real screenshots when requested; never fake screenshots or bypass tests. Do not add unrequested offline/backup/account features. Use the returned environment with your tools. Frozen verification and packaging: ${JSON.stringify({ verification: job.config.verification, packaging: job.config.packaging, packageTarget: job.config.packageTarget })}. Complete this turn without a result payload when source is ready; the Harness will then execute verification, not infer success.`;
  } else {
    instruction = reviewInstructions(job);
  }
  // Host-visible JSON carries only task overrides, never inherited credential values.
  const environment = job.spec.framework === 'flutter' ? flutterEnvironment(job.config, job.workspace, { CI: '1' }) : { CI: '1' } as NodeJS.ProcessEnv;
  if (job.spec.framework === 'mygo') Object.assign(environment, { GOENV: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly', GOWORK: closestOwnedGoWorkspace(job.workspace, job.spec.project?.directory) ?? 'off' });
  if (job.spec.framework === 'flutter' && job.config.toolchain) {
    environment.FLUTTER_ROOT = job.config.toolchain.flutterSdk;
    environment.PATH = `${join(job.config.toolchain.flutterSdk, 'bin')}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ''}`;
  }
  const role = [...(job.config.roles?.[turn.stage] ?? DEFAULT_ROLES[turn.stage])];
  const prompt = `${taskPrompt(job)}${instruction}\nTurn roles (adopt every role through your native delegation, with independent contexts where the skill requires them): ${JSON.stringify(role)}`;
  return { job, action: 'host', turn: { id: turn.id, stage: turn.stage, prompt, cwd: projectDirectory(job), environment: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)), role } };
}

function repair(job: Job, message: string): Partial<Job> {
  return {
    stage: 'build', status: (job.attempts[job.stage] ?? 0) >= job.config.maxAttempts ? 'failed' : 'waiting',
    ...invalidateVerification(), turn: null, feedback: message, error: message,
    nextAt: Date.now() + job.config.retryDelayMs,
  };
}

export async function nextTurn(store: Store, id: string, options: TurnOptions = {}): Promise<HostAction> {
  store.acquire();
  try {
    let job = store.get(id);
    assertTurnPermission(job, options);
    if (job.turn) {
      if (job.status !== 'running' || job.stage !== job.turn.stage || contextDigest(job) !== job.turn.contextDigest) throw new Error('Active host turn context changed; abandon its token before requesting another turn');
      if (deadlineExpired(job)) {
        const claimed = job.turn;
        job = store.transition(id, current => {
          assertTurnPermission(current, options);
          if (current.turn?.id !== claimed.id || contextDigest(current) !== claimed.contextDigest) throw new Error('Host turn changed while checking its deadline; inspect the current task');
          return { turn: null, status: 'failed', error: 'Task wall-clock limit reached; the expired host turn cannot resume' };
        });
        return { job, action: 'done' };
      }
      return hostAction(store, job);
    }
    if (job.groups.length && !job.manualRecovery) return { job, action: 'step' };
    if (['failed', 'ready', 'built'].includes(job.status)) return { job, action: 'done' };
    const eligible = ['queued', 'waiting'].includes(job.status) || (job.status === 'blocked' && job.blockedReason?.kind === 'prerequisite');
    if (!eligible || job.nextAt > Date.now() || job.manualRecovery) return { job, action: 'wait' };
    if (!['research', 'build', 'review'].includes(job.stage)) return { job, action: 'step' };
    if (deadlineExpired(job) || job.hostTurns >= job.config.maxHostTurns || (job.attempts[job.stage] ?? 0) >= job.config.maxAttempts) {
      job = store.transition(id, current => {
        assertTurnPermission(current, options);
        return { status: 'failed', error: 'Host turn, stage attempt or task wall-clock limit reached; no further host work will start' };
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
      if (deadlineExpired(current) || current.hostTurns >= current.config.maxHostTurns || (current.attempts[current.stage] ?? 0) >= current.config.maxAttempts) return { status: 'failed', error: 'Host turn, stage attempt or task wall-clock limit reached; no further host work will start' };
      if (current.stage === 'review') requireReviewProof(current);
      const turn = { id: randomUUID(), stage: current.stage as HostStage, createdAt: Date.now(), contextDigest: contextDigest(current) };
      return { turn, hostTurns: current.hostTurns + 1, attempts: { ...current.attempts, [current.stage]: (current.attempts[current.stage] ?? 0) + 1 }, status: 'running', blockedReason: null, error: null };
    });
    return job.turn ? hostAction(store, job) : { job, action: 'done' };
  } finally { store.release(); }
}

export type QueueTurn =
  | HostAction
  | { action: 'idle'; nextAt: number | null; pendingErrors: Array<{ id: string; error: string }>; summary: QueueSummary };

export type QueueSummary = { total: number; built: number; failed: number; blocked: number; waiting: number; queued: number; running: number };

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
  const pendingErrors: Array<{ id: string; error: string }> = [];
  // Priority lanes order the scan (P0 > P1 > P2); within a lane, earliest due
  // time wins, then insertion order. Priority never overrides eligibility:
  // a deferred P0 job is skipped and the scan continues to the next safe action.
  const rank = (job: Job): number => job.spec.priority === 'P0' ? 0 : job.spec.priority === 'P2' ? 2 : 1;
  const jobs = [...store.list()].sort((left, right) => rank(left) - rank(right) || left.nextAt - right.nextAt);
  for (const job of jobs) {
    try {
      const action = await nextTurn(store, job.id, options);
      if (action.action === 'host' || action.action === 'step') return action;
    } catch (cause) {
      pendingErrors.push({ id: job.id, error: toError(cause).message });
    }
  }
  const summary: QueueSummary = { total: jobs.length, built: 0, failed: 0, blocked: 0, waiting: 0, queued: 0, running: 0 };
  for (const job of jobs) {
    const status = job.status;
    if (status === 'built' || status === 'failed' || status === 'blocked' || status === 'waiting' || status === 'queued' || status === 'running') summary[status] += 1;
  }
  const due = jobs.map(job => job.nextAt).filter(nextAt => nextAt > Date.now());
  return { action: 'idle', nextAt: due.length ? Math.min(...due) : null, pendingErrors, summary };
}

export function completeTurn(store: Store, id: string, turnId: string, result?: unknown, options: TurnOptions = {}): Job {
  return store.transition(id, job => {
    assertTurnPermission(job, options);
    if (!job.turn || job.turn.id !== turnId || job.turn.stage !== job.stage || job.status !== 'running') throw new Error('Stale, replayed or wrong-phase host turn; use next to inspect the active token');
    if (contextDigest(job) !== job.turn.contextDigest) throw new Error('Host turn context changed; abandon this stale token before continuing');
    if (job.groups.length || job.manualRecovery) throw new Error('Command recovery must finish before completing a host turn');
    if (deadlineExpired(job)) return { turn: null, status: 'failed', error: 'Task wall-clock limit reached; the expired host result was not accepted' };
    let patch: Partial<Job>;
    if (job.stage === 'research') {
      const research = parseResearch(JSON.stringify(result), job.spec.channel);
      patch = research.viable ? { stage: 'build', research } : { status: 'failed', research, error: 'Research rejected this product; no replacement product will be attempted' };
    } else if (job.stage === 'build') {
      if (result !== undefined) throw new Error('Build completion accepts no result payload; actual deterministic verification is required');
      assertProject(projectDirectory(job), job.spec);
      patch = { ...invalidateVerification(), stage: job.config.obfuscation ? 'obfuscate' : 'verify' };
    } else {
      const review = ReviewSchema.parse(result);
      if (!job.spec.acceptance.every(requirement => review.acceptanceEvidence.some(item => item.requirement === requirement))) throw new Error('Review verdict must cover each acceptance requirement with concrete evidence');
      try { requireReviewProof(job); }
      catch (cause) { return repair(job, toError(cause).message); }
      if (!review.approved || review.findings.length) return { ...repair(job, `Independent review rejected the artifact: ${JSON.stringify(review)}`), review };
      patch = { stage: 'package', review };
    }
    store.event(id, { completedTurn: turnId, stage: job.stage });
    return { status: 'queued', nextAt: Date.now(), error: null, turn: null, ...patch };
  });
}

export function abandonTurn(store: Store, id: string, turnId: string, options: TurnOptions = {}): Job {
  return store.transition(id, job => {
    assertTurnPermission(job, options);
    if (!job.turn || job.turn.id !== turnId) throw new Error('Stale or replayed host turn; no active claim was abandoned');
    if (job.groups.length || job.manualRecovery) throw new Error('Command recovery must finish before abandoning a host turn');
    store.event(id, { abandonedTurn: turnId, stage: job.turn.stage });
    return { turn: null, status: 'queued', nextAt: Date.now(), error: null };
  });
}

function next(store: Store, job: Job, stage: Stage, extra: Partial<Job> = {}): Job {
  return store.update(job.id, { stage, status: 'queued', nextAt: Date.now(), error: null, groups: [], ...extra });
}

export async function executeStep(store: Store, job: Job, { signal }: { signal?: AbortSignal } = {}): Promise<Job> {
  const config = job.config;
  if (['research', 'build', 'review'].includes(job.stage) || job.turn) throw new Error(`Stage ${job.stage} belongs to a native host turn; use next and complete`);
  if (signal?.aborted) return store.update(job.id, { status: 'waiting', nextAt: Date.now(), error: 'Worker was interrupted before this stage started' });
  if (!config.allowLocalExecution) return store.update(job.id, { status: 'blocked', error: config.executionWarning ?? 'Local execution is disabled. Explicitly enable allowLocalExecution only for trusted deterministic commands in a dedicated account or VM.' });
  if (deadlineExpired(job)) return store.update(job.id, { status: 'failed', error: 'Task wall-clock limit reached; no further work will start' });
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
      const result = await run(isolated?.argv ?? command, {
        timeoutMs: config.timeoutMs, signal, logPath, ...options, cwd, env: isolated?.env ?? effectiveEnv,
        onSpawn: (value, metadata) => {
          pid = value;
          const current = store.get(job.id);
          store.update(job.id, { groups: [...current.groups, value], commands: { ...current.commands, [value]: metadata }, recoveryStage: job.stage });
          options.onSpawn?.(value, metadata);
        },
      });
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
    if ((job.attempts[job.stage] ?? 0) >= config.maxAttempts) return store.update(job.id, { status: 'failed', error: `Attempt limit reached at ${job.stage}` });
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
      const before = sourceDigest(job.workspace, true, job.spec.framework, job.spec.project?.directory);
      const dependenciesBefore = dependencyDigest(job.workspace, job.spec.framework, job.spec.project?.directory);
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
      return store.update(job.id, { status: 'built', artifact, cloudBuildPending: false, error: null });
    }
    throw new Error(`Unknown task stage ${job.stage}`);
  } catch (cause) {
    const error = toError(cause);
    if (store.get(job.id).cloudBuildPending) return store.update(job.id, { status: 'blocked', blockedReason: null, error: `Cloud build outcome requires provider reconciliation; automatic replay is forbidden. ${error.message}` });
    if (error.code === 'PROCESS_CLEANUP_BLOCKED') return store.update(job.id, { status: 'blocked', blockedReason: null, manualRecovery: error.message, error: error.message });
    if (signal?.aborted) return store.update(job.id, { status: 'waiting', attempts: { ...attempts, [job.stage]: job.attempts[job.stage] ?? 0 }, nextAt: Date.now(), error: error.message });
    if (error.code === 'PREREQUISITE_FAILED' && error.prerequisite) return store.update(job.id, { status: 'blocked', blockedReason: { kind: 'prerequisite', stage: job.stage, prerequisite: error.prerequisite }, attempts: { ...job.attempts }, nextAt: Date.now() + config.pollMs, error: error.message });
    if (!attemptCharged) return store.update(job.id, { status: 'blocked', blockedReason: null, attempts: { ...job.attempts }, nextAt: Date.now(), error: error.message });
    const blocked = (error.code === 'ENOENT' && error.syscall?.startsWith('spawn')) || /SETUP_REQUIRED|UNSUPPORTED|PROCESS_CLEANUP_BLOCKED/.test(error.code ?? '');
    if (blocked) return store.update(job.id, { status: 'blocked', error: error.message });
    const charged = attempts[job.stage] ?? 0;
    const exhausted = error.code === 'BUDGET' || charged >= config.maxAttempts;
    if (job.stage === 'verify' || (job.stage === 'package' && error.code === 'EVIDENCE_CHANGED')) return store.update(job.id, { ...repair({ ...job, attempts }, error.message), status: exhausted ? 'failed' : 'waiting', nextAt: Date.now() + config.retryDelayMs * charged });
    return store.update(job.id, { status: exhausted ? 'failed' : 'waiting', error: error.message, feedback: error.message, nextAt: Date.now() + config.retryDelayMs * charged });
  }
}
