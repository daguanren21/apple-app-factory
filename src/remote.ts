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
  node: remotePath,
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
      if (rest.length !== 1 || !rest[0]) throw new Error(`remote ${action} requires one task ID`);
      forwarded = [action, ...rest];
      break;
    case 'run':
      if (rest.length !== 1 || rest[0] !== '--once') throw new Error('remote run requires --once; continuous workers belong to the Mac service');
      forwarded = [action, '--once'];
      break;
    case 'scan':
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--observe')) throw new Error('remote scan accepts only --observe');
      forwarded = [action, ...rest];
      break;
    case 'inbox':
    case 'worker':
    case 'stop':
    case 'doctor':
    case 'service':
      if (rest.length) throw new Error(`remote ${action} accepts no arguments`);
      forwarded = [action];
      break;
    default: throw new Error('remote supports enqueue, submit, scan, inbox, worker, stop, status, events, retry, run --once, doctor and service; publication commands are forbidden');
  }
  const command = `cd -- ${quote(remote.directory)} && exec ${[remote.node, 'dist/cli.js', '--build-only', '--config', remote.config, ...forwarded].map(quote).join(' ')}`;
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
