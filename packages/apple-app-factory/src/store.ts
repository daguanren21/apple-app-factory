import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectProcessGroup, signalOwnedProcessGroup, TERMINATION_GRACE_MS } from './process.js';
import { canonicalPath, normalizeIsolationPaths, validateProjectSource } from './config.js';
import { projectDirectory, sourceDigest } from './workspace.js';
import { dependencyDigest } from './dependencies.js';
import { ConfigSchema, JobSchema, SpecSchema, InboxEntrySchema, validateJobConfig, toError, type CommandMetadata, type Job, type Spec, type Config, type InboxEntry } from './schemas.js';

function parseStoredJob(data: unknown): Job {
  if (typeof data !== 'string') throw new Error('Stored task data must be JSON text');
  return JobSchema.parse(JSON.parse(data));
}

function sameIdentity(left: Spec, right: Spec): boolean {
  return left.id === right.id && left.platform === right.platform && left.channel === right.channel && left.version === right.version;
}

function overlaps(left: string, right: string): boolean {
  const contains = (root: string, path: string): boolean => {
    const child = relative(root, path);
    return !child || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  };
  return contains(left, right) || contains(right, left);
}

function migrateSpec(value: unknown): Spec {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return SpecSchema.parse(value);
  const saved = { ...value } as Record<string, unknown>;
  const apple = saved.apple && typeof saved.apple === 'object' && !Array.isArray(saved.apple) ? { ...saved.apple } as Record<string, unknown> : undefined;
  if (saved.platform === undefined) {
    saved.framework = 'flutter';
    saved.platform = 'ios';
    saved.channel = 'app-store';
  }
  if (apple) {
    saved.version ??= apple.version;
    saved.screenshotsDir ??= apple.screenshotsDir;
    delete apple.version;
    delete apple.screenshotsDir;
    saved.apple = apple;
  }
  return SpecSchema.parse(saved);
}

export class Store {
  readonly db: DatabaseSync;
  readonly directory: string;

