import { executeStep, drainCommandGroups } from './runner.js';
import { toError, type Config, type Job } from './schemas.js';
import type { Store } from './store.js';
import { activeWorkflowNodes } from './workflow.js';

export async function runStep(store: Store, config: Config, id: string, options: { signal?: AbortSignal; buildOnly?: boolean } = {}): Promise<Job> {
  store.acquire();
  try {
    const initial = store.get(id);
    if (initial.turn || activeWorkflowNodes(initial).length) throw new Error('Active host turns must be completed or abandoned before a deterministic step');
    // A crashed invocation may still own children even though its queue lock is free.
    // Drain them before shared Flutter/Apple tooling can be used by any new stage.
    await drainCommandGroups(store);
    if (!initial.groups.length && !options.signal?.aborted) {
      if (['research', 'build', 'review'].includes(initial.stage)) throw new Error(`Stage ${initial.stage} belongs to the host; use next and complete, not step`);
      const excluded = new Set(store.list().filter(job => job.id !== id).map(job => job.id));
      const job = store.next(current => {
        if (current.id !== id || current.turn || activeWorkflowNodes(current).length || ['research', 'build', 'review'].includes(current.stage)) return false;
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
