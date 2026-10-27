#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, loadJSON } from './config.js';
import { Store } from './store.js';
import { run, executionEnvironment } from './process.js';
import { appleDoctor, validateAppleSpec } from './apple.js';
import { runStep } from './scheduler.js';
import { nextTurn, completeTurn, abandonTurn } from './runner.js';
import { hosts, installIntegration, updateIntegration, inspectIntegration, uninstallIntegration } from './integrations.js';
import { submitRequirement, scanInbox } from './inbox.js';
import { MAX_INPUT_BYTES, parseRequirement, readInputFile } from './requirements.js';
import { dispatchRemote } from './remote.js';
import { toError } from './schemas.js';
import type { Config, Job } from './schemas.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));
const view = (job: Job) => ({ id: job.id, product: job.spec.id, version: job.spec.apple?.version ?? '1.0.0', stage: job.stage, status: job.status, hostTurns: job.hostTurns, attempts: job.attempts, workspace: job.workspace, artifact: job.artifact ?? null, error: job.error ?? null });

function inputJSON(path: string): unknown {
  const bytes = path === '-' ? readFileSync(0) : readInputFile(path);
  if (bytes.length > MAX_INPUT_BYTES) throw new Error(`Input exceeds ${MAX_INPUT_BYTES} bytes`);
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function arity(args: string[], minimum: number, maximum: number, usage: string): void {
  if (args.length < minimum || args.length > maximum) throw new Error(`Usage: apphx ${usage}`);
}

function outcome(job: Job): void {
  print(view(job));
  if (job.status === 'blocked' || job.status === 'failed') process.exitCode = 2;
}

async function probe(argv: string[], config: Config) {
  try {
    const result = await run(argv, { env: executionEnvironment(config), timeoutMs: 30000 });
    return { available: result.code === 0, detail: (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim() };
  } catch (error) { return { available: false, detail: toError(error).message }; }
}

const help = `apphx <command> [--config factory.json] [--build-only]
  hosts                         List supported agent hosts and activation commands
  install <host>                Install the workflow in the current project
  update <host>                 Update an existing, unmodified host workflow
  uninstall <host>              Remove an unchanged installation owned by this package
    --project <directory>       Select the project (default: current directory)
    --global                    Use the host's user-level skill directory instead
  doctor --host <host>           Check installed workflow files; does not run the agent
  init [--allow-local-execution] Create factory.json without overwriting it
  doctor                        Check local build tools and execution permissions
  enqueue <spec.json|->          Persist requirements and return a task ID
  next <id>                     Resume a host turn or show the next deterministic action
  complete <id> <turn> [json|-]   Record research/review, or finish the host's build turn
  abandon <id> <turn>            Abandon a host turn without resetting its budget
  step <id>                     Execute one verification, packaging or Apple stage
  status [id]                   Read durable task state as JSON
  events <id>                   Read task transitions and evidence
  retry <id>                    Resume stopped work; preserve budgets and permissions
  submit <spec.json|->           Write requirements to the configured inbox
  scan [--observe]              Validate or ingest inbox files; never start an agent
  inbox                         Read durable intake results
  reconcile-intake <id> <json|-> Restore a legacy request identity from original input
  authorize <id> --submit [--release]  Explicitly grant publication permission
  feedback <id> <file>           Resume using actual App Review rejection feedback
  remote <command>              Call an installed Mac CLI over SSH (build-only)
  --version                     Print the installed package version

Your agent supplies the model, session, tools and native delegation.
No coding-agent subprocess or autonomous daemon is started by this CLI.
Only verified local artifacts reach built; uploads require separate authorization.`;

async function main(): Promise<void> {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      config: { type: 'string', default: 'factory.json' },
      'build-only': { type: 'boolean', default: false },
      project: { type: 'string' },
      global: { type: 'boolean' },
      host: { type: 'string' },
      'allow-local-execution': { type: 'boolean' },
      observe: { type: 'boolean' },
      submit: { type: 'boolean' },
      release: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (values.version) {
    const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string };
    console.log(metadata.version);
    return;
  }
  if (!command || command === 'help' || values.help) { console.log(help); return; }
  const flags: Record<string, string[]> = {
    hosts: [], install: ['project', 'global'], update: ['project', 'global'], uninstall: ['project', 'global'],
    init: ['config', 'allow-local-execution'], doctor: ['config', 'build-only', 'host', 'project', 'global'],
    enqueue: ['config', 'build-only'], next: ['config', 'build-only'], complete: ['config', 'build-only'], abandon: ['config', 'build-only'],
    step: ['config', 'build-only'], status: ['config', 'build-only'], events: ['config', 'build-only'], retry: ['config', 'build-only'],
    submit: ['config', 'build-only'], scan: ['config', 'build-only', 'observe'], inbox: ['config', 'build-only'],
    'reconcile-intake': ['config', 'build-only'], authorize: ['config', 'build-only', 'submit', 'release'], feedback: ['config', 'build-only'],
    remote: ['config', 'observe'],
  };
  if (!(command in flags)) throw new Error(`Unknown command ${command}; run apphx --help`);
  for (const token of tokens) {
    if (token.kind === 'option' && !flags[command].includes(token.name)) throw new Error(`${command} does not accept --${token.name}`);
  }
  const configPath = values.config;
  const buildOnly = values['build-only'];
  if (values.global && values.project) throw new Error('Choose --project or --global, not both');
  const scope = { project: values.project, global: values.global };
  if (command === 'hosts') { arity(args, 0, 0, 'hosts'); print(hosts); return; }
  if (command === 'install' || command === 'update' || command === 'uninstall') {
    arity(args, 1, 1, `${command} <host> [--project <directory> | --global]`);
    const operation = command === 'install' ? installIntegration : command === 'update' ? updateIntegration : uninstallIntegration;
    print(operation(args[0], scope));
    return;
  }
  if (command === 'doctor' && values.host) {
    arity(args, 0, 0, 'doctor --host <host> [--project <directory> | --global]');
    const result = inspectIntegration(values.host, scope);
    print(result);
    if (!result.installed) process.exitCode = 2;
    return;
  }
  if (command === 'doctor' && (values.project || values.global)) throw new Error('--project and --global require doctor --host <host>');
  if (command === 'init') {
    arity(args, 0, 0, 'init [--config <file>] [--allow-local-execution]');
    const template = JSON.parse(readFileSync(join(packageRoot, 'examples', 'factory.json'), 'utf8')) as Record<string, unknown>;
    if (values['allow-local-execution']) template.allowLocalExecution = true;
    mkdirSync(dirname(resolve(configPath)), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    print({ config: resolve(configPath), localExecution: template.allowLocalExecution, next: 'Configure Flutter/Xcode and IOS_DEVICE_ID, then run apphx doctor --build-only' });
    return;
  }
  if (command === 'remote') {
    process.exitCode = await dispatchRemote(loadJSON(configPath), [...args, ...(values.observe ? ['--observe'] : [])]);
    return;
  }
  const config = loadConfig(configPath);
  if (buildOnly && (config.allowSubmit || config.allowRelease)) throw new Error('--build-only refuses configurations with upload or release enabled');
  if (buildOnly && ['authorize', 'feedback'].includes(command)) throw new Error('Publication commands are forbidden in --build-only mode');
  if (command === 'submit') {
    arity(args, 1, 1, 'submit <spec.json|->');
    print(submitRequirement(config, inputJSON(args[0])));
    return;
  }
  if (command === 'doctor') {
    arity(args, 0, 0, 'doctor [--build-only]');
    const flutter = config.toolchain ? join(config.toolchain.flutterSdk, 'bin', 'flutter') : 'flutter';
    const [flutterCheck, xcode] = await Promise.all([probe([flutter, '--version'], config), probe(['xcodebuild', '-version'], config)]);
    const environment = executionEnvironment(config);
    const neededEnv = [...new Set([...config.verification.prerequisites, ...config.verification.checks, ...config.verification.runtime].flat().flatMap(arg => [...arg.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map(match => match[1])))];
    const checks = [
      { name: 'local-execution-permission', available: config.allowLocalExecution, detail: config.executionWarning ?? 'Trusted local commands permitted; host tools remain under the host permission policy' },
      { name: 'flutter', ...flutterCheck }, { name: 'xcode', ...xcode },
      ...neededEnv.map(name => ({ name, available: Boolean(environment[name]), detail: environment[name] ? 'Available in the configured execution environment; value not printed' : `Set ${name} and include its name in executionEnv` })),
    ];
    if (config.allowSubmit) checks.push(...await appleDoctor());
    print({ checks, submissionEnabled: config.allowSubmit, model: 'Provided by your agent host; no separate model authentication is configured here' });
    if (checks.some(check => !check.available)) process.exitCode = 2;
    return;
  }
  const store = new Store(config.stateDir);
  try {
    if (command === 'enqueue') {
      arity(args, 1, 1, 'enqueue <spec.json|->');
      const { spec, baseJobId } = parseRequirement(inputJSON(args[0]));
      if (config.allowSubmit) validateAppleSpec(spec);
      print(view(store.enqueue(spec, config, baseJobId)));
    } else if (command === 'scan') {
      arity(args, 0, 0, 'scan [--observe]');
      const result = await scanInbox(store, config, { observe: values.observe });
      print(result);
      if (result.error || result.entries.some(entry => entry.status === 'error')) process.exitCode = 2;
    } else if (command === 'inbox') {
      arity(args, 0, 0, 'inbox');
      print(store.inboxEntries());
    } else if (command === 'status') {
      arity(args, 0, 1, 'status [id]');
      print(args[0] ? store.get(args[0]) : store.list().map(view));
    } else if (command === 'events') {
      arity(args, 1, 1, 'events <id>');
      print(store.events(args[0]));
    } else if (command === 'next') {
      arity(args, 1, 1, 'next <id>');
      const result = await nextTurn(store, args[0], { buildOnly });
      print(result);
      if (result.job.status === 'blocked' || result.job.status === 'failed') process.exitCode = 2;
    } else if (command === 'complete') {
      arity(args, 2, 3, 'complete <id> <turn-id> [result.json|-]');
      outcome(await completeTurn(store, args[0], args[1], args[2] ? inputJSON(args[2]) : undefined, { buildOnly }));
    } else if (command === 'abandon') {
      arity(args, 2, 2, 'abandon <id> <turn-id>');
      outcome(abandonTurn(store, args[0], args[1], { buildOnly }));
    } else if (command === 'step') {
      arity(args, 1, 1, 'step <id>');
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      try { outcome(await runStep(store, config, args[0], { signal: controller.signal, buildOnly })); }
      finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    } else if (command === 'reconcile-intake') {
      arity(args, 2, 2, 'reconcile-intake <id> <original-spec.json|->');
      const { spec, baseJobId } = parseRequirement(inputJSON(args[1]));
      print(view(store.reconcileIntake(args[0], spec, baseJobId)));
    } else if (command === 'retry') {
      arity(args, 1, 1, 'retry <id>');
      print(view(store.transition(args[0], job => {
        if (buildOnly && (job.config.allowSubmit || job.config.allowRelease)) throw new Error('--build-only refuses a task with snapshotted publication permission');
        if (!['blocked', 'ready', 'built'].includes(job.status)) throw new Error(`Cannot retry ${job.status}; budgets and active work cannot be reset by retry`);
        if (job.turn) throw new Error('Abandon the active host turn before changing task configuration');
        const proofChanged = JSON.stringify(config.verification) !== JSON.stringify(job.config.verification) || JSON.stringify(config.executionEnv) !== JSON.stringify(job.config.executionEnv) || JSON.stringify(config.toolchain) !== JSON.stringify(job.config.toolchain) || (job.verifiedDigest != null && !job.verifiedDependencyDigest);
        if (proofChanged && Object.keys(job.receipt).length) throw new Error('Verification proof is no longer valid after publication began; reconcile the existing upload before creating a new version');
        const patch: Partial<Job> = proofChanged && job.verifiedDigest ? { stage: 'verify', verifiedDigest: null, verifiedDependencyDigest: null, review: null, artifact: null } : {};
        const resumedConfig = { ...config, packageTarget: job.config.allowSubmit ? 'ipa' as const : config.packageTarget, allowSubmit: job.config.allowSubmit, allowRelease: job.config.allowRelease };
        return { ...patch, config: resumedConfig, status: 'queued', manualRecovery: null, nextAt: Date.now(), error: null };
      })));
    } else if (command === 'authorize') {
      arity(args, 1, 1, 'authorize <id> --submit [--release]');
      if (!values.submit) throw new Error('authorize requires --submit');
      print(view(store.transition(args[0], job => {
        if (job.turn || !['ready', 'blocked', 'built'].includes(job.status) || Object.keys(job.receipt).length || job.stage === 'monitor') throw new Error('Publication permission can change only on stopped work before any remote intent');
        const publishing = validateAppleSpec(job.spec);
        if (values.release && !/^[A-Za-z]{2}$/.test(publishing.storefrontCountry ?? '')) throw new Error('--release requires apple.storefrontCountry in the immutable product specification');
        const granted = { ...job.config, packageTarget: 'ipa' as const, allowSubmit: true, allowRelease: Boolean(values.release) };
        return { config: granted, status: ['ready', 'built'].includes(job.status) ? 'queued' : 'blocked', nextAt: Date.now() };
      })));
    } else if (command === 'feedback') {
      arity(args, 2, 2, 'feedback <id> <file>');
      const feedback = readInputFile(args[1], 'App Review feedback').toString('utf8').trim();
      if (!feedback) throw new Error('App Review feedback file is empty');
      print(view(store.transition(args[0], job => {
        if (job.turn || job.stage !== 'monitor' || job.appleReview?.status !== 'rejected' || job.status !== 'blocked') throw new Error('feedback is only allowed for an observed App Review rejection');
        const spec = structuredClone(job.spec);
        if (!spec.apple?.buildNumber || !/^\d+$/.test(spec.apple.buildNumber)) throw new Error('A numeric apple.buildNumber is required to prepare a replacement build');
        spec.apple.buildNumber = String(BigInt(spec.apple.buildNumber) + 1n);
        const resumedConfig = { ...config, packageTarget: job.config.allowSubmit ? 'ipa' as const : config.packageTarget, allowSubmit: job.config.allowSubmit, allowRelease: job.config.allowRelease };
        return { spec, config: resumedConfig, feedback, status: 'queued', stage: 'build', createdAt: Date.now(), attempts: {}, hostTurns: 0, nextAt: Date.now(), receipt: {}, ipaPath: null, archiveDigest: null, verifiedDigest: null, verifiedDependencyDigest: null, review: null, error: null };
      })));
    }
  } finally { store.close(); }
}

main().catch(error => { console.error(JSON.stringify({ error: toError(error).message })); process.exitCode = 1; });