  constructor(directory: string) {
    this.directory = canonicalPath(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.directory, 'queue.sqlite'));
    chmodSync(join(this.directory, 'queue.sqlite'), 0o600);
    this.db.exec('PRAGMA busy_timeout=5000;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > 3) { this.db.close(); throw new Error(`Queue schema ${version} is newer than this factory supports; use the version that created it. No task data was changed.`); }
    this.db.exec('PRAGMA journal_mode=WAL;');
    if (version < 3) {
      try {
        this.transaction(() => {
          const lockedVersion = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
          if (lockedVersion > 3) throw new Error(`Queue schema ${lockedVersion} is newer than this factory supports; use the version that created it. No task data was changed.`);
          if (lockedVersion === 3) return;
          this.db.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, job TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS worker (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS inbox (source TEXT PRIMARY KEY, digest TEXT, data TEXT NOT NULL);`);
          const owner = this.db.prepare('SELECT pid FROM worker WHERE id=1').get();
          if (owner) {
            if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 1) throw new Error('Legacy queue has invalid execution ownership; inspect it with the previous factory version');
            let alive = true;
            try { process.kill(owner.pid, 0); } catch (cause) { alive = toError(cause).code !== 'ESRCH'; }
            if (alive) throw new Error(`Stop the previous factory execution (${owner.pid}) before migrating its queue; no process was signaled`);
          }
          this.db.exec('CREATE TABLE IF NOT EXISTS snapshot_migrations (job TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job,version));');
          const hasJobs = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get();
          const rows = hasJobs ? this.db.prepare('SELECT id,data FROM jobs ORDER BY rowid').all() : [];
          this.db.exec('CREATE TABLE jobs_v3 (id TEXT PRIMARY KEY, product TEXT NOT NULL, platform TEXT NOT NULL, channel TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, next_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(product,platform,channel,version));');
          for (const row of rows) {
            if (typeof row.data !== 'string') throw new Error('Stored task data must be JSON text');
            const saved = JSON.parse(row.data);
            if (saved.turn) throw new Error(`Abandon the active host turn for task ${row.id} with the previous factory version before migrating; no host turn was changed`);
            this.db.prepare('INSERT OR IGNORE INTO snapshot_migrations VALUES(?,?,?)').run(row.id, lockedVersion, row.data);
            if (saved.requestSpec === undefined) {
              const changed = this.db.prepare("SELECT 1 FROM events WHERE job=? AND json_type(data,'$.spec') IS NOT NULL LIMIT 1").get(row.id);
              saved.requestSpec = changed ? null : saved.spec;
              saved.requestSpecError = changed ? 'Original intake identity cannot be proven after legacy requirement edits; use reconcile-intake with the original requirements' : null;
            }
            saved.spec = migrateSpec(saved.spec);
            if (saved.requestSpec !== null) saved.requestSpec = migrateSpec(saved.requestSpec);
            const config = saved.config;
            config.executionEnv ??= config.agentEnv ?? [];
            config.maxHostTurns ??= config.maxAgentCalls ?? 16;
            config.packageTarget ??= saved.spec?.channel === 'google-play' ? 'aab' : 'simulator';
            for (const key of ['builder', 'reviewer', 'researcher', 'agentEnv', 'maxAgentCalls', 'maxConcurrentJobs', 'allowSubmit', 'allowRelease']) delete config[key];
            saved.hostTurns ??= saved.agentCalls ?? 0;
            delete saved.agentCalls;
            const advanced = ['review', 'package', 'publish', 'monitor'].includes(saved.stage) || ['built', 'ready', 'approved', 'released'].includes(saved.status);
            const published = saved.receipt && Object.keys(saved.receipt).length > 0;
            saved.verifiedDigest = null;
            saved.verifiedDependencyDigest = null;
            saved.screenshotDigest = null;
            delete saved.verifiedAt;
            saved.review = null;
            saved.artifact = null;
            if (!published) { saved.ipaPath = null; saved.archiveDigest = null; }
            if (published) {
              saved.stage = ['publish', 'monitor'].includes(saved.stage) ? 'package' : saved.stage;
              saved.status = 'blocked';
              saved.blockedReason = null;
              saved.error = 'Automatic store publication has been removed from this tool. Store submission and review are manual human work; legacy publication receipts are retained only as records and will not be replayed.';
            } else if (advanced) {
              saved.stage = 'verify';
              saved.status = 'blocked';
              saved.blockedReason = null;
              saved.error = 'Snapshot fingerprint contract changed; retry to run fresh verification and review before packaging';
            }
            const job = JobSchema.parse(saved);
            validateJobConfig(job.spec, job.config);
            if (job.id !== row.id) throw new Error('Stored task ID does not match its queue row');
            this.db.prepare('INSERT INTO jobs_v3 VALUES(?,?,?,?,?,?,?,?)').run(job.id, job.spec.id, job.spec.platform, job.spec.channel, job.spec.version, job.status, job.nextAt, JSON.stringify(job));
          }
          if (hasJobs) this.db.exec('DROP TABLE jobs;');
          this.db.exec('ALTER TABLE jobs_v3 RENAME TO jobs; PRAGMA user_version=3;');
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
    const config = this.snapshotConfig(configValue);
    validateJobConfig(spec, config);
    return this.transaction(() => this.insertJob(spec, config, baseJobId));
  }
  checkIngest(specValue: unknown, baseJobId?: string, pending: ReadonlyArray<{ spec: Spec; baseJobId?: string }> = []): Job | undefined {
    const spec = SpecSchema.parse(specValue);
    if (baseJobId && spec.project?.sourceDir) throw new Error('project.sourceDir and baseJobId are mutually exclusive');
    const row = this.db.prepare('SELECT data FROM jobs WHERE product=? AND platform=? AND channel=? AND version=?').get(spec.id, spec.platform, spec.channel, spec.version);
    const existing = row ? parseStoredJob(row.data) : undefined;
    if (existing?.requestSpec === null) throw new Error(existing.requestSpecError ?? 'Original intake identity is unknown; use reconcile-intake with the original requirements');
    const prospective = pending.find(item => sameIdentity(item.spec, spec));
    const original = existing?.requestSpec ? { spec: existing.requestSpec, baseJobId: existing.automaticBase ? undefined : existing.baseJobId } : undefined;
    for (const candidate of [original, prospective]) {
      if (candidate && (JSON.stringify(candidate.spec) !== JSON.stringify(spec) || candidate.baseJobId !== baseJobId)) throw new Error(`${spec.id} already has immutable requirements for this platform, channel and version; submit a new version instead of editing its task`);
    }
    if (existing || prospective) return existing;
    const base = this.selectBase(spec, baseJobId, pending);
    if (base && (base.spec.id !== spec.id || base.spec.platform !== spec.platform || base.spec.channel !== spec.channel || base.spec.framework !== spec.framework || !['built', 'ready'].includes(base.status) || !base.verifiedDigest || !base.verifiedDependencyDigest || base.turn || base.groups.length || base.manualRecovery)) {
      throw new Error('baseJobId must identify a finished, verified task of the same product, platform, channel and framework with no active work');
    }
    if (base) this.predecessorSpec(spec, base);
    if (base && sourceDigest(base.workspace, true, base.spec.framework, base.spec.project?.directory) !== base.verifiedDigest) throw new Error('baseJobId source changed after verification; verify the predecessor again before creating a successor');
    if (base && dependencyDigest(base.workspace, base.spec.framework, base.spec.project?.directory) !== base.verifiedDependencyDigest) throw new Error('baseJobId dependency resolution changed after verification; verify the predecessor again before creating a successor');
    return undefined;
  }
  private selectBase(spec: Spec, baseJobId?: string, pending: ReadonlyArray<{ spec: Spec; baseJobId?: string }> = []): Job | undefined {
    if (baseJobId !== undefined) return this.get(baseJobId);
    if (spec.platform !== 'ios' || spec.channel !== 'app-store' || spec.project?.sourceDir) return undefined;
    const row = this.db.prepare("SELECT data FROM jobs WHERE product=? AND platform=? AND channel=? AND status IN ('built','ready') ORDER BY rowid DESC LIMIT 1").get(spec.id, spec.platform, spec.channel);
    if (row) return parseStoredJob(row.data);
    const history = this.db.prepare('SELECT 1 FROM jobs WHERE product=? AND platform=? AND channel=? LIMIT 1').get(spec.id, spec.platform, spec.channel);
    if (history || pending.some(item => item.spec.id === spec.id && item.spec.platform === spec.platform && item.spec.channel === spec.channel && !sameIdentity(item.spec, spec))) throw new Error('Previous App Store versions exist but none is finished and verified; finish or explicitly import the existing application before creating a successor');
    return undefined;
  }

  private predecessorSpec(spec: Spec, base: Job): Spec {
    if (spec.platform !== 'ios' || spec.channel !== 'app-store') return spec;
    const directory = base.spec.project?.directory ?? '.';
    if (spec.project && spec.project.directory !== directory) throw new Error('project.directory must preserve the predecessor project directory');
    return SpecSchema.parse({ ...spec, ...(base.spec.project || spec.project ? { project: { directory } } : {}) });
  }
  private snapshotConfig(value: unknown): Config {
    const config = ConfigSchema.parse(value);
    const root = config.configPath ? dirname(resolve(config.configPath)) : process.cwd();
    config.stateDir = canonicalPath(resolve(root, config.stateDir));
    config.workspaceRoot = canonicalPath(resolve(root, config.workspaceRoot));
    if (overlaps(config.stateDir, config.workspaceRoot) || overlaps(this.directory, config.workspaceRoot)) throw new Error('stateDir and workspaceRoot must not overlap in either direction');
    normalizeIsolationPaths(config);
    return config;
  }
  private insertJob(spec: Spec, config: Config, baseJobId?: string): Job {
    if (this.checkIngest(spec, baseJobId)) throw new Error(`${spec.id} ${spec.platform} ${spec.channel} ${spec.version} is already queued; retry its task or use a new product version`);
    const base = this.selectBase(spec, baseJobId);
    const effectiveSpec = base ? this.predecessorSpec(spec, base) : spec;
    const sourceDirectory = validateProjectSource(spec, config);
    let importDigest: string | undefined;
    if (sourceDirectory) {
      if (overlaps(this.directory, sourceDirectory)) throw new Error('project.sourceDir must not overlap the queue directory in either direction');
      importDigest = sourceDigest(sourceDirectory, true, spec.framework, spec.project?.directory);
    }
    const now = Date.now();
    const id = randomUUID();
    const job = JobSchema.parse({ id, spec: effectiveSpec, requestSpec: spec, config, ...(base ? { baseJobId: base.id, baseDigest: base.verifiedDigest, ...(baseJobId === undefined ? { automaticBase: true } : {}) } : {}), ...(sourceDirectory ? { sourceDirectory, importDigest, importPrepared: false } : {}), stage: 'research', status: 'queued', blockedReason: null, manualRecovery: null, createdAt: now, updatedAt: now, nextAt: now, attempts: {}, hostTurns: 0, turn: null, groups: [], commands: {}, receipt: {}, logs: [], workspace: join(config.workspaceRoot, id) });
    projectDirectory(job);
    this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)').run(id, spec.id, spec.platform, spec.channel, spec.version, job.status, now, JSON.stringify(job));
    this.event(id, { stage: job.stage, status: job.status, baseJobId: job.baseJobId });
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
    const config = this.snapshotConfig(configValue);
    validateJobConfig(spec, config);
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
    const config = patch.config ? this.snapshotConfig(patch.config) : current.config;
    if (current.sourceDirectory && [config.stateDir, config.workspaceRoot].some(path => overlaps(path, current.sourceDirectory!))) throw new Error('Pinned project source must not overlap stateDir or workspaceRoot after reconfiguration');
    const job = JobSchema.parse({ ...current, ...patch, config, updatedAt: Date.now() });
    validateJobConfig(job.spec, job.config);
    if (job.id !== current.id || !sameIdentity(job.spec, current.spec) || job.spec.framework !== current.spec.framework) throw new Error('Task product, platform, channel, version and framework are immutable; enqueue a new task');
    if (job.workspace !== current.workspace || job.sourceDirectory !== current.sourceDirectory || job.importDigest !== current.importDigest || job.baseJobId !== current.baseJobId || job.baseDigest !== current.baseDigest || job.automaticBase !== current.automaticBase || JSON.stringify(job.spec.project) !== JSON.stringify(current.spec.project)) throw new Error('Pinned project source and workspace identity cannot be changed by task updates');
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
      if (!sameIdentity(spec, current.spec) || spec.framework !== current.spec.framework || baseJobId !== (current.automaticBase ? undefined : current.baseJobId)) throw new Error('Original requirements must match this task product, platform, channel, framework, version and predecessor');
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
