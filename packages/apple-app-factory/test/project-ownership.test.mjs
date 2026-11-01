import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigSchema } from '../dist/contracts/schemas.js';
import { Store } from '../dist/state/store.js';
import { abandonTurn, cancelWorkflow, completeTurn, executeStep, nextTurn } from '../dist/workflow/runner.js';
import { assertProjectSnapshot, prepareExecutionWorkspace, prepareWorkspace } from '../dist/projects/workspace.js';

const spec = {
  id: 'root-owner', name: 'Root owner', purpose: 'Keep maintained source under one owner', audience: 'Maintainers',
  framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0',
  differentiators: ['Explicit project ownership'], acceptance: ['Never overwrite adopted source'],
};

function flutter(root, content = 'void main() {}\n') {
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'pubspec.yaml'), 'name: owned_app\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(root, 'lib/main.dart'), content);
}

function fixture(t, overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apphx-root-ownership-')));
  const config = ConfigSchema.parse({
    projectRoot: join(root, 'projects/live'), workspaceRoot: join(root, 'execution/workspaces'), stateDir: join(root, 'state'),
    packageTarget: 'simulator', allowLocalExecution: true, obfuscation: { options: {} },
    verification: { checks: [[process.execPath, '-e', 'throw new Error("must not run")']], runtime: [['unused']] }, ...overrides,
  });
  flutter(config.projectRoot);
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue(spec, config);
  return { root, config, store, job };
}

function adopt(f, id = 'adopted-source', obfuscation) {
  return f.store.enqueue({ ...spec, id }, { ...f.config, projectRoot: f.job.workspace, obfuscation });
}

for (const status of ['queued', 'waiting', 'blocked', 'needs-owner', 'running']) {
  test(`a ${status} execution root cannot be adopted mid-flight`, t => {
    const f = fixture(t);
    flutter(f.job.workspace, 'owner execution bytes');
    f.store.update(f.job.id, { status });
    const before = readdirSync(f.config.workspaceRoot);
    assert.throws(() => adopt(f), /execution|ownership|project/i);
    assert.equal(f.store.list().length, 1);
    assert.deepEqual(readdirSync(f.config.workspaceRoot), before);
    assert.equal(readFileSync(join(f.job.workspace, 'lib/main.dart'), 'utf8'), 'owner execution bytes');
  });
}

for (const status of ['queued', 'built', 'failed']) {
  for (const isolated of [false, true]) {
    test(`a ${status} adopter permanently protects a ${isolated ? 'legacy isolated' : 'project-copy'} execution root`, async t => {
      const f = fixture(t, isolated ? { projectMode: 'isolated' } : {});
      if (isolated) flutter(f.job.workspace);
      else prepareExecutionWorkspace(f.store, f.job);
      f.store.update(f.job.id, { status: 'built', stage: 'package' });
      const adopter = f.store.enqueue({ ...spec, id: 'maintained-copy' }, { ...f.config, projectMode: 'project', projectRoot: f.job.workspace, obfuscation: undefined });
      writeFileSync(join(adopter.projectRoot, 'lib/main.dart'), 'maintainer edits must survive');
      f.store.update(adopter.id, { status });
      const entries = readdirSync(f.config.workspaceRoot);
      assert.throws(() => prepareWorkspace(f.store, f.job), /ownership|project/i);
      assert.throws(() => prepareExecutionWorkspace(f.store, f.job), /ownership|project/i);
      assert.throws(() => f.store.update(f.job.id, { status: 'running' }), /ownership|project/i);
      f.store.update(f.job.id, { status: 'queued', stage: 'obfuscate', nextAt: 0 });
      const result = await executeStep(f.store, f.store.get(f.job.id));
      assert.equal(result.status, 'waiting');
      assert.equal(f.store.get(f.job.id).attempts.obfuscate, undefined);
      assert.deepEqual(readdirSync(f.config.workspaceRoot), entries);
      assert.equal(readFileSync(join(adopter.projectRoot, 'lib/main.dart'), 'utf8'), 'maintainer edits must survive');
      const successor = f.store.enqueue({ ...spec, id: 'continued-maintenance' }, { ...f.config, projectMode: 'project', projectRoot: adopter.projectRoot, obfuscation: undefined });
      assert.equal((await nextTurn(f.store, successor.id)).action, 'host');
    });
  }
}

