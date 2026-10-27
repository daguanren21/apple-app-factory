import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const skill = 'apphx';
const marker = '.apphx-install.json';
const owner = 'apphx';
const bundledDirectory = fileURLToPath(new URL('../skills/apphx/', import.meta.url));
const packageFile = fileURLToPath(new URL('../package.json', import.meta.url));

export const hosts = Object.freeze([
  { id: 'codex', name: 'Codex', invocation: '$apphx', projectDirectory: '.agents/skills', globalDirectory: '~/.agents/skills', source: 'https://developers.openai.com/codex/skills', instructions: 'Use $apphx in Codex CLI or the IDE extension; /skills lists skills. Restart if discovery has not refreshed.' },
  { id: 'claude', name: 'Claude Code', invocation: '/apphx', projectDirectory: '.claude/skills', globalDirectory: '$CLAUDE_CONFIG_DIR/skills (default ~/.claude/skills)', source: 'https://code.claude.com/docs/en/skills', instructions: 'Use /apphx in a local Claude Code session. Start a new session if the skill is not listed. Cloud sessions do not inherit local user skills.' },
  { id: 'cursor', name: 'Cursor', invocation: '/apphx', projectDirectory: '.cursor/skills', globalDirectory: '~/.cursor/skills', source: 'https://cursor.com/docs/skills', instructions: 'In Agent chat, type / and select apphx. Restart or reopen the project if necessary. Global installation is local, not a Cloud Agent sync.' },
  { id: 'pi', name: 'Pi', invocation: '/skill:apphx', projectDirectory: '.pi/skills', globalDirectory: '$PI_CODING_AGENT_DIR/skills (default ~/.pi/agent/skills)', source: 'https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md', instructions: 'Grant project trust before using project skills, then /reload and /skill:apphx. Stock Pi has no native subagents: use a separate human-started reviewer session, not a spawned coding-agent CLI.' },
  { id: 'gemini', name: 'Gemini CLI', invocation: 'Use the apphx skill', projectDirectory: '.gemini/skills', globalDirectory: '$GEMINI_CLI_HOME/.gemini/skills (default ~/.gemini/skills)', source: 'https://geminicli.com/docs/cli/skills/', instructions: 'Run /skills reload and /skills list, then ask: Use the apphx skill. Gemini calls activate_skill; approve its consent prompt. This is not a /apphx command.' },
  { id: 'opencode', name: 'OpenCode', invocation: 'Use the apphx skill', projectDirectory: '.opencode/skills', globalDirectory: '$XDG_CONFIG_HOME/opencode/skills (default ~/.config/opencode/skills)', source: 'https://opencode.ai/docs/skills/', instructions: 'Ask OpenCode to use apphx; the agent loads it with its native skill({ name: "apphx" }) tool. Skill permissions must permit loading. Restart if necessary; no custom slash command is installed.' },
  { id: 'deepseek', name: 'DeepSeek Harness', invocation: 'Use the apphx skill', projectDirectory: '.dsh/skills (nearest Git root, otherwise selected project)', globalDirectory: '$DSH_HOME/skills (default ~/.dsh/skills)', source: 'https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/skills', instructions: 'Ask DeepSeek Harness to use apphx; its native skill({ name: "apphx" }) tool loads it. Requires the shipped filesystem skill provider and skill tool, with default roots enabled. Custom provider configurations are not modified.' },
  { id: 'hermes', name: 'Hermes Agent', invocation: '/apphx', projectDirectory: '.hermes/skills', globalDirectory: '$HERMES_HOME/skills (default ~/.hermes/skills)', source: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/skills', instructions: 'Use /apphx. Project installation requires a Git root and a separate owner-approved hermes skills trust decision; this installer never grants trust. For non-Git projects or profile-wide cron use --global in the same HERMES_HOME as Hermes. Confirm discovery with hermes skills list; cron must attach the skill and an absolute workdir.' },
].map(host => Object.freeze(host)));

export type IntegrationOptions = { project?: string; global?: boolean };
type Host = (typeof hosts)[number];
type Location = { host: Host; scope: 'project' | 'global'; path: string };
export type IntegrationInspection = {
  host: string; name: string; scope: 'project' | 'global'; path: string;
  invocation: string; instructions: string; source: string;
  installed: boolean; status: 'missing' | 'installed' | 'conflict';
  version?: string; current?: boolean; reason?: string;
};

type Tree = { files: Record<string, Buffer>; directories: string[] };
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const safeRelative = (path: string) => /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path) && path.split('/').every(part => part !== '.' && part !== '..' && part.length > 0) && path !== marker;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.strictObject({
  format: z.literal(1), owner: z.literal(owner), skill: z.literal(skill), host: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/),
  files: z.record(z.string().refine(safeRelative), digestSchema), metadataDigest: digestSchema,
});
type Manifest = z.infer<typeof manifestSchema>;

