import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { inspectProcess, processIsAlive, inspectProcessGroup, signalOwnedProcessGroup, TERMINATION_GRACE_MS } from '../execution/process.js';
import { canonicalPath, normalizeIsolationPaths, validateProjectSource, validateProjectContext } from '../configuration/config.js';
import { assertPinnedProjectRoots, projectDirectory, sourceDigest } from '../projects/workspace.js';
import { dependencyDigest } from '../projects/dependencies.js';
import { ConfigSchema, JobSchema, SpecSchema, InboxEntrySchema, validateJobConfig, toError, type CommandMetadata, type Job, type Spec, type Config, type InboxEntry } from '../contracts/schemas.js';
import { activeWorkflowNodes } from '../workflow/graph.js';
import { migrateNotifications } from './notification-migrations.js';

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

function activeProjectWork(job: Job): boolean {
  return Boolean(job.turn || activeWorkflowNodes(job).length || job.groups.length || job.manualRecovery || job.status === 'running');
}

function privateExecution(job: Job): boolean {
  return job.config.projectMode === 'isolated' || job.workspace !== job.projectRoot;
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

const MigrationOwnershipSchema = z.object({
  turn: z.unknown().optional(), groups: z.array(z.number()).optional(), manualRecovery: z.unknown().optional(),
  workflow: z.object({ phases: z.record(z.string(), z.object({ nodes: z.array(z.object({ turn: z.unknown().optional() })).optional() })) }).optional(),
});

function migrateProjectContext(saved: Record<string, unknown>): void {
  const config = z.record(z.string(), z.unknown()).parse(saved.config);
  saved.projectRoot ??= saved.workspace;
  config.projectMode ??= 'isolated';
  config.projectRoot ??= canonicalPath(z.string().min(1).parse(saved.projectRoot));
  saved.config = config;
  migrateNotifications(saved);
}

export class Store {
  readonly db: DatabaseSync;
  readonly directory: string;
  private workerClaim?: { identity: string; token: string };
  private inTransaction = false;

  constructor(directory: string) {
    this.directory = canonicalPath(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.directory, 'queue.sqlite'));
    chmodSync(join(this.directory, 'queue.sqlite'), 0o600);
    this.db.exec('PRAGMA busy_timeout=5000;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > 4) { this.db.close(); throw new Error(`Queue schema ${version} is newer than this factory supports; use the version that created it. No task data was changed.`); }
    this.db.exec('PRAGMA journal_mode=WAL;');
    if (version < 3) {
      try {
        this.transaction(() => {
          const lockedVersion = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
          if (lockedVersion > 4) throw new Error(`Queue schema ${lockedVersion} is newer than this factory supports; use the version that created it. No task data was changed.`);
          if (lockedVersion >= 3) return;
          this.db.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, job TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS worker (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS inbox (source TEXT PRIMARY KEY, digest TEXT, data TEXT NOT NULL);`);
          const owner = this.db.prepare('SELECT pid FROM worker WHERE id=1').get();
          if (owner) {
            if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 1 || owner.pid > 2147483647) throw new Error('Legacy queue has invalid execution ownership; inspect it with the previous factory version');
            if (processIsAlive(owner.pid)) throw new Error(`Stop the previous factory execution (${owner.pid}) before migrating its queue; no process was signaled`);
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
            migrateProjectContext(saved);
            const job = JobSchema.parse(saved);
            validateJobConfig(job.spec, job.config);
            if (job.id !== row.id) throw new Error('Stored task ID does not match its queue row');
            this.db.prepare('INSERT INTO jobs_v3 VALUES(?,?,?,?,?,?,?,?)').run(job.id, job.spec.id, job.spec.platform, job.spec.channel, job.spec.version, job.status, job.nextAt, JSON.stringify(job));
          }
          if (hasJobs) this.db.exec('DROP TABLE jobs;');
          this.db.exec('ALTER TABLE jobs_v3 RENAME TO jobs; PRAGMA user_version=4;');
        });
      } catch (cause) {
        this.db.close();
        throw new Error(`Cannot migrate saved factory snapshots: ${toError(cause).message}. No migration was committed. Preserve queue.sqlite and use the previous factory version to inspect or repair unsupported data.`);
      }
    }
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < 4) {
      try {
        this.transaction(() => {
          const lockedVersion = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
          if (lockedVersion > 4) throw new Error(`Queue schema ${lockedVersion} is newer than this factory supports`);
          if (lockedVersion === 4) return;
          const owner = this.db.prepare('SELECT pid FROM worker WHERE id=1').get();
          if (owner && (typeof owner.pid !== 'number' || processIsAlive(owner.pid))) throw new Error('Stop the previous factory worker before migrating its project contexts; no process was signaled');
          this.db.exec('CREATE TABLE IF NOT EXISTS snapshot_migrations (job TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job,version));');
          for (const row of this.db.prepare('SELECT id,data FROM jobs ORDER BY rowid').all()) {
            if (typeof row.data !== 'string') throw new Error('Stored task data must be JSON text');
            const saved = z.record(z.string(), z.unknown()).parse(JSON.parse(row.data));
            const ownership = MigrationOwnershipSchema.parse(saved);
            const activeNodes = Object.values(ownership.workflow?.phases ?? {}).some(phase => phase.nodes?.some(node => node.turn));
            if (ownership.turn || activeNodes || ownership.groups?.length || ownership.manualRecovery) throw new Error(`Finish or abandon active work for task ${row.id} with the previous factory version before migrating; no claim or process was changed`);
            this.db.prepare('INSERT OR IGNORE INTO snapshot_migrations VALUES(?,?,?)').run(row.id, lockedVersion, row.data);
            migrateProjectContext(saved);
            const job = JobSchema.parse(saved);
            if (job.id !== row.id) throw new Error('Stored task ID does not match its queue row');
            this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), row.id);
          }
          this.db.exec('PRAGMA user_version=4;');
        });
      } catch (cause) {
        this.db.close();
        throw new Error(`Cannot migrate saved project contexts: ${toError(cause).message}. No context migration was committed. Preserve queue.sqlite and use the previous factory version to finish active work.`);
      }
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS worker_identity (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, claim TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS worker_identity_insert BEFORE INSERT ON worker BEGIN DELETE FROM worker_identity WHERE id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS worker_identity_update BEFORE UPDATE ON worker BEGIN DELETE FROM worker_identity WHERE id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS worker_identity_delete AFTER DELETE ON worker BEGIN DELETE FROM worker_identity WHERE id=OLD.id; END;`);
  }
  close(): void { this.db.close(); }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
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
    if (base && (base.spec.id !== spec.id || base.spec.platform !== spec.platform || base.spec.channel !== spec.channel || base.spec.framework !== spec.framework || !['built', 'ready'].includes(base.status) || !base.verifiedDigest || !base.verifiedDependencyDigest || base.turn || activeWorkflowNodes(base).length || base.groups.length || base.manualRecovery)) {
      throw new Error('baseJobId must identify a finished, verified task of the same product, platform, channel and framework with no active work');
    }
    if (base) this.predecessorSpec(spec, base);
    if (base?.config.projectMode === 'isolated') {
      if (sourceDigest(base.workspace, true, base.spec.framework, base.spec.project?.directory) !== base.verifiedDigest) throw new Error('baseJobId source changed after verification; verify the predecessor again before creating a successor');
      if (dependencyDigest(base.workspace, base.spec.framework, base.spec.project?.directory) !== base.verifiedDependencyDigest) throw new Error('baseJobId dependency resolution changed after verification; verify the predecessor again before creating a successor');
    }
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
    config.projectRoot = canonicalPath(resolve(root, config.projectRoot ?? '.'));
    if (overlaps(config.stateDir, config.workspaceRoot) || overlaps(this.directory, config.workspaceRoot)) throw new Error('stateDir and workspaceRoot must not overlap in either direction');
    normalizeIsolationPaths(config);
    return config;
  }
  private insertJob(spec: Spec, config: Config, baseJobId?: string): Job {
    if (this.checkIngest(spec, baseJobId)) throw new Error(`${spec.id} ${spec.platform} ${spec.channel} ${spec.version} is already queued; retry its task or use a new product version`);
    const base = this.selectBase(spec, baseJobId);
    if (base && base.config.projectMode !== config.projectMode) throw new Error('Successors must retain their predecessor project mode; explicitly select a source revision instead of silently switching live and isolated ownership');
    const effectiveSpec = base ? this.predecessorSpec(spec, base) : spec;
    const sourceDirectory = validateProjectSource(spec, config);
    let importDigest: string | undefined;
    if (sourceDirectory) {
      if (overlaps(this.directory, sourceDirectory)) throw new Error('project.sourceDir must not overlap the queue directory in either direction');
      importDigest = sourceDigest(sourceDirectory, true, spec.framework, spec.project?.directory);
    }
    const now = Date.now();
    const id = randomUUID();
    const projectRoot = config.projectMode === 'isolated' ? join(config.workspaceRoot, id) : config.projectRoot!;
    const workspace = config.projectMode === 'isolated' || config.obfuscation ? join(config.workspaceRoot, id) : projectRoot;
    if (config.projectMode === 'project') {
      validateProjectContext(config, workspace === projectRoot ? undefined : workspace);
      if (base && base.projectRoot !== projectRoot) throw new Error('A project-context successor must use its predecessor project root; select that project explicitly instead of copying over another project');
    }
    const job = JobSchema.parse({ id, spec: effectiveSpec, requestSpec: spec, config, ...(base ? { baseJobId: base.id, baseDigest: base.verifiedDigest, ...(config.projectMode === 'project' ? { basePrepared: true } : {}), ...(baseJobId === undefined ? { automaticBase: true } : {}) } : {}), ...(sourceDirectory ? { sourceDirectory, importDigest, importPrepared: false } : {}), stage: 'research', status: 'queued', blockedReason: null, manualRecovery: null, createdAt: now, updatedAt: now, nextAt: now, attempts: {}, hostTurns: 0, turn: null, groups: [], commands: {}, receipt: {}, logs: [], workspace, projectRoot });
    assertPinnedProjectRoots(job);
    if (this.projectOwnershipConflict(job, true)) throw new Error('Project ownership conflicts with another task execution or maintained live source; finish its work before adopting an execution root');
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
    if (Boolean(config.workflow) !== Boolean(current.config.workflow) && (current.hostTurns > 0 || current.workflow || current.stage !== 'research' || current.groups.length)) throw new Error('Workflow mode is frozen once a task has started; enqueue a new task instead of bypassing its work graph');
    if (current.config.uiQuality && !config.uiQuality && (current.hostTurns > 0 || current.stage !== 'research')) throw new Error('A started UI task cannot disable its platform evidence gate to bypass review');
    if (current.sourceDirectory && [config.stateDir, config.workspaceRoot].some(path => overlaps(path, current.sourceDirectory!))) throw new Error('Pinned project source must not overlap stateDir or workspaceRoot after reconfiguration');
    const job = JobSchema.parse({ ...current, ...patch, config, updatedAt: Date.now() });
    validateJobConfig(job.spec, job.config);
    if (job.id !== current.id || !sameIdentity(job.spec, current.spec) || job.spec.framework !== current.spec.framework) throw new Error('Task product, platform, channel, version and framework are immutable; enqueue a new task');
    if (job.workspace !== current.workspace || job.sourceDirectory !== current.sourceDirectory || job.importDigest !== current.importDigest || job.baseJobId !== current.baseJobId || job.baseDigest !== current.baseDigest || job.automaticBase !== current.automaticBase || JSON.stringify(job.spec.project) !== JSON.stringify(current.spec.project)) throw new Error('Pinned project source and workspace identity cannot be changed by task updates');
    if (job.projectRoot !== current.projectRoot || config.projectMode !== current.config.projectMode || config.projectRoot !== current.config.projectRoot) throw new Error('The selected project context is immutable; resume with its original root instead of retargeting an existing task');
    if (config.projectMode === 'project' && Boolean(config.obfuscation) !== Boolean(current.config.obfuscation)) throw new Error('Execution-copy ownership is frozen for this project task; enqueue an explicitly authorized new task to change obfuscation mode');
    if (JSON.stringify(config.notifications) !== JSON.stringify(current.config.notifications)) throw new Error('Notification destinations are frozen with the task; a configuration change cannot redirect an existing delivery');
    if (patch.config && config.projectMode === 'project') validateProjectContext(config, job.workspace === job.projectRoot ? undefined : job.workspace);
    // Revoking claims and recording recovery must remain possible after a root is broken.
    let claiming = job.status === 'running' && current.status !== 'running'
      || Boolean(job.turn && job.turn.id !== current.turn?.id)
      || job.groups.some(group => !current.groups.includes(group));
    if (!claiming && patch.workflow) {
      const previousTokens = new Set(activeWorkflowNodes(current).map(entry => entry.node.turn!.id));
      claiming = activeWorkflowNodes(job).some(entry => !previousTokens.has(entry.node.turn!.id));
    }
    if (claiming) this.assertProjectWrite(job);
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
  private projectOwnershipConflict(job: Job, admission = false): Job | undefined {
    const jobs = this.list();
    return jobs.find(other => {
      if (other.id === job.id) return false;
      // Once adopted as live source, an execution directory is never disposable again.
      if (privateExecution(job) && other.config.projectMode === 'project' && overlaps(job.workspace, other.projectRoot)) return true;
      if (admission && job.config.projectMode === 'project' && privateExecution(other) && overlaps(job.projectRoot, other.workspace)) {
        // Adoption remains authoritative even if the retired execution owner is requeued.
        const adopted = jobs.some(owner => owner.id !== other.id && owner.config.projectMode === 'project' && overlaps(owner.projectRoot, other.workspace));
        if (activeProjectWork(other) || !adopted && !(['built', 'ready', 'failed'].includes(other.status) || other.workflow?.cancelled)) return true;
      }
      // Normal sequential tasks may share live source, but not simultaneous claims.
      return !admission && activeProjectWork(other)
        && (overlaps(job.projectRoot, other.projectRoot) || overlaps(job.projectRoot, other.workspace)
          || overlaps(job.workspace, other.projectRoot) || overlaps(job.workspace, other.workspace));
    });
  }
  projectConflict(job: Job): Job | undefined {
    return this.projectOwnershipConflict(job);
  }
  private assertProjectWrite(job: Job): void {
    assertPinnedProjectRoots(job);
    if (job.config.projectMode === 'project') validateProjectContext(job.config, job.workspace === job.projectRoot ? undefined : job.workspace);
    if (this.projectConflict(job)) throw Object.assign(new Error('Project ownership conflicts with active work or an execution root adopted as maintained live source'), { code: 'SETUP_REQUIRED' });
  }
  /** Keep ownership checks and synchronous source side effects in the same queue transaction. */
  withProjectWrite<T>(id: string, action: (current: Job) => T): T {
    const write = (): T => {
      const current = this.get(id);
      this.assertProjectWrite(current);
      return action(current);
    };
    return this.inTransaction ? write() : this.transaction(write);
  }
  acquire(): void {
    const current = inspectProcess(process.pid);
    if (!current) throw new Error('Cannot inspect this worker process incarnation; queue ownership was not changed');
    const claim = { identity: current.identity, token: randomUUID() };
    const jobs = this.transaction(() => {
      const jobs = this.list();
      const owner = this.db.prepare('SELECT worker.pid, worker_identity.identity FROM worker LEFT JOIN worker_identity USING(id) WHERE worker.id=1').get();
      if (owner) {
        if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 1 || owner.pid > 2147483647) throw new Error('Stored worker PID must be a valid process ID');
        if (owner.identity !== null && (typeof owner.identity !== 'string' || !owner.identity)) throw new Error('Stored worker process incarnation is invalid; inspect queue ownership before retrying');
        if (processIsAlive(owner.pid, typeof owner.identity === 'string' ? owner.identity : undefined)) throw new Error(`Execution ${owner.pid} already owns this queue; wait for its command to finish`);
      }
      this.db.prepare('INSERT OR REPLACE INTO worker VALUES(1,?)').run(process.pid);
      this.db.prepare('INSERT INTO worker_identity VALUES(1,?,?)').run(claim.identity, claim.token);
      return jobs;
    });
    this.workerClaim = claim;
    for (const job of jobs) {
      if (job.status === 'running' && !job.turn && !activeWorkflowNodes(job).length) this.update(job.id, { status: 'waiting', blockedReason: null, nextAt: Date.now(), error: 'Execution stopped during a deterministic stage; recover its command groups before resuming' });
    }
  }
  release(): void {
    const claim = this.workerClaim;
    if (!claim) return;
    this.transaction(() => {
      this.db.prepare('DELETE FROM worker WHERE id=1 AND pid=? AND EXISTS (SELECT 1 FROM worker_identity WHERE id=1 AND identity=? AND claim=?)').run(process.pid, claim.identity, claim.token);
    });
    this.workerClaim = undefined;
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
          if (!eligible || current.workflow?.cancelled || current.turn || activeWorkflowNodes(current).length || current.nextAt > Date.now() || current.groups.length || current.manualRecovery != null || this.projectConflict(current) || !canClaim(current)) return undefined;
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
