import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, delimiter, relative, sep } from 'node:path';
import { inside } from './config.js';
import { ToolchainSchema, toError, type Config, type Job, type Toolchain } from './schemas.js';
import type { Run } from './process.js';

const FlutterIdentitySchema = ToolchainSchema.pick({ frameworkRevision: true, engineRevision: true }).strip();
type FlutterIdentity = Pick<Toolchain, 'frameworkRevision' | 'engineRevision'>;

export interface PrepareFlutterOptions {
  run: Run;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

function unavailable(message: string, reason: string, path: string) {
  return Object.assign(new Error(message), { code: 'PREREQUISITE_FAILED', prerequisite: { reason, path } });
}

export function flutterEnvironment(config: Config, workspace: string, base: NodeJS.ProcessEnv, trusted = false): NodeJS.ProcessEnv {
  if (!config.toolchain?.flutterSdk) return base;
  const cache = trusted ? join(config.stateDir, 'verification-cache') : join(workspace, '.factory-cache');
  const sdk = trusted ? config.toolchain.flutterSdk : join(cache, 'flutter');
  return {
    ...base,
    PATH: `${join(sdk, 'bin')}${delimiter}${base.PATH ?? ''}`,
    FLUTTER_ROOT: sdk,
    PUB_CACHE: join(cache, 'pub'),
    ANALYZER_STATE_LOCATION_OVERRIDE: join(cache, 'analyzer'),
    DART_SUPPRESS_ANALYTICS: 'true',
    FLUTTER_SUPPRESS_ANALYTICS: 'true',
  };
}

export async function prepareFlutter(job: Pick<Job, 'config' | 'workspace' | 'spec' | 'stage' | 'toolchain'>, { run, env, signal }: PrepareFlutterOptions): Promise<Toolchain | null> {
  if (!job.config.toolchain?.flutterSdk) return null;
  signal?.throwIfAborted();
  if (process.platform !== 'darwin') throw unavailable('Isolated iOS Flutter SDK preparation requires macOS clone-capable storage.', 'platform', job.workspace);
  let source: string;
  try { source = realpathSync(job.config.toolchain.flutterSdk); }
  catch (error) { throw unavailable(`Flutter SDK is unavailable at the configured toolchain.flutterSdk: ${toError(error).message}`, 'missing-sdk', job.config.toolchain.flutterSdk); }
  if (!existsSync(join(source, 'bin', 'flutter'))) throw unavailable('Configured toolchain.flutterSdk does not contain bin/flutter.', 'missing-sdk', source);
  const cache = inside(job.workspace, '.factory-cache');
  const sdk = inside(job.workspace, '.factory-cache/flutter');
  const overlap = relative(source, cache);
  if (!overlap || !(overlap === '..' || overlap.startsWith(`..${sep}`))) throw unavailable('The Flutter SDK source cannot contain its workspace cache.', 'overlapping-sdk', source);
  if (job.toolchain && job.toolchain.source !== source) throw unavailable('This task is pinned to a different Flutter SDK. Restore its configured SDK or enqueue a new version; cached SDKs are not silently replaced.', 'sdk-mismatch', join(cache, 'flutter.json'));
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  if (!existsSync(join(cache, '.gitignore'))) writeFileSync(join(cache, '.gitignore'), '*\n', { mode: 0o600 });
  const marker = join(cache, 'flutter.json');
  let metadata: Toolchain | undefined;
  if (existsSync(marker)) {
    try { metadata = ToolchainSchema.parse(JSON.parse(readFileSync(marker, 'utf8'))); }
    catch (error) { throw unavailable(`Cannot read the owned Flutter cache metadata: ${toError(error).message}`, 'cache-metadata', marker); }
    if (metadata.source !== source) throw unavailable('This task is pinned to a different Flutter SDK. Restore its configured SDK or enqueue a new version; cached SDKs are not silently replaced.', 'sdk-mismatch', marker);
  } else if (existsSync(sdk)) {
    throw unavailable('An unmanaged Flutter cache already exists in this workspace; it will not be overwritten.', 'cache-conflict', sdk);
  }
  const pin = job.toolchain ?? metadata;
  const checkVersion = (identity: FlutterIdentity): void => {
    let current: FlutterIdentity;
    try { current = FlutterIdentitySchema.parse(JSON.parse(readFileSync(join(source, 'bin', 'cache', 'flutter.version.json'), 'utf8'))); }
    catch (error) { throw unavailable(`Cannot establish the verifier SDK identity: ${toError(error).message}`, 'sdk-version-unavailable', source); }
    if (current.frameworkRevision !== identity.frameworkRevision || current.engineRevision !== identity.engineRevision) throw unavailable('The configured verifier SDK changed during this task. Restore the pinned SDK or enqueue a new version; old verification cannot be reused.', 'sdk-version-changed', source);
  };
  if (pin) {
    checkVersion(pin);
    if (metadata && (metadata.frameworkRevision !== pin.frameworkRevision || metadata.engineRevision !== pin.engineRevision)) throw unavailable('The configured verifier SDK changed during this task. Restore the pinned SDK or enqueue a new version; old verification cannot be reused.', 'sdk-version-changed', source);
  }
  if (!existsSync(sdk)) {
    const initialized = await run([join(source, 'bin', 'flutter'), '--suppress-analytics', '--version', '--machine'], { env: { ...flutterEnvironment(job.config, job.workspace, env, true), FLUTTER_ROOT: source }, signal });
    if (initialized.code !== 0) throw unavailable(`Cannot initialize the configured Flutter SDK: ${initialized.stderr || initialized.stdout}`, 'sdk-initialization', source);
    let version: FlutterIdentity;
    try { version = FlutterIdentitySchema.parse(JSON.parse(initialized.stdout)); }
    catch { throw unavailable('Flutter --version --machine returned no valid version metadata.', 'sdk-version', source); }
    const prepared = await run([join(source, 'bin', 'flutter'), '--suppress-analytics', 'precache', '--ios'], { env: { ...flutterEnvironment(job.config, job.workspace, env, true), FLUTTER_ROOT: source }, signal });
    if (prepared.code !== 0) throw unavailable(`Cannot prepare Flutter artifacts before agent execution: ${prepared.stderr || prepared.stdout}`, 'sdk-artifacts', source);
    const identity = { source, frameworkRevision: version.frameworkRevision, engineRevision: version.engineRevision };
    checkVersion(pin ?? identity);
    if (pin && (identity.frameworkRevision !== pin.frameworkRevision || identity.engineRevision !== pin.engineRevision)) throw unavailable('The configured verifier SDK changed during this task. Restore the pinned SDK or enqueue a new version; old verification cannot be reused.', 'sdk-version-changed', source);
    metadata = { ...identity, ready: false };
    writeFileSync(marker, JSON.stringify(metadata), { mode: 0o600 });
    const temporary = mkdtempSync(join(cache, 'flutter-clone-'));
    try {
      const cloned = await run(['/bin/cp', '-cRp', `${source}/.`, temporary], { signal });
      if (cloned.code !== 0) throw unavailable(`Cannot create the workspace-local copy-on-write SDK: ${cloned.stderr || cloned.stdout}`, 'sdk-clone', source);
      signal?.throwIfAborted();
      renameSync(temporary, sdk);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  if (metadata?.ready) return metadata;
  if (job.stage === 'build' && !existsSync(join(job.workspace, 'pubspec.yaml'))) {
    const bundle = job.spec.apple?.bundleId;
    const organization = typeof bundle === 'string' && bundle.includes('.') ? bundle.slice(0, bundle.lastIndexOf('.')) : 'com.example';
    const created = await run([join(sdk, 'bin', 'flutter'), '--suppress-analytics', 'create', '--no-pub', '--platforms=ios', '--project-name', job.spec.id.replaceAll('-', '_'), '--org', organization, '.'], { env, signal });
    if (created.code !== 0) throw unavailable(`Cannot bootstrap the Flutter project: ${created.stderr || created.stdout}`, 'sdk-bootstrap', sdk);
  }
  metadata = ToolchainSchema.parse({ ...metadata, ready: true });
  writeFileSync(marker, JSON.stringify(metadata), { mode: 0o600 });
  return metadata;
}
