import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { nextTurn, completeTurn, abandonTurn, executeStep } from '../dist/runner.js';
import { runStep } from '../dist/scheduler.js';

const research = {
  viable: true,
  distinctness: 'A controlled lifecycle fixture, not an App Store compliance attestation.',
  risks: ['Content ownership still requires a human decision.'], plan: ['Implement and externally exercise the requested workflow.'],
};
function researchFor() { return { ...research, risks: [...research.risks], plan: [...research.plan] }; }
const spec = { id: 'host-fixture', name: 'Host fixture', purpose: 'Exercise native host transition safety', audience: 'Harness maintainers', framework: 'flutter', platform: 'ios', channel: 'app-store', version: '1.0.0', differentiators: ['Persisted typed turns'], acceptance: ['Real configured commands gate review'] };

function fixture(t, overrides = {}, product = spec) {
  const root = mkdtempSync(join(tmpdir(), 'factory-harness-'));
  const marker = join(root, 'executed');
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator', allowLocalExecution: true, retryDelayMs: 1,
    verification: { checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)},'runtime')`]] }, ...overrides });
  const stores = [];
  const open = () => { const store = new Store(config.stateDir); stores.push(store); return store; };
  const store = open();
  t.after(() => { for (const item of stores) item.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue(product, config);
  return { root, marker, config, store, job, open };
}

function reviewFor(job, patch = {}) {
  return { approved: true, findings: [], acceptanceEvidence: job.spec.acceptance.map(requirement => ({ requirement, evidence: 'Configured runtime command completed; see persisted execution log.' })), ...patch };
}

async function buildTurn(f) {
  const first = await nextTurn(f.store, f.job.id);
  completeTurn(f.store, f.job.id, first.turn.id, researchFor());
  const build = await nextTurn(f.store, f.job.id);
  writeFileSync(join(build.turn.cwd, 'pubspec.yaml'), 'name: host_fixture\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(build.turn.cwd, 'main.dart'), 'void main() {}\n');
  return build;
}

async function reviewTurn(f) {
  const build = await buildTurn(f);
  completeTurn(f.store, f.job.id, build.turn.id);
  const verified = await runStep(f.store, f.config, f.job.id);
  assert.equal(verified.stage, 'review');
  return nextTurn(f.store, f.job.id);
}

test('review seat receipts count duplicate names by appended entry, not timestamps', async t => {
  const f = fixture(t, { roles: { receipt: true, review: ['duplicate-seat', { name: 'duplicate-seat' }, 'qa-engineer'] } });
  const build = await buildTurn(f);
  completeTurn(f.store, f.job.id, build.turn.id);
  const verified = await runStep(f.store, f.config, f.job.id);
  assert.equal(verified.stage, 'review');

  // Commit a pre-claim receipt at the exact claim clock value. The persisted
  // decision cursor, rather than a wall-clock comparison, must reject it.
  const clock = Date.now();
  const originalNow = Date.now;
  let review;
  Date.now = () => clock;
  try {
    f.store.update(f.job.id, { decisions: [{ at: clock, stage: 'review', role: 'duplicate-seat', rationale: 'receipt committed before this review turn' }] });
    review = await nextTurn(f.store, f.job.id);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(review.turn.stage, 'review');
  assert.throws(() => completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job)),
    /Review seat receipts missing for: duplicate-seat, duplicate-seat, qa-engineer/);

  // One duplicate seat plus qa is still insufficient for the second seat.
  const current = f.store.get(f.job.id);
  const firstReceipts = ['duplicate-seat', 'qa-engineer'];
  f.store.update(f.job.id, { decisions: [...current.decisions, ...firstReceipts.map(role => ({ at: clock - 1000, stage: 'review', role, rationale: `${role} recorded after the turn claim` }))] });
  assert.throws(() => completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job)),
    /Review seat receipts missing for: duplicate-seat/);

  // The second duplicate is appended separately and now completes the multiset.
  const afterOne = f.store.get(f.job.id);
  f.store.update(f.job.id, { decisions: [...afterOne.decisions, { at: clock - 1000, stage: 'review', role: 'duplicate-seat', rationale: 'second duplicate seat recorded after the turn claim' }] });
  const approved = completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job));
  assert.equal(approved.stage, 'package');
  assert.equal(approved.status, 'queued');
});

test('legacy active review turns without a receipt cursor fail closed', async t => {
  const f = fixture(t, { roles: { receipt: true } });
  const review = await reviewTurn(f);
  const current = f.store.get(f.job.id);
  const { decisionsLengthAtClaim: _discarded, ...legacyTurn } = current.turn;
  f.store.update(f.job.id, { turn: legacyTurn });
  assert.throws(() => completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job)), /boundary.*abandon.*reclaim/);
});

test('host-native research/build/review persist while actual deterministic commands gate progress', async t => {
  const f = fixture(t);
  const first = await nextTurn(f.store, f.job.id);
  assert.equal(first.action, 'host');
  assert.equal(first.turn.stage, 'research');
  assert.equal(first.turn.cwd, f.job.workspace);
  assert.equal(existsSync(first.turn.cwd), true);
  assert.equal(first.job.hostTurns, 1);
  assert.deepEqual(first.job.commands, {});
  assert.equal(existsSync(f.marker), false);
  const resumed = await nextTurn(f.open(), f.job.id);
  assert.equal(resumed.turn.id, first.turn.id);
  assert.equal(resumed.job.hostTurns, 1);
  assert.deepEqual(resumed.job.attempts, { research: 1 });
  assert.throws(() => completeTurn(f.store, f.job.id, first.turn.id, 'approved'));
  assert.equal(f.store.get(f.job.id).turn.id, first.turn.id);
  assert.equal(completeTurn(f.store, f.job.id, first.turn.id, researchFor()).stage, 'build');
  assert.throws(() => completeTurn(f.store, f.job.id, first.turn.id, researchFor()));
  const build = await nextTurn(f.store, f.job.id);
  assert.throws(() => completeTurn(f.store, f.job.id, build.turn.id));
  writeFileSync(join(build.turn.cwd, 'pubspec.yaml'), 'name: host_fixture\ndependencies:\n  flutter: {sdk: flutter}\n');
  assert.throws(() => completeTurn(f.store, f.job.id, build.turn.id, { verified: true }));
  const pending = completeTurn(f.store, f.job.id, build.turn.id);
  assert.equal(pending.stage, 'verify');
  assert.equal(pending.verifiedDigest, null);
  assert.equal(existsSync(f.marker), false);
  assert.equal((await nextTurn(f.store, f.job.id)).action, 'step');
  const verified = await runStep(f.store, f.config, f.job.id);
  assert.equal(verified.stage, 'review');
  assert.equal(readFileSync(f.marker, 'utf8'), 'runtime');
  assert.match(verified.verifiedDigest, /^[a-f0-9]{64}$/);
  assert.match(verified.verifiedDependencyDigest, /^[a-f0-9]{64}$/);
  const review = await nextTurn(f.store, f.job.id);
  assert.throws(() => completeTurn(f.store, f.job.id, review.turn.id, { approved: true, findings: [], acceptanceEvidence: [] }), /each acceptance/);
  const approved = completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job));
  assert.equal(approved.stage, 'package');
  assert.equal(approved.status, 'queued');
  assert.equal(Object.hasOwn(approved.config, 'allowSubmit'), false);
  assert.equal(Object.hasOwn(approved.config, 'allowRelease'), false);
  assert.deepEqual(approved.receipt, {});
  assert.equal(approved.hostTurns, 3);
  assert.throws(() => completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job)), /Stale/);
});

test('abandonment releases only its matching claim and never refunds turn budgets', async t => {
  const f = fixture(t, { maxHostTurns: 2 });
  const first = await nextTurn(f.store, f.job.id);
  assert.throws(() => abandonTurn(f.store, f.job.id, 'wrong-token'));
  assert.equal(f.store.get(f.job.id).turn.id, first.turn.id);
  const abandoned = abandonTurn(f.store, f.job.id, first.turn.id);
  assert.equal(abandoned.turn, null);
  assert.equal(abandoned.hostTurns, 1);
  assert.deepEqual(abandoned.attempts, { research: 1 });
  assert.throws(() => completeTurn(f.store, f.job.id, first.turn.id, researchFor()));
  const next = await nextTurn(f.store, f.job.id);
  assert.notEqual(next.turn.id, first.turn.id);
  assert.equal(next.job.hostTurns, 2);
  assert.equal((await nextTurn(f.open(), f.job.id)).turn.id, next.turn.id);
  abandonTurn(f.store, f.job.id, next.turn.id);
  const exhausted = await nextTurn(f.store, f.job.id);
  assert.equal(exhausted.action, 'done');
  assert.equal(exhausted.job.status, 'needs-owner');
  assert.equal(exhausted.job.hostTurns, 2);
});

test('host work is available without local-execution permission but external verification remains blocked', async t => {
  const f = fixture(t, { allowLocalExecution: false });
  const build = await buildTurn(f);
  completeTurn(f.store, f.job.id, build.turn.id);
  const blocked = await runStep(f.store, f.config, f.job.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stage, 'verify');
  assert.equal(blocked.hostTurns, 2);
  assert.equal(existsSync(f.marker), false);
});

test('failed runtime verification without a source change re-runs verify and retains no approval evidence', async t => {
  const f = fixture(t, { verification: { checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(19)']] } });
  const build = await buildTurn(f);
  completeTurn(f.store, f.job.id, build.turn.id);
  const failure = await runStep(f.store, f.config, f.job.id);
  assert.equal(failure.stage, 'verify');
  assert.equal(failure.status, 'waiting');
  assert.equal(failure.recoveryStage, 'verify');
  assert.equal(failure.review, null);
  assert.equal(failure.verifiedDigest, null);
  assert.match(failure.feedback, /Verification failed/);
  f.store.update(f.job.id, { nextAt: 0 });
  const repair = await nextTurn(f.store, f.job.id);
  assert.equal(repair.action, 'step');
  assert.equal(repair.job.stage, 'verify');
  assert.equal(repair.job.hostTurns, 2);
});

test('configured obfuscation runs between build and verify before any verification evidence exists', async t => {
  const configPath = join(tmpdir(), `obfuscator-${Date.now()}.json`);
  writeFileSync(configPath, JSON.stringify({ code: { removeComments: true }, seed: 'fixture' }));
  const marker = join(tmpdir(), `obfuscated-${Date.now()}`);
  t.after(() => { rmSync(configPath, { force: true }); rmSync(marker, { force: true }); });
  const f = fixture(t, { obfuscation: { command: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'obfuscated')`, '--'], configPath } });
  const build = await buildTurn(f);
  const pending = completeTurn(f.store, f.job.id, build.turn.id);
  assert.equal(pending.stage, 'obfuscate');
  assert.equal(pending.verifiedDigest, null);
  assert.equal((await nextTurn(f.store, f.job.id)).action, 'step');
  const obfuscated = await runStep(f.store, f.config, f.job.id);
  assert.equal(obfuscated.stage, 'verify');
  assert.equal(obfuscated.verifiedDigest, null);
  assert.equal(readFileSync(marker, 'utf8'), 'obfuscated');
  const verified = await runStep(f.store, f.config, f.job.id);
  assert.equal(verified.stage, 'review');
  assert.match(verified.verifiedDigest, /^[a-f0-9]{64}$/);
});

