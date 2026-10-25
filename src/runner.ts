import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync, cpSync, existsSync, mkdtempSync, renameSync, constants } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { providerCommand } from './agents.js';
import { run, agentEnvironment, processGroupAlive } from './process.js';
import { shipApple, pollApple } from './apple.js';
import { inside, expandArgv } from './config.js';
import { checkPrerequisites } from './preflight.js';
import { flutterEnvironment, prepareFlutter } from './flutter.js';
import { prepareExportOptions } from './export-options.js';
import { GENERATED_PATHS, dependencyDigest, isGeneratedPath, validateLocalDependencies } from './dependencies.js';
import { ResearchSchema, ReviewSchema, toError } from './schemas.js';
import type { Job, Provider, Stage } from './schemas.js';
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
  if (dependencyDigest(job.workspace) !== job.verifiedDependencyDigest) throw new Error('Dependency resolution changed since verification; re-verification is required');
}

export function parseVerdict(text: string): unknown {
  const content = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  try { return JSON.parse(content); }
  catch { throw new Error('Agent did not return a JSON verdict; no approval was inferred from its exit code'); }
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
    try {
      cpSync(base.workspace, staging, { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE,
        filter: path => !isGeneratedPath(relative(base.workspace, path)) });
      if (sourceDigest(staging) !== job.baseDigest || sourceDigest(base.workspace) !== job.baseDigest) throw new Error('Predecessor changed while copying; no successor was initialized');
      renameSync(staging, job.workspace);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  store.update(job.id, { basePrepared: true });
}


function taskPrompt(job: Job): string {
  return `You are operating inside an autonomous Flutter app factory. Implement only this product. Never hide functionality from App Review or target low code similarity through obfuscation. Reviewer and user behavior must match. Do not upload, submit, push or change factory state. Do not read publisher credentials. No accounts, analytics or network APIs unless explicitly required by the product. Complete real implementations, not placeholders.\nImmutable product requirements:\n${JSON.stringify(job.spec, null, 2)}\nPrevious verification/review failure (repair the mechanism, do not weaken acceptance):\n${job.feedback ?? job.error ?? 'none'}\nPersisted execution logs for diagnosing the prior attempt:\n${JSON.stringify(job.logs.slice(-3))}\nContinue the existing implementation rather than restarting completed work. The external factory, not the agent's own claims, decides verification.\n`;
}

async function invoke(store: Store, job: Job, provider: Provider, prompt: string, readOnly: boolean, exec: Run): Promise<string> {
  const current = store.get(job.id);
  if (current.agentCalls >= job.config.maxAgentCalls) throw Object.assign(new Error('Agent call limit reached; no further model calls are permitted'), { code: 'BUDGET' });
  const outputPath = join(job.config.stateDir, 'logs', job.id, `agent-${current.agentCalls + 1}-final.txt`);
  const environment = flutterEnvironment(job.config, job.workspace, agentEnvironment(job.config));
  const command = providerCommand(provider, { cwd: job.workspace, prompt, readOnly, outputPath, environment });
  store.event(job.id, { agent: { role: job.stage, kind: provider.kind, model: provider.model, provider: provider.provider }, call: current.agentCalls + 1 });
  const result = await exec(command.argv, { input: command.input, env: environment, onSpawn: () => store.update(job.id, { agentCalls: current.agentCalls + 1 }) });
  if (result.code !== 0) throw new Error(`Agent failed (${result.code}): ${result.stderr.slice(-4000) || result.stdout.slice(-4000)}`);
  if (command.outputPath) {
    let final;
    try { final = readFileSync(command.outputPath, 'utf8').trim(); } catch {}
    if (!final) throw new Error(`Agent exited without a final response; exit zero did not prove a successful model request. ${result.stdout.slice(-2000)} ${result.stderr.slice(-1000)}`);
    return final;
  }
  if (!result.stdout.trim()) throw new Error('Agent produced no final response');
  return result.stdout;
}

function next(store: Store, job: Job, stage: Stage, extra: Partial<Job> = {}): Job {
  return store.update(job.id, { stage, status: 'queued', nextAt: Date.now(), error: null, groups: [], ...extra });
}

export async function executeStep(store: Store, job: Job, { signal }: { signal?: AbortSignal } = {}): Promise<Job> {
  const config = job.config;
  if (signal?.aborted) return store.update(job.id, { status: 'waiting', nextAt: Date.now(), error: 'Worker was interrupted before this stage started' });
  if (!config.allowLocalExecution) return store.update(job.id, { status: 'blocked', error: config.executionWarning });
  if (Date.now() - job.createdAt > config.maxJobHours * 3600000 && !['publish', 'monitor'].includes(job.stage)) {
    return store.update(job.id, { status: 'failed', error: 'Task wall-clock limit reached; no further work will start' });
  }
  const attemptNumber = (job.attempts[job.stage] ?? 0) + 1;
  let attempts = { ...job.attempts };
  let attemptCharged = false;
  const developerEnv = flutterEnvironment(config, job.workspace, agentEnvironment(config));
  const verifierEnv = flutterEnvironment(config, job.workspace, agentEnvironment(config), true);
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
    if (config.toolchain && ['build', 'verify', 'package'].includes(job.stage)) {
      const toolchain = await prepareFlutter(job, { run: exec, env: developerEnv, signal });
      if (toolchain) store.update(job.id, { toolchain });
    }
    attempts = { ...attempts, [job.stage]: attemptNumber };
    store.update(job.id, { attempts });
    attemptCharged = true;
    if (job.stage === 'research') {
      const response = await fetch('https://developer.apple.com/app-store/review/guidelines/', { signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) });
      if (!response.ok) throw new Error(`Apple policy fetch failed: HTTP ${response.status}`);
      const policy = await response.text();
      const inputDir = join(job.workspace, '.factory-input');
      mkdirSync(inputDir, { recursive: true });
      writeFileSync(join(inputDir, 'apple-guidelines.html'), policy);
      const policyEvidence = { url: response.url, fetchedAt: new Date().toISOString(), sha256: createHash('sha256').update(policy).digest('hex') };
      const portfolio = store.list().filter(value => value.id !== job.id).map(value => ({ id: value.spec.id, purpose: value.spec.purpose, audience: value.spec.audience, differentiators: value.spec.differentiators }));
      const text = await invoke(store, job, config.researcher ?? config.reviewer, `${taskPrompt(job)}\nResearch only; read .factory-input/apple-guidelines.html. Assess rules ${REQUIRED_POLICY_RULES.join(', ')}, offline persistence/backup and actual distinct utility against portfolio ${JSON.stringify(portfolio)}. Address whether the content owner and submitting account comply with commercial template/app-generation rule 4.2.6; unknown ownership must be reported, not invented or attested by the model. Return ONLY JSON {"viable":boolean,"policySources":[{"rule":"4.2","url":"https://developer.apple.com/..."}],"distinctness":"specific reasoning","risks":["..."],"plan":["..."]}. Do not promise App Store approval.`, true, exec);
      const research = parseResearch(text);
      if (research.viable !== true) return store.update(job.id, { status: 'failed', research, policyEvidence, error: 'Research rejected this product; no replacement product or review evasion will be attempted' });
      return next(store, job, 'build', { research, policyEvidence });
    }
    if (job.stage === 'build') {
      const sdk = await exec(['flutter', '--version']);
      if (sdk.code !== 0) throw new Error(`Flutter SDK is unusable: ${sdk.stderr}`);
      let development = job;
      if (config.toolchain) {
        const warmed = await exec(['flutter', 'pub', 'get']);
        if (warmed.code !== 0) development = { ...job, feedback: `${job.feedback ?? ''}\nDependency resolution before development failed (${warmed.code}): ${warmed.stderr}\n${warmed.stdout}` };
      }
      await invoke(store, development, config.builder, `${taskPrompt(development)}\nResearch plan:\n${JSON.stringify(job.research)}\nCreate a complete iOS Flutter project in the current directory if absent. Use the provided FLUTTER_ROOT, PUB_CACHE and ANALYZER_STATE_LOCATION_OVERRIDE; SDK and caches inside .factory-cache are not application source. Do not copy SDKs or write host HOME caches. Build the entire product, including local persistence, backup/restore validation, accessibility, realistic empty/error states, privacy policy entry, integration_test and test_driver for the acceptance workflow, and actual simulator screenshots under build/screenshots/<Apple display type>/. No fake screenshots or bypassing tests. The immutable external checks are ${JSON.stringify(config.verification)}. Use these commands to understand the required contracts; do not modify their meaning or replace behavioral tests with source/wording tests. Finish source and tests; the factory executes verification independently.`, false, exec);
      readFileSync(join(job.workspace, 'pubspec.yaml'));
      const dependencies = await exec(['flutter', 'pub', 'get'], { env: verifierEnv });
      if (dependencies.code !== 0) throw new Error(`Flutter dependency resolution failed: ${dependencies.stderr.slice(-4000)}`);
      return next(store, job, 'verify', { verifiedDigest: null, verifiedDependencyDigest: null, review: null });
    }
    if (job.stage === 'verify') {
      if (config.toolchain) {
        const dependencies = await exec(['flutter', 'pub', 'get']);
        if (dependencies.code !== 0) throw new Error(`Verification dependency resolution failed: ${dependencies.stderr.slice(-4000)}`);
      }
      const before = sourceDigest(job.workspace);
      const dependenciesBefore = dependencyDigest(job.workspace);
      for (const argv of [...config.verification.checks, ...config.verification.runtime]) {
        const result = await exec(expandArgv(argv, agentEnvironment(config)));
        if (result.code !== 0) throw new Error(`Verification failed (${result.code}) ${JSON.stringify(argv)}:\n${result.stderr.slice(-5000)}\n${result.stdout.slice(-5000)}`);
      }
      if (sourceDigest(job.workspace) !== before) throw new Error('Verification changed source files; the new revision must be verified again');
      if (dependencyDigest(job.workspace) !== dependenciesBefore) throw new Error('Verification changed dependency resolution; the new resolution must be verified again');
      const screenshotDigest = job.spec.apple?.screenshotsDir ? sourceDigest(inside(job.workspace, job.spec.apple.screenshotsDir), false) : null;
      return next(store, job, 'review', { verifiedDigest: before, verifiedDependencyDigest: dependenciesBefore, screenshotDigest, verifiedAt: new Date().toISOString() });
    }
    if (job.stage === 'review') {
      if (sourceDigest(job.workspace) !== job.verifiedDigest) throw new Error('Source changed since verification; stale evidence cannot approve a release');
      requireDependencyProof(job);
      const text = await invoke(store, job, config.reviewer, `${taskPrompt(job)}\nIndependently review actual source and acceptance/integration tests. Verified source digest: ${job.verifiedDigest}. Checks ran: ${JSON.stringify(config.verification)}. Reject incomplete workflows, untested backup roundtrip/corrupt import, data loss, fake screenshots, accessibility failures, placeholder/legal claims, weak tests, hidden features and repetitive products. Test success does not guarantee approval. Return ONLY JSON {"approved":boolean,"findings":["blocking issue"],"acceptanceEvidence":[{"requirement":"exact acceptance string","evidence":"file/symbol + observed command or scenario"}]}. You cannot edit files.`, true, exec);
      const review = ReviewSchema.parse(parseVerdict(text));
      if (typeof review.approved !== 'boolean' || !Array.isArray(review.findings) || !Array.isArray(review.acceptanceEvidence) || !job.spec.acceptance.every(requirement => review.acceptanceEvidence.some(item => item.requirement === requirement && typeof item.evidence === 'string' && item.evidence.trim()))) throw new Error('Review verdict must cover each acceptance requirement with concrete evidence');
      if (sourceDigest(job.workspace) !== job.verifiedDigest) throw new Error('Reviewer changed source; the release cannot use stale verification');
      requireDependencyProof(job);
      if (!review.approved || review.findings.length) throw new Error(`Independent review rejected the artifact: ${JSON.stringify(review)}`);
      return next(store, job, 'package', { review });
    }
    if (job.stage === 'package') {
      if (sourceDigest(job.workspace) !== job.verifiedDigest) throw new Error('Source changed after approval; refusing to build unverified source');
      requireDependencyProof(job);
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
      if (sourceDigest(job.workspace) !== job.verifiedDigest) throw new Error('Packaging changed source; re-verification is required');
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
    const blocked = (error.code === 'ENOENT' && error.syscall?.startsWith('spawn')) || /SETUP_REQUIRED|UNSUPPORTED|PROVIDER_UNAVAILABLE|APPLE_WRITE_UNCERTAIN|APPLE_STATE_|PROCESS_CLEANUP_BLOCKED/.test(error.code ?? '');
    if (blocked) return store.update(job.id, { status: 'blocked', error: error.message });
    if (error.code === 'APPLE_PROCESSING' || error.code === 'APPLE_RATE_LIMIT') return store.update(job.id, { status: 'waiting', attempts: { ...attempts, [job.stage]: Math.max(0, (attempts[job.stage] ?? 0) - 1) }, error: error.message, nextAt: Date.now() + config.pollMs });
    const receipt = store.get(job.id).receipt;
    const publicationRecovery = ['publish', 'monitor'].includes(job.stage) && (job.stage === 'monitor' || !!(receipt.upload || receipt.pending || receipt.buildId || receipt.submissionId || receipt.versionId || Object.keys(receipt.effects ?? {}).length));
    if (publicationRecovery && error.transient === true) return store.update(job.id, { status: 'waiting', error: error.message, nextAt: Date.now() + config.pollMs });
    if (job.stage === 'monitor' || (publicationRecovery && error.code?.startsWith('APPLE_'))) return store.update(job.id, { status: 'blocked', error: error.message });
    const charged = attempts[job.stage] ?? 0;
    const exhausted = error.code === 'BUDGET' || charged >= config.maxAttempts;
    const stage = ['verify', 'review'].includes(job.stage) ? 'build' : job.stage;
    return store.update(job.id, { status: exhausted ? 'failed' : 'waiting', stage, error: error.message, feedback: error.message, nextAt: Date.now() + config.retryDelayMs * charged });
  }
}
