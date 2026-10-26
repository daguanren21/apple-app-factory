import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectProcessGroup, signalOwnedProcessGroup, TERMINATION_GRACE_MS } from './process.js';
import { ConfigSchema, JobSchema, SpecSchema, InboxEntrySchema, toError, type CommandMetadata, type Job, type Spec, type Config, type InboxEntry } from './schemas.js';

function parseStoredJob(data: unknown): Job {
  if (typeof data !== 'string') throw new Error('Stored task data must be JSON text');
  return JobSchema.parse(JSON.parse(data));
}

export class Store {
  readonly db: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'queue.sqlite'));
    chmodSync(join(directory, 'queue.sqlite'), 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, product TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, next_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(product, version));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, job TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (source TEXT PRIMARY KEY, digest TEXT, data TEXT NOT NULL);`);
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > 2) { this.db.close(); throw new Error(`Queue schema ${version} is newer than this factory supports; use the version that created it. No task data was changed.`); }
    if (version < 2) {
      try {
        this.transaction(() => {
          const owner = this.db.prepare('SELECT pid FROM worker WHERE id=1').get();
          if (owner) {
            if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 1) throw new Error('Legacy queue has invalid execution ownership; inspect it with the previous factory version');
            let alive = true;
            try { process.kill(owner.pid, 0); } catch (cause) { alive = toError(cause).code !== 'ESRCH'; }
            if (alive) throw new Error(`Stop the previous factory execution (${owner.pid}) before migrating its queue; no process was signaled`);
          }
          this.db.exec('CREATE TABLE IF NOT EXISTS snapshot_migrations (job TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job,version));');
          for (const row of this.db.prepare('SELECT id,data FROM jobs').all()) {
            if (typeof row.data !== 'string') throw new Error('Stored task data must be JSON text');
            const saved = JSON.parse(row.data);
            this.db.prepare('INSERT OR IGNORE INTO snapshot_migrations VALUES(?,?,?)').run(row.id, version, row.data);
            if (saved.requestSpec === undefined) {
              const changed = this.db.prepare("SELECT 1 FROM events WHERE job=? AND json_type(data,'$.spec') IS NOT NULL LIMIT 1").get(row.id);
              saved.requestSpec = changed ? null : saved.spec;
              saved.requestSpecError = changed ? 'Original intake identity cannot be proven after legacy requirement edits; use reconcile-intake with the original requirements' : null;
            }
            const config = saved.config;
            config.executionEnv ??= config.agentEnv ?? [];
            config.maxHostTurns ??= config.maxAgentCalls ?? 16;
            for (const key of ['builder', 'reviewer', 'researcher', 'agentEnv', 'maxAgentCalls', 'maxConcurrentJobs']) delete config[key];
            saved.hostTurns ??= saved.agentCalls ?? 0;
            delete saved.agentCalls;
            const job = JobSchema.parse(saved);
            this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id);
          }
          this.db.exec('PRAGMA user_version=2;');
        });
      } catch (cause) {
        this.db.close();
        throw new Error(`Cannot migrate saved factory snapshots: ${toError(cause).message}. No migration was committed. Preserve queue.sqlite and use the previous factory version to inspect or repair unsupported data.`);
      }
    }
  }
  close(): void { this.db.close(); }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  list(): Job[] { return this.db.prepare('SELECT data FROM jobs ORDER BY rowid').all().map(row => parseStoredJob(row.data)); }
  get(id: string): Job {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id);
    if (!row) throw new Error(`Unknown task ${id}; use status to list task IDs`);
    return parseStoredJob(row.data);
  }
  enqueue(specValue: unknown, configValue: unknown, baseJobId?: string): Job {
    const spec = SpecSchema.parse(specValue);
    const config = ConfigSchema.parse(configValue);
    return this.transaction(() => this.insertJob(spec, config, baseJobId));
  }
  checkIngest(specValue: unknown, baseJobId?: string, pending: ReadonlyArray<{ spec: Spec; baseJobId?: string }> = []): Job | undefined {
    const spec = SpecSchema.parse(specValue);
    const row = this.db.prepare('SELECT data FROM jobs WHERE product=? AND version=?').get(spec.id, spec.apple?.version ?? '1.0.0');
    const existing = row ? parseStoredJob(row.data) : undefined;
    if (existing?.requestSpec === null) throw new Error(existing.requestSpecError ?? 'Original intake identity is unknown; use reconcile-intake with the original requirements');
    const prospective = pending.find(item => item.spec.id === spec.id && (item.spec.apple?.version ?? '1.0.0') === (spec.apple?.version ?? '1.0.0'));
    const original = existing?.requestSpec ? { spec: existing.requestSpec, baseJobId: existing.baseJobId } : undefined;
    for (const candidate of [original, prospective]) {
      if (candidate && (JSON.stringify(candidate.spec) !== JSON.stringify(spec) || candidate.baseJobId !== baseJobId)) throw new Error(`${spec.id} already has immutable requirements for this version; submit a new apple.version instead of editing its task`);
    }
    if (existing) return existing;
    const signature = (value: { purpose: string; audience: string }): string => `${value.purpose.trim().toLowerCase()}\n${value.audience.trim().toLowerCase()}`;
    const duplicates = (job: { spec: Spec }): boolean => job.spec.id !== spec.id && signature(job.spec) === signature(spec);
    const duplicate = this.list().find(duplicates) ?? pending.find(duplicates);
    if (duplicate) throw new Error(`Product purpose and audience duplicate ${duplicate.spec.id}; differentiate actual utility, not names or code`);
    const base = baseJobId === undefined ? undefined : this.get(baseJobId);
    if (base && (base.spec.id !== spec.id || !['built', 'ready', 'approved', 'released'].includes(base.status) || !base.verifiedDigest || base.groups.length)) {
      throw new Error('baseJobId must identify a finished, verified task of the same product with no live command groups');
    }
    return undefined;
  }
  private insertJob(spec: Spec, config: Config, baseJobId?: string): Job {
    if (this.checkIngest(spec, baseJobId)) throw new Error(`${spec.id} ${spec.apple?.version ?? '1.0.0'} is already queued; retry its task or use a new product version`);
    const version = spec.apple?.version ?? '1.0.0';
    const base = baseJobId === undefined ? undefined : this.get(baseJobId);
    const now = Date.now();
    const id = randomUUID();
    const job = JobSchema.parse({ id, spec, requestSpec: spec, config, ...(base ? { baseJobId: base.id, baseDigest: base.verifiedDigest } : {}), stage: 'research', status: 'queued', blockedReason: null, manualRecovery: null, createdAt: now, updatedAt: now, nextAt: now, attempts: {}, hostTurns: 0, turn: null, groups: [], commands: {}, receipt: {}, logs: [], workspace: join(config.workspaceRoot, id) });
    this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run(id, spec.id, version, job.status, now, JSON.stringify(job));
    this.event(id, { stage: job.stage, status: job.status, baseJobId });
    return job;
  }
  inboxEntries(): InboxEntry[] {
    return this.db.prepare('SELECT data FROM inbox ORDER BY source').all().map(row => {
      if (typeof row.data !== 'string') throw new Error('Stored inbox data must be JSON text');
      return InboxEntrySchema.parse(JSON.parse(row.data));
    });
  }
  private saveInbox(entry: InboxEntry): InboxEntry {
    this.db.prepare('INSERT INTO inbox VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET digest=excluded.digest,data=excluded.data').run(entry.source, entry.digest, JSON.stringify(entry));
    return entry;
  }
  inboxError(source: string, digest: string | null, error: string): InboxEntry {
    const previous = this.inboxEntries().find(entry => entry.source === source);
    if (previous?.status === 'error' && previous.digest === digest && previous.error === error) return previous;
    return this.saveInbox(InboxEntrySchema.parse({ source, digest, status: 'error', jobId: previous?.jobId ?? null, error, observedAt: Date.now() }));
  }
  ingest(source: string, digest: string, specValue: unknown, configValue: unknown, baseJobId?: string): InboxEntry {
    const spec = SpecSchema.parse(specValue);
    const config = ConfigSchema.parse(configValue);
    return this.transaction(() => {
      const job = this.checkIngest(spec, baseJobId) ?? this.insertJob(spec, config, baseJobId);
      return this.saveInbox(InboxEntrySchema.parse({ source, digest, status: 'accepted', jobId: job.id, error: null, observedAt: Date.now() }));
    });
  }
  event(id: string, data: Record<string, unknown>): void { this.db.prepare('INSERT INTO events(job,at,data) VALUES (?,?,?)').run(id, Date.now(), JSON.stringify(data)); }
  update(id: string, patch: Partial<Job>): Job {
    return this.transition(id, () => patch);
  }
  transition(id: string, change: (current: Job) => Partial<Job>): Job {
    return this.transaction(() => {
      const current = this.get(id);
      return this.saveJob(current, change(current));
    });
  }
  private saveJob(current: Job, patch: Partial<Job>, reconcileIntake = false): Job {
    const job = JobSchema.parse({ ...current, ...patch, updatedAt: Date.now() });
    if (!reconcileIntake && patch.requestSpec !== undefined && JSON.stringify(job.requestSpec) !== JSON.stringify(current.requestSpec)) throw new Error('Original intake requirements cannot be changed by task updates');
    this.db.prepare('UPDATE jobs SET status=?,next_at=?,data=? WHERE id=?').run(job.status, job.nextAt, JSON.stringify(job), job.id);
    this.event(job.id, patch);
    return job;
  }
  reconcileIntake(id: string, specValue: unknown, baseJobId?: string): Job {
    const spec = SpecSchema.parse(specValue);
    return this.transaction(() => {
      const current = this.get(id);
      if (current.requestSpec !== null) throw new Error('This task already has a known intake identity; it cannot be replaced');
      if (spec.id !== current.spec.id || (spec.apple?.version ?? '1.0.0') !== (current.spec.apple?.version ?? '1.0.0') || baseJobId !== current.baseJobId) throw new Error('Original requirements must match this task product, version and predecessor');
      return this.saveJob(current, { requestSpec: spec, requestSpecError: null }, true);
    });
  }
  acquire(): void {
    const jobs = this.transaction(() => {
      const jobs = this.list();
      const owner = this.db.prepare('SELECT pid FROM worker WHERE id=1').get();
      if (owner) {
        if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 1) throw new Error('Stored worker PID must be a valid process ID');
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) { alive = toError(error).code !== 'ESRCH'; }
        if (alive) throw new Error(`Execution ${owner.pid} already owns this queue; wait for its command to finish`);
      }
      this.db.prepare('INSERT OR REPLACE INTO worker VALUES(1,?)').run(process.pid);
      return jobs;
    });
    for (const job of jobs) {
      if (job.status === 'running' && !job.turn) this.update(job.id, { status: 'waiting', blockedReason: null, nextAt: Date.now(), error: 'Execution stopped during a deterministic stage; recover its command groups before resuming' });
    }
  }
  release(): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM worker WHERE id=1 AND pid=?').run(process.pid);
    });
  }
  next(canClaim: (job: Job) => boolean = () => true, excludeIds: ReadonlySet<string> = new Set()): Job | undefined {
    const now = Date.now();
    const rows = this.db.prepare("SELECT data FROM jobs WHERE (status IN ('queued','waiting') OR (status='blocked' AND json_extract(data,'$.blockedReason.kind')='prerequisite')) AND next_at<=? ORDER BY next_at,rowid").all(now);
    const jobs = rows.map(row => parseStoredJob(row.data));
    for (const job of jobs) {
      if (excludeIds.has(job.id)) continue;
      const groups: number[] = [], commands: Record<string, CommandMetadata> = {};
      let manualRecovery = job.manualRecovery ?? null, pending = false, nextAt = Infinity;
      for (const pid of job.groups) {
        const command = job.commands[pid];
        const ownership = inspectProcessGroup(pid, command?.identity);
        if (ownership === 'gone') continue;
        groups.push(pid);
        const saved = command ? { ...command } : undefined;
        if (saved) commands[pid] = saved;
        if (ownership !== 'owned' || !saved || !Number.isFinite(saved.deadline)) {
          manualRecovery ??= `Command group ${pid} has ${ownership === 'mismatch' ? 'a different process identity' : 'no verifiable ownership and deadline'}. It was not signaled. Inspect this task's recorded command ownership before retrying.`;
          continue;
        }
        try {
          if (!saved.termAt && now < saved.deadline) {
            nextAt = Math.min(nextAt, saved.deadline, now + job.config.pollMs);
          } else if (!saved.termAt) {
            signalOwnedProcessGroup(pid, saved.identity, 'SIGTERM');
            saved.termAt = Date.now();
            nextAt = Math.min(nextAt, saved.termAt + TERMINATION_GRACE_MS);
          } else if (now < saved.termAt + TERMINATION_GRACE_MS) {
            nextAt = Math.min(nextAt, saved.termAt + TERMINATION_GRACE_MS);
          } else if (!saved.killAt) {
            signalOwnedProcessGroup(pid, saved.identity, 'SIGKILL');
            saved.killAt = Date.now();
            nextAt = Math.min(nextAt, saved.killAt + TERMINATION_GRACE_MS);
          } else if (now < saved.killAt + TERMINATION_GRACE_MS) {
            nextAt = Math.min(nextAt, saved.killAt + TERMINATION_GRACE_MS);
          } else {
            manualRecovery ??= `Command group ${pid} is still active after SIGKILL. No replay is allowed. Inspect and stop the recorded group, then retry this task.`;
            continue;
          }
          pending = true;
        } catch (error) { manualRecovery ??= toError(error).message; }
      }
      if (!groups.length && manualRecovery === null) {
        if (job.groups.length) this.update(job.id, { groups: [], commands: {}, recoveryStage: undefined });
        const claimed = this.transaction(() => {
          const current = this.get(job.id);
          const eligible = current.status === 'queued' || current.status === 'waiting' || (current.status === 'blocked' && current.blockedReason?.kind === 'prerequisite');
          if (!eligible || current.turn || current.nextAt > Date.now() || current.groups.length || current.manualRecovery != null || !canClaim(current)) return undefined;
          return this.saveJob(current, { status: 'running', blockedReason: null, manualRecovery: null, groups: [], commands: {}, recoveryStage: undefined });
        });
        if (claimed) return claimed;
        continue;
      }
      if (pending) {
        this.update(job.id, { status: 'waiting', blockedReason: null, manualRecovery, groups, commands, nextAt, error: manualRecovery ?? 'Recovering an owned command group; waiting for its deadline and TERM-to-KILL cleanup before replay' });
      } else {
        this.update(job.id, { status: 'blocked', blockedReason: null, manualRecovery, groups, commands, error: manualRecovery });
      }
    }
    return undefined;
  }
  events(id: string) {
    this.get(id);
    return this.db.prepare('SELECT seq,at,data FROM events WHERE job=? ORDER BY seq').all(id).map(row => {
      if (typeof row.data !== 'string') throw new Error('Stored event data must be JSON text');
      const data: unknown = JSON.parse(row.data);
      return { ...row, data };
    });
  }
}
