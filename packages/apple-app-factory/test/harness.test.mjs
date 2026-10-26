import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ConfigSchema } from '../dist/schemas.js';
import { loadConfig } from '../dist/config.js';
import { Store } from '../dist/store.js';
import { nextTurn, completeTurn, abandonTurn, executeStep } from '../dist/runner.js';
import { runStep } from '../dist/scheduler.js';

const research = {
  viable: true,
  policySources: ['2.1', '2.3.1', '2.5.19', '4.2', '4.2.6', '4.3', '5.1.1'].map(rule => ({ rule, url: 'https://developer.apple.com/app-store/review/guidelines/' })),
  distinctness: 'A controlled lifecycle fixture, not an App Store compliance attestation.',
  risks: ['Content ownership still requires a human decision.'], plan: ['Implement and externally exercise the requested workflow.'],
};
const spec = { id: 'host-fixture', name: 'Host fixture', purpose: 'Exercise native host transition safety', audience: 'Harness maintainers', framework: 'flutter', differentiators: ['Persisted typed turns'], acceptance: ['Real configured commands gate review'] };

function fixture(t, overrides = {}, product = spec) {
  const root = mkdtempSync(join(tmpdir(), 'factory-harness-'));
  const marker = join(root, 'executed');
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), allowLocalExecution: true, retryDelayMs: 1,
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
  completeTurn(f.store, f.job.id, first.turn.id, research);
  const build = await nextTurn(f.store, f.job.id);
  writeFileSync(join(build.turn.cwd, 'pubspec.yaml'), 'name: host_fixture\n');
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
  assert.equal(completeTurn(f.store, f.job.id, first.turn.id, research).stage, 'build');
  assert.throws(() => completeTurn(f.store, f.job.id, first.turn.id, research), /Stale/);
  const build = await nextTurn(f.store, f.job.id);
  assert.throws(() => completeTurn(f.store, f.job.id, build.turn.id));
  writeFileSync(join(build.turn.cwd, 'pubspec.yaml'), 'name: host_fixture\n');
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
  assert.equal(approved.config.allowSubmit, false);
  assert.equal(approved.config.allowRelease, false);
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
  assert.throws(() => completeTurn(f.store, f.job.id, first.turn.id, research));
  const next = await nextTurn(f.store, f.job.id);
  assert.notEqual(next.turn.id, first.turn.id);
  assert.equal(next.job.hostTurns, 2);
  assert.equal((await nextTurn(f.open(), f.job.id)).turn.id, next.turn.id);
  abandonTurn(f.store, f.job.id, next.turn.id);
  const exhausted = await nextTurn(f.store, f.job.id);
  assert.equal(exhausted.action, 'done');
  assert.equal(exhausted.job.status, 'failed');
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

test('failed runtime verification returns to host build and cannot retain approval evidence', async t => {
  const f = fixture(t, { verification: { checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(19)']] } });
  const build = await buildTurn(f);
  completeTurn(f.store, f.job.id, build.turn.id);
  const failure = await runStep(f.store, f.config, f.job.id);
  assert.equal(failure.stage, 'build');
  assert.equal(failure.status, 'waiting');
  assert.equal(failure.review, null);
  assert.equal(failure.verifiedDigest, null);
  assert.match(failure.feedback, /Verification failed/);
  f.store.update(f.job.id, { nextAt: 0 });
  const repair = await nextTurn(f.store, f.job.id);
  assert.equal(repair.turn.stage, 'build');
  assert.notEqual(repair.turn.id, build.turn.id);
  assert.equal(repair.job.hostTurns, 3);
});

for (const mutation of ['source', 'dependencies', 'screenshots']) {
  test(`review completion invalidates ${mutation} mutations instead of granting packaging`, async t => {
    const product = mutation === 'screenshots' ? { ...spec, apple: { screenshotsDir: 'build/screenshots' } } : spec;
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
    assert.equal(rejected.review, null);
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
  assert.throws(() => completeTurn(f.store, f.job.id, turn.turn.id, research), /context changed/);
  await assert.rejects(nextTurn(f.store, f.job.id), /context changed/);
  const released = abandonTurn(f.store, f.job.id, turn.turn.id);
  assert.equal(released.turn, null);
  const replacement = await nextTurn(f.store, f.job.id);
  assert.notEqual(replacement.turn.id, turn.turn.id);
});

test('build-only host APIs reject snapshotted publication permission without changing the claim', async t => {
  const f = fixture(t, { allowSubmit: true, packageTarget: 'ipa' });
  await assert.rejects(nextTurn(f.store, f.job.id, { buildOnly: true }), /build-only/);
  assert.equal(f.store.get(f.job.id).hostTurns, 0);
  const turn = await nextTurn(f.store, f.job.id);
  const before = f.store.get(f.job.id);
  assert.throws(() => completeTurn(f.store, f.job.id, turn.turn.id, research, { buildOnly: true }), /build-only/);
  assert.throws(() => abandonTurn(f.store, f.job.id, turn.turn.id, { buildOnly: true }), /build-only/);
  assert.deepEqual(f.store.get(f.job.id), before);
  await assert.rejects(executeStep(f.store, before), /native host turn/);
});

function legacySnapshot(f) {
  const job = f.store.update(f.job.id, { stage: 'monitor', status: 'waiting', attempts: { build: 2, publish: 4 }, hostTurns: 7, receipt: { versionId: 'saved-version', buildId: 'saved-build' } });
  const saved = structuredClone(job);
  saved.agentCalls = saved.hostTurns;
  delete saved.hostTurns;
  saved.config.agentEnv = saved.config.executionEnv;
  delete saved.config.executionEnv;
  saved.config.maxAgentCalls = saved.config.maxHostTurns;
  delete saved.config.maxHostTurns;
  saved.config.builder = { kind: 'codex' };
  saved.config.reviewer = { kind: 'cursor' };
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
  assert.deepEqual(job.requestSpec, legacy.job.requestSpec);
  assert.equal(Object.hasOwn(job, 'agentCalls'), false);
  assert.equal(Object.hasOwn(job.config, 'builder'), false);
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 2);
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

test('legacy configuration receives actionable migration instructions without opening or deleting its queue', t => {
  const f = fixture(t);
  const path = join(f.root, 'old-factory.json');
  writeFileSync(path, JSON.stringify({ ...f.config, builder: { kind: 'codex' }, maxAgentCalls: 8 }));
  assert.throws(() => loadConfig(path), /rename agentEnv to executionEnv and maxAgentCalls to maxHostTurns/);
  assert.equal(f.store.get(f.job.id).id, f.job.id);
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
      assert.equal(completeTurn(f.store, f.job.id, first.turn.id, research).status, 'failed');
    }
    const stopped = f.store.get(f.job.id);
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.stage, 'research');
    assert.equal(stopped.turn, null);
    assert.equal(stopped.hostTurns, 1);
    assert.deepEqual(stopped.attempts, { research: 1 });
    assert.equal(stopped.research, undefined);
    assert.throws(() => completeTurn(f.store, f.job.id, first.turn.id, research), /Stale/);
  });
}
