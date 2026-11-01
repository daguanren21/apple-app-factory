import { createHash } from 'node:crypto';
import { readFileSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import { ConfigSchema, SpecSchema, toError } from '../contracts/schemas.js';
import type { Config, Spec } from '../contracts/schemas.js';

export interface ProjectStorage {
  stateDir: string;
  workspaceRoot: string;
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}
function validateDirectory(path: string, label: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`${label} must identify a real directory`);
}

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
function storagePaths(root: string): ProjectStorage {
  const digest = createHash('sha256').update(root).digest('hex');
  const base = join(homedir(), '.apphx', 'projects', digest);
  return { stateDir: join(base, 'state'), workspaceRoot: join(base, 'workspaces') };
}

/** Resolve external per-project control storage from the canonical owner root without creating it. */
export function projectStorage(root: string): ProjectStorage {
  return storagePaths(canonicalPath(root));
}

/** Validate canonical project, control, inbox and optional execution-root boundaries for admission. */
export function validateProjectContext(config: Config, workspace?: string): void {
  const root = config.configPath ? dirname(resolve(config.configPath)) : process.cwd();
  const projectPath = resolve(root, config.projectRoot ?? '.');
  const statePath = resolve(root, config.stateDir);
  const workspacePath = resolve(root, config.workspaceRoot);
  validateDirectory(projectPath, 'projectRoot');
  validateDirectory(statePath, 'stateDir');
  validateDirectory(workspacePath, 'workspaceRoot');
  const project = canonicalPath(projectPath);
  const state = canonicalPath(statePath);
  const workspaces = canonicalPath(workspacePath);
  if (config.inbox) validateDirectory(resolve(root, config.inbox.directory), 'inbox.directory');
  if (overlaps(state, workspaces)) throw new Error('stateDir and workspaceRoot must not overlap in either direction so host tools do not own task state');
  if (config.projectMode === 'project') {
    if (overlaps(project, state)) throw new Error('projectRoot must not overlap stateDir in either direction');
    if (contains(project, workspaces)) throw new Error('projectRoot must not contain workspaceRoot; keep execution workspaces outside the live project');
    if (config.inbox && overlaps(project, canonicalPath(resolve(root, config.inbox.directory)))) throw new Error('inbox.directory must remain outside projectRoot so control inputs cannot become writable project source');
    if (config.toolchain && overlaps(project, canonicalPath(resolve(root, config.toolchain.flutterSdk)))) throw new Error('toolchain.flutterSdk must remain outside projectRoot so host source edits cannot change the trusted verification SDK');
  }
  if (workspace !== undefined) {
    const executionPath = resolve(root, workspace);
    validateDirectory(executionPath, 'Job workspace');
    const execution = canonicalPath(executionPath);
    if (execution !== project && !contains(workspaces, execution)) throw new Error('Job workspace must remain inside workspaceRoot unless it is the live projectRoot');
    if (config.projectMode === 'project' && execution !== project && overlaps(project, execution)) throw new Error('Job workspace must not overlap projectRoot');
  }
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

/** Load and canonicalize configuration without admitting a new project job; historical queues may still need inspection. */
export function loadConfig(path = 'factory.json', options: { access?: 'source' | 'metadata' } = {}): Config & { configPath: string } {
  const configPath = resolve(path);
  const source = z.record(z.string(), z.unknown()).parse(loadJSON(configPath));
  if ('notify' in source) throw new Error('Legacy notify configuration is not supported; move recipients to notifications.targets and choose a host delivery capability there.');
  const legacyKeys = ['builder', 'reviewer', 'researcher', 'agentEnv', 'maxAgentCalls', 'maxConcurrentJobs'].filter(key => key in source);
  if (legacyKeys.length) throw new Error(`Legacy provider/daemon configuration is not supported (${legacyKeys.join(', ')}). Remove builder/reviewer/researcher/maxConcurrentJobs, rename agentEnv to executionEnv and maxAgentCalls to maxHostTurns. Models and authentication now belong to your host. Existing queue snapshots are migrated without deleting task history.`);
  const root = dirname(configPath);
  const selectedRoot = resolve(root, z.string().min(1).default('.').parse(source.projectRoot));
  const metadataOnly = options.access === 'metadata';
  const projectRoot = metadataOnly ? selectedRoot : canonicalPath(selectedRoot);
  // With explicit queue storage, metadata operations need no live filesystem
  // identity for an unused workspace default. Execution uses each saved job's roots.
  const defaults = source.stateDir === undefined || source.workspaceRoot === undefined
    ? metadataOnly && source.stateDir !== undefined ? storagePaths(selectedRoot) : projectStorage(selectedRoot)
    : undefined;
  const config = ConfigSchema.parse({
    ...source, configPath, projectRoot,
    stateDir: resolve(root, z.string().min(1).parse(source.stateDir ?? defaults?.stateDir)),
    workspaceRoot: resolve(root, z.string().min(1).parse(source.workspaceRoot ?? defaults?.workspaceRoot)),
  });
  if (metadataOnly) {
    config.stateDir = canonicalPath(config.stateDir);
    return { ...config, configPath };
  }
  if (config.toolchain) {
    config.toolchain.flutterSdk = resolve(root, config.toolchain.flutterSdk);
    if (existsSync(config.toolchain.flutterSdk)) config.toolchain.flutterSdk = realpathSync(config.toolchain.flutterSdk);
    const workspace = existsSync(config.workspaceRoot) ? realpathSync(config.workspaceRoot) : config.workspaceRoot;
    const child = relative(workspace, config.toolchain.flutterSdk);
    if (!child || !(child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))) throw new Error('toolchain.flutterSdk must be outside workspaceRoot so verification does not trust an agent-writable SDK');
  }
  if (config.apple?.exportOptionsPlist) config.apple.exportOptionsPlist = resolve(root, config.apple.exportOptionsPlist);
  if (config.obfuscation?.configPath) {
    config.obfuscation.configPath = resolve(root, config.obfuscation.configPath);
    if (!existsSync(config.obfuscation.configPath) || !lstatSync(config.obfuscation.configPath).isFile()) throw new Error(`obfuscation.configPath must name an existing regular file: ${config.obfuscation.configPath}`);
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
  if (overlaps(state, workspace)) throw new Error('stateDir and workspaceRoot must not overlap in either direction so host tools do not own task state');
  normalizeIsolationPaths(config);
  return { ...config, configPath };
}

/** Validate an optional requirement source root; project mode never returns an import snapshot. */
export function validateProjectSource(spec: Spec, config: Config): string | undefined {
  const sourceDir = spec.project?.sourceDir;
  if (!sourceDir) {
    if (config.projectMode === 'project') validateProjectContext(config);
    return undefined;
  }
  const root = config.configPath ? dirname(resolve(config.configPath)) : process.cwd();
  const source = resolve(root, sourceDir);
  const info = lstatSync(source, { throwIfNoEntry: false });
  if (!info) throw Object.assign(new Error(`Project source does not exist: ${source}`), { code: 'ENOENT', path: source });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('project.sourceDir must identify an existing real directory, not a symlink');
  const sourceDirectory = canonicalPath(source);
  validateProjectContext(config);
  if (config.projectMode === 'project') {
    const projectRoot = canonicalPath(resolve(root, config.projectRoot ?? '.'));
    if (sourceDirectory !== projectRoot) throw new Error('project.sourceDir must canonical-match the configured projectRoot in project mode; it cannot widen writable authority');
    return undefined;
  }
  for (const path of [config.stateDir, config.workspaceRoot]) {
    const reserved = canonicalPath(resolve(root, path));
    if (overlaps(reserved, sourceDirectory)) throw new Error('project.sourceDir must not overlap stateDir or workspaceRoot in either direction');
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
