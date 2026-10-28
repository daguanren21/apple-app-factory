#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, loadJSON, expandArgv, validateProjectSource } from './config.js';
import { Store } from './store.js';
import { run, executionEnvironment } from './process.js';
import { appleDoctor, validateAppleSpec } from './apple.js';
import { runStep } from './scheduler.js';
import { nextTurn, completeTurn, abandonTurn } from './runner.js';
import { hosts, installIntegration, updateIntegration, inspectIntegration, uninstallIntegration } from './integrations.js';
import { submitRequirement, scanInbox } from './inbox.js';
import { MAX_INPUT_BYTES, parseRequirement, readInputFile } from './requirements.js';
import { dispatchRemote } from './remote.js';
import { FrameworkSchema, PackageTargetSchema, toError, validateJobConfig } from './schemas.js';
import type { Config, Framework, Job, Platform } from './schemas.js';
import { assertProject, doctorCommands } from './project-profiles.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));
const view = (job: Job) => ({ id: job.id, product: job.spec.id, framework: job.spec.framework, platform: job.spec.platform, channel: job.spec.channel, version: job.spec.version, stage: job.stage, status: job.status, hostTurns: job.hostTurns, attempts: job.attempts, workspace: job.workspace, artifact: job.artifact ?? null, error: job.error ?? null });

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
    const env = executionEnvironment(config);
    const result = await run(expandArgv(argv, env), { env, timeoutMs: 30000 });
    return { available: result.code === 0, detail: (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim() };
  } catch (error) { return { available: false, detail: toError(error).message }; }
}

const frameworks = FrameworkSchema.options;
const packageTargets = PackageTargetSchema.options;

