import { mkdirSync, readFileSync, readdirSync, lstatSync, rmSync, cpSync, existsSync, mkdtempSync, renameSync, constants } from 'node:fs';
import { join, relative, delimiter } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { run, executionEnvironment, processGroupAlive } from './process.js';
import { shipApple, pollApple } from './apple.js';
import { inside, expandArgv } from './config.js';
import { checkPrerequisites } from './preflight.js';
import { flutterEnvironment, prepareFlutter } from './flutter.js';
import { prepareExportOptions } from './export-options.js';
import { GENERATED_PATHS, dependencyDigest, isGeneratedPath, validateLocalDependencies } from './dependencies.js';
import { ResearchSchema, ReviewSchema, toError } from './schemas.js';
import type { Job, HostStage, Stage } from './schemas.js';
import type { Run, RunOptions } from './process.js';
import type { Store } from './store.js';

const REQUIRED_POLICY_RULES = ['2.1', '2.3.1', '2.5.19', '4.2', '4.2.6', '4.3', '5.1.1'];

export function sourceDigest(root: string, omitGenerated = true): string {
  if (lstatSync(root).isSymbolicLink()) throw new Error('A source or screenshot root cannot be a symlink');
  if (omitGenerated) {
    for (const path of GENERATED_PATHS) inside(root, path);
    validateLocalDependencies(root);
  }
  const hash = createHash('sha256');
  function visit(directory: string): void {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (omitGenerated && isGeneratedPath(relative(root, path))) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Source symlink is not permitted: ${relative(root, path)}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) hash.update(relative(root, path)).update('\0').update(`${stat.size}:${stat.mode & 0o777}\0`).update(readFileSync(path));
    }
  }
  visit(root);
  return hash.digest('hex');
}

function requireDependencyProof(job: Job): void {
  if (!job.verifiedDependencyDigest) throw Object.assign(new Error('Dependency resolution proof is missing; retry this stopped task to re-run verification'), { code: 'SETUP_REQUIRED' });
  if (dependencyDigest(job.workspace) !== job.verifiedDependencyDigest) throw Object.assign(new Error('Dependency resolution changed since verification; re-verification is required'), { code: 'EVIDENCE_CHANGED' });
}

export function parseVerdict(text: string): unknown {
  const content = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  try { return JSON.parse(content); }
  catch { throw new Error('Host did not return a JSON verdict; no approval was inferred from text or an exit code'); }
}

