import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { canonicalPath, inside, validateProjectContext } from '../configuration/config.js';
import { GENERATED_PATHS, dependencyDigest, generatedModulePaths, isControlMetadataPath, isGeneratedPath, validateLocalDependencies } from './dependencies.js';
import { detectProjectFramework } from './profiles.js';
import type { Framework, Job } from '../contracts/schemas.js';
import type { Store } from '../state/store.js';

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

function setup(message: string): Error {
  return Object.assign(new Error(message), { code: 'SETUP_REQUIRED' });
}

function changed(message: string): Error {
  return Object.assign(new Error(message), { code: 'EVIDENCE_CHANGED' });
}

/** Check frozen path identity before source operations, not during historical metadata reads. */
export function assertPinnedProjectRoots(job: Pick<Job, 'projectRoot' | 'workspace' | 'config'>): void {
  if (job.config.projectMode !== 'project') return;
  const configDirectory = job.config.configPath ? dirname(resolve(job.config.configPath)) : process.cwd();
  if (resolve(configDirectory, job.config.projectRoot ?? job.projectRoot) !== job.projectRoot) throw setup('Job projectRoot does not match the frozen Config.projectRoot');
  for (const [label, path] of [['projectRoot', job.projectRoot], ['workspace', job.workspace]]) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() || canonicalPath(path) !== path) {
      throw setup(`Frozen ${label} was retargeted through a symlink; restore the selected root before source operations`);
    }
  }
}

function jobProjectRoot(job: Job): string {
  assertPinnedProjectRoots(job);
  const entry = lstatSync(job.projectRoot, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) throw setup('Job projectRoot must be a canonical real directory');
  return canonicalPath(job.projectRoot);
}

function projectPath(root: string, framework: Framework | undefined, directory: string, moduleOutputs: Iterable<string>): string {
  if (directory === '.') return root;
  const project = inside(root, directory);
  const selected = relative(root, project).split(sep).join('/');
  if (isGeneratedPath(selected, framework)) throw new Error('project.directory must select owned source, not a generated directory');
  for (const output of moduleOutputs) if (selected === output || selected.startsWith(`${output}/`)) throw new Error('project.directory cannot be inside a generated Gradle module output');
  return project;
}

export function sourceDigest(root: string, omitGenerated = true, framework?: Framework, directory = '.'): string {
  if (lstatSync(root).isSymbolicLink()) throw new Error('A source or screenshot root cannot be a symlink');
  if (omitGenerated) {
    for (const path of GENERATED_PATHS) inside(root, path);
    validateLocalDependencies(root, framework, directory);
  }
  const hash = createHash('sha256');
  const moduleOutputs = framework && omitGenerated ? generatedModulePaths(root, framework, directory) : [];
  const project = omitGenerated ? projectPath(root, framework, directory, moduleOutputs) : root;
  for (const output of moduleOutputs) inside(root, output);
  function visit(directory: string): void {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (omitGenerated) {
        const workspacePath = relative(root, path).split(sep).join('/');
        let generated = isGeneratedPath(workspacePath, framework) || (project !== root && !relative(project, path).startsWith('..') && isGeneratedPath(relative(project, path), framework));
        if (!generated) for (const output of moduleOutputs) if (workspacePath === output || workspacePath.startsWith(`${output}/`)) { generated = true; break; }
        if (generated) { inside(root, path); continue; }
      }
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Source symlink is not permitted: ${relative(root, path)}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) hash.update(relative(root, path)).update('\0').update(`${stat.size}:${stat.mode & 0o777}\0`).update(readFileSync(path));
      else throw new Error(`Source is not a regular file or directory: ${relative(root, path)}`);
    }
  }
  visit(root);
  return hash.digest('hex');
}

export function projectDirectory(job: Pick<Job, 'workspace' | 'spec'>): string {
  const directory = job.spec.project?.directory ?? '.';
  const modules = existsSync(job.workspace) ? generatedModulePaths(job.workspace, job.spec.framework, directory) : [];
  return projectPath(job.workspace, job.spec.framework, directory, modules);
}

/** Resolve the selected monorepo-relative app directory from the immutable live project root. */
export function sourceProjectDirectory(job: Pick<Job, 'projectRoot' | 'spec'>): string {
  const directory = job.spec.project?.directory ?? '.';
  const modules = existsSync(job.projectRoot) ? generatedModulePaths(job.projectRoot, job.spec.framework, directory) : [];
  return projectPath(job.projectRoot, job.spec.framework, directory, modules);
}