test('safe adoption allows a new sibling snapshot and sequential work on the maintained project', async t => {
  const f = fixture(t);
  prepareExecutionWorkspace(f.store, f.job);
  f.store.update(f.job.id, { status: 'built', stage: 'package' });
  const adopter = adopt(f, 'adopter', { options: {} });
  writeFileSync(join(adopter.projectRoot, 'lib/main.dart'), 'maintained adopted source');
  prepareExecutionWorkspace(f.store, adopter);
  assert.equal(readFileSync(join(adopter.workspace, 'lib/main.dart'), 'utf8'), 'maintained adopted source');
  const second = f.store.enqueue({ ...spec, id: 'same-live-next' }, { ...f.config, projectRoot: adopter.projectRoot });
  const active = await nextTurn(f.store, adopter.id);
  assert.equal(active.action, 'host');
  const blocked = await nextTurn(f.store, second.id);
  assert.equal(blocked.action, 'wait');
  assert.equal(blocked.turn, undefined);
  abandonTurn(f.store, adopter.id, active.turn.id);
  assert.equal((await nextTurn(f.store, second.id)).action, 'host');
});

test('persisted cross-root claims are refused before build completion replaces maintained source', async t => {
  const f = fixture(t);
  f.store.update(f.job.id, { stage: 'build' });
  const active = await nextTurn(f.store, f.job.id);
  const oldClaim = f.store.get(f.job.id);
  abandonTurn(f.store, f.job.id, active.turn.id);
  prepareExecutionWorkspace(f.store, f.job);
  f.store.update(f.job.id, { status: 'built', stage: 'package' });
  const adopter = adopt(f);
  writeFileSync(join(adopter.projectRoot, 'lib/main.dart'), 'maintained after adoption');
  // Restore the unsafe ownership state admitted by the previous queue implementation.
  f.store.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run(oldClaim.status, JSON.stringify(oldClaim), oldClaim.id);
  const entries = readdirSync(f.config.workspaceRoot);
  assert.equal(f.store.projectConflict(adopter).id, f.job.id);
  assert.equal((await nextTurn(f.store, adopter.id)).action, 'wait');
  assert.throws(() => completeTurn(f.store, f.job.id, active.turn.id), /ownership|project/i);
  assert.equal(f.store.get(f.job.id).turn.id, active.turn.id);
  assert.deepEqual(readdirSync(f.config.workspaceRoot), entries);
  assert.equal(readFileSync(join(adopter.projectRoot, 'lib/main.dart'), 'utf8'), 'maintained after adoption');
});

test('build completion takes its snapshot inside the existing Store transition', async t => {
  const f = fixture(t);
  f.store.update(f.job.id, { stage: 'build' });
  const active = await nextTurn(f.store, f.job.id);
  const completed = completeTurn(f.store, f.job.id, active.turn.id);
  assert.equal(completed.stage, 'obfuscate');
  assert.equal(completed.turn, null);
  assert.match(completed.projectDigest, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(join(completed.workspace, 'lib/main.dart'), 'utf8'), 'void main() {}\n');
});

test('direct snapshot callers serialize admission and use saved roots rather than caller paths', t => {
  const f = fixture(t);
  f.store.update(f.job.id, { status: 'built', stage: 'package' });
  const other = new Store(f.config.stateDir);
  t.after(() => other.close());
  other.db.exec('PRAGMA busy_timeout=0');
  const unrelated = join(f.root, 'unrelated');
  flutter(unrelated, 'unrelated bytes');
  f.store.withProjectWrite(f.job.id, () => {
    assert.throws(() => other.enqueue({ ...spec, id: 'contending-adopter' }, { ...f.config, projectRoot: f.job.workspace, obfuscation: undefined }), /locked|busy/i);
    prepareExecutionWorkspace(f.store, { ...f.job, projectRoot: unrelated, workspace: join(unrelated, 'replacement') });
  });
  assert.equal(readFileSync(join(f.job.workspace, 'lib/main.dart'), 'utf8'), 'void main() {}\n');
  assert.equal(readFileSync(join(unrelated, 'lib/main.dart'), 'utf8'), 'unrelated bytes');
  assert.equal(existsSync(join(unrelated, 'replacement')), false);
  const adopter = other.enqueue({ ...spec, id: 'contending-adopter' }, { ...f.config, projectRoot: f.job.workspace, obfuscation: undefined });
  assert.equal(adopter.projectRoot, f.job.workspace);
  assert.throws(() => prepareExecutionWorkspace(f.store, f.job), /ownership|project/i);
});