test('failed obfuscation returns for repair with feedback and never reaches verify', async t => {
  const configPath = join(tmpdir(), `obfuscator-${Date.now()}.json`);
  writeFileSync(configPath, JSON.stringify({ code: { removeComments: true } }));
  t.after(() => rmSync(configPath, { force: true }));
  const f = fixture(t, { obfuscation: { command: [process.execPath, '-e', 'process.exit(7)', '--'], configPath } });
  const build = await buildTurn(f);
  completeTurn(f.store, f.job.id, build.turn.id);
  const failure = await runStep(f.store, f.config, f.job.id);
  assert.equal(failure.stage, 'obfuscate');
  assert.equal(failure.status, 'waiting');
  assert.equal(failure.verifiedDigest, null);
  assert.match(failure.feedback, /Obfuscation failed/);
  assert.equal(existsSync(f.marker), false);
});

for (const mutation of ['source', 'dependencies', 'screenshots']) {
  test(`review completion invalidates ${mutation} mutations instead of granting packaging`, async t => {
    const product = mutation === 'screenshots' ? { ...spec, screenshotsDir: 'build/screenshots' } : spec;
    const f = fixture(t, {}, product);
    const build = await buildTurn(f);
    if (mutation === 'screenshots') {
      mkdirSync(join(f.job.workspace, 'build/screenshots'), { recursive: true });
      writeFileSync(join(f.job.workspace, 'build/screenshots', 'capture.png'), 'controlled screenshot fingerprint fixture');
    }
    completeTurn(f.store, f.job.id, build.turn.id);
    assert.equal((await runStep(f.store, f.config, f.job.id)).stage, 'review');
    const review = await nextTurn(f.store, f.job.id);
    if (mutation === 'source') writeFileSync(join(f.job.workspace, 'main.dart'), 'void changed() {}\n');
    if (mutation === 'dependencies') {
      mkdirSync(join(f.job.workspace, '.dart_tool'), { recursive: true });
      writeFileSync(join(f.job.workspace, '.dart_tool/package_config.json'), JSON.stringify({ configVersion: 2, packages: [] }));
    }
    if (mutation === 'screenshots') writeFileSync(join(f.job.workspace, 'build/screenshots', 'capture.png'), 'different capture');
    const rejected = completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job));
    assert.equal(rejected.stage, 'build');
    assert.equal(rejected.turn, null);
    assert.ok(rejected.review, 'the host review is preserved so the repair handoff keeps the submitted verdict');
    assert.equal(rejected.review.approved, true);
    assert.equal(rejected.verifiedDigest, null);
    assert.throws(() => completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job)), /Stale/);
  });
}

