import { executeStep } from './runner.js';
import { terminateOwnedProcessGroup } from './process.js';
import { toError, type Config, type Job } from './schemas.js';
import type { Store } from './store.js';

async function drainCommandGroups(store: Store): Promise<void> {
  let failure: Error | undefined;
  for (const job of store.list()) {
    const groups: number[] = [], commands: Job['commands'] = {};
    let manualRecovery = job.manualRecovery ?? null;
    for (const pid of job.groups) {
      const command = job.commands[pid];
      try { await terminateOwnedProcessGroup(pid, command?.identity); }
      catch (cause) {
        const error = toError(cause);
        failure ??= error;
        manualRecovery ??= error.message;
        groups.push(pid);
        if (command) commands[pid] = command;
      }
    }
    if (job.groups.length || manualRecovery) {
      store.update(job.id, {
        groups, commands, recoveryStage: groups.length ? job.recoveryStage ?? job.stage : undefined,
        ...(manualRecovery ? { status: 'blocked', blockedReason: null, manualRecovery, error: manualRecovery } : {}),
      });
    }
    if (manualRecovery) failure ??= Object.assign(new Error(manualRecovery), { code: 'PROCESS_CLEANUP_BLOCKED' });
  }
  if (failure) throw failure;
}

export async function runStep(store: Store, config: Config, id: string, options: { signal?: AbortSignal; buildOnly?: boolean } = {}): Promise<Job> {
  if (options.buildOnly && (config.allowSubmit || config.allowRelease)) throw new Error('--build-only refuses configurations with upload or release enabled');
  store.acquire();
  try {
    const initial = store.get(id);
    if (initial.turn) throw new Error('An active host turn must be completed or abandoned before a deterministic step');
    if (options.buildOnly && (initial.config.allowSubmit || initial.config.allowRelease)) throw new Error('--build-only refuses this task with snapshotted publication permission');
    // A crashed invocation may still own children even though its queue lock is free.
    // Drain them before shared Flutter/Apple tooling can be used by any new stage.
    await drainCommandGroups(store);
    if (!initial.groups.length && !options.signal?.aborted) {
      if (['research', 'build', 'review'].includes(initial.stage)) throw new Error(`Stage ${initial.stage} belongs to the host; use next and complete, not step`);
      const excluded = new Set(store.list().filter(job => job.id !== id).map(job => job.id));
      const job = store.next(current => {
        if (current.id !== id || current.turn || ['research', 'build', 'review'].includes(current.stage)) return false;
        if (options.buildOnly && (current.config.allowSubmit || current.config.allowRelease)) throw new Error('--build-only refuses this task with snapshotted publication permission');
        return true;
      }, excluded);
      if (job) {
        try { await executeStep(store, job, { signal: options.signal }); }
        catch (cause) {
          store.update(id, { stage: job.stage, status: 'blocked', blockedReason: null, error: `Stage ${job.stage} stopped unexpectedly: ${toError(cause).message}` });
        }
      }
    }
  } finally {
    try { await drainCommandGroups(store); }
    finally { store.release(); }
  }
  return store.get(id);
}