/** Select the live root for research/build and the execution root for review and deterministic stages. */
export function hostProjectDirectory(job: Pick<Job, 'projectRoot' | 'workspace' | 'spec' | 'stage'>): string {
  return job.stage === 'research' || job.stage === 'build' ? sourceProjectDirectory(job) : projectDirectory(job);
}

export function artifactOutputPath(root: string, path: string): string {
  const output = inside(root, path);
  let current = root;
  for (const part of relative(root, output).split(sep)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) throw Object.assign(new Error('Artifact output and its ancestors cannot be symlinks, including aliases into owned source'), { code: 'SETUP_REQUIRED' });
  }
  return output;
}

function prepareProjectWorkspace(job: Job): void {
  validateProjectContext(job.config, job.workspace);
  const root = jobProjectRoot(job);
  const info = lstatSync(root, { throwIfNoEntry: false });
  if (!info) mkdirSync(root, { recursive: true, mode: 0o700 });
  else if (info.isSymbolicLink() || !info.isDirectory()) throw setup('Configured projectRoot must be a real directory');
  const project = sourceProjectDirectory(job);
  if (!existsSync(project)) return;
  const detected = detectProjectFramework(project);
  if (detected && detected !== job.spec.framework) throw setup(`Existing ${detected} project conflicts with requested ${job.spec.framework} framework`);
}

function prepareIsolatedWorkspace(store: Store, job: Job): Partial<Job> | undefined {
  const imported = Boolean(job.sourceDirectory);
  if (imported ? job.importPrepared : !job.baseJobId || job.basePrepared) return;
  const source = imported ? job.sourceDirectory! : store.get(job.baseJobId!).workspace;
  const expected = imported ? job.importDigest : job.baseDigest;
  const digest = (root: string) => sourceDigest(root, true, job.spec.framework, job.spec.project?.directory);
  if (!expected || digest(source) !== expected) throw setup('Project source changed since intake; refusing to copy an unverified revision');
  if (existsSync(job.workspace)) {
    if (lstatSync(job.workspace).isSymbolicLink() || digest(job.workspace) !== expected) throw setup('Uninitialized workspace differs from its pinned project source; inspect it before retrying');
  } else {
    mkdirSync(job.config.workspaceRoot, { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(join(job.config.workspaceRoot, `.${job.id}.source-`));
    const prepared = join(staging, 'source');
    const sourceProject = join(source, job.spec.project?.directory ?? '.');
    try {
      const moduleOutputs = generatedModulePaths(source, job.spec.framework, job.spec.project?.directory);
      cpSync(source, prepared, {
        recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE,
        filter: path => {
          const workspacePath = relative(source, path).split(sep).join('/');
          if (isGeneratedPath(workspacePath, job.spec.framework) || (sourceProject !== source && !relative(sourceProject, path).startsWith('..') && isGeneratedPath(relative(sourceProject, path), job.spec.framework))) return false;
          for (const output of moduleOutputs) if (workspacePath === output || workspacePath.startsWith(`${output}/`)) return false;
          return true;
        },
      });
      if (digest(prepared) !== expected || digest(source) !== expected) throw setup('Project source changed while copying; no workspace was initialized');
      renameSync(prepared, job.workspace);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  return imported ? { importPrepared: true } : { basePrepared: true };
}

/** Prepare live project context or preserve historical isolated snapshot-import semantics. */
export function prepareWorkspace(store: Store, job: Job): void {
  const patch = store.withProjectWrite(job.id, current => {
    if (current.config.projectMode === 'project') {
      prepareProjectWorkspace(current);
      return undefined;
    }
    return prepareIsolatedWorkspace(store, current);
  });
  if (patch) store.update(job.id, patch);
}

function pathWithinAny(path: string, roots: readonly string[]): boolean {
  return roots.some(root => contains(root, path));
}

function validateSnapshotLinks(root: string, excluded: readonly string[]): void {
  function visit(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (isControlMetadataPath(relative(root, path)) || pathWithinAny(path, excluded)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path, 'utf8');
        const lexical = isAbsolute(target) ? resolve(target) : resolve(dirname(path), target);
        if (!existsSync(lexical) || !isAbsolute(target) && !contains(root, lexical)) throw changed(`Unsafe source symlink escapes projectRoot: ${relative(root, path)}`);
        const actual = canonicalPath(lexical);
        if (!contains(root, actual) || pathWithinAny(actual, excluded) || isControlMetadataPath(relative(root, actual))) throw changed(`Unsafe source symlink escapes projectRoot: ${relative(root, path)}`);
      } else if (stat.isDirectory()) visit(path);
      else if (!stat.isFile()) throw changed(`Source is not a regular file or directory: ${relative(root, path)}`);
    }
  }

  visit(root);
}
function relocatedOwnedPath(sourceRoot: string, destinationRoot: string, target: string): string | undefined {
  const actual = canonicalPath(target);
  if (!contains(sourceRoot, actual)) return undefined;
  return join(destinationRoot, relative(sourceRoot, actual));
}

function relocateOwnedSymlinks(sourceRoot: string, destinationRoot: string): void {
  function visit(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (isControlMetadataPath(relative(destinationRoot, path))) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path, 'utf8');
        if (isAbsolute(target)) {
          const mapped = relocatedOwnedPath(sourceRoot, destinationRoot, resolve(target));
          if (!mapped) throw changed(`Unsafe external absolute source symlink: ${relative(sourceRoot, path)}`);
          const replacement = relative(dirname(path), mapped);
          unlinkSync(path);
          symlinkSync(replacement, path);
        } else {
          const targetPath = resolve(dirname(path), target);
          if (!existsSync(targetPath) || !contains(destinationRoot, canonicalPath(targetPath))) throw changed(`Unsafe copied source symlink: ${relative(destinationRoot, path)}`);
        }
      } else if (stat.isDirectory()) visit(path);
    }
  }
  visit(destinationRoot);
}