test('a rejected review is a repair handoff, not an approval', async t => {
  const f = fixture(t);
  const review = await reviewTurn(f);
  const rejected = completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job, { approved: false, findings: ['The acceptance workflow is incomplete.'] }));
  assert.equal(rejected.stage, 'build');
  assert.equal(rejected.review.approved, false);
  assert.equal(rejected.verifiedDigest, null);
  assert.equal(rejected.turn, null);
});

test('source changes after approval invalidate review before any compiler invocation', async t => {
  const f = fixture(t);
  const review = await reviewTurn(f);
  completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job));
  writeFileSync(join(f.job.workspace, 'main.dart'), 'void changedAfterApproval() {}\n');
  const rejected = await runStep(f.store, f.config, f.job.id);
  assert.equal(rejected.stage, 'build');
  assert.equal(rejected.review, null);
  assert.equal(rejected.verifiedDigest, null);
  assert.equal(rejected.artifact, null);
  assert.deepEqual(rejected.receipt, {});
  assert.equal(rejected.hostTurns, 3);
});

test('snapshotted context changes invalidate completion and require explicit abandonment', async t => {
  const f = fixture(t);
  const turn = await nextTurn(f.store, f.job.id);
  f.store.update(f.job.id, { feedback: 'Owner changed the required context while this turn was active.' });
  assert.throws(() => completeTurn(f.store, f.job.id, turn.turn.id, researchFor()));
  await assert.rejects(nextTurn(f.store, f.job.id), /context changed/);
  const released = abandonTurn(f.store, f.job.id, turn.turn.id);
  assert.equal(released.turn, null);
  const replacement = await nextTurn(f.store, f.job.id);
  assert.notEqual(replacement.turn.id, turn.turn.id);
});

