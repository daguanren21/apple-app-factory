import { readFileSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { basename, dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import { ConfigSchema, SpecSchema, toError } from './schemas.js';
import type { Config, Spec } from './schemas.js';

export function loadJSON(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (cause) { throw new Error(`Cannot read JSON at ${path}: ${toError(cause).message}`); }
}

export function validateSpec(spec: unknown): Spec {
  return SpecSchema.parse(spec);
}

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Cannot resolve dangling symlink at ${absolute}; point it to an existing directory before continuing`);
  return resolve(canonicalPath(dirname(absolute)), basename(absolute));
}

export function normalizeIsolationPaths(config: Config): void {
  if (!config.isolation) return;
  const root = config.configPath ? dirname(resolve(config.configPath)) : process.cwd();
  const protectedPaths = [config.stateDir, config.workspaceRoot, ...(config.configPath ? [config.configPath] : [])].map(path => canonicalPath(resolve(root, path)));
  const contains = (parent: string, child: string): boolean => {
    const path = relative(parent, child);
    return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  config.isolation.readOnlyPaths = [...new Set(config.isolation.readOnlyPaths.map(path => {
    const absolute = canonicalPath(resolve(root, path));
    const info = lstatSync(absolute, { throwIfNoEntry: false });
    if (!info || !info.isDirectory() && !info.isFile()) throw new Error(`Isolation read-only path must exist as a regular file or directory: ${path}`);
    if (protectedPaths.some(protectedPath => contains(absolute, protectedPath) || contains(protectedPath, absolute))) throw new Error('Isolation read-only paths must not expose control state, configuration or other task workspaces');
    return absolute;
  }))];
}

export function loadConfig(path = 'factory.json'): Config & { configPath: string } {
  const configPath = resolve(path);
  const source = z.record(z.string(), z.unknown()).parse(loadJSON(configPath));
  const legacyKeys = ['builder', 'reviewer', 'researcher', 'agentEnv', 'maxAgentCalls', 'maxConcurrentJobs'].filter(key => key in source);
  if (legacyKeys.length) throw new Error(`Legacy provider/daemon configuration is not supported (${legacyKeys.join(', ')}). Remove builder/reviewer/researcher/maxConcurrentJobs, rename agentEnv to executionEnv and maxAgentCalls to maxHostTurns. Models and authentication now belong to your host. Existing queue snapshots are migrated without deleting task history.`);
  const root = dirname(configPath);
  const config = ConfigSchema.parse({
    ...source, configPath,
    stateDir: resolve(root, z.string().min(1).default('.factory').parse(source.stateDir)),
    workspaceRoot: resolve(root, z.string().min(1).default('workspaces').parse(source.workspaceRoot)),
  });
  if (config.toolchain) {
    config.toolchain.flutterSdk = resolve(root, config.toolchain.flutterSdk);
    if (existsSync(config.toolchain.flutterSdk)) config.toolchain.flutterSdk = realpathSync(config.toolchain.flutterSdk);
    const workspace = existsSync(config.workspaceRoot) ? realpathSync(config.workspaceRoot) : config.workspaceRoot;
    const child = relative(workspace, config.toolchain.flutterSdk);
    if (!child || !(child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))) throw new Error('toolchain.flutterSdk must be outside workspaceRoot so verification does not trust an agent-writable SDK');
  }
  if (config.apple?.exportOptionsPlist) config.apple.exportOptionsPlist = resolve(root, config.apple.exportOptionsPlist);
  if (config.obfuscation) {
    if (config.obfuscation.configPath) {
      config.obfuscation.configPath = resolve(root, config.obfuscation.configPath);
      if (!existsSync(config.obfuscation.configPath) || !lstatSync(config.obfuscation.configPath).isFile()) throw new Error(`obfuscation.configPath must name an existing regular file: ${config.obfuscation.configPath}`);
    }
  }
  if (config.inbox) {
    config.inbox.directory = resolve(root, config.inbox.directory);
    const workspace = canonicalPath(config.workspaceRoot);
    const inbox = canonicalPath(config.inbox.directory);
    const child = relative(workspace, inbox);
    if (!child || !(child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))) throw new Error('inbox.directory must be outside workspaceRoot so agent output cannot become new requirements');
  }
  if (!config.allowLocalExecution) config.executionWarning = 'Local execution is disabled. Use a dedicated OS account or VM, then set allowLocalExecution=true; a workspace is not a security sandbox.';
  const state = canonicalPath(config.stateDir), workspace = canonicalPath(config.workspaceRoot);
  if ([relative(workspace, state), relative(state, workspace)].some(child => !child || !(child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)))) throw new Error('stateDir and workspaceRoot must not overlap in either direction so host tools do not own task state');
  normalizeIsolationPaths(config);
  return { ...config, configPath };
}

export function validateProjectSource(spec: Spec, config: Config): string | undefined {
  if (!spec.project?.sourceDir) return undefined;
  const root = config.configPath ? dirname(resolve(config.configPath)) : process.cwd();
  const source = resolve(root, spec.project.sourceDir);
  const info = lstatSync(source);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('project.sourceDir must identify a real directory, not a symlink');
  const sourceDirectory = canonicalPath(source);
  for (const path of [config.stateDir, config.workspaceRoot]) {
    const reserved = canonicalPath(resolve(root, path));
    if ([relative(reserved, sourceDirectory), relative(sourceDirectory, reserved)].some(child => !child || !(child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)))) throw new Error('project.sourceDir must not overlap stateDir or workspaceRoot in either direction');
  }
  return sourceDirectory;
}

export function inside(root: string, path: string): string {
  const resolved = resolve(root, path);
  const child = relative(root, resolved);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error(`Expected a path inside the workspace: ${path}`);
  const actual = relative(canonicalPath(root), canonicalPath(resolved));
  if (!actual || actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) throw new Error(`Workspace path escapes through a symlink: ${path}`);
  return resolved;
}

export function expandArgv(argv: string[], env: NodeJS.ProcessEnv): string[] {
  return argv.map(arg => arg.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, key: string) => {
    if (/^(ASC_|APPLE_|FASTLANE_|MATCH_)/.test(key) || !env[key]) throw Object.assign(new Error(`Verification requires ${key} in the allowed worker environment; publisher secrets cannot be command arguments`), { code: 'SETUP_REQUIRED' });
    return env[key];
  }));
}
