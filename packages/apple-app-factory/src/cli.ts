#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalPath, loadConfig, loadJSON, expandArgv, normalizeIsolationPaths, validateProjectSource } from './config.js';
import { Store } from './store.js';
import { run, executionEnvironment } from './process.js';

import { runStep } from './scheduler.js';
import { nextTurn, nextQueueTurn, completeTurn, abandonTurn, driveQueue } from './runner.js';
import { hosts, installIntegration, updateIntegration, inspectIntegration, uninstallIntegration } from './integrations.js';
import { submitRequirement, scanInbox } from './inbox.js';
import { MAX_INPUT_BYTES, parseRequirement, readInputFile } from './requirements.js';
import { dispatchRemote } from './remote.js';
import { FrameworkSchema, PlatformSchema, PackageTargetSchema, DecisionInputSchema, toError, validateJobConfig } from './schemas.js';
import type { Config, Framework, Job, Platform } from './schemas.js';
import { assertProject, doctorCommands } from './project-profiles.js';
import { closestOwnedGoWorkspace } from './go-dependencies.js';
import { validateMyGoCommand } from './mygo-build.js';
import { invalidateVerification, verificationConfigChanged } from './proof.js';
import { notifyJob, notifyBuiltJobs } from './notify.js';
import { prepareIsolatedCommand, removeConfinedPath, type IsolatedCommand } from './isolation.js';
import { reportJob } from './report.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));
const view = (job: Job) => ({ id: job.id, product: job.spec.id, framework: job.spec.framework, platform: job.spec.platform, channel: job.spec.channel, version: job.spec.version, priority: job.spec.priority, stage: job.stage, status: job.status, hostTurns: job.hostTurns, attempts: job.attempts, workspace: job.workspace, artifact: job.artifact ?? null, error: job.error ?? null });

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
  if (job.status === 'blocked' || job.status === 'failed' || job.status === 'needs-owner') process.exitCode = 2;
}

function assertDecideBuildOnly(config: Config): void {
  const forbidden = ['allowSubmit', 'allowRelease'].filter(key => key in (config as unknown as Record<string, unknown>));
  if (forbidden.length) {
    throw Object.assign(new Error(`--build-only cannot decide on a configuration with publication permission (${forbidden.join(', ')}); remove it from the control configuration`), { code: 'SETUP_REQUIRED' });
  }
}

function decisionEntries(input: unknown): Array<{ at: number; stage: string; role: string; rationale: string }> {
  const items = Array.isArray(input) ? input : [input];
  if (items.length === 0) throw new Error('decide requires at least one decision-log entry');
  return items.map(item => {
    const entry = DecisionInputSchema.parse(item);
    return { at: Date.now(), stage: entry.stage, role: entry.role, rationale: entry.rationale };
  });
}