test('build-only host APIs stay accepted for CLI compatibility without creating publication permission', async t => {
  const f = fixture(t, { packageTarget: 'ipa' });
  const turn = await nextTurn(f.store, f.job.id, { buildOnly: true });
  assert.equal(turn.action, 'host');
  assert.equal(turn.turn.stage, 'research');
  const researched = completeTurn(f.store, f.job.id, turn.turn.id, researchFor(), { buildOnly: true });
  assert.equal(researched.stage, 'build');
  assert.equal(Object.hasOwn(researched.config, 'allowSubmit'), false);
  assert.equal(Object.hasOwn(researched.config, 'allowRelease'), false);
  const build = await nextTurn(f.store, f.job.id, { buildOnly: true });
  assert.equal(build.action, 'host');
  const released = abandonTurn(f.store, f.job.id, build.turn.id, { buildOnly: true });
  assert.equal(released.turn, null);
  assert.equal(released.hostTurns, 2);
  assert.deepEqual(f.store.get(f.job.id).receipt, {});
  await assert.rejects(executeStep(f.store, released), /native host turn/);
});

function legacySnapshot(f) {
  const job = f.store.update(f.job.id, { stage: 'package', status: 'waiting', attempts: { build: 2, package: 4 }, hostTurns: 7, receipt: { versionId: 'saved-version', buildId: 'saved-build' } });
  const saved = structuredClone(job);
  for (const value of [saved.spec, saved.requestSpec]) {
    value.apple = { ...value.apple, version: value.version, ...(value.screenshotsDir ? { screenshotsDir: value.screenshotsDir } : {}) };
    delete value.version;
    delete value.platform;
    delete value.channel;
    delete value.screenshotsDir;
  }
  delete saved.config.packageTarget;
  saved.agentCalls = saved.hostTurns;
  delete saved.hostTurns;
  saved.config.agentEnv = saved.config.executionEnv;
  delete saved.config.executionEnv;
  saved.config.maxAgentCalls = saved.config.maxHostTurns;
  delete saved.config.maxHostTurns;
  saved.config.builder = { kind: 'codex' };
  saved.config.reviewer = { kind: 'cursor' };
  saved.config.allowSubmit = true;
  saved.config.allowRelease = false;
  saved.config.maxConcurrentJobs = 2;
  const text = JSON.stringify(saved);
  f.store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(text, f.job.id);
  f.store.db.exec('PRAGMA user_version=1');
  return { job, saved, text };
}

