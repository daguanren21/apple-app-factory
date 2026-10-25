import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, SpecSchema, ReviewSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';

const example = JSON.parse(readFileSync(new URL('../examples/factory.json', import.meta.url)));
const product = JSON.parse(readFileSync(new URL('../examples/luggage.json', import.meta.url)));

test('configuration never coerces string permissions, accepts unknown executable settings or exposes publisher variables', () => {
  const config = { ...example, stateDir: '/owned/state', workspaceRoot: '/owned/workspaces' };
  for (const patch of [{ allowSubmit: 'false' }, { allowRelease: 1 }, { maxAttempts: 0 }, { maxAgentCalls: 1.5 }, { agentEnv: ['ASC_PRIVATE_KEY_PATH'] }, { builder: { kind: 'cursor', provider: 'xai' } }, { unexpectedCommand: ['sh', '-c', 'bad'] }]) {
    assert.equal(ConfigSchema.safeParse({ ...config, ...patch }).success, false);
  }
});

test('products and model approval require complete typed acceptance evidence', () => {
  for (const patch of [{ acceptance: [] }, { differentiators: [' '] }, { framework: 'web' }, { hiddenFeatures: true }, { reviewBypass: true }]) assert.equal(SpecSchema.safeParse({ ...product, ...patch }).success, false);
  for (const verdict of [{ approved: 'true', findings: [], acceptanceEvidence: [] }, { approved: true, findings: [], acceptanceEvidence: [{ requirement: product.acceptance[0], evidence: '' }] }, { approved: true, findings: 'none', acceptanceEvidence: [] }]) assert.equal(ReviewSchema.safeParse(verdict).success, false);
});

test('corrupt persisted permissions cannot be claimed or rewrite the original queue', t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-schema-'));
  const store = new Store(join(root, 'state'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue(product, { ...example, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces') });
  const corrupt = { ...job, config: { ...job.config, allowSubmit: 'true' } };
  const bytes = JSON.stringify(corrupt);
  store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(bytes, job.id);
  assert.throws(() => store.acquire());
  assert.throws(() => store.next());
  assert.deepEqual(store.db.prepare('SELECT * FROM worker').all(), []);
  assert.equal(store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id).data, bytes);
});

test('invalid state transitions cannot partially overwrite persisted budgets', t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-state-'));
  const store = new Store(join(root, 'state'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue(product, { ...example, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces') });
  for (const patch of [{ attempts: { build: -1 } }, { agentCalls: -1 }, { nextAt: NaN }, { stage: 'skip-verification' }, { receipt: { upload: { status: 'approved' } } }]) assert.throws(() => store.update(job.id, patch));
  assert.deepEqual(store.get(job.id), job);
});

test('stored configuration cannot combine publication with simulator-only packaging or release without submission', () => {
  const config = { ...example, stateDir: '/owned/state', workspaceRoot: '/owned/workspaces' };
  assert.equal(ConfigSchema.safeParse({ ...config, allowSubmit: true, packageTarget: 'simulator' }).success, false);
  assert.equal(ConfigSchema.safeParse({ ...config, allowRelease: true, allowSubmit: false }).success, false);
});
