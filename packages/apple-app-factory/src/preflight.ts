import { expandArgv } from './config.js';
import { run as runCommand, type Run, type RunResult } from './process.js';
import { toError } from './schemas.js';

export interface PrerequisiteOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  run?: Run;
  signal?: AbortSignal;
}

function prerequisiteFailure(argv: string[], reason: string, detail: string, cause?: unknown) {
  return Object.assign(new Error(`Prerequisite ${JSON.stringify(argv)} ${detail}. Restore the configured worker environment before retrying.`, { cause }), {
    code: 'PREREQUISITE_FAILED',
    prerequisite: { argv: [...argv], reason },
  });
}

export async function checkPrerequisites(commands: string[][], { cwd, env = process.env, run = runCommand, signal }: PrerequisiteOptions = {}): Promise<void> {
  signal?.throwIfAborted();
  for (const argv of commands) {
    signal?.throwIfAborted();
    let expanded: string[];
    try {
      expanded = expandArgv(argv, env);
    } catch (error) {
      if (signal?.aborted || toError(error).code !== 'SETUP_REQUIRED') throw error;
      throw prerequisiteFailure(argv, 'environment', 'requires an allowed environment variable', error);
    }
    let result: RunResult;
    try {
      result = await run(expanded, { cwd, env, signal });
    } catch (value) {
      const error = toError(value);
      if (signal?.aborted || error.code !== 'ENOENT' || !error.syscall?.startsWith('spawn')) throw value;
      throw prerequisiteFailure(argv, 'missing-command', 'could not be started because its executable or working directory is missing', value);
    }
    signal?.throwIfAborted();
    if (result.code !== 0) throw prerequisiteFailure(argv, 'nonzero-exit', `exited with code ${result.code}`);
  }
}