function initialConfig(framework: Framework, platform: Platform, target: Config['packageTarget']): Record<string, unknown> {
  if ((framework === 'android-java' && platform !== 'android') || (framework === 'swift' && platform !== 'ios')) throw new Error(`${framework} does not support ${platform}`);
  if ((platform === 'ios') !== ['simulator', 'ipa'].includes(target)) throw new Error(`${target} does not match platform ${platform}`);
  const template = JSON.parse(readFileSync(join(packageRoot, 'examples', `${framework}.factory.json`), 'utf8')) as Record<string, unknown>;
  template.packageTarget = target;
  if (framework === 'flutter') {
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
      runtime: framework === 'swift' ? [[...base, 'test', '-destination', 'id=${IOS_DEVICE_ID}', '-derivedDataPath', 'build/DerivedData']] : [['npm', 'run', 'test:e2e', '--', '--platform', 'ios', '--device', '${IOS_DEVICE_ID}']],
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
  init [--allow-local-execution] Create owner-editable factory.json; default Flutter/iOS
    --framework <stack>         flutter|android-java|swift|react-native|expo|uni-app
    --platform <platform>       ios|android (default ios; android-java defaults android)
    --package-target <target>   simulator|ipa|apk|aab (iOS simulator; Expo iOS ipa; Android apk)
  doctor [spec.json]            Check configured prerequisites and optional stack tools
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
  authorize <id> --submit [--release]  Grant App Store publication only (iOS/IPA)
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
      framework: { type: 'string' },
      platform: { type: 'string' },
      'package-target': { type: 'string' },
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
    init: ['config', 'allow-local-execution', 'framework', 'platform', 'package-target'], doctor: ['config', 'build-only', 'host', 'project', 'global'],
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
    arity(args, 0, 0, 'init [--framework <stack>] [--platform ios|android] [--package-target simulator|ipa|apk|aab] [--config <file>] [--allow-local-execution]');
    const framework = values.framework ?? 'flutter';
    if (!frameworks.includes(framework as Framework)) throw new Error(`Unknown framework ${framework}; choose ${frameworks.join(', ')}`);
    const platform = values.platform ?? (framework === 'android-java' ? 'android' : 'ios');
    if (platform !== 'ios' && platform !== 'android') throw new Error('platform must be ios or android');
    const target = values['package-target'] ?? (platform === 'ios' ? framework === 'expo' ? 'ipa' : 'simulator' : 'apk');
    if (!packageTargets.includes(target as Config['packageTarget'])) throw new Error(`Unknown package target ${target}; choose ${packageTargets.join(', ')}`);
    const template = initialConfig(framework as Framework, platform, target as Config['packageTarget']);
    if (values['allow-local-execution']) template.allowLocalExecution = true;
    mkdirSync(dirname(resolve(configPath)), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    print({ config: resolve(configPath), framework, platform, packageTarget: target, localExecution: template.allowLocalExecution, next: framework === 'expo' ? 'Configure your existing eas.json production (store IPA/AAB), apk (Android buildType apk), or simulator (ios.simulator true) profile, real device acceptance, and exact app product/output path; no prebuild/eject is requested. Run apphx doctor <spec.json> --build-only.' : 'Adapt module/scheme, real device acceptance, signing and artifact path to your project; then run apphx doctor <spec.json> --build-only. init creates configuration, not app source.' });
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
    arity(args, 0, 1, 'doctor [spec.json] [--build-only]');
    const spec = args[0] ? parseRequirement(inputJSON(args[0])).spec : undefined;
    if (spec) {
      validateJobConfig(spec, config);
      const source = validateProjectSource(spec, config);
      if (source) assertProject(resolve(source, spec.project?.directory ?? '.'), spec);
    }
    const commands = spec && config.packaging?.provider !== 'cloud' ? doctorCommands(spec.framework, spec.platform) : [];
    const tools = await Promise.all(commands.map(async ({ name, argv }) => ({ name, ...await probe(argv[0] === 'flutter' && config.toolchain ? [join(config.toolchain.flutterSdk, 'bin', 'flutter'), ...argv.slice(1)] : argv, config) })));
    const prerequisites = await Promise.all(config.verification.prerequisites.map(async (argv, index) => ({ name: `configured-prerequisite-${index + 1}`, ...(config.allowLocalExecution ? await probe(argv, config) : { available: false, detail: 'Owner must enable allowLocalExecution before configured prerequisite commands run' }) })));
    const environment = executionEnvironment(config);
    const configuredCommands = [...config.verification.prerequisites, ...config.verification.checks, ...config.verification.runtime, ...(config.packaging?.commands ?? [])];
    const neededEnv = [...new Set(configuredCommands.flat().flatMap(arg => [...arg.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map(match => match[1])))];
    const checks = [
      { name: 'local-execution-permission', available: config.allowLocalExecution, detail: config.executionWarning ?? 'Trusted local commands permitted; host tools remain under the host permission policy' },
      ...tools, ...prerequisites,
      ...neededEnv.map(name => ({ name, available: Boolean(environment[name]), detail: environment[name] ? 'Available in the configured execution environment; value not printed' : `Set ${name} and include its name in executionEnv` })),
    ];
    if (config.allowSubmit && spec?.channel !== 'app-store') throw new Error('Submission requires an App Store requirement; pass its spec.json to doctor');
    if (config.allowSubmit) checks.push(...await appleDoctor());
    print({ framework: spec?.framework ?? null, platform: spec?.platform ?? null, checks, submissionEnabled: config.allowSubmit, note: spec ? 'Tool availability is not runtime acceptance; configured checks run in the task workspace during verify' : 'No stack assumed; pass spec.json for profile-specific probes and compatibility checks', model: 'Provided by your agent host; no separate model authentication is configured here' });
    if (checks.some(check => !check.available)) process.exitCode = 2;
    return;
  }
  const queuedRequirement = command === 'enqueue' ? (() => {
    arity(args, 1, 1, 'enqueue <spec.json|->');
    const requirement = parseRequirement(inputJSON(args[0]));
    validateJobConfig(requirement.spec, config);
    validateProjectSource(requirement.spec, config);
    if (config.allowSubmit) {
      if (requirement.spec.channel !== 'app-store' || requirement.spec.platform !== 'ios') throw new Error('Automated publication supports only iOS App Store jobs');
      validateAppleSpec(requirement.spec);
    }
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
        if (job.cloudBuildPending) throw new Error('Cloud packaging outcome is uncertain; reconcile the existing provider run rather than replaying it with retry');
        const resumedConfig = { ...config, packageTarget: job.config.allowSubmit ? 'ipa' as const : config.packageTarget, allowSubmit: job.config.allowSubmit, allowRelease: job.config.allowRelease };
        const proofChanged = JSON.stringify(resumedConfig.verification) !== JSON.stringify(job.config.verification) || JSON.stringify(resumedConfig.executionEnv) !== JSON.stringify(job.config.executionEnv) || JSON.stringify(resumedConfig.toolchain) !== JSON.stringify(job.config.toolchain) || JSON.stringify(resumedConfig.packaging) !== JSON.stringify(job.config.packaging) || JSON.stringify(resumedConfig.apple) !== JSON.stringify(job.config.apple) || resumedConfig.packageTarget !== job.config.packageTarget || resumedConfig.allowCloudBuild !== job.config.allowCloudBuild || (job.verifiedDigest != null && !job.verifiedDependencyDigest);
        if (Object.keys(job.receipt).length && (proofChanged || !job.verifiedDigest || !job.verifiedDependencyDigest)) throw new Error('Verification proof is no longer valid after publication began; reconcile the existing upload before creating a new version');
        const patch: Partial<Job> = proofChanged ? { stage: ['verify', 'review', 'package', 'publish', 'monitor'].includes(job.stage) ? 'verify' : job.stage, verifiedDigest: null, verifiedDependencyDigest: null, review: null, artifact: null, ipaPath: null, archiveDigest: null } : {};
        validateJobConfig(job.spec, resumedConfig);
        return { ...patch, config: resumedConfig, status: 'queued', manualRecovery: null, nextAt: Date.now(), error: null };
      })));
    } else if (command === 'authorize') {
      arity(args, 1, 1, 'authorize <id> --submit [--release]');
      if (!values.submit) throw new Error('authorize requires --submit');
      print(view(store.transition(args[0], job => {
        if (job.turn || !['ready', 'blocked', 'built'].includes(job.status) || Object.keys(job.receipt).length || job.stage === 'monitor') throw new Error('Publication permission can change only on stopped work before any remote intent');
        if (job.spec.channel !== 'app-store' || job.spec.platform !== 'ios') throw new Error('Automated publication supports only iOS App Store jobs; local and Google Play tasks require local handoff');
        if (job.config.packaging && !job.config.packaging.artifactPath.endsWith('.ipa')) throw new Error('App Store authorization requires an IPA packaging profile; adapt packaging.commands/artifactPath and retry to renew proof before authorizing');
        const publishing = validateAppleSpec(job.spec);
        if (values.release && !/^[A-Za-z]{2}$/.test(publishing.storefrontCountry ?? '')) throw new Error('--release requires apple.storefrontCountry in the immutable product specification');
        const granted = { ...job.config, packageTarget: 'ipa' as const, allowSubmit: true, allowRelease: Boolean(values.release) };
        validateJobConfig(job.spec, granted);
        return { config: granted, stage: job.status === 'built' ? 'package' : job.stage, artifact: null, ipaPath: null, archiveDigest: null, status: ['ready', 'built'].includes(job.status) ? 'queued' : 'blocked', nextAt: Date.now() };
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
        validateJobConfig(spec, resumedConfig);
        return { spec, config: resumedConfig, feedback, status: 'queued', stage: 'build', createdAt: Date.now(), attempts: {}, hostTurns: 0, nextAt: Date.now(), receipt: {}, ipaPath: null, archiveDigest: null, verifiedDigest: null, verifiedDependencyDigest: null, review: null, error: null };
      })));
    }
  } finally { store.close(); }
}

main().catch(error => { console.error(JSON.stringify({ error: toError(error).message })); process.exitCode = 1; });
