import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalPath, normalizeIsolationPaths } from './config.js';
import type { Config } from './schemas.js';

export interface IsolationCapabilities {
  /** Narrow capabilities for trusted harness utilities; never populated from project command data. */
  readableFiles?: readonly string[];
  writableDirectories?: readonly string[];
}

export interface IsolationContext extends IsolationCapabilities {
  config: Config;
  workspace: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  scratchParent?: string;
}

export interface IsolatedCommand {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

function failure(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'SETUP_REQUIRED' });
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function executablePath(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const candidates = command.includes('/') ? [resolve(cwd, command)] : (env.PATH ?? '').split(delimiter).filter(Boolean).map(path => resolve(cwd, path, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const path = realpathSync(candidate);
      if (lstatSync(path).isFile()) return path;
    } catch {}
  }
  throw failure(`Cannot resolve isolated executable ${command}; select an existing executable in the approved worker PATH`);
}

function pathRule(path: string): string {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw failure(`Isolation grant requires a regular canonical file or directory: ${path}`);
  return `(${info.isDirectory() ? 'subpath' : 'literal'} ${JSON.stringify(path)})`;
}

/** Keep deletion authority on the original trusted root, never a re-resolved target or its parent. */
export function removeConfinedPath(path: string, root: string): void {
  if (process.platform !== 'darwin') throw failure('Confined cleanup requires the selected macOS backend');
  const boundary = resolve(root), target = resolve(path);
  if (boundary === '/' || !contains(boundary, target)) throw failure('Cleanup target must stay within its original isolation root');
  const ancestors = new Set<string>(['/', '/bin', '/usr', '/System']);
  for (let parent = dirname(boundary); !ancestors.has(parent); parent = dirname(parent)) ancestors.add(parent);
  const profile = [
    '(version 1)', '(deny default)', '(allow process-exec)', '(allow sysctl-read)',
    '(allow file-read* (literal "/") (literal "/bin/rm") (subpath "/System/Library") (subpath "/usr/lib") (literal "/dev/null"))',
    `(allow file-read-metadata ${[...ancestors].map(parent => `(literal ${JSON.stringify(parent)})`).join(' ')})`,
    `(allow file-read* file-write* (subpath ${JSON.stringify(boundary)}))`,
    '(allow file-write* (literal "/dev/null"))',
  ].join('\n');
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/rm', '-rf', '--', target], {
    cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
  });
  if (result.error || result.signal || result.status !== 0) throw Object.assign(new Error(`Confined cleanup did not complete; outside paths were not granted: ${result.error?.message ?? result.stderr ?? result.signal}`), { code: 'PROCESS_CLEANUP_BLOCKED' });
}

/** This confines spawned commands, not the host agent, resource consumption or GUI/device services. */
export function prepareIsolatedCommand(argv: string[], context: IsolationContext): IsolatedCommand {
  if (!context.config.isolation) throw failure('No subprocess isolation mode was selected');
  if (process.platform !== 'darwin') throw failure('macos-sandbox isolation requires macOS; execution was not downgraded to trusted mode');
  try { accessSync('/usr/bin/sandbox-exec', constants.X_OK); }
  catch { throw failure('The selected macos-sandbox backend is unavailable; no command was started'); }
  const config = { ...context.config, isolation: { ...context.config.isolation, readOnlyPaths: [...context.config.isolation.readOnlyPaths] } };
  normalizeIsolationPaths(config);
  for (let index = 0; index < config.isolation.readOnlyPaths.length; index++) {
    if (config.isolation.readOnlyPaths[index] !== context.config.isolation.readOnlyPaths[index]) throw failure('An isolation read-only path changed identity; review the owner configuration before retrying');
  }
  const workspaceInfo = lstatSync(context.workspace);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) throw failure('Isolation requires a real owned workspace directory');
  const workspace = realpathSync(context.workspace);
  const state = canonicalPath(config.stateDir), workspaceRoot = canonicalPath(config.workspaceRoot);
  if (workspace === workspaceRoot || contains(workspace, state) || contains(state, workspace)) throw failure('Isolation workspace must not expose control state or the whole workspace root');
  const cwd = realpathSync(context.cwd);
  const approved = [workspace, ...config.isolation.readOnlyPaths];
  if (!approved.some(path => contains(path, cwd))) throw failure('Isolated command cwd must stay in its workspace or an approved read-only root');
  const executable = executablePath(argv[0] ?? '', cwd, context.env);
  if (contains(state, executable) || contains(workspaceRoot, executable) && !contains(workspace, executable)) throw failure('An isolated command cannot execute control state or another task workspace');
  const readable = [...config.isolation.readOnlyPaths, executable, realpathSync(process.execPath)];
  for (const file of context.readableFiles ?? []) {
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw failure(`Harness isolation capability requires a regular file: ${file}`);
    readable.push(realpathSync(file));
  }
  const extraWritable = (context.writableDirectories ?? []).map(path => {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw failure(`Harness isolation capability requires a real directory: ${path}`);
    return realpathSync(path);
  });
  const scratchParent = context.scratchParent ?? state;
  mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  const scratch = realpathSync(mkdtempSync(join(scratchParent, 'isolated-command-')));
  const cleanup = () => removeConfinedPath(scratch, scratch);
  try {
    const home = join(scratch, 'home'), temporary = join(scratch, 'tmp'), cache = join(scratch, 'cache');
    for (const path of [home, temporary, cache]) mkdirSync(path, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...context.env, HOME: home, TMPDIR: `${temporary}${sep}`, TMP: temporary, TEMP: temporary, XDG_CACHE_HOME: cache, GRADLE_USER_HOME: join(cache, 'gradle'), npm_config_cache: join(cache, 'npm') };
    for (const [name, fallback] of [['GOCACHE', join(cache, 'go-build')], ['GOMODCACHE', join(cache, 'go-mod')]] as const) {
      if (!env[name] || contains(state, canonicalPath(resolve(cwd, env[name]!)))) env[name] = fallback;
    }
    const systemPaths = ['/System/Library', '/usr/lib'].filter(existsSync);
    const devices = ['/dev/urandom', '/dev/random', '/dev/null'].filter(existsSync);
    const readablePaths = [...new Set([...systemPaths, ...readable])];
    const writablePaths = [...new Set([workspace, scratch, ...extraWritable])];
    const ancestors = new Set<string>(['/']);
    for (const path of [...readablePaths, ...writablePaths, ...devices, cwd]) {
      let parent = dirname(path);
      while (true) {
        ancestors.add(parent);
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
    }
    const profile = [
      '(version 1)', '(deny default)', '(allow process-exec)', '(allow process-fork)', '(allow sysctl-read)',
      '(allow file-read* (literal "/"))',
      `(allow file-read-metadata ${[...ancestors].map(path => `(literal ${JSON.stringify(path)})`).join(' ')})`,
      `(allow file-read* ${readablePaths.map(pathRule).join(' ')} ${devices.map(path => `(literal ${JSON.stringify(path)})`).join(' ')})`,
      `(allow file-read* file-write* ${writablePaths.map(pathRule).join(' ')})`,
      '(allow file-write* (literal "/dev/null"))',
      ...(config.isolation.network === 'allow' ? ['(allow network*)'] : []),
    ].join('\n');
    return { argv: ['/usr/bin/sandbox-exec', '-p', profile, executable, ...argv.slice(1)], env, cleanup };
  } catch (cause) {
    cleanup();
    throw cause;
  }
}