test('legacy snapshot migration preserves raw data, receipts, budgets and history without execution', t => {
  const f = fixture(t);
  const legacy = legacySnapshot(f);
  const events = f.store.db.prepare('SELECT seq,at,data FROM events WHERE job=? ORDER BY seq').all(f.job.id);
  const migrated = f.open();
  const job = migrated.get(f.job.id);
  assert.equal(job.hostTurns, 7);
  assert.equal(job.config.maxHostTurns, legacy.job.config.maxHostTurns);
  assert.deepEqual(job.attempts, legacy.job.attempts);
  assert.deepEqual(job.receipt, legacy.job.receipt);
  assert.deepEqual(job.requestSpec, { ...legacy.job.requestSpec, apple: {} });
  assert.equal(Object.hasOwn(job, 'agentCalls'), false);
  assert.equal(Object.hasOwn(job.config, 'builder'), false);
  assert.equal(Object.hasOwn(job.config, 'allowSubmit'), false);
  assert.equal(Object.hasOwn(job.config, 'allowRelease'), false);
  assert.equal(job.spec.platform, 'ios');
  assert.equal(job.spec.channel, 'app-store');
  assert.equal(job.spec.version, legacy.job.spec.version);
  assert.equal(Object.hasOwn(job.spec.apple, 'version'), false);
  assert.equal(job.config.packageTarget, 'simulator');
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(job.verifiedDigest, null);
  assert.equal(job.verifiedDependencyDigest, null);
  assert.equal(job.review, null);
  assert.equal(job.artifact, null);
  assert.equal(job.status, 'blocked');
  assert.match(job.error, /Automatic store publication has been removed/);
  assert.equal(job.manualRecovery ?? null, null);
  assert.equal(migrated.db.prepare('SELECT data FROM snapshot_migrations WHERE job=? AND version=1').get(job.id).data, legacy.text);
  assert.deepEqual(migrated.db.prepare('SELECT seq,at,data FROM events WHERE job=? ORDER BY seq').all(job.id), events);
  assert.equal(existsSync(f.marker), false);
  const persisted = migrated.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id).data;
  assert.equal(f.open().db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id).data, persisted);
});

