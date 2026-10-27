import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { inside } from './config.js';
import { GENERATED_PATHS, generatedModulePaths, isGeneratedPath, validateLocalDependencies } from './dependencies.js';
import type { Framework, Job } from './schemas.js';
import type { Store } from './store.js';

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

export function prepareWorkspace(store: Store, job: Job): void {
  const imported = Boolean(job.sourceDirectory);
  if (imported ? job.importPrepared : !job.baseJobId || job.basePrepared) return;
  const source = imported ? job.sourceDirectory! : store.get(job.baseJobId!).workspace;
  const expected = imported ? job.importDigest : job.baseDigest;
  const digest = (root: string) => sourceDigest(root, true, job.spec.framework, job.spec.project?.directory);
  const setup = (message: string) => Object.assign(new Error(message), { code: 'SETUP_REQUIRED' });
  if (!expected || digest(source) !== expected) throw setup('Project source changed since intake; refusing to copy an unverified revision');
  if (existsSync(job.workspace)) {
    if (digest(job.workspace) !== expected) throw setup('Uninitialized workspace differs from its pinned project source; inspect it before retrying');
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
  store.update(job.id, imported ? { importPrepared: true } : { basePrepared: true });
}