function retarget(parent, target) {
  renameSync(parent, `${parent}-original`);
  mkdirSync(target, { recursive: true });
  symlinkSync(target, parent, 'dir');
}

for (const target of ['live', 'execution']) {
  test(`a frozen ${target} ancestor cannot retarget snapshot or deterministic writes`, async t => {
    const f = fixture(t);
    const snapshot = prepareExecutionWorkspace(f.store, f.job);
    f.store.update(f.job.id, { ...snapshot, stage: 'verify' });
    const parent = target === 'live' ? dirname(f.job.projectRoot) : dirname(f.job.workspace);
    const outside = join(f.root, `replacement-${target}`);
    retarget(parent, outside);
    const redirected = target === 'live' ? join(outside, 'live') : join(outside, f.job.id);
    flutter(redirected, 'unrelated replacement source');
    const before = readdirSync(outside);
    assert.throws(() => prepareWorkspace(f.store, f.job), /frozen.*(?:projectRoot|workspace)/i);
    assert.throws(() => prepareExecutionWorkspace(f.store, f.job), /frozen.*(?:projectRoot|workspace)/i);
    assert.throws(() => assertProjectSnapshot(f.store.get(f.job.id)), /frozen.*(?:projectRoot|workspace)/i);
    const result = await executeStep(f.store, f.store.get(f.job.id));
    assert.equal(result.status, 'blocked');
    assert.match(result.error, /frozen.*(?:projectRoot|workspace)/i);
    assert.deepEqual(readdirSync(outside), before);
    assert.equal(readFileSync(join(redirected, 'lib/main.dart'), 'utf8'), 'unrelated replacement source');
    assert.equal(result.attempts.verify, undefined);
  });
}

test('retargeted source cannot resume a host claim, but metadata inspection and cancellation still work', async t => {
  const f = fixture(t, { workflow: {}, obfuscation: undefined });
  const active = await nextTurn(f.store, f.job.id);
  assert.equal(active.action, 'host');
  retarget(dirname(f.job.projectRoot), join(f.root, 'replacement'));
  flutter(join(f.root, 'replacement/live'), 'unrelated source');
  await assert.rejects(nextTurn(f.store, f.job.id), /frozen.*projectRoot/i);
  assert.equal(f.store.get(f.job.id).turn.id, active.turn.id);
  assert.equal(f.store.list().length, 1);
  assert.ok(f.store.events(f.job.id).length > 0);
  const cancelled = cancelWorkflow(f.store, f.job.id, 'Stop after source retarget');
  assert.equal(cancelled.workflow.cancelled, true);
  assert.equal(cancelled.turn, null);
  assert.equal(cancelled.status, 'needs-owner');
  assert.equal(readFileSync(join(f.root, 'replacement/live/lib/main.dart'), 'utf8'), 'unrelated source');
});

test('an absent frozen execution directory cannot be created through a retargeted ancestor', t => {
  const f = fixture(t);
  mkdirSync(f.config.workspaceRoot, { recursive: true });
  retarget(f.config.workspaceRoot, join(f.root, 'replacement-execution'));
  assert.throws(() => prepareExecutionWorkspace(f.store, f.job), /frozen.*workspace/i);
  assert.equal(existsSync(join(f.root, 'replacement-execution', f.job.id)), false);
  assert.deepEqual(readdirSync(join(f.root, 'replacement-execution')), []);
});