test('unsupported snapshot migrations roll back every row and keep the legacy schema version', t => {
  const f = fixture(t);
  const legacy = legacySnapshot(f);
  const invalid = { ...legacy.saved, config: { ...legacy.saved.config, verification: { checks: [], runtime: [] } } };
  const text = JSON.stringify(invalid);
  f.store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(text, f.job.id);
  assert.throws(() => new Store(f.config.stateDir), /No migration was committed/);
  const db = new DatabaseSync(join(f.config.stateDir, 'queue.sqlite'));
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare('SELECT data FROM jobs WHERE id=?').get(f.job.id).data, text);
});

test('migration refuses live legacy ownership without signaling or changing stored work', t => {
  const f = fixture(t);
  const legacy = legacySnapshot(f);
  f.store.db.prepare('INSERT INTO worker VALUES(1,?)').run(process.pid);
  assert.throws(() => new Store(f.config.stateDir), /Stop the previous factory execution/);
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(f.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(f.job.id).data, legacy.text);
  assert.equal(f.store.db.prepare('SELECT pid FROM worker WHERE id=1').get().pid, process.pid);
});


test('host-visible turns do not disclose configured secrets needed by verification commands', async t => {
  const key = 'FACTORY_PRIVATE_TEST_TOKEN';
  const secret = 'controlled-private-verification-value';
  const previous = process.env[key];
  process.env[key] = secret;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const expected = createHash('sha256').update(secret).digest('hex');
  const check = `const actual=require('node:crypto').createHash('sha256').update(process.env.${key}??'').digest('hex');require('node:assert/strict').equal(actual,${JSON.stringify(expected)});`;
  const f = fixture(t, { executionEnv: [key], verification: { checks: [[process.execPath, '-e', check]], runtime: [[process.execPath, '--version']] } });
  const research = await nextTurn(f.store, f.job.id);
  assert.equal(JSON.stringify(research).includes(secret), false);
  assert.equal(Object.hasOwn(research.turn.environment, key), false);
  const build = await buildTurn(f);
  assert.equal(JSON.stringify(build).includes(secret), false);
  completeTurn(f.store, f.job.id, build.turn.id);
  assert.equal((await runStep(f.store, f.config, f.job.id)).stage, 'review', 'the real verification process must still receive its explicitly allowed environment');
});

for (const operation of ['resume', 'complete']) {
  test(`expired host claims cannot ${operation} or refund their consumed budget`, async t => {
    const f = fixture(t, { maxJobHours: 1 });
    const first = await nextTurn(f.store, f.job.id);
    const expiredTime = Date.now() + 2 * 3600000;
    t.mock.method(Date, 'now', () => expiredTime);
    if (operation === 'resume') {
      const result = await nextTurn(f.store, f.job.id);
      assert.equal(result.action, 'done');
      assert.equal(result.turn, undefined);
    } else {
      assert.equal(completeTurn(f.store, f.job.id, first.turn.id, researchFor()).status, 'needs-owner');
    }
    const stopped = f.store.get(f.job.id);
    assert.equal(stopped.status, 'needs-owner');
    assert.equal(stopped.stage, 'research');
    assert.equal(stopped.turn, null);
    assert.equal(stopped.hostTurns, 1);
    assert.deepEqual(stopped.attempts, { research: 1 });
    assert.equal(stopped.research, undefined);
    assert.throws(() => completeTurn(f.store, f.job.id, first.turn.id, researchFor()));
  });
}