export function parseResearch(text: string) {
  const research = ResearchSchema.parse(parseVerdict(text));
  const cited = new Set();
  for (const source of Array.isArray(research?.policySources) ? research.policySources : []) {
    if (typeof source?.url !== 'string') continue;
    try {
      const url = new URL(source.url);
      if (url.protocol === 'https:' && url.hostname === 'developer.apple.com') cited.add(source.rule);
    } catch {}
  }
  if (typeof research?.viable !== 'boolean' || !REQUIRED_POLICY_RULES.every(rule => cited.has(rule)) || typeof research.distinctness !== 'string' || !research.distinctness.trim() || !Array.isArray(research.plan) || !research.plan.length || research.plan.some(step => typeof step !== 'string' || !step.trim())) {
    throw new Error('Research verdict requires boolean viability, all required official policy references, distinctness reasoning and a concrete implementation plan');
  }
  return research;
}
function prepareWorkspace(store: Store, job: Job): void {
  if (!job.baseJobId || job.basePrepared) return;
  const base = store.get(job.baseJobId);
  if (!job.baseDigest || sourceDigest(base.workspace) !== job.baseDigest) throw Object.assign(new Error('Predecessor source changed since intake; refusing to copy unverified code'), { code: 'SETUP_REQUIRED' });
  if (existsSync(job.workspace)) {
    if (sourceDigest(job.workspace) !== job.baseDigest) throw Object.assign(new Error('Uninitialized successor workspace differs from its verified predecessor; inspect it before retrying'), { code: 'SETUP_REQUIRED' });
  } else {
    mkdirSync(job.config.workspaceRoot, { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(join(job.config.workspaceRoot, `.${job.id}.base-`));
    const prepared = join(staging, 'source');
    try {
      cpSync(base.workspace, prepared, { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE,
        filter: path => !isGeneratedPath(relative(base.workspace, path)) });
      if (sourceDigest(prepared) !== job.baseDigest || sourceDigest(base.workspace) !== job.baseDigest) throw new Error('Predecessor changed while copying; no successor was initialized');
      renameSync(prepared, job.workspace);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  store.update(job.id, { basePrepared: true });
}


function taskPrompt(job: Job): string {
  return `You are the native host of an embedded Flutter app Harness. Use your own context, tools and native delegation in ${job.workspace}; never launch another coding-agent CLI. Implement only this product. Never hide functionality from App Review or use obfuscation to imitate distinct utility. Do not upload, submit, push, read publisher credentials or change factory state. These instructions constrain this workflow, not arbitrary host tools: the workspace is not a security sandbox. Complete real implementations, not placeholders.\nImmutable product requirements:\n${JSON.stringify(job.spec, null, 2)}\nPrevious verification/review failure (repair the mechanism, never weaken acceptance):\n${job.feedback ?? job.error ?? 'none'}\nPersisted execution logs:\n${JSON.stringify(job.logs.slice(-3))}\nContinue existing work. Only actual deterministic checks performed by the Harness establish verification; host claims do not.\n`;
}

export interface TurnOptions { buildOnly?: boolean }
export interface HostAction {
  job: Job;
  action: 'host' | 'step' | 'wait' | 'done';
  turn?: { id: string; stage: HostStage; prompt: string; cwd: string; environment: Record<string, string> };
}

function assertTurnPermission(job: Job, options: TurnOptions): void {
  if (options.buildOnly && (job.config.allowSubmit || job.config.allowRelease)) throw new Error('--build-only refuses this task with snapshotted publication permission');
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
    if (!job.verifiedDigest || sourceDigest(job.workspace) !== job.verifiedDigest) throw new Error('Source changed since verification; stale evidence cannot approve a release');
    requireDependencyProof(job);
    if (job.spec.apple?.screenshotsDir && sourceDigest(inside(job.workspace, job.spec.apple.screenshotsDir), false) !== job.screenshotDigest) throw new Error('Screenshots changed since runtime verification; stale evidence cannot approve a release');
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
    const portfolio = store.list().filter(value => value.id !== job.id).map(value => ({ id: value.spec.id, purpose: value.spec.purpose, audience: value.spec.audience, differentiators: value.spec.differentiators }));
    instruction = `Research only with your own host tools. Retrieve the current official Apple review guidelines at https://developer.apple.com/app-store/review/guidelines/ and assess rules ${REQUIRED_POLICY_RULES.join(', ')}, offline persistence/backup and distinct utility against portfolio ${JSON.stringify(portfolio)}. Assess content ownership and submitting account compliance with rule 4.2.6; report unknowns rather than inventing attestations. Return a typed JSON result {"viable":boolean,"policySources":[{"rule":"4.2","url":"https://developer.apple.com/..."}],"distinctness":"specific reasoning","risks":["..."],"plan":["concrete step"]}. Cite all required rules. These host-supplied citations are not independently verified policy evidence. Do not promise App Store approval.`;
  } else if (turn.stage === 'build') {
    instruction = `Research plan: ${JSON.stringify(job.research)}\nCreate a complete iOS Flutter project in this cwd if absent. Implement the entire product, persistence and validated backup/restore, accessibility and realistic empty/error states. Include real integration_test and test_driver acceptance workflows and real simulator screenshots under the requested screenshots directory; never fake screenshots or bypass tests. Use the returned environment with your own tools. The configured SDK, if any, is external to source; keep development caches task-local. Frozen checks: ${JSON.stringify(job.config.verification)}. Complete this turn without a result payload when source is ready; the Harness will then run verification, not infer success.`;
  } else {
    instruction = `Use a native independent reviewer with a fresh context when your host supports one. Review actual source and acceptance tests read-only; do not edit files. If independent review is unavailable, disclose that limitation rather than claim a separate reviewer. Verified source: ${job.verifiedDigest}; dependency resolution: ${job.verifiedDependencyDigest}; actual checks: ${JSON.stringify(job.config.verification)}. Reject incomplete workflows, data loss, untested backup/corrupt import, fake screenshots, accessibility failures, placeholders, misleading legal claims, weak tests, hidden features and repetitive products. Return typed JSON {"approved":boolean,"findings":["blocking issue"],"acceptanceEvidence":[{"requirement":"exact acceptance string","evidence":"file/symbol + observed command or scenario"}]}. Cover every acceptance requirement. Host reviewer identity is advisory; the Harness gates only typed results and unchanged deterministic evidence.`;
  }
  // Host-visible JSON carries only task overrides, never inherited credential values.
  const environment = flutterEnvironment(job.config, job.workspace, { CI: '1' });
  if (job.config.toolchain) {
    environment.FLUTTER_ROOT = job.config.toolchain.flutterSdk;
    environment.PATH = `${join(job.config.toolchain.flutterSdk, 'bin')}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ''}`;
  }
  return { job, action: 'host', turn: { id: turn.id, stage: turn.stage, prompt: taskPrompt(job) + instruction, cwd: job.workspace, environment: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)) } };
}

function repair(job: Job, message: string): Partial<Job> {
  return {
    stage: 'build', status: (job.attempts[job.stage] ?? 0) >= job.config.maxAttempts ? 'failed' : 'waiting',
    turn: null, review: null, verifiedDigest: null, verifiedDependencyDigest: null, screenshotDigest: null, verifiedAt: undefined,
    artifact: null, ipaPath: null, archiveDigest: null, feedback: message, error: message,
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
    if (['failed', 'ready', 'built', 'approved', 'released'].includes(job.status)) return { job, action: 'done' };
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
      mkdirSync(job.workspace, { recursive: true, mode: 0o700 });
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

export function completeTurn(store: Store, id: string, turnId: string, result?: unknown, options: TurnOptions = {}): Job {
  return store.transition(id, job => {
    assertTurnPermission(job, options);
    if (!job.turn || job.turn.id !== turnId || job.turn.stage !== job.stage || job.status !== 'running') throw new Error('Stale, replayed or wrong-phase host turn; use next to inspect the active token');
    if (contextDigest(job) !== job.turn.contextDigest) throw new Error('Host turn context changed; abandon this stale token before continuing');
    if (job.groups.length || job.manualRecovery) throw new Error('Command recovery must finish before completing a host turn');
    if (deadlineExpired(job)) return { turn: null, status: 'failed', error: 'Task wall-clock limit reached; the expired host result was not accepted' };
    let patch: Partial<Job>;
    if (job.stage === 'research') {
      const research = parseResearch(JSON.stringify(ResearchSchema.parse(result)));
      patch = research.viable ? { stage: 'build', research } : { status: 'failed', research, error: 'Research rejected this product; no replacement product or review evasion will be attempted' };
    } else if (job.stage === 'build') {
      if (result !== undefined) throw new Error('Build completion accepts no result payload; actual deterministic verification is required');
      const project = inside(job.workspace, 'pubspec.yaml');
      if (!lstatSync(project).isFile()) throw new Error('Build completion requires a regular pubspec.yaml in the task workspace');
      patch = { stage: 'verify', verifiedDigest: null, verifiedDependencyDigest: null, screenshotDigest: null, verifiedAt: undefined, review: null, artifact: null, ipaPath: null, archiveDigest: null };
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
  if (deadlineExpired(job) && !['publish', 'monitor'].includes(job.stage)) {
    return store.update(job.id, { status: 'failed', error: 'Task wall-clock limit reached; no further work will start' });
  }
  const attemptNumber = (job.attempts[job.stage] ?? 0) + 1;
  let attempts = { ...job.attempts };
  let attemptCharged = false;
  const developerEnv = flutterEnvironment(config, job.workspace, executionEnvironment(config));
  const verifierEnv = flutterEnvironment(config, job.workspace, executionEnvironment(config), true);
  const environment = ['verify', 'package'].includes(job.stage) ? verifierEnv : developerEnv;
  const logPath = join(config.stateDir, 'logs', job.id, `${job.stage}-${attemptNumber}-${Date.now()}.log`);
  store.update(job.id, { logs: [...job.logs, logPath] });
  const exec: Run = async (argv: string[], options: RunOptions = {}) => {
    let pid: number | undefined;
    try {
      const effectiveEnv = options.env ?? environment;
      const command = effectiveEnv.FLUTTER_ROOT && ['flutter', 'dart'].includes(argv[0]) ? [join(effectiveEnv.FLUTTER_ROOT, 'bin', argv[0]), ...argv.slice(1)] : argv;
      const result = await run(command, {
        cwd: job.workspace, env: effectiveEnv, timeoutMs: config.timeoutMs, signal, logPath, ...options,
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
      const current = store.get(job.id);
      const groups = current.groups.filter(processGroupAlive);
      const commands = Object.fromEntries(Object.entries(current.commands ?? {}).filter(([pid]) => groups.includes(Number(pid))));
      store.update(job.id, { groups, commands, recoveryStage: groups.length ? current.recoveryStage ?? job.stage : undefined });
    }
  };
  try {
    prepareWorkspace(store, job);
    mkdirSync(job.workspace, { recursive: true, mode: 0o700 });
    if (job.stage === 'verify' || job.stage === 'package') {
      await checkPrerequisites(config.verification.prerequisites ?? [], { cwd: job.workspace, env: environment, run: exec, signal });
    }
    if ((job.attempts[job.stage] ?? 0) >= config.maxAttempts && !['publish', 'monitor'].includes(job.stage)) return store.update(job.id, { status: 'failed', error: `Attempt limit reached at ${job.stage}` });
    if (config.toolchain && ['verify', 'package'].includes(job.stage)) {
      const toolchain = await prepareFlutter(job, { run: exec, env: developerEnv, signal });
      if (toolchain) store.update(job.id, { toolchain });
    }
    attempts = { ...attempts, [job.stage]: attemptNumber };
    store.update(job.id, { attempts });
    attemptCharged = true;
    if (job.stage === 'verify') {
      if (config.toolchain) {
        const dependencies = await exec(['flutter', 'pub', 'get']);
        if (dependencies.code !== 0) throw new Error(`Verification dependency resolution failed: ${dependencies.stderr.slice(-4000)}`);
      }
      const before = sourceDigest(job.workspace);
      const dependenciesBefore = dependencyDigest(job.workspace);
      for (const argv of [...config.verification.checks, ...config.verification.runtime]) {
        const result = await exec(expandArgv(argv, executionEnvironment(config)));
        if (result.code !== 0) throw new Error(`Verification failed (${result.code}) ${JSON.stringify(argv)}:\n${result.stderr.slice(-5000)}\n${result.stdout.slice(-5000)}`);
      }
      if (sourceDigest(job.workspace) !== before) throw new Error('Verification changed source files; the new revision must be verified again');
      if (dependencyDigest(job.workspace) !== dependenciesBefore) throw new Error('Verification changed dependency resolution; the new resolution must be verified again');
      const screenshotDigest = job.spec.apple?.screenshotsDir ? sourceDigest(inside(job.workspace, job.spec.apple.screenshotsDir), false) : null;
      return next(store, job, 'review', { verifiedDigest: before, verifiedDependencyDigest: dependenciesBefore, screenshotDigest, verifiedAt: new Date().toISOString() });
    }
    if (job.stage === 'package') {
      requireReviewProof(job);
      if (!job.review?.approved || job.review.findings.length) throw new Error('Packaging requires an approved host review');
      if (process.platform !== 'darwin') throw Object.assign(new Error('iOS packaging requires the Mac worker; use the SSH controller from Linux'), { code: 'SETUP_REQUIRED' });
      const target = config.packageTarget;
      if (config.allowSubmit && target !== 'ipa') throw Object.assign(new Error('Only a verified IPA can enter publication'), { code: 'SETUP_REQUIRED' });
      const output = inside(job.workspace, target === 'ipa' ? 'build/ios/ipa' : 'build/ios/iphonesimulator');
      if (target === 'ipa' && !config.apple?.exportOptionsPlist) throw Object.assign(new Error('Configure apple.exportOptionsPlist and valid local signing before IPA packaging'), { code: 'SETUP_REQUIRED' });
      const apple = job.spec.apple;
      if (target === 'ipa' && (!apple?.version || !apple.buildNumber)) throw Object.assign(new Error('apple.version and apple.buildNumber are required for signing'), { code: 'SETUP_REQUIRED' });
      let exportOptions: { directory: string; path: string } | undefined;
      let built;
      try {
        if (target === 'ipa') exportOptions = await prepareExportOptions(config.apple!.exportOptionsPlist!, config.stateDir, exec);
        store.update(job.id, { artifact: null, ipaPath: null, archiveDigest: null });
        rmSync(output, { recursive: true, force: true });
        const command = target === 'ipa'
          ? ['flutter', 'build', 'ipa', '--release', '--build-name', apple!.version!, '--build-number', apple!.buildNumber!, '--export-options-plist', exportOptions!.path]
          : ['flutter', 'build', 'ios', '--simulator', '--debug', '--no-pub'];
        built = await exec(command);
      } finally { if (exportOptions) rmSync(exportOptions.directory, { recursive: true, force: true }); }
      if (built.code !== 0) throw new Error(`iOS ${target} build failed: ${built.stderr.slice(-5000)}`);
      if (sourceDigest(job.workspace) !== job.verifiedDigest) throw Object.assign(new Error('Packaging changed source; re-verification is required'), { code: 'EVIDENCE_CHANGED' });
      requireDependencyProof(job);
      const products = readdirSync(output).filter(name => name.endsWith(target === 'ipa' ? '.ipa' : '.app'));
      if (products.length !== 1) throw new Error(`Expected exactly one ${target === 'ipa' ? 'IPA' : 'simulator app'} in ${relative(job.workspace, output)}`);
      const path = inside(job.workspace, join(relative(job.workspace, output), products[0]));
      const digest = target === 'ipa' ? createHash('sha256').update(readFileSync(path)).digest('hex') : sourceDigest(path, false);
      const artifact = { kind: target === 'ipa' ? 'ipa' as const : 'ios-simulator' as const, path, digest, createdAt: new Date().toISOString() };
      if (!config.allowSubmit) return store.update(job.id, { status: 'built', artifact, error: null });
      return next(store, job, 'publish', { artifact, ipaPath: path, archiveDigest: digest });
    }
    if (job.stage === 'publish') {
      if (!config.allowSubmit) throw Object.assign(new Error('This task has no upload/submission permission'), { code: 'SETUP_REQUIRED' });
      if (!job.ipaPath || !job.archiveDigest) throw new Error('Publication requires a completed verified IPA artifact');
      if (sourceDigest(job.workspace) !== job.verifiedDigest || createHash('sha256').update(readFileSync(job.ipaPath)).digest('hex') !== job.archiveDigest) throw new Error('Source or archive changed after verification; refusing publication');
      requireDependencyProof(job);
      const spec = structuredClone(job.spec);
      if (spec.apple?.screenshotsDir) spec.apple.screenshotsDir = inside(job.workspace, spec.apple.screenshotsDir);
      if (spec.apple?.screenshotsDir && sourceDigest(spec.apple.screenshotsDir, false) !== job.screenshotDigest) throw new Error('Screenshots changed after runtime verification; refusing to upload different assets');
      const receipt = await shipApple({ spec, ipaPath: job.ipaPath, state: store.get(job.id).receipt, save: receipt => { store.update(job.id, { receipt }); }, run: exec, signal, allowRelease: config.allowRelease });
      return next(store, job, 'monitor', { receipt, status: 'waiting', nextAt: Date.now() + config.pollMs });
    }
    if (job.stage === 'monitor') {
      const result = await pollApple({ spec: job.spec, state: job.receipt, signal });
      if (result.status === 'approved' && (result.available || !config.allowRelease)) return store.update(job.id, { status: result.available ? 'released' : 'approved', appleReview: result, error: null });
      if (result.status === 'rejected') {
        return store.update(job.id, { status: 'blocked', appleReview: result, error: 'Apple rejected this version. Rejection message details are not available through this API; do not invent feedback. Supply the actual App Review message with the feedback command to resume repairs.' });
      }
      return store.update(job.id, { status: 'waiting', appleReview: result, attempts: { ...attempts, monitor: 0 }, nextAt: Date.now() + config.pollMs, error: null });
    }
    throw new Error(`Unknown task stage ${job.stage}`);
  } catch (cause) {
    const error = toError(cause);
    if (error.code === 'PROCESS_CLEANUP_BLOCKED') return store.update(job.id, { status: 'blocked', blockedReason: null, manualRecovery: error.message, error: error.message });
    if (signal?.aborted) return store.update(job.id, { status: 'waiting', attempts: { ...attempts, [job.stage]: job.attempts[job.stage] ?? 0 }, nextAt: Date.now(), error: error.message });
    if (error.code === 'PREREQUISITE_FAILED' && error.prerequisite) return store.update(job.id, { status: 'blocked', blockedReason: { kind: 'prerequisite', stage: job.stage, prerequisite: error.prerequisite }, attempts: { ...job.attempts }, nextAt: Date.now() + config.pollMs, error: error.message });
    if (!attemptCharged) return store.update(job.id, { status: 'blocked', blockedReason: null, attempts: { ...job.attempts }, nextAt: Date.now(), error: error.message });
    const blocked = (error.code === 'ENOENT' && error.syscall?.startsWith('spawn')) || /SETUP_REQUIRED|UNSUPPORTED|APPLE_WRITE_UNCERTAIN|APPLE_STATE_|PROCESS_CLEANUP_BLOCKED/.test(error.code ?? '');
    if (blocked) return store.update(job.id, { status: 'blocked', error: error.message });
    if (error.code === 'APPLE_PROCESSING' || error.code === 'APPLE_RATE_LIMIT') return store.update(job.id, { status: 'waiting', attempts: { ...attempts, [job.stage]: Math.max(0, (attempts[job.stage] ?? 0) - 1) }, error: error.message, nextAt: Date.now() + config.pollMs });
    const receipt = store.get(job.id).receipt;
    const publicationRecovery = ['publish', 'monitor'].includes(job.stage) && (job.stage === 'monitor' || !!(receipt.upload || receipt.pending || receipt.buildId || receipt.submissionId || receipt.versionId || Object.keys(receipt.effects ?? {}).length));
    if (publicationRecovery && error.transient === true) return store.update(job.id, { status: 'waiting', error: error.message, nextAt: Date.now() + config.pollMs });
    if (job.stage === 'monitor' || (publicationRecovery && error.code?.startsWith('APPLE_'))) return store.update(job.id, { status: 'blocked', error: error.message });
    const charged = attempts[job.stage] ?? 0;
    const exhausted = error.code === 'BUDGET' || charged >= config.maxAttempts;
    if (job.stage === 'verify' || (job.stage === 'package' && error.code === 'EVIDENCE_CHANGED')) return store.update(job.id, { ...repair({ ...job, attempts }, error.message), status: exhausted ? 'failed' : 'waiting', nextAt: Date.now() + config.retryDelayMs * charged });
    return store.update(job.id, { status: exhausted ? 'failed' : 'waiting', error: error.message, feedback: error.message, nextAt: Date.now() + config.retryDelayMs * charged });
  }
}
