import { spawn } from 'node:child_process';

// The registered PID is this detached process-group leader, not the payload PID.
// Caller environment hooks cannot run until the parent commits ownership and
// sends the start acknowledgement. EOF before that acknowledgement runs nothing.
let acknowledged = false;
process.once('disconnect', () => { if (!acknowledged) process.exit(1); });

function fail(cause: unknown): void {
  const error = cause instanceof Error ? cause as NodeJS.ErrnoException & { spawnargs?: string[] } : new Error(String(cause));
  if (process.connected && process.send) {
    process.send({ error: { ...error, name: error.name, message: error.message } }, () => process.exit(1));
  } else process.exit(1);
}

process.once('message', (message: { argv: string[]; env: NodeJS.ProcessEnv }) => {
  acknowledged = true;
  try {
    const { argv, env } = message;
    const executable = argv[0];
    if (executable === undefined) throw new Error('Missing command executable');
    // Ordinary spawn retains PATH, executable-error and isolation semantics on
    // every supported Node version. The payload inherits this registered group
    // and stdio, but never the bootstrap's private acknowledgement channel.
    const child = spawn(executable, argv.slice(1), { env, detached: false, stdio: 'inherit', shell: false });
    child.once('error', fail);
    child.once('exit', code => process.exit(code ?? 1));
  } catch (cause) { fail(cause); }
});
