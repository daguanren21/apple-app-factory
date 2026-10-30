import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../dist/process.js';
import { Store } from '../dist/store.js';
import { nextTurn } from '../dist/runner.js';
import { validateJobConfig } from '../dist/schemas.js';

const cli = resolve('dist/cli.js');
const spec = { id: 'autopilot-fixture', name: 'Autopilot fixture', purpose: 'Exercise unattended execution', audience: 'Harness maintainers', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Unattended decisions'], acceptance: ['Deterministic checks gate progress'] };

function configFor(root, overrides = {}) {
  return {
    stateDir: join(root, 'state'),
    workspaceRoot: join(root, 'workspaces'),
    packageTarget: 'simulator',
    allowLocalExecution: true,
    verification: { checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] },
    ...overrides,
  };
}

test('init --autopilot writes autopilot and local execution authorization', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apphx-autopilot-init-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'factory.json');
  const result = await run([process.execPath, cli, 'init', '--autopilot', '--config', path]);
  assert.equal(result.code, 0, result.stderr);
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(written.autopilot, true);
  assert.equal(written.allowLocalExecution, true);
});

test('init without --autopilot keeps the field absent and local execution off', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apphx-autopilot-plain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'factory.json');
  const result = await run([process.execPath, cli, 'init', '--config', path]);
  assert.equal(result.code, 0, result.stderr);
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(Object.hasOwn(written, 'autopilot'), false);
  assert.equal(written.allowLocalExecution, false);
});

test('validateJobConfig requires local execution pre-authorization for autopilot', () => {
  const config = { packageTarget: 'simulator', allowLocalExecution: true, autopilot: true };
  assert.doesNotThrow(() => validateJobConfig(spec, config));
  assert.throws(() => validateJobConfig(spec, { ...config, allowLocalExecution: false }), /autopilot requires allowLocalExecution=true/);
});

test('taskPrompt adds autopilot instructions only for autopilot jobs', async t => {
  const autopilotRoot = mkdtempSync(join(tmpdir(), 'apphx-autopilot-prompt-'));
  const plainRoot = mkdtempSync(join(tmpdir(), 'apphx-plain-prompt-'));
  t.after(() => { rmSync(autopilotRoot, { recursive: true, force: true }); rmSync(plainRoot, { recursive: true, force: true }); });

  const autopilotStore = new Store(join(autopilotRoot, 'state'));
  const plainStore = new Store(join(plainRoot, 'state'));
  t.after(() => { autopilotStore.close(); plainStore.close(); });

  const autopilotJob = autopilotStore.enqueue(spec, configFor(autopilotRoot, { autopilot: true }));
  const plainJob = plainStore.enqueue(spec, configFor(plainRoot));

  const autopilotTurn = await nextTurn(autopilotStore, autopilotJob.id);
  assert.equal(autopilotTurn.action, 'host');
  assert.match(autopilotTurn.turn.prompt, /AUTOPILOT MODE/);
  assert.match(autopilotTurn.turn.prompt, /Stuck states are host work, never a user handback/);
  assert.match(autopilotTurn.turn.prompt, /terminally failed task with no recovery path may be continued/);

  const plainTurn = await nextTurn(plainStore, plainJob.id);
  assert.equal(plainTurn.action, 'host');
  assert.doesNotMatch(plainTurn.turn.prompt, /AUTOPILOT MODE/);
  assert.doesNotMatch(plainTurn.turn.prompt, /Stuck states are host work/);
});
