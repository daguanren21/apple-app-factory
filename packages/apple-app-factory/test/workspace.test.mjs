import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { executeStep, sourceDigest } from '../dist/runner.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-successor-'));
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), allowLocalExecution: true,
    verification: { prerequisites: [[process.execPath, '-e', "process.stderr.write('Fixture environment unavailable'); process.exit(1)"]], checks: [['unused']], runtime: [['unused']] } });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const spec = { id: 'revision-product', name: 'Revision product', purpose: 'Preserve local revision data', audience: 'Revision consumers', framework: 'flutter', differentiators: ['Verified source continuation'], acceptance: ['Retain existing behavior'], apple: { version: '1.0.0' } };
  const base = store.enqueue(spec, config);
  mkdirSync(join(base.workspace, 'lib'), { recursive: true });
  mkdirSync(join(base.workspace, 'build'), { recursive: true });
  writeFileSync(join(base.workspace, 'lib', 'model.dart'), 'int total(int a, int b) => a + b;\n');
  writeFileSync(join(base.workspace, 'build', 'stale-artifact'), 'must not be copied');
  store.update(base.id, { status: 'built', stage: 'package', verifiedDigest: sourceDigest(base.workspace) });
  const successor = store.enqueue({ ...spec, apple: { version: '1.1.0' }, acceptance: ['Retain existing behavior', 'Handle the next requirement'] }, config, base.id);
  return { store, base: store.get(base.id), successor };
}

test('a new requirement copies verified predecessor source without sharing files or stale artifacts', async t => {
  const { store, base, successor } = fixture(t);
  store.update(successor.id, { stage: 'verify' });
  const result = await executeStep(store, store.next());
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockedReason.kind, 'prerequisite');
  assert.equal(result.basePrepared, true);
  assert.equal(sourceDigest(result.workspace), base.verifiedDigest);
  assert.equal(existsSync(join(result.workspace, 'build', 'stale-artifact')), false);
  writeFileSync(join(result.workspace, 'lib', 'model.dart'), 'int total(int a, int b) => a - b;\n');
  assert.equal(readFileSync(join(base.workspace, 'lib', 'model.dart'), 'utf8'), 'int total(int a, int b) => a + b;\n');
  const retried = await executeStep(store, store.update(result.id, { status: 'running' }));
  assert.equal(retried.status, 'blocked');
  assert.equal(readFileSync(join(result.workspace, 'lib', 'model.dart'), 'utf8'), 'int total(int a, int b) => a - b;\n');
});

test('changed predecessor code is not silently copied as verified source', async t => {
  const { store, base, successor } = fixture(t);
  writeFileSync(join(base.workspace, 'lib', 'model.dart'), 'changed after intake');
  store.update(successor.id, { stage: 'verify' });
  const result = await executeStep(store, store.next());
  assert.equal(result.status, 'blocked');
  assert.match(result.error, /Predecessor source changed/);
  assert.equal(existsSync(successor.workspace), false);
  assert.equal(result.hostTurns, 0);
});

test('a crash between atomic copy and checkpoint safely resumes without overwriting divergent work', async t => {
  const { store, base, successor } = fixture(t);
  mkdirSync(join(successor.workspace, 'lib'), { recursive: true });
  writeFileSync(join(successor.workspace, 'lib', 'model.dart'), readFileSync(join(base.workspace, 'lib', 'model.dart')));
  store.update(successor.id, { stage: 'verify' });
  const result = await executeStep(store, store.next());
  assert.equal(result.basePrepared, true);
  assert.equal(result.blockedReason.kind, 'prerequisite');
  store.update(successor.id, { basePrepared: false, status: 'queued', nextAt: 0 });
  writeFileSync(join(successor.workspace, 'lib', 'model.dart'), 'user work after interrupted preparation');
  const divergent = await executeStep(store, store.next());
  assert.equal(divergent.status, 'blocked');
  assert.match(divergent.error, /differs from its verified predecessor/);
  assert.equal(readFileSync(join(successor.workspace, 'lib', 'model.dart'), 'utf8'), 'user work after interrupted preparation');
});
