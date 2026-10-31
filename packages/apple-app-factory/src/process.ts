import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { toError, type CommandMetadata, type Config, type ProcessIdentity } from './schemas.js';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  logPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number, metadata: CommandMetadata) => void;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Run = (argv: string[], options?: RunOptions) => Promise<RunResult>;

const OUTPUT_LIMIT = 262144;
const COMMAND_TOKEN = 'APPLE_APP_FACTORY_COMMAND_TOKEN';
export const TERMINATION_GRACE_MS = 1000;
export const SUCCESS_DRAIN_GRACE_MS = 30000;
const DRAIN_FAILURE_DETAIL = 'left stdout or stderr open after its verified process group exited; processes outside that group were not signaled';

export interface ProcessInfo { identity: string; parentPid: number; argv: string[]; executable?: string; command?: string }

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1 && pid <= 2147483647;
}

export function inspectProcess(pid: number): ProcessInfo | undefined {
  if (!validPid(pid)) return undefined;
  try {
    if (process.platform === 'linux') {
      const stat = (): string[] => {
        const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
        // comm may contain spaces and parentheses; fields after its final ')' are numeric/stat fields.
        return value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/);
      };
      const before = stat();
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const after = stat();
      const parentPid = Number(after[1]);
      if (!boot || !/^\d+$/.test(before[19] ?? '') || before[19] !== after[19] || !Number.isSafeInteger(parentPid) || parentPid < 0) return undefined;
      return { identity: `linux:${boot}:${pid}:${after[19]}`, parentPid, argv: command ? command.replace(/\0$/, '').split('\0') : [] };
    }
    if (process.platform === 'darwin') {
      const options = { encoding: 'utf8' as const, timeout: 1000, maxBuffer: 1048576, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC0' } };
      const ps = (fields: string): string | undefined => {
        const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', fields], options);
        return result.status === 0 && !result.error ? result.stdout.trimEnd() : undefined;
      };
      const before = ps('lstart=,ppid=');
      const boot = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], options);
      const executable = ps('comm=');
      const command = ps('args=');
      const after = ps('lstart=,ppid=');
      const birth = /^\s*(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s*$/;
      const first = before?.match(birth), last = after?.match(birth);
      const bootTime = boot.status === 0 && !boot.error ? boot.stdout.match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/) : undefined;
      if (!first || !last || first[1] !== last[1] || !bootTime) return undefined;
      // macOS ps exposes second-resolution birth time, not an unambiguous argv vector.
      // Same-second PID reuse remains conservatively live; never infer argv by splitting args.
      return { identity: `darwin:${bootTime[1]}.${bootTime[2]}:${pid}:${last[1]}`, parentPid: Number(last[2]), argv: [], ...(executable ? { executable: executable.trimStart() } : {}), ...(command ? { command: command.trimStart() } : {}) };
    }
  } catch {}
  return undefined;
}

export function processIsAlive(pid: number, expectedIdentity?: string): boolean {
  if (!validPid(pid)) return false;
  try { process.kill(pid, 0); }
  catch (error) { if (toError(error).code === 'ESRCH') return false; }
  if (expectedIdentity === undefined) return true;
  const current = inspectProcess(pid);
  return current === undefined || current.identity === expectedIdentity;
}

function groupMembers(pid: number): number[] | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return [];
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); }
  catch (error) { if (toError(error).code === 'ESRCH') return []; }
  if (process.platform === 'win32') return [pid];
  const result = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4194304 });
  if (result.status !== 0 || result.error) return null;
  const members: number[] = [];
  for (const line of result.stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (Number(fields[1]) === pid && !fields[2]?.startsWith('Z')) members.push(Number(fields[0]));
  }
  return members;
}

export function processGroupAlive(pid: number): boolean {
  const members = groupMembers(pid);
  return members === null || members.length > 0;
}

function processToken(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const prefix = `${COMMAND_TOKEN}=`;
      return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find(value => value.startsWith(prefix))?.slice(prefix.length) ?? '';
    }
    if (process.platform === 'darwin') {
      const result = spawnSync('/bin/ps', ['-E', '-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000, maxBuffer: 1048576 });
      if (result.status === 0 && !result.error) return result.stdout.match(new RegExp(`(?:^|\\s)${COMMAND_TOKEN}=([a-f0-9-]+)(?=\\s|$)`))?.[1] ?? '';
    }
  } catch {}
  return undefined;
}