const SnapshotPackageConfigSchema = z.object({
  packages: z.array(z.object({ name: z.string(), rootUri: z.string(), packageUri: z.string().optional() }).passthrough()),
}).passthrough();

function relativeDirectoryUri(base: string, target: string, original: URL): string {
  const path = relative(base, target).split(sep).map(part => encodeURIComponent(part)).join('/') || '.';
  return `${path}/${original.search}${original.hash}`;
}

function relocatePackageConfig(sourceRoot: string, destinationRoot: string, directory: string): void {
  const path = join(destinationRoot, directory, '.dart_tool', 'package_config.json');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) throw changed('Copied Flutter dependency metadata must be a regular file');
  const originalPath = join(sourceRoot, directory, '.dart_tool', 'package_config.json');
  const parsed = SnapshotPackageConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  let rewritten = false;
  for (const entry of parsed.packages) {
    const rootUri = new URL(entry.rootUri, pathToFileURL(originalPath));
    if (rootUri.protocol !== 'file:') continue;
    if (!rootUri.pathname.endsWith('/')) rootUri.pathname += '/';
    const mappedRoot = relocatedOwnedPath(sourceRoot, destinationRoot, fileURLToPath(rootUri));
    const packageUri = new URL(entry.packageUri ?? '', rootUri);
    const mappedPackage = packageUri.protocol === 'file:' ? relocatedOwnedPath(sourceRoot, destinationRoot, fileURLToPath(packageUri)) : undefined;
    if (mappedRoot) {
      if (!mappedPackage) throw changed(`Owned Flutter package ${entry.name} resolves code outside projectRoot`);
      const nextRoot = relativeDirectoryUri(dirname(path), mappedRoot, rootUri);
      const nextPackage = relativeDirectoryUri(mappedRoot, mappedPackage, packageUri);
      rewritten ||= nextRoot !== entry.rootUri || entry.packageUri !== undefined && nextPackage !== entry.packageUri;
      entry.rootUri = nextRoot;
      if (entry.packageUri !== undefined) entry.packageUri = nextPackage;
    } else {
      if (mappedPackage) throw changed(`Flutter package ${entry.name} needs an owned root before its source can be relocated`);
      rewritten ||= entry.rootUri !== rootUri.href;
      entry.rootUri = rootUri.href;
    }
  }
  if (rewritten) writeFileSync(path, `${JSON.stringify(parsed)}\n`);
}

function replaceSnapshot(workspaceRoot: string, workspace: string, prepared: string, jobId: string): void {
  const existing = lstatSync(workspace, { throwIfNoEntry: false });
  if (!existing) {
    renameSync(prepared, workspace);
    return;
  }
  if (existing.isSymbolicLink() || !existing.isDirectory()) throw setup('Existing execution workspace is not a job-owned directory');
  const previous = join(workspaceRoot, `.${jobId}.previous-${randomUUID()}`);
  renameSync(workspace, previous);
  try {
    renameSync(prepared, workspace);
    rmSync(previous, { recursive: true, force: true });
  } catch (cause) {
    if (!lstatSync(workspace, { throwIfNoEntry: false })) renameSync(previous, workspace);
    throw cause;
  }
}