test('ten pending packages gate their own verdicts and reviews, repair automatically and isolate failed facts', async t => {
  const f = fixture(t);
  const jobs = [f.job, ...Array.from({ length: 9 }, (_, index) => f.store.enqueue({ ...spec, id: `batch-package-${index + 1}` }, f.config))];
  for (const [index, job] of jobs.entries()) {
    const first = await nextTurn(f.store, job.id);
    const verdict = researchFor();
    if (index === 1) verdict.viable = false;
    const researched = completeTurn(f.store, job.id, first.turn.id, verdict);
    if (index === 1) {
      assert.equal(researched.status, 'needs-owner');
      assert.equal(researched.research.viable, false);
      assert.equal((await nextTurn(f.store, job.id)).action, 'done');
      assert.equal(researched.artifact, undefined);
      continue;
    }
    const build = await nextTurn(f.store, job.id);
    writeFileSync(join(build.turn.cwd, 'pubspec.yaml'), 'name: batch_fixture\ndependencies:\n  flutter: {sdk: flutter}\n');
    writeFileSync(join(build.turn.cwd, 'main.dart'), 'void main() {}\n');
    if (index === 0) {
      const pinned = f.store.get(job.id);
      for (const value of [{ appleMetadata: { appId: 'different-app' } }, { apple: { description: 'x' } }, { allowSubmit: true }, { verified: true }]) assert.throws(() => completeTurn(f.store, job.id, build.turn.id, value));
      assert.deepEqual(f.store.get(job.id).spec, pinned.spec);
      assert.deepEqual(f.store.get(job.id).requestSpec, pinned.requestSpec);
      assert.equal(Object.hasOwn(f.store.get(job.id).config, 'allowSubmit'), false);
      assert.equal(f.store.get(job.id).verifiedDigest ?? null, null);
    }
    completeTurn(f.store, job.id, build.turn.id);
    assert.equal((await runStep(f.store, f.config, job.id)).stage, 'review');
    let review = await nextTurn(f.store, job.id);
    const copied = reviewFor(review.job);
    copied.appStoreAudit = { jobId: jobs[1].id };
    assert.throws(() => completeTurn(f.store, job.id, review.turn.id, copied));
    if (index === 0) {
      const repair = completeTurn(f.store, job.id, review.turn.id, reviewFor(review.job, { findings: ['An empty-state action remains incomplete'] }));
      assert.equal(repair.stage, 'build');
      assert.equal(repair.status, 'waiting');
      assert.equal(repair.verifiedDigest, null);
      assert.equal(repair.artifact, null);
      f.store.update(job.id, { nextAt: 0 });
      const retry = await nextTurn(f.store, job.id);
      writeFileSync(join(retry.turn.cwd, 'main.dart'), 'void main() { print("empty-state result"); }\n');
      completeTurn(f.store, job.id, retry.turn.id);
      assert.equal((await runStep(f.store, f.config, job.id)).stage, 'review');
      review = await nextTurn(f.store, job.id);
    }
    const approved = completeTurn(f.store, job.id, review.turn.id, reviewFor(review.job));
    assert.equal(approved.stage, 'package');
    assert.equal(approved.review.approved, true);
    assert.equal(approved.review.findings.length, 0);
  }
  assert.deepEqual(jobs.map(job => f.store.get(job.id).stage), ['package', 'research', ...Array(8).fill('package')]);
  assert.equal(f.store.get(jobs[1].id).status, 'needs-owner');
  assert.equal(f.store.list().every(job => !job.artifact && !Object.keys(job.receipt).length), true);
});

test('packaging requires an approved review and unchanged proofs, and never replays remote effects', async t => {
  const f = fixture(t);
  const review = await reviewTurn(f);
  const packaged = completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job));
  assert.equal(packaged.stage, 'package');
  assert.equal(packaged.status, 'queued');
  const before = readFileSync(f.marker, 'utf8');
  const tampered = f.store.update(f.job.id, { review: { ...packaged.review, approved: false, findings: ['The stored verdict was tampered with.'] } });
  const gated = await executeStep(f.store, tampered);
  assert.equal(gated.stage, 'package');
  assert.equal(gated.status, 'waiting');
  assert.match(gated.error, /Packaging requires an approved host review/);
  assert.equal(gated.artifact, null);
  assert.deepEqual(gated.attempts, { ...tampered.attempts, package: 1 });
  assert.equal(readFileSync(f.marker, 'utf8'), before);
  const remote = f.store.update(f.job.id, { cloudBuildPending: true });
  const blocked = await executeStep(f.store, remote);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stage, 'package');
  assert.match(blocked.error, /automatic replay is forbidden/);
  assert.deepEqual(blocked.attempts, { ...remote.attempts, package: 2 });
});