export function inspectProcessGroup(pid: number, identity?: ProcessIdentity): 'gone' | 'unknown' | 'owned' | 'mismatch' {
  const members = groupMembers(pid);
  if (members?.length === 0) return 'gone';
  if (members === null || !identity?.token) return 'unknown';
  let readable = false;
  const inspectionDeadline = Date.now() + 1000;
  for (const member of members) {
    if (Date.now() >= inspectionDeadline) return 'unknown';
    const token = processToken(member);
    if (token === identity.token) return 'owned';
    if (token !== undefined) readable = true;
  }
  if (!processGroupAlive(pid)) return 'gone';
  return readable ? 'mismatch' : 'unknown';
}

function cleanupError(pid: number, detail: string): Error & { code: string } {
  return Object.assign(new Error(`Command group ${pid} ${detail}. No replay is allowed; inspect this task's recorded command ownership before retrying.`), { code: 'PROCESS_CLEANUP_BLOCKED' });
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(process.platform === 'win32' ? pid : -pid, signal); }
  catch (value) {
    const error = toError(value);
    if (error.code !== 'ESRCH') throw cleanupError(pid, `could not receive ${signal}: ${error.message}`);
  }
}

export function signalOwnedProcessGroup(pid: number, identity: ProcessIdentity | undefined, signal: NodeJS.Signals): boolean {
  const ownership = inspectProcessGroup(pid, identity);
  if (ownership === 'gone') return false;
  if (ownership !== 'owned') throw cleanupError(pid, `has ${ownership === 'mismatch' ? 'a different process identity' : 'unverifiable ownership'}`);
  sendSignal(pid, signal);
  return true;
}

async function terminateGroup(pid: number, identity: ProcessIdentity | undefined, leaderAlive: () => boolean): Promise<void> {
  const signal = (value: NodeJS.Signals): void => {
    if (leaderAlive()) sendSignal(pid, value);
    else signalOwnedProcessGroup(pid, identity, value);
  };
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGKILL'];
  for (const value of signals) {
    if (!processGroupAlive(pid)) return;
    signal(value);
    const deadline = Date.now() + TERMINATION_GRACE_MS;
    do {
      if (!processGroupAlive(pid)) return;
      await sleep(50);
    } while (Date.now() < deadline);
  }
  if (processGroupAlive(pid)) throw cleanupError(pid, 'is still active after SIGKILL');
}

export async function terminateOwnedProcessGroup(pid: number, identity: ProcessIdentity | undefined): Promise<void> {
  await terminateGroup(pid, identity, () => false);
}

export function executionEnvironment(config: Pick<Config, 'executionEnv'>, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', ...config.executionEnv]) {
    if (source[key] !== undefined && !/^(ASC_|APPLE_|FASTLANE_|MATCH_)/.test(key)) env[key] = source[key];
  }
  env.CI = '1';
  return env;
}