/** Build a snapshot only while its queue owner holds the project-write transaction. */
export function prepareExecutionWorkspace(store: Store, job: Job): Partial<Job> {
  return store.withProjectWrite(job.id, createExecutionSnapshot);
}

function createExecutionSnapshot(job: Job): Partial<Job> {
  const source = jobProjectRoot(job);
  const execution = canonicalPath(job.workspace);
  if (source === execution) return {};
  if (job.config.projectMode !== 'project') throw setup('Only project-mode jobs may create an execution snapshot');
  validateProjectContext(job.config, job.workspace);
  const workspaceRoot = canonicalPath(job.config.workspaceRoot);
  if (relative(workspaceRoot, execution) !== job.id) throw setup('Execution workspace is not the deterministic directory owned by this job');
  const sourceInfo = lstatSync(source, { throwIfNoEntry: false });
  if (!sourceInfo || sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw changed('Live projectRoot is unavailable for execution snapshot');
  const protectedPaths = [job.config.stateDir, execution, ...(job.config.inbox ? [job.config.inbox.directory] : [])].map(path => canonicalPath(path));
  if (protectedPaths.some(path => overlaps(source, path))) throw setup('Execution workspace or control state overlaps live projectRoot');
  validateSnapshotLinks(source, protectedPaths);
  const directory = job.spec.project?.directory ?? '.';
  const sourceBefore = sourceDigest(source, true, job.spec.framework, directory);
  const dependencyBefore = dependencyDigest(source, job.spec.framework, directory);
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(workspaceRoot, `.${job.id}.snapshot-`));
  const prepared = join(staging, 'execution');
  protectedPaths.push(staging);
  try {
    cpSync(source, prepared, {
      recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE,
      dereference: false, verbatimSymlinks: true,
      filter: path => {
        if (isControlMetadataPath(relative(source, path))) return false;
        if (pathWithinAny(path, protectedPaths)) return false;
        return true;
      },
    });
    relocateOwnedSymlinks(source, prepared);
    relocatePackageConfig(source, prepared, directory);
    assertPinnedProjectRoots(job);
    const sourceAfter = sourceDigest(source, true, job.spec.framework, directory);
    const dependencyAfter = dependencyDigest(source, job.spec.framework, directory);
    if (sourceAfter !== sourceBefore || dependencyAfter !== dependencyBefore) throw changed('Live project source or dependency inputs changed while creating execution snapshot');
    if (sourceDigest(prepared, true, job.spec.framework, directory) !== sourceBefore) throw changed('Execution snapshot source proof does not match live project source');
    const copiedDependency = dependencyDigest(prepared, job.spec.framework, directory);
    if (!/^[a-f0-9]{64}$/.test(copiedDependency)) throw changed('Execution snapshot dependency proof is invalid');
    assertPinnedProjectRoots(job);
    replaceSnapshot(workspaceRoot, execution, prepared, job.id);
    return { projectDigest: sourceBefore, projectDependencyDigest: dependencyBefore };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Reject live source or dependency changes after an obfuscation execution snapshot was recorded. */
export function assertProjectSnapshot(job: Job): void {
  const source = jobProjectRoot(job);
  const execution = canonicalPath(job.workspace);
  if (source === execution) return;
  if (!job.projectDigest || !job.projectDependencyDigest) throw changed('Execution snapshot is missing live source and dependency proof');
  try {
    const currentSource = sourceDigest(source, true, job.spec.framework, job.spec.project?.directory);
    if (currentSource !== job.projectDigest) throw changed(`Live project source changed since execution snapshot (current=${currentSource.slice(0, 16)} recorded=${job.projectDigest.slice(0, 16)})`);
    const currentDependency = dependencyDigest(source, job.spec.framework, job.spec.project?.directory);
    if (currentDependency !== job.projectDependencyDigest) throw changed(`Live project dependency inputs changed since execution snapshot (current=${currentDependency.slice(0, 16)} recorded=${job.projectDependencyDigest.slice(0, 16)})`);
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === 'EVIDENCE_CHANGED') throw cause;
    throw changed(`Live project snapshot cannot be proven unchanged: ${error.message}`);
  }
}
