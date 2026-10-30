import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { executeStep, nextTurn } from '../dist/runner.js';
import { sourceDigest } from '../dist/workspace.js';

const success = [process.execPath, '-e', 'process.exit(0)'];

function spec(overrides = {}) {
  return {
    id: 'verify-repair-fixture', name: 'Verify repair fixture', purpose: 'Classify verification failures by source mutation',
    audience: 'Harness maintainers', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0',
    differentiators: ['Idempotent evidence'], acceptance: ['Deterministic runtime evidence'], ...overrides,
  };
}

function fixture(t, { product = spec(), verification = { checks: [success], runtime: [success] } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-verify-repair-'));
  const config = ConfigSchema.parse({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    allowLocalExecution: true, retryDelayMs: 1, verification,
  });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue(product, config);
  return { root, config, store, job };
}

test('a failed runtime command with unchanged source re-runs verify instead of build', async t => {
  const pass = join(tmpdir(), `verify-repair-pass-${Date.now()}`);
  t.after(() => rmSync(pass, { force: true }));
  const f = fixture(t, {
    verification: {
      checks: [success],
      runtime: [[process.execPath, '-e', `require('node:fs').existsSync(${JSON.stringify(pass)}) ? process.exit(0) : process.exit(19)`]],
    },
  });
  f.store.update(f.job.id, { stage: 'verify' });
  const failure = await executeStep(f.store, f.store.get(f.job.id));
  assert.equal(failure.stage, 'verify');
  assert.equal(failure.status, 'waiting');
  assert.equal(failure.recoveryStage, 'verify');
  assert.equal(failure.review ?? null, null);
  assert.equal(failure.verifiedDigest ?? null, null);
  assert.match(failure.feedback ?? '', /Verification failed/);
  assert.deepEqual(failure.attempts, { verify: 1 });

  f.store.update(f.job.id, { nextAt: 0 });
  const step = await nextTurn(f.store, f.job.id);
  assert.equal(step.action, 'step');
  assert.equal(step.job.stage, 'verify');

  writeFileSync(pass, '');
  const replayed = await executeStep(f.store, f.store.get(f.job.id));
  assert.equal(replayed.stage, 'review');
  assert.deepEqual(replayed.attempts, { verify: 2 });
  assert.match(replayed.verifiedDigest ?? '', /^[a-f0-9]{64}$/);
});

test('a runtime command that mutates source still returns to build for host repair', async t => {
  const f = fixture(t, {
    verification: {
      checks: [success],
      runtime: [[process.execPath, '-e', `require('node:fs').writeFileSync('main.dart', 'void changed() {}\\n'); process.exit(23)`]],
    },
  });
  f.store.update(f.job.id, { stage: 'verify' });
  const result = await executeStep(f.store, f.store.get(f.job.id));
  assert.equal(result.stage, 'build');
  assert.equal(result.status, 'waiting');
  assert.equal(result.recoveryStage, undefined);
  assert.equal(result.review ?? null, null);
  assert.equal(result.verifiedDigest ?? null, null);
  assert.match(result.feedback ?? '', /Verification failed/);
  assert.equal(existsSync(join(f.job.workspace, 'main.dart')), true);
});

test('screenshotsDir is emptied before verify so evidence is idempotent across reruns', async t => {
  const screenshot = 'capture.png';
  const f = fixture(t, {
    product: spec({ screenshotsDir: 'build/screenshots' }),
    verification: {
      checks: [success],
      runtime: [[process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(join('build', 'screenshots', screenshot))}, 'this-run-only')`]],
    },
  });
  const screenshots = join(f.job.workspace, 'build', 'screenshots');
  mkdirSync(join(screenshots, 'stale'), { recursive: true });
  writeFileSync(join(screenshots, 'garbage.txt'), 'stale file');
  writeFileSync(join(screenshots, 'stale', 'old.png'), 'stale nested file');
  f.store.update(f.job.id, { stage: 'verify' });
  const result = await executeStep(f.store, f.store.get(f.job.id));
  assert.equal(result.stage, 'review');
  assert.equal(existsSync(join(screenshots, 'garbage.txt')), false);
  assert.equal(existsSync(join(screenshots, 'stale')), false);
  assert.equal(readFileSync(join(screenshots, screenshot), 'utf8'), 'this-run-only');
  assert.equal(result.screenshotDigest, sourceDigest(screenshots, false));
});
