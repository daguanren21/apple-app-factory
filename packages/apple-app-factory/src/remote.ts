import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { z } from 'zod';
import { loadJSON } from './config.js';
import { parseRequirement } from './requirements.js';
import { toError } from './schemas.js';

const remotePath = z.string().min(1).refine(value => posix.isAbsolute(value) && !value.includes('\0') && !/[\r\n]/.test(value), 'Use an absolute path on the Mac worker');
export const RemoteSchema = z.strictObject({
  host: z.string().regex(/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  directory: remotePath,
  executable: remotePath,
  config: remotePath,
});
export type Remote = z.infer<typeof RemoteSchema>;
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function remoteCommand(endpoint: unknown, args: string[]): { argv: string[]; input?: string } {
  const remote = RemoteSchema.parse(endpoint);
  const [action, ...rest] = args;
  let input: string | undefined;
  let forwarded: string[];
  switch (action) {
    case 'enqueue':
    case 'submit': {
      if (rest.length !== 1) throw new Error(`remote ${action} requires one local requirements JSON file`);
      const { spec, baseJobId } = parseRequirement(loadJSON(rest[0]));
      input = JSON.stringify({ ...spec, ...(baseJobId ? { baseJobId } : {}) });
      forwarded = [action, '-'];
      break;
    }
    case 'status':
      if (rest.length > 1) throw new Error('remote status accepts at most one task ID');
      forwarded = [action, ...rest];
      break;
    case 'events':
    case 'retry':
    case 'next':
    case 'step':
      if (rest.length !== 1 || !rest[0]) throw new Error(`remote ${action} requires one task ID`);
      forwarded = [action, ...rest];
      break;
    case 'complete':
      if (rest.length < 2 || rest.length > 3 || !rest[0] || !rest[1]) throw new Error('remote complete requires a task ID, turn ID and optional local result JSON file');
      if (rest[2]) input = JSON.stringify(loadJSON(rest[2]));
      forwarded = [action, rest[0], rest[1], ...(rest[2] ? ['-'] : [])];
      break;
    case 'abandon':
      if (rest.length !== 2 || !rest[0] || !rest[1]) throw new Error('remote abandon requires a task ID and turn ID');
      forwarded = [action, ...rest];
      break;
    case 'scan':
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--observe')) throw new Error('remote scan accepts only --observe');
      forwarded = [action, ...rest];
      break;
    case 'inbox':
    case 'doctor':
      if (rest.length) throw new Error(`remote ${action} accepts no arguments`);
      forwarded = [action];
      break;
    default:
      throw new Error('remote supports enqueue, submit, scan, inbox, status, events, retry, next, complete, abandon, step and doctor; publication commands are forbidden');
  }
  const command = `cd -- ${quote(remote.directory)} && exec ${[remote.executable, '--build-only', '--config', remote.config, ...forwarded].map(quote).join(' ')}`;
  return {
    argv: ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '--', remote.host, command],
    input,
  };
}

export async function dispatchRemote(endpoint: unknown, args: string[]): Promise<number> {
  const command = remoteCommand(endpoint, args);
  const { promise, resolve, reject } = Promise.withResolvers<number>();
    const child = spawn(command.argv[0], command.argv.slice(1), { stdio: ['pipe', 'inherit', 'inherit'], shell: false });
    const interrupt = (): void => { child.kill('SIGTERM'); };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    const cleanup = (): void => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); };
    child.once('error', error => { cleanup(); reject(error); });
    child.stdin.on('error', error => { if (toError(error).code !== 'EPIPE') child.kill('SIGTERM'); });
    child.once('close', (code, signal) => { cleanup(); resolve(code ?? (signal ? 128 : 1)); });
    child.stdin.end(command.input ?? '');
  return promise;
}
