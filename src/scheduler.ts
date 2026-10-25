import { executeStep } from './runner.js';
import { scanInbox, type InboxScan } from './inbox.js';
import { processGroupAlive, terminateOwnedProcessGroup } from './process.js';
import { toError, type Config, type Job, type Stage } from './schemas.js';
import type { Store } from './store.js';

export interface WorkerOptions {
  once?: boolean;
  buildOnly?: boolean;
  signal?: AbortSignal;
  onResult?: (job: Job) => void;
  onScan?: (scan: InboxScan) => void;
  step?: typeof executeStep;
  scan?: typeof scanInbox;
}

function sharedTooling(stage: Stage): boolean {
  return stage === 'verify' || stage === 'package';
}

function scanIdentity(scan: InboxScan): string {
  return JSON.stringify({
    error: scan.error,
    entries: scan.entries.map(entry => ({
      source: entry.source, digest: entry.digest, status: entry.status,
      jobId: entry.jobId, error: entry.error,
    })).sort((left, right) => left.source.localeCompare(right.source)),
  });
}

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

export async function runWorker(store: Store, config: Config, options: WorkerOptions = {}): Promise<void> {
  const step = options.step ?? executeStep;
  const scan = options.scan ?? scanInbox;
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  const active = new Map<string, { stage: Stage; completion: Promise<void> }>();
  const activeIds = new Set<string>();
  const served = new Set<string>();
  const limit = options.once ? 1 : config.maxConcurrentJobs;
  let dispatched = 0;
  let nextScanAt = 0;
  let lastScan: string | undefined;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;

  const assertBuildOnly = (): void => {
    if (!options.buildOnly) return;
    if (config.allowSubmit || config.allowRelease) {
      throw new Error('--build-only refuses configurations with upload or release enabled');
    }
    if (store.list().some(job => ['queued', 'waiting', 'running', 'blocked'].includes(job.status) && (job.config.allowSubmit || job.config.allowRelease))) {
      throw new Error('--build-only refuses a queue containing work with publication permission');
    }
  };

  const wait = (delay: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      if (wake === finish) wake = undefined;
      resolve();
    };
    const timer = setTimeout(finish, delay);
    wake = finish;
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
    return promise;
  };

  const canClaim = (job: Job): boolean => {
    if (options.buildOnly && (job.config.allowSubmit || job.config.allowRelease)) {
      throw new Error(`--build-only refuses task ${job.id} with snapshotted publication permission`);
    }
    if (signal.aborted || activeIds.has(job.id) || served.has(job.id)) return false;
    if (!sharedTooling(job.stage)) return true;
    for (const entry of active.values()) {
      if (sharedTooling(entry.stage)) return false;
    }
    return !store.list().some(other => other.id !== job.id && sharedTooling(other.recoveryStage ?? other.stage) && other.groups.some(processGroupAlive));
  };

  const launch = (job: Job): void => {
    activeIds.add(job.id);
    served.add(job.id);
    dispatched++;
    const completion = Promise.resolve().then(async () => {
      let result: Job;
      try {
        if (signal.aborted) {
          result = store.update(job.id, { status: 'waiting', nextAt: Date.now(), error: 'Worker was interrupted before this stage started' });
        } else {
          result = await step(store, job, { signal });
        }
      } catch (error) {
        // Keep command ownership and its original resource phase available for recovery.
        result = store.update(job.id, {
          stage: job.stage, status: 'blocked', blockedReason: null,
          error: `Stage ${job.stage} stopped unexpectedly: ${toError(error).message}`,
        });
      }
      options.onResult?.(result);
    }).catch(error => {
      failure ??= toError(error);
      stop.abort();
    }).finally(() => {
      active.delete(job.id);
      activeIds.delete(job.id);
      wake?.();
    });
    active.set(job.id, { stage: job.stage, completion });
  };

  assertBuildOnly();
  store.acquire();
  try {
    while (!signal.aborted) {
      assertBuildOnly();
      if (Date.now() >= nextScanAt) {
        let result: InboxScan;
        try { result = await scan(store, config, { signal }); }
        catch (error) { result = { entries: [], error: toError(error).message, observed: false }; }
        nextScanAt = !options.once && config.inbox ? Date.now() + config.inbox.pollMs : Infinity;
        if (options.onScan) {
          const identity = scanIdentity(result);
          if (identity !== lastScan) {
            lastScan = identity;
            options.onScan(result);
          }
        }
      }
      if (signal.aborted) break;
      while (active.size < limit && !signal.aborted && (!options.once || dispatched === 0)) {
        assertBuildOnly();
        let job = store.next(canClaim, activeIds);
        if (!job && served.size) {
          served.clear();
          assertBuildOnly();
          job = store.next(canClaim, activeIds);
        }
        if (!job) break;
        launch(job);
      }
      if (options.once && (dispatched > 0 || !store.list().some(job => ['queued', 'waiting'].includes(job.status) && job.groups.length > 0))) break;
      const now = Date.now();
      let delay = Math.min(1000, Math.max(1, nextScanAt - now));
      if (active.size < limit) {
        for (const job of store.list()) {
          const due = ['queued', 'waiting'].includes(job.status) || (job.status === 'blocked' && job.blockedReason?.kind === 'prerequisite');
          if (due && !activeIds.has(job.id) && job.nextAt > now) delay = Math.min(delay, job.nextAt - now);
        }
      }
      await wait(delay);
    }
  } catch (error) {
    failure ??= toError(error);
    stop.abort();
  } finally {
    // Persisted groups can belong to a prior worker and never enter this worker's active map.
    await Promise.all([...active.values()].map(entry => entry.completion));
    try { await drainCommandGroups(store); }
    catch (error) { failure ??= toError(error); }
    finally { store.release(); }
  }
  if (failure) throw failure;
}
