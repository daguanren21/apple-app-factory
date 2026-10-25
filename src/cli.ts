#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadJSON } from './config.js';
import { Store } from './store.js';
import { run } from './process.js';
import { providerCommand, probeProvider } from './agents.js';
import { appleDoctor, validateAppleSpec } from './apple.js';
import { runWorker } from './scheduler.js';
import { submitRequirement, scanInbox } from './inbox.js';
import { parseRequirement, readInputFile } from './requirements.js';
import { dispatchRemote } from './remote.js';
import { toError } from './schemas.js';
import type { Job } from './schemas.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const buildOnlyIndex = argv.indexOf('--build-only');
const buildOnly = buildOnlyIndex !== -1;
if (buildOnly) argv.splice(buildOnlyIndex, 1);
const configIndex = argv.indexOf('--config');
let configPath = 'factory.json';
if (configIndex !== -1) {
  configPath = argv[configIndex + 1];
  argv.splice(configIndex, 2);
}
const [command, ...args] = argv;
const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));
const view = (job: Job) => ({ id: job.id, product: job.spec.id, version: job.spec.apple?.version ?? '1.0.0', stage: job.stage, status: job.status, agentCalls: job.agentCalls, attempts: job.attempts, workspace: job.workspace, artifact: job.artifact ?? null, error: job.error ?? null });
const xml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