// Never follow a symlink, including an existing ancestor of a not-yet-created target.
function assertPath(path: string): void {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const parts = absolute.slice(current.length).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink path: ${current}. Select its real directory explicitly.`);
    if (i < parts.length - 1 && !info.isDirectory()) throw new Error(`Not a directory: ${current}`);
  }
}

function readRegular(path: string, packageSource = false): Buffer {
  assertPath(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || (!packageSource && info.nlink !== 1)) throw new Error(`Refusing non-regular or hard-linked installation file: ${path}`);
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

function readTree(root: string, packageSource = false): Tree {
  assertPath(root);
  if (!lstatSync(root).isDirectory()) throw new Error(`Not a skill directory: ${root}`);
  const tree: Tree = { files: Object.create(null), directories: [] };
  function visit(directory: string, prefix: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Refusing symlink installation entry: ${path}`);
      if (info.isDirectory()) { tree.directories.push(relative); visit(path, relative); }
      else tree.files[relative] = readRegular(path, packageSource);
    }
  }
  visit(root, '');
  return tree;
}

function fileDigests(tree: Tree): Record<string, string> {
  return Object.fromEntries(Object.entries(tree.files).filter(([path]) => path !== marker).map(([path, bytes]) => [path, digest(bytes)]));
}

function metadataDigest(value: Omit<Manifest, 'metadataDigest'>): string {
  return digest(JSON.stringify([value.format, value.owner, value.skill, value.host, value.version, Object.entries(value.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]));
}

function directoriesFor(files: Record<string, unknown>): string[] {
  const directories = new Set<string>();
  for (const file of Object.keys(files)) {
    let parent = file.slice(0, file.lastIndexOf('/'));
    if (!file.includes('/')) continue;
    while (parent) { directories.add(parent); parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : ''; }
  }
  return [...directories].sort();
}

function readOwned(path: string, host: string): Manifest {
  const tree = readTree(path);
  if (!tree.files[marker]) throw new Error(`Foreign skill directory has no ${marker}: ${path}`);
  let manifest: Manifest;
  try { manifest = manifestSchema.parse(JSON.parse(tree.files[marker].toString('utf8'))); }
  catch { throw new Error(`Invalid ownership metadata: ${path}`); }
  if (manifest.host !== host || manifest.metadataDigest !== metadataDigest(manifest)) throw new Error(`Foreign or edited ownership metadata: ${path}`);
  if (!manifest.files['SKILL.md'] || JSON.stringify(Object.keys(tree.files).filter(file => file !== marker).sort()) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error(`Added or missing files in owned skill: ${path}`);
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (digest(tree.files[file]!) !== expected) throw new Error(`User-edited skill file: ${join(path, file)}`);
  }
  if (JSON.stringify(tree.directories.sort()) !== JSON.stringify(directoriesFor(manifest.files))) throw new Error(`Unowned directories in skill: ${path}`);
  return manifest;
}

function selectedHost(id: string): Host {
  const host = hosts.find(value => value.id === id);
  if (!host) throw new Error(`Unsupported host ${JSON.stringify(id)}. Supported hosts: ${hosts.map(value => value.id).join(', ')}`);
  return host;
}

function environmentDirectory(name: string, fallback: string): string {
  const configured = process.env[name];
  if (!configured) return fallback;
  const expanded = configured === '~' ? homedir() : configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
  if (!isAbsolute(expanded)) throw new Error(`${name} must be an absolute directory for installation`);
  return resolve(expanded);
}

function location(id: string, options: IntegrationOptions): Location {
  const host = selectedHost(id);
  if (options.global && options.project !== undefined) throw new Error('Choose either project or global installation, not both');
  if (options.global) {
    let directory: string;
    switch (id) {
      case 'claude': directory = join(environmentDirectory('CLAUDE_CONFIG_DIR', join(homedir(), '.claude')), 'skills'); break;
      case 'gemini': directory = join(environmentDirectory('GEMINI_CLI_HOME', homedir()), '.gemini', 'skills'); break;
      case 'pi': directory = join(environmentDirectory('PI_CODING_AGENT_DIR', join(homedir(), '.pi', 'agent')), 'skills'); break;
      case 'opencode': directory = join(environmentDirectory('XDG_CONFIG_HOME', join(homedir(), '.config')), 'opencode', 'skills'); break;
      case 'deepseek': directory = join(environmentDirectory('DSH_HOME', join(homedir(), '.dsh')), 'skills'); break;
      case 'hermes': directory = join(environmentDirectory('HERMES_HOME', join(homedir(), '.hermes')), 'skills'); break;
      default: directory = join(homedir(), host.projectDirectory);
    }
    return { host, scope: 'global', path: join(directory, skill) };
  }
  if (options.project !== undefined && !options.project.trim()) throw new Error('Project directory must not be empty');
  let project = resolve(options.project ?? process.cwd());
  assertPath(project);
  if (!lstatSync(project, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Project directory does not exist: ${project}`);
  if (id === 'deepseek' || id === 'hermes') {
    let found = false;
    for (let candidate = project; ; candidate = dirname(candidate)) {
      if (lstatSync(join(candidate, '.git'), { throwIfNoEntry: false })) { project = candidate; found = true; break; }
      if (dirname(candidate) === candidate) break;
    }
    if (id === 'hermes' && !found) throw new Error('Hermes project skills require a Git root; use --global for a profile-level installation instead');
  }
  return { host, scope: 'project', path: join(project, id === 'deepseek' ? '.dsh/skills' : host.projectDirectory, skill) };
}

function details(target: Location) {
  return { host: target.host.id, name: target.host.name, scope: target.scope, path: target.path, invocation: target.host.invocation, instructions: target.host.instructions, source: target.host.source };
}

function bundle(host: string): { tree: Tree; manifest: Manifest } {
  // Package stores may hard-link read-only resources; owned installation targets may not.
  const tree = readTree(bundledDirectory, true);
  if (!tree.files['SKILL.md'] || tree.files[marker]) throw new Error('Invalid bundled apphx skill');
  const files = fileDigests(tree);
  if (!Object.keys(files).every(safeRelative) || JSON.stringify(tree.directories.sort()) !== JSON.stringify(directoriesFor(files))) throw new Error('Invalid bundled skill resource paths');
  const version = JSON.parse(readRegular(packageFile, true).toString('utf8')).version;
  const value: Omit<Manifest, 'metadataDigest'> = { format: 1, owner, skill, host, version, files };
  const manifest = manifestSchema.parse({ ...value, metadataDigest: metadataDigest(value) });
  tree.files[marker] = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return { tree, manifest };
}

export function inspectIntegration(host: string, options: IntegrationOptions = {}): IntegrationInspection {
  const target = location(host, options);
  const result = details(target);
  try {
    assertPath(target.path);
    if (!lstatSync(target.path, { throwIfNoEntry: false })) return { ...result, installed: false, status: 'missing' };
    const manifest = readOwned(target.path, host);
    const current = bundle(host).manifest.metadataDigest === manifest.metadataDigest;
    return { ...result, installed: true, status: 'installed', version: manifest.version, current };
  } catch (error) {
    return { ...result, installed: false, status: 'conflict', reason: error instanceof Error ? error.message : String(error) };
  }
}

function withLock<T>(target: Location, action: () => T): T {
  const directory = dirname(dirname(target.path));
  assertPath(directory);
  mkdirSync(directory, { recursive: true });
  assertPath(directory);
  const lock = join(directory, '.apphx-install.lock');
  let descriptor: number;
  try { descriptor = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error(`Installation is locked at ${lock}; if an earlier installer stopped, inspect it before removing its lock`); }
  try { return action(); }
  finally { closeSync(descriptor); unlinkSync(lock); }
}

function applyIntegration(host: string, options: IntegrationOptions, operation: 'install' | 'update'): IntegrationInspection & { changed: boolean } {
  const target = location(host, options);
  const next = bundle(host);
  assertPath(target.path);
  if (operation === 'update' && !lstatSync(target.path, { throwIfNoEntry: false })) throw new Error(`No installation at ${target.path}; run apphx install ${host} first with the same scope`);
  return withLock(target, () => {
    assertPath(target.path);
    const previous = lstatSync(target.path, { throwIfNoEntry: false }) ? readOwned(target.path, host) : undefined;
    if (operation === 'update' && !previous) throw new Error(`No installation at ${target.path}; run apphx install ${host} first with the same scope`);
    const result = { ...details(target), installed: true, status: 'installed' as const, version: next.manifest.version, current: true };
    if (previous?.metadataDigest === next.manifest.metadataDigest) return { ...result, changed: false };
    if (operation === 'install' && previous) throw new Error(`An older or different workflow is installed at ${target.path}; use apphx update ${host} with the same scope`);
    const parent = dirname(target.path);
    mkdirSync(parent, { recursive: true });
    const staging = mkdtempSync(join(dirname(parent), '.apphx-stage-'));
    const replacement = join(staging, skill);
    const backup = join(staging, 'previous');
    let moved = false;
    try {
      mkdirSync(replacement);
      for (const [file, bytes] of Object.entries(next.tree.files)) {
        const path = join(replacement, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes, { flag: 'wx', mode: 0o644 });
      }
      assertPath(target.path);
      if (previous) {
        if (readOwned(target.path, host).metadataDigest !== previous.metadataDigest) throw new Error('Installation changed during upgrade');
        renameSync(target.path, backup);
        moved = true;
      } else if (lstatSync(target.path, { throwIfNoEntry: false })) throw new Error('Skill appeared during installation; refusing overwrite');
      try { renameSync(replacement, target.path); }
      catch (error) { if (moved) { renameSync(backup, target.path); moved = false; } throw error; }
      if (moved) { readOwned(backup, host); rmSync(backup, { recursive: true }); moved = false; }
      return { ...result, changed: true };
    } finally {
      // Keep a displaced install intact if rollback or cleanup was interrupted.
      if (!moved) rmSync(staging, { recursive: true, force: true });
    }
  });
}

export function installIntegration(host: string, options: IntegrationOptions = {}): IntegrationInspection & { changed: boolean } {
  return applyIntegration(host, options, 'install');
}

export function updateIntegration(host: string, options: IntegrationOptions = {}): IntegrationInspection & { changed: boolean } {
  return applyIntegration(host, options, 'update');
}

export function uninstallIntegration(host: string, options: IntegrationOptions = {}): IntegrationInspection & { changed: boolean } {
  const target = location(host, options);
  assertPath(target.path);
  const result = { ...details(target), installed: false, status: 'missing' as const };
  if (!lstatSync(target.path, { throwIfNoEntry: false })) return { ...result, changed: false };
  return withLock(target, () => {
    assertPath(target.path);
    if (!lstatSync(target.path, { throwIfNoEntry: false })) return { ...result, changed: false };
    readOwned(target.path, host);
    rmSync(target.path, { recursive: true });
    return { ...result, changed: true };
  });
}