export async function run(argv: string[], { cwd, env = process.env, input, logPath, timeoutMs = 600000, signal, onSpawn }: RunOptions = {}): Promise<RunResult> {
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string')) throw new Error('Command must be a non-empty argv array');
  const executable = argv[0];
  if (executable === undefined) throw new Error('Command must be a non-empty argv array');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Command timeoutMs must be positive and finite');
  signal?.throwIfAborted();
  if (onSpawn && process.platform === 'win32') throw Object.assign(new Error('Tracked commands require POSIX process-group supervision; no command was started'), { code: 'PROCESS_START_UNSUPPORTED' });
  const deadline = Date.now() + timeoutMs;
  const identity: ProcessIdentity = { token: randomUUID() };
  let fd: number | undefined;
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    fd = openSync(logPath, 'a', 0o600);
  }
  try {
    const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
    const commandEnv = { ...env, [COMMAND_TOKEN]: identity.token };
    // Only trusted bootstrap code runs before ownership commits. In particular, caller
    // NODE_OPTIONS / loader environment must not execute payload code in the bootstrap.
    const child = (onSpawn
      ? spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('./command-bootstrap.js', import.meta.url))], { cwd, env: { [COMMAND_TOKEN]: identity.token }, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], shell: false })
      : spawn(executable, argv.slice(1), { cwd, env: commandEnv, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], shell: false })) as ChildProcessWithoutNullStreams;
    let stdout = '', stderr = '';
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    let failure: unknown, exitCode: number | null | undefined;
    let exited = false, closed = false, cleanupStarted = false, cleanupComplete = false, cleanupFailed = false, drainResolved = false, settled = false;
    const finish = (): void => {
      if (settled || !cleanupComplete || (!closed && !cleanupFailed && !drainResolved)) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else resolve({ code: exitCode ?? 1, stdout, stderr });
    };
    const destroyStreams = (): void => {
      child.unref();
      if (child.connected) child.disconnect();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const failCleanup = (error: unknown): void => {
      failure = error;
      cleanupFailed = true;
      destroyStreams();
      finish();
    };
    const resolveCleanup = (): void => {
      drainResolved = true;
      destroyStreams();
      finish();
    };
    const onDrainExpired = (pid: number): void => {
      if (closed || cleanupFailed || drainResolved) return;
      if (failure || exitCode !== 0) failCleanup(cleanupError(pid, DRAIN_FAILURE_DETAIL));
      else resolveCleanup();
    };
    const onDrainGrace = (pid: number): void => {
      if (closed || cleanupFailed || drainResolved) return;
      if (failure || exitCode !== 0) { onDrainExpired(pid); return; }
      drainTimer = setTimeout(() => onDrainExpired(pid), SUCCESS_DRAIN_GRACE_MS);
    };
    const cleanup = (): void => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      clearTimeout(timer);
      const pending = child.pid ? terminateGroup(child.pid, identity, () => !exited) : Promise.resolve();
      pending.catch(failCleanup).finally(() => {
        cleanupComplete = true;
        const pid = child.pid;
        if (pid && !closed && !cleanupFailed) {
          drainTimer = setTimeout(() => onDrainGrace(pid), TERMINATION_GRACE_MS);
        }
        finish();
      });
    };
    const onAbort = (): void => {
      failure ??= new Error('Command interrupted; its task remains resumable');
      cleanup();
      if (cleanupComplete && !closed && !cleanupFailed && !drainResolved) {
        onDrainExpired(child.pid ?? 0);
      }
    };
    let timer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined;
    const onDeadline = (): void => {
      const remaining = deadline - Date.now();
      if (remaining > 0) timer = setTimeout(onDeadline, Math.min(remaining, 2147483647));
      else { failure ??= new Error(`Command timed out after ${timeoutMs} ms: ${executable}`); cleanup(); }
    };
    timer = setTimeout(onDeadline, Math.min(timeoutMs, 2147483647));
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + stdoutDecoder.write(chunk)).slice(-OUTPUT_LIMIT);
      if (fd !== undefined) writeSync(fd, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + stderrDecoder.write(chunk)).slice(-OUTPUT_LIMIT);
      if (fd !== undefined) writeSync(fd, chunk);
    });
    child.stdout.on('end', () => { stdout = (stdout + stdoutDecoder.end()).slice(-OUTPUT_LIMIT); });
    child.stderr.on('end', () => { stderr = (stderr + stderrDecoder.end()).slice(-OUTPUT_LIMIT); });
    child.stdin.on('error', (error: Error) => { if (toError(error).code !== 'EPIPE') { failure ??= error; cleanup(); } });
    child.on('error', error => { failure ??= error; cleanup(); });
    child.on('message', message => {
      if (!message || typeof message !== 'object' || !('error' in message) || typeof message.error !== 'object' || message.error === null) return;
      const details = message.error as NodeJS.ErrnoException & { spawnargs?: string[] };
      const ErrorType = details.name === 'TypeError' ? TypeError : details.name === 'RangeError' ? RangeError : Error;
      failure ??= Object.assign(new ErrorType(details.message), details);
      cleanup();
    });
    child.on('exit', code => { exited = true; exitCode = code; cleanup(); });
    child.on('close', code => { closed = true; exitCode ??= code; cleanup(); finish(); });
    if (child.pid && onSpawn) {
      const pid = child.pid;
      const acknowledge = async (): Promise<void> => {
        try {
          await onSpawn(pid, { deadline, identity });
          if (signal?.aborted) { onAbort(); return; }
          if (Date.now() >= deadline) { onDeadline(); return; }
          if (cleanupStarted || exited || !child.connected) return;
          child.send({ argv, env: commandEnv }, error => { if (error) { failure ??= error; cleanup(); } });
        } catch (error) { failure ??= error; cleanup(); }
      };
      void acknowledge();
    }
    if (signal?.aborted) onAbort();
    child.stdin.end(input ?? '');
    return await promise;
  } finally { if (fd !== undefined) closeSync(fd); }
}