async function probe(argv: string[]) {
  try {
    const result = await run(argv, { timeoutMs: 30000 });
    return { available: result.code === 0, detail: (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim() };
  } catch (error) { return { available: false, detail: toError(error).message }; }
}

async function main() {
  if (configIndex !== -1 && !configPath) throw new Error('--config requires a file path');
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(`app-factory <command> [--config factory.json] [--build-only]
  init                 Create factory.json without overwriting an existing file
  doctor               Probe tools and permissions; does not validate agent login
  enqueue <spec.json|-> Persist validated requirements without using the inbox
  submit <spec.json|-> Atomically publish requirements to the configured inbox
  scan [--observe]     Scan inbox once; --observe validates without enqueueing
  inbox                Read durable per-file intake results
  run [--once]         Poll inbox and run bounded concurrent stages; --once runs at most one
  worker               Read queue owner and cooperative stop-request state
  stop                 Request that the queue owner stop and drain owned commands
  status [task-id]      Read durable task state as JSON
  events <task-id>      Read task transitions as JSON
  retry <task-id>       Resume blocked/built work, preserving budgets and publication permissions
  reconcile-intake <id> <spec.json>  Restore an unknown legacy request identity from the original input
  authorize <id> --submit [--release]  Grant task-specific publication permission before any remote intent
  feedback <id> <file>  Resume a rejected version using actual App Review feedback
  service              Print a launchd plist; does not install or start a service
  remote <command>     Dispatch build-only work over SSH using --config remote.json

built means a verified local build artifact exists; it is not uploaded or approved.
No uploads occur unless allowSubmit=true was snapshotted into the task.
Local agents are trusted programs, not an OS security boundary.`);
    return;
  }
  if (command === 'init') {
    mkdirSync(dirname(resolve(configPath)), { recursive: true });
    writeFileSync(configPath, readFileSync(join(here, '..', 'examples', 'factory.json')), { flag: 'wx', mode: 0o600 });
    print({ config: resolve(configPath), next: 'Configure dedicated-worker execution and providers, then run doctor' });
    return;
  }
  if (command === 'remote') {
    if (buildOnly) throw new Error('remote already enforces build-only execution');
    process.exitCode = await dispatchRemote(loadJSON(configPath), args);
    return;
  }
  const config = loadConfig(configPath);
  if (buildOnly && (config.allowSubmit || config.allowRelease)) throw new Error('--build-only refuses configurations with upload or release enabled');
  if (buildOnly && ['authorize', 'feedback'].includes(command)) throw new Error('Publication commands are forbidden in --build-only mode');
  if (command === 'submit') {
    if (args.length !== 1) throw new Error('submit requires one requirements JSON path or -');
    print(submitRequirement(config, args[0] === '-' ? JSON.parse(readFileSync(0, 'utf8')) as unknown : loadJSON(args[0])));
    return;
  }
  if (command === 'doctor') {
    const researcherConfig = config.researcher ?? config.reviewer;
    const [builder, reviewer, researcher, flutter, xcode] = await Promise.all([
      probeProvider(config.builder, config), probeProvider(config.reviewer, config), probeProvider(researcherConfig, config), probe(['flutter', '--version']), probe(['xcodebuild', '-version']),
    ]);
    const policies = [{ name: 'reviewer-policy', provider: config.reviewer }, { name: 'researcher-policy', provider: researcherConfig }].map(({ name, provider }) => {
      try { providerCommand(provider, { prompt: 'Capability check only', cwd: config.workspaceRoot, readOnly: true }); return { name, available: true, detail: 'Configured role supports a non-editing tool policy; no live task was run' }; }
      catch (error) { return { name, available: false, detail: toError(error).message }; }
    });
    const neededEnv = [...new Set([...config.verification.checks, ...config.verification.runtime].flat().flatMap(arg => [...arg.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map(match => match[1])))];
    const checks = [
      { name: 'local-execution-permission', available: config.allowLocalExecution, detail: config.executionWarning ?? 'Trusted local execution allowed; use a dedicated account or VM, not a personal credential-bearing account' },
      { name: 'builder', ...builder }, { name: 'reviewer', ...reviewer }, { name: 'researcher', ...researcher }, ...policies,
      { name: 'flutter', ...flutter }, { name: 'xcode', ...xcode },
      ...neededEnv.map(name => ({ name, available: Boolean(process.env[name]), detail: process.env[name] ? 'Configured in worker environment; value not printed' : `Set ${name} before running verification` })),
    ];
    if (config.allowSubmit) checks.push(...await appleDoctor());
    print({ checks, submissionEnabled: config.allowSubmit, authenticationVerified: false });
    if (checks.some(check => !check.available)) process.exitCode = 2;
    return;
  }
  if (command === 'service') {
    const logDirectory = join(config.stateDir, 'service');
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>local.apple-app-factory</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(here, 'cli.js'))}</string><string>run</string>${buildOnly ? '<string>--build-only</string>' : ''}<string>--config</string><string>${xml(config.configPath)}</string></array>
<key>WorkingDirectory</key><string>${xml(dirname(config.configPath))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin')}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(logDirectory, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logDirectory, 'stderr.log'))}</string>
</dict></plist>`);
    return;
  }
  const store = new Store(config.stateDir);
  try {
    if (command === 'enqueue') {
      if (args.length !== 1) throw new Error('enqueue requires one requirements JSON path or -');
      const { spec, baseJobId } = parseRequirement(args[0] === '-' ? JSON.parse(readFileSync(0, 'utf8')) as unknown : loadJSON(args[0]));
      if (config.allowSubmit) validateAppleSpec(spec);
      print(view(store.enqueue(spec, config, baseJobId)));
    } else if (command === 'scan') {
      if (args.length > 1 || (args.length === 1 && args[0] !== '--observe')) throw new Error('scan accepts only --observe');
      const result = await scanInbox(store, config, { observe: args.includes('--observe') });
      print(result);
      if (result.error || result.entries.some(entry => entry.status === 'error')) process.exitCode = 2;
    } else if (command === 'inbox' || command === 'worker' || command === 'stop') {
      if (args.length) throw new Error(`${command} accepts no arguments`);
      print(command === 'inbox' ? store.inboxEntries() : command === 'worker' ? store.workerStatus() : store.requestStop());
    } else if (command === 'status') print(args[0] ? store.get(args[0]) : store.list().map(view));
    else if (command === 'events') print(store.events(args[0]));
    else if (command === 'reconcile-intake') {
      if (args.length !== 2) throw new Error('reconcile-intake requires a task ID and the original requirements JSON path');
      const { spec, baseJobId } = parseRequirement(args[1] === '-' ? JSON.parse(readFileSync(0, 'utf8')) as unknown : loadJSON(args[1]));
      print(view(store.reconcileIntake(args[0], spec, baseJobId)));
    } else if (command === 'retry') {
      print(view(store.transition(args[0], job => {
        if (buildOnly && (job.config.allowSubmit || job.config.allowRelease)) throw new Error('--build-only refuses a task with snapshotted publication permission');
        if (!['blocked', 'ready', 'built'].includes(job.status)) throw new Error(`Cannot retry ${job.status}; budgets and active work cannot be reset by retry`);
        const proofChanged = JSON.stringify(config.verification) !== JSON.stringify(job.config.verification) || JSON.stringify(config.reviewer) !== JSON.stringify(job.config.reviewer) || JSON.stringify(config.toolchain) !== JSON.stringify(job.config.toolchain) || (job.verifiedDigest != null && !job.verifiedDependencyDigest);
        if (proofChanged && Object.keys(job.receipt).length) throw new Error('Verification proof is no longer valid after publication began; reconcile the existing upload before creating a new version');
        const patch: Partial<Job> = proofChanged && job.verifiedDigest ? { stage: 'verify', verifiedDigest: null, verifiedDependencyDigest: null, review: null, artifact: null } : {};
        const resumedConfig = { ...config, packageTarget: job.config.allowSubmit ? 'ipa' as const : config.packageTarget, allowSubmit: job.config.allowSubmit, allowRelease: job.config.allowRelease };
        return { ...patch, config: resumedConfig, status: 'queued', manualRecovery: null, nextAt: Date.now(), error: null };
      })));
    } else if (command === 'authorize') {
      if (!args.includes('--submit') || args.slice(1).some(arg => !['--submit', '--release'].includes(arg))) throw new Error('authorize requires --submit and optionally --release');
      print(view(store.transition(args[0], job => {
        if (!['ready', 'blocked', 'built'].includes(job.status) || Object.keys(job.receipt).length || job.stage === 'monitor') throw new Error('Publication permission can change only on stopped work before any remote intent');
        const publishing = validateAppleSpec(job.spec);
        if (args.includes('--release') && !/^[A-Za-z]{2}$/.test(publishing.storefrontCountry ?? '')) throw new Error('--release requires apple.storefrontCountry in the immutable product specification');
        const granted = { ...job.config, packageTarget: 'ipa' as const, allowSubmit: true, allowRelease: args.includes('--release') };
        return { config: granted, status: ['ready', 'built'].includes(job.status) ? 'queued' : 'blocked', nextAt: Date.now() };
      })));
    } else if (command === 'feedback') {
      if (!args[1]) throw new Error('Provide a file containing the actual App Review message; guessed feedback is not accepted');
      const feedback = readInputFile(args[1], 'App Review feedback').toString('utf8').trim();
      if (!feedback) throw new Error('App Review feedback file is empty');
      print(view(store.transition(args[0], job => {
        if (job.stage !== 'monitor' || job.appleReview?.status !== 'rejected' || job.status !== 'blocked') throw new Error('feedback is only allowed for an observed App Review rejection');
        const spec = structuredClone(job.spec);
        if (!spec.apple?.buildNumber || !/^\d+$/.test(spec.apple.buildNumber)) throw new Error('A numeric apple.buildNumber is required to prepare a replacement build');
        spec.apple.buildNumber = String(BigInt(spec.apple.buildNumber) + 1n);
        const resumedConfig = { ...config, packageTarget: job.config.allowSubmit ? 'ipa' as const : config.packageTarget, allowSubmit: job.config.allowSubmit, allowRelease: job.config.allowRelease };
        return { spec, config: resumedConfig, feedback, status: 'queued', stage: 'build', createdAt: Date.now(), attempts: {}, agentCalls: 0, nextAt: Date.now(), receipt: {}, ipaPath: null, archiveDigest: null, verifiedDigest: null, verifiedDependencyDigest: null, review: null, error: null };
      })));
    } else if (command === 'run') {
      if (args.some(arg => arg !== '--once')) throw new Error('run accepts only --once; use --config for the configuration path');
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      const stopPoll = setInterval(() => {
        const owner = store.workerStatus();
        if (owner.ownerPid === process.pid && owner.stopRequested) controller.abort();
      }, 1000);
      stopPoll.unref();
      try {
        await runWorker(store, config, { signal: controller.signal, once: args.includes('--once'), buildOnly,
          onResult: result => print(view(result)), onScan: result => console.error(JSON.stringify({ inbox: result })) });
      } finally {
        clearInterval(stopPoll);
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    } else throw new Error(`Unknown command ${command}; run help for supported commands`);
  } finally { store.close(); }
}

main().catch(error => { console.error(JSON.stringify({ error: toError(error).message })); process.exitCode = 1; });
