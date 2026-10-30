import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { nextTurn, completeTurn } from '../dist/runner.js';
import { runStep } from '../dist/scheduler.js';

const success = [process.execPath, '-e', 'process.exit(0)'];
const research = { viable: true, distinctness: 'Review-proof fixture', risks: [], plan: ['Implement the requested workflow'] };
const spec = {
  id: 'review-proof-fixture', name: 'Review proof fixture', purpose: 'Diagnose post-verification source changes', audience: 'Harness maintainers',
  framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0',
  differentiators: ['Attributable proof diagnosis'], acceptance: ['Configured deterministic commands gate progress'],
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-review-proof-'));
  const config = ConfigSchema.parse({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    allowLocalExecution: true, retryDelayMs: 1,
    verification: { checks: [success], runtime: [success] },
  });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue(spec, config);
  return { root, config, store, job };
}

function reviewFor(job) {
  return { approved: true, findings: [], acceptanceEvidence: job.spec.acceptance.map(requirement => ({ requirement, evidence: 'Configured runtime command completed' })) };
}

async function advanceToReview(f) {
  const first = await nextTurn(f.store, f.job.id);
  assert.equal(first.turn.stage, 'research');
  completeTurn(f.store, f.job.id, first.turn.id, research);
  const build = await nextTurn(f.store, f.job.id);
  assert.equal(build.turn.stage, 'build');
  writeFileSync(join(build.turn.cwd, 'pubspec.yaml'), 'name: review_proof_fixture\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(build.turn.cwd, 'main.dart'), 'void main() {}\n');
  completeTurn(f.store, f.job.id, build.turn.id);
  assert.equal((await runStep(f.store, f.config, f.job.id)).stage, 'review');
  return nextTurn(f.store, f.job.id);
}

test('a post-verification source change is diagnosed with guard and digest while preserving the host review', async t => {
  const f = fixture(t);
  const review = await advanceToReview(f);
  assert.equal(review.turn.stage, 'review');

  writeFileSync(join(f.job.workspace, 'main.dart'), 'void changed() {}\n');
  const rejected = completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job));

  assert.equal(rejected.stage, 'build');
  assert.equal(rejected.turn, null);
  assert.equal(rejected.verifiedDigest, null);
  assert.ok(rejected.review, 'the host-submitted review must survive the repair handoff');
  assert.equal(rejected.review.approved, true);
  assert.equal(rejected.review.findings.length, 0);
  assert.match(rejected.error, /Source changed/);
  assert.match(rejected.error, /current=[a-f0-9]{16}/);
  assert.match(rejected.error, /recorded=[a-f0-9]{16}/);
  assert.throws(() => completeTurn(f.store, f.job.id, review.turn.id, reviewFor(review.job)), /Stale/);
});