async function probe(argv: string[], config: Config, context?: { cwd: string; env: NodeJS.ProcessEnv; sourceRoot?: string }) {
  let temporary: string | undefined;
  let isolated: IsolatedCommand | undefined;
  try {
    const env = context?.env ?? executionEnvironment(config);
    const expanded = expandArgv(argv, env);
    validateMyGoCommand(config, expanded);
    if (config.isolation) {
      if (!config.allowLocalExecution) return { available: false, detail: 'Owner must enable local execution before isolated probes run' };
      temporary = mkdtempSync(join(tmpdir(), 'apphx-doctor-'));
      const scoped: Config = { ...config, isolation: { ...config.isolation, readOnlyPaths: [...config.isolation.readOnlyPaths, ...(context?.sourceRoot ? [canonicalPath(context.sourceRoot)] : [])] } };
      normalizeIsolationPaths(scoped);
      isolated = prepareIsolatedCommand(expanded, { config: scoped, workspace: temporary, cwd: context?.cwd ?? temporary, env, scratchParent: temporary });
    }
    const result = await run(isolated?.argv ?? expanded, { cwd: context?.cwd ?? temporary, env: isolated?.env ?? env, timeoutMs: 30000 });
    return { available: result.code === 0, detail: (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim() };
  } catch (error) { return { available: false, detail: toError(error).message }; }
  finally {
    isolated?.cleanup();
    if (temporary) removeConfinedPath(temporary, temporary);
  }
}

const frameworks = FrameworkSchema.options;
const packageTargets = PackageTargetSchema.options;

function initialConfig(framework: Framework, platform: Platform, target: Config['packageTarget']): Record<string, unknown> {
  if ((framework === 'mygo') !== (platform === 'macos')) throw new Error(`${framework} does not support ${platform}`);
  if ((framework === 'android-java' && platform !== 'android') || (framework === 'swift' && platform !== 'ios')) throw new Error(`${framework} does not support ${platform}`);
  const allowedTargets = platform === 'macos' ? ['app', 'dmg'] : platform === 'ios' ? ['simulator', 'ipa'] : ['apk', 'aab'];
  if (!allowedTargets.includes(target)) throw new Error(`${target} does not match platform ${platform}`);
  const template = JSON.parse(readFileSync(join(packageRoot, 'examples', `${framework}.factory.json`), 'utf8')) as Record<string, unknown>;
  template.packageTarget = target;
  if (framework === 'mygo') {
    template.packaging = {
      provider: 'local',
      commands: [['go', 'tool', 'mygo', 'build', '-platform', 'darwin/arm64', '-sign', '-', '-skip-notarize', ...(target === 'app' ? ['-skip-dmg'] : []), '-o', 'build']],
      artifactPath: target === 'app' ? 'build/darwin-arm64/MyGo App.app' : 'build/darwin-arm64/MyGo App 0.1.0.dmg',
    };
  } else if (framework === 'flutter') {
    template.executionEnv = platform === 'ios' ? ['IOS_DEVICE_ID'] : ['ANDROID_DEVICE_ID'];
    template.verification = {
      prerequisites: platform === 'ios' ? [['xcodebuild', '-version']] : [['java', '-version'], ['adb', 'version']],
      checks: [['flutter', 'analyze', '--fatal-infos'], ['flutter', 'test']],
      runtime: [['flutter', 'drive', '--driver', 'test_driver/integration_test.dart', '--target', 'integration_test/app_test.dart', '-d', platform === 'ios' ? '${IOS_DEVICE_ID}' : '${ANDROID_DEVICE_ID}', '--no-pub']],
    };
  } else if (framework === 'expo') {
    const device = platform === 'ios' ? 'IOS_DEVICE_ID' : 'ANDROID_DEVICE_ID';
    const profile = target === 'simulator' ? 'simulator' : target === 'apk' ? 'apk' : 'production';
    const output = target === 'simulator' ? 'build/simulator.tar.gz' : `build/app.${target}`;
    template.executionEnv = [device, ...(platform === 'android' ? ['ANDROID_HOME'] : [])];
    template.verification = {
      prerequisites: [['node', '--version'], ['eas', '--version']],
      checks: [['npm', 'run', 'lint'], ['npm', 'test', '--', '--runInBand']],
      runtime: [['npm', 'run', 'test:e2e', '--', '--platform', platform, '--device', '${' + device + '}']],
    };
    template.packaging = {
      provider: 'local',
      commands: [['eas', 'build', '--platform', platform, '--profile', profile, '--local', '--non-interactive', '--output', output], ...(target === 'simulator' ? [['tar', '-xzf', output, '-C', 'build']] : [])],
      artifactPath: target === 'simulator' ? 'build/App.app' : output,
    };
  } else if (platform === 'ios') {
    const native = framework === 'swift' ? '.' : framework === 'uni-app' ? 'native/ios' : 'ios';
    const project = framework === 'swift' ? ['-project', 'App.xcodeproj'] : ['-workspace', `${native}/App.xcworkspace`];
    const base = ['xcodebuild', ...project, '-scheme', 'App'];
    template.executionEnv = ['IOS_DEVICE_ID'];
    template.verification = {
      prerequisites: [['xcodebuild', '-version'], ...(framework === 'swift' ? [] : [['node', '--version'], ['npm', '--version']])],
      checks: framework === 'swift' ? [[...base, 'build-for-testing', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', 'build/DerivedData']] : [['npm', 'run', 'lint'], ['npm', 'test', '--', '--runInBand']],
      runtime: framework === 'swift' ? [[...base, 'test-without-building', '-destination', 'id=${IOS_DEVICE_ID}', '-derivedDataPath', 'build/DerivedData']] : [['npm', 'run', 'test:e2e', '--', '--platform', 'ios', '--device', '${IOS_DEVICE_ID}']],
    };
    template.packaging = target === 'simulator' ? {
      commands: [[...base, 'build', '-configuration', 'Debug', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', 'build/DerivedData']],
      artifactPath: 'build/DerivedData/Build/Products/Debug-iphonesimulator/App.app', provider: 'local',
    } : {
      commands: [[...base, 'archive', '-configuration', 'Release', '-destination', 'generic/platform=iOS', '-archivePath', 'build/App.xcarchive'], ['xcodebuild', '-exportArchive', '-archivePath', 'build/App.xcarchive', '-exportPath', 'build/export', '-exportOptionsPlist', 'ExportOptions.plist']],
      artifactPath: 'build/export/App.ipa', provider: 'local',
    };
  } else if (target === 'apk') {
    const packaging = template.packaging as { commands: string[][]; artifactPath: string };
    packaging.commands = packaging.commands.map(argv => argv.map(arg => arg === ':app:bundleRelease' ? ':app:assembleRelease' : arg));
    packaging.artifactPath = packaging.artifactPath.replace('bundle/release/app-release.aab', 'apk/release/app-release.apk');
  }
  return template;
}

const help = `apphx <command> [--config factory.json] [--build-only]
  hosts                         List supported agent hosts and activation commands
  install <host>                Install the workflow in the current project
  update <host>                 Update an existing, unmodified host workflow
  uninstall <host>              Remove an unchanged installation owned by this package
    --project <directory>       Select the project (default: current directory)
    --global                    Use the host's user-level skill directory instead
  doctor --host <host>           Check installed workflow files; does not run the agent
  init [--allow-local-execution] [--autopilot] Create owner-editable factory.json; default Flutter/iOS
    --autopilot                 Owner-preauthorized unattended local build (implies allowLocalExecution)
    --framework <stack>         flutter|android-java|swift|react-native|expo|uni-app|mygo
    --platform <platform>       ios|android|macos (mygo defaults macos; android-java android)
    --package-target <target>   simulator|ipa|apk|aab|app|dmg (MyGo app; Expo iOS ipa)
  doctor [spec.json]            Check configured prerequisites and optional stack tools
  enqueue <spec.json|->          Persist requirements and return a task ID
  next [<id>|--any]             Resume a host turn, show the next deterministic action, or pick the next actionable queued task (--any)
  drive [--once] [--max-rounds n] [--strict]   Drive the loop: sweep inbox, run due stages, claim host turns; wait/done carry nextDueAt and the queue summary; --strict exits 2 on failed/needs-owner
  complete <id> <turn> [json|-]   Record research/review, or finish the host's build turn
  abandon <id> <turn>            Abandon a host turn without resetting its budget
  decide <id> <json-file|->       Append decision-log entries (role, rationale) to a task
  step <id>                     Execute one obfuscation, verification or packaging stage
  status [id]                   Read durable task state as JSON
  events <id>                   Read task transitions and evidence
  report <id>                   Write handoff deliverables (source copy, artifact, checklist, failures)
  retry <id>                    Resume stopped work; preserve budgets and proofs
  submit <spec.json|->           Write requirements to the configured inbox
  scan [--observe]              Validate or ingest inbox files; never start an agent
  inbox                         Read durable intake results
  reconcile-intake <id> <json|-> Restore a legacy request identity from original input
  notify [<id>|--any]          Email the author for built, gate-passed tasks (--any sweeps all unnotified)
  remote <command>              Call an installed Mac CLI over SSH (build-only)
  obfuscator <project>          Run the bundled deterministic obfuscator on a project copy
    --config <file>             Obfuscator options as JSON (required)
    --framework <stack>         flutter|android-java|swift|react-native|expo|uni-app|mygo
    --seed <text>               Determinism seed
  --version                     Print the installed package version

Your agent supplies the model, session, tools and native delegation.
No coding-agent subprocess or autonomous daemon is started by this CLI.
Only verified local artifacts reach built. Store submission and review are manual human work outside this tool.`;

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
      autopilot: { type: 'boolean' },
      framework: { type: 'string' },
      seed: { type: 'string' },
      platform: { type: 'string' },
      'package-target': { type: 'string' },
      observe: { type: 'boolean' },
      any: { type: 'boolean' },
      out: { type: 'string' },
      collect: { type: 'boolean', default: false },
      once: { type: 'boolean', default: false },
      'max-rounds': { type: 'string' },
      strict: { type: 'boolean', default: false },
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
    init: ['config', 'allow-local-execution', 'autopilot', 'framework', 'platform', 'package-target'], doctor: ['config', 'build-only', 'host', 'project', 'global'],
    enqueue: ['config', 'build-only'], next: ['config', 'build-only', 'any'], drive: ['config', 'build-only', 'once', 'max-rounds', 'strict'], complete: ['config', 'build-only'], abandon: ['config', 'build-only'],
    decide: ['config', 'build-only'],
    step: ['config', 'build-only'], status: ['config', 'build-only'], events: ['config', 'build-only'], report: ['config', 'build-only', 'out', 'collect'], retry: ['config', 'build-only'],
    notify: ['config', 'build-only', 'any'],
    submit: ['config', 'build-only'], scan: ['config', 'build-only', 'observe'], inbox: ['config', 'build-only'],
    'reconcile-intake': ['config', 'build-only'],
    remote: ['config', 'observe'],
    obfuscator: ['config', 'framework', 'seed'],
  };
  if (!(command in flags)) throw new Error(`Unknown command ${command}; run apphx --help`);
  for (const token of tokens) {
    if (token.kind === 'option' && !flags[command].includes(token.name)) throw new Error(`${command} does not accept --${token.name}`);
  }
  const configPath = values.config;
  const buildOnly = values['build-only'];
  if (values.global && values.project) throw new Error('Choose --project or --global, not both');
  const scope = { project: values.project, global: values.global };
  if (command === 'obfuscator') {
    arity(args, 1, 1, 'obfuscator <project> --config <file> [--framework <stack>] [--seed <text>]');
    const bundled = join(packageRoot, 'dist', 'vendor', 'obfuscator', 'dist', 'cli.js');
    if (!existsSync(bundled)) throw new Error(`Bundled obfuscator is missing at ${bundled}; reinstall the apphx package`);
    const forward = [bundled, '--project', resolve(args[0]!)];
    // Forward only flags that were actually given, so the bundled binary sees exactly what the user
    // typed; an explicit empty value must reach the child and be rejected there, not dropped here.
    const configGiven = tokens.some(token => token.kind === 'option' && token.name === 'config');
    if (configGiven) forward.push('--config', resolve(values.config));
    if (values.framework !== undefined) forward.push('--framework', values.framework);
    if (values.seed !== undefined) forward.push('--seed', values.seed);
    const result = spawnSync(process.execPath, forward, { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  if (command === 'hosts') { arity(args, 0, 0, 'hosts'); print(hosts); return; }
  if (command === 'install' || command === 'update' || command === 'uninstall') {
    arity(args, 1, 1, `${command} <host> [--project <directory> | --global]`);
    const operation = command === 'install' ? installIntegration : command === 'update' ? updateIntegration : uninstallIntegration;
    operation(args[0], scope);
    print(['apphx', 'apphx-obfuscator'].map(skill => inspectIntegration(args[0], scope, skill as 'apphx' | 'apphx-obfuscator')));
    return;
  }
  if (command === 'doctor' && values.host) {
    arity(args, 0, 0, 'doctor --host <host> [--project <directory> | --global]');
    const host = values.host;
    const skills = ['apphx', 'apphx-obfuscator'] as const;
    const results = skills.map(skill => inspectIntegration(host, scope, skill));
    print(results);
    if (!results[0]!.installed) process.exitCode = 2;
    return;
  }
  if (command === 'doctor' && (values.project || values.global)) throw new Error('--project and --global require doctor --host <host>');
  if (command === 'init') {
    arity(args, 0, 0, 'init [--framework <stack>] [--platform ios|android|macos] [--package-target simulator|ipa|apk|aab|app|dmg] [--config <file>] [--allow-local-execution] [--autopilot]');
    const framework = values.framework ?? 'flutter';
    if (!frameworks.includes(framework as Framework)) throw new Error(`Unknown framework ${framework}; choose ${frameworks.join(', ')}`);
    const platform = PlatformSchema.parse(values.platform ?? (framework === 'mygo' ? 'macos' : framework === 'android-java' ? 'android' : 'ios'));
    const target = values['package-target'] ?? (platform === 'macos' ? 'app' : platform === 'ios' ? framework === 'expo' ? 'ipa' : 'simulator' : 'apk');
    if (!packageTargets.includes(target as Config['packageTarget'])) throw new Error(`Unknown package target ${target}; choose ${packageTargets.join(', ')}`);
    const template = initialConfig(framework as Framework, platform, target as Config['packageTarget']);
    if (values['allow-local-execution']) template.allowLocalExecution = true;
    if (values.autopilot) {
      template.allowLocalExecution = true;
      template.autopilot = true;
    }
    mkdirSync(dirname(resolve(configPath)), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    print({ config: resolve(configPath), framework, platform, packageTarget: target, localExecution: template.allowLocalExecution, next: framework === 'mygo' ? 'Pin MyGo v0.3.0 in go.mod (Go 1.27.1), match app name/version/arch and artifact path, and implement real desktop UI acceptance in cmd/acceptance. Native UI needs no Bun. Local ad-hoc builds only; init creates configuration, not source.' : framework === 'expo' ? 'Configure your existing eas.json production (store IPA/AAB), apk (Android buildType apk), or simulator (ios.simulator true) profile, real device acceptance, and exact app product/output path; no prebuild/eject is requested. Run apphx doctor <spec.json> --build-only.' : 'Adapt module/scheme, real device acceptance, signing and artifact path to your project; then run apphx doctor <spec.json> --build-only. init creates configuration, not app source.' });
    return;
  }
  if (command === 'remote') {
    process.exitCode = await dispatchRemote(loadJSON(configPath), [...args, ...(values.observe ? ['--observe'] : [])]);
    return;
  }
  const config = loadConfig(configPath);
  if (command === 'submit') {
    arity(args, 1, 1, 'submit <spec.json|->');
    print(submitRequirement(config, inputJSON(args[0])));
    return;
  }
  if (command === 'doctor') {
    arity(args, 0, 1, 'doctor [spec.json] [--build-only]');
    const spec = args[0] ? parseRequirement(inputJSON(args[0])).spec : undefined;
    let prerequisiteContext: { cwd: string; env: NodeJS.ProcessEnv; sourceRoot?: string } | undefined;
    if (spec) {
      validateJobConfig(spec, config);
      let source: string | undefined;
      try { source = validateProjectSource(spec, config); }
      catch (error) {
        if (spec.framework !== 'mygo' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const directory = spec.project?.directory ?? '.';
      const project = source ? resolve(source, directory) : undefined;
      if (source && project && (spec.framework !== 'mygo' || existsSync(project))) {
        assertProject(project, spec);
        if (spec.framework === 'mygo' || config.isolation) prerequisiteContext = {
          cwd: project, sourceRoot: source,
          env: { ...executionEnvironment(config), ...(spec.framework === 'mygo' ? { GOWORK: closestOwnedGoWorkspace(source, directory) ?? 'off', GOENV: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly' } : {}) },
        };
      }
    }
    const commands = spec && config.packaging?.provider !== 'cloud' ? doctorCommands(spec.framework, spec.platform) : [];
    const tools = await Promise.all(commands.map(async ({ name, argv }) => ({ name, ...await probe(argv[0] === 'flutter' && config.toolchain ? [join(config.toolchain.flutterSdk, 'bin', 'flutter'), ...argv.slice(1)] : argv, config) })));
    const prerequisites = await Promise.all(config.verification.prerequisites.map(async (argv, index) => ({
      name: `configured-prerequisite-${index + 1}`,
      ...(!config.allowLocalExecution
        ? { available: false, detail: 'Owner must enable allowLocalExecution before configured prerequisite commands run' }
        : spec?.framework === 'mygo' && !prerequisiteContext
          ? { available: false, detail: 'Project-scoped prerequisite cannot be checked yet: select an existing MyGo source app with project.sourceDir and project.directory; doctor does not create source or use the control module' }
          : await probe(argv, config, prerequisiteContext)),
    })));
    const environment = executionEnvironment(config);
    const configuredCommands = [...config.verification.prerequisites, ...config.verification.checks, ...config.verification.runtime, ...(config.packaging?.commands ?? [])];
    const neededEnv = [...new Set(configuredCommands.flat().flatMap(arg => [...arg.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map(match => match[1])))];
    const checks = [
      { name: 'local-execution-permission', available: config.allowLocalExecution, detail: config.executionWarning ?? 'Trusted local commands permitted; host tools remain under the host permission policy' },
      ...(config.isolation ? [{ name: 'subprocess-isolation', ...await probe(['/usr/bin/true'], config), mode: config.isolation.mode, network: config.isolation.network }] : []),
      ...tools, ...prerequisites,
      ...neededEnv.map(name => ({ name, available: Boolean(environment[name]), detail: environment[name] ? 'Available in the configured execution environment; value not printed' : `Set ${name} and include its name in executionEnv` })),
    ];
    print({ framework: spec?.framework ?? null, platform: spec?.platform ?? null, checks, note: spec ? 'Tool availability is not runtime acceptance; configured checks run in the task workspace during verify' : 'No stack assumed; pass spec.json for profile-specific probes and compatibility checks', model: 'Provided by your agent host; no separate model authentication is configured here' });
    if (checks.some(check => !check.available)) process.exitCode = 2;
    return;
  }
  const queuedRequirement = command === 'enqueue' ? (() => {
    arity(args, 1, 1, 'enqueue <spec.json|->');
    const requirement = parseRequirement(inputJSON(args[0]));
    validateJobConfig(requirement.spec, config);
    validateProjectSource(requirement.spec, config);
    return requirement;
  })() : undefined;
  const store = new Store(config.stateDir);
  try {
    if (command === 'enqueue') {
      const { spec, baseJobId } = queuedRequirement!;
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
    } else if (command === 'report') {
      arity(args, 1, 1, 'report <id> [--out <dir>] [--collect] [--build-only] [--config <file>]');
      print(reportJob(store, args[0], { out: values.out, collect: values.collect, buildOnly, config }));
    } else if (command === 'next') {
      if (values.any) {
        arity(args, 0, 0, 'next --any');
        print(await nextQueueTurn(store, { buildOnly }));
      } else {
        arity(args, 1, 1, 'next <id>');
        const result = await nextTurn(store, args[0], { buildOnly });
        print(result);
        if (result.job.status === 'blocked' || result.job.status === 'failed' || result.job.status === 'needs-owner') process.exitCode = 2;
      }
    } else if (command === 'drive') {
      arity(args, 0, 0, 'drive [--once] [--max-rounds <n>] [--strict] [--build-only] [--config <file>]');
      const maxRounds = values['max-rounds'] === undefined ? undefined : Number(values['max-rounds']);
      if (maxRounds !== undefined && (!Number.isSafeInteger(maxRounds) || maxRounds <= 0)) throw new Error('--max-rounds must be a positive integer');
      const result = await driveQueue(store, config, { once: values.once, maxRounds, strict: values.strict, buildOnly });
      print(result);
      if (values.strict && result.failed?.length) process.exitCode = 2;
    } else if (command === 'complete') {
      arity(args, 2, 3, 'complete <id> <turn-id> [result.json|-]');
      outcome(await completeTurn(store, args[0], args[1], args[2] ? inputJSON(args[2]) : undefined, { buildOnly }));
    } else if (command === 'abandon') {
      arity(args, 2, 2, 'abandon <id> <turn-id>');
      outcome(abandonTurn(store, args[0], args[1], { buildOnly }));
    } else if (command === 'decide') {
      arity(args, 2, 2, 'decide <id> <json-file|->');
      if (buildOnly) assertDecideBuildOnly(config);
      const entries = decisionEntries(inputJSON(args[1]));
      print(view(store.transition(args[0], current => ({ decisions: [...current.decisions, ...entries] }))));
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
    } else if (command === 'notify') {
      if (values.any) {
        arity(args, 0, 0, 'notify --any');
        const outcomes = await notifyBuiltJobs(store, config);
        print(outcomes);
        if (outcomes.some(outcome => outcome.error)) process.exitCode = 2;
      } else {
        arity(args, 1, 1, 'notify <id>');
        print(await notifyJob(store, config, args[0]));
      }
    } else if (command === 'retry') {
      arity(args, 1, 1, 'retry <id>');
      print(view(store.transition(args[0], job => {
        if (!['blocked', 'needs-owner', 'ready', 'built'].includes(job.status)) throw new Error(`Cannot retry ${job.status}; budgets and active work cannot be reset by retry`);
        if (job.turn) throw new Error('Abandon the active host turn before changing task configuration');
        if (job.cloudBuildPending) throw new Error('Cloud packaging outcome is uncertain; reconcile the existing provider run rather than replaying it with retry');
        const resumedConfig = { ...config, packageTarget: config.packageTarget };
        const proofChanged = verificationConfigChanged(job, resumedConfig);
        const patch: Partial<Job> = proofChanged ? { ...invalidateVerification(), stage: ['verify', 'review', 'package'].includes(job.stage) ? 'verify' : job.stage } : {};
        validateJobConfig(job.spec, resumedConfig);
        // Report the same limits `next` enforces instead of queuing a job that
        // will immediately defer again: the owner must raise the budget in
        // factory.json or provide input before a retry can actually proceed.
        const deadlineExpired = Date.now() - job.createdAt > resumedConfig.maxJobHours * 3600000;
        const hostLimit = job.hostTurns >= resumedConfig.maxHostTurns;
        const stageLimit = (job.attempts[job.stage] ?? 0) >= resumedConfig.maxAttempts;
        if (deadlineExpired || hostLimit || stageLimit) {
          const exceeded = deadlineExpired ? `maxJobHours (${resumedConfig.maxJobHours})` : hostLimit ? `maxHostTurns (${resumedConfig.maxHostTurns})` : `maxAttempts (${resumedConfig.maxAttempts}) at ${job.stage}`;
          return { ...patch, config: resumedConfig, status: 'needs-owner', manualRecovery: null, nextAt: Date.now(), error: `${exceeded} is exhausted under the resumed configuration; raise the budget in factory.json or provide owner input before retrying` };
        }
        return { ...patch, config: resumedConfig, status: 'queued', manualRecovery: null, nextAt: Date.now(), error: null };
      })));
    } else throw new Error(`Unknown command ${command}; use --help`);
  } finally { store.close(); }
}

main().catch(error => { console.error(JSON.stringify({ error: toError(error).message })); process.exitCode = 1; });
