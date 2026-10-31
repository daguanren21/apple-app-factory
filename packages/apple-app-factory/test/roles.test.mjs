import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, RoleSeatSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { nextTurn } from '../dist/runner.js';

const success = [process.execPath, '-e', 'process.exit(0)'];

const spec = {
  id: 'role-panels-fixture', name: 'Role panels fixture', purpose: 'Exercise role seat pinning', audience: 'Harness maintainers',
  framework: 'flutter', platform: 'ios', channel: 'app-store', version: '1.0.0',
  differentiators: ['Pinned role seats'], acceptance: ['Pinned seats gate review'],
};

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-roles-'));
  const config = ConfigSchema.parse({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    allowLocalExecution: true, pollMs: 25,
    verification: { prerequisites: [], checks: [success], runtime: [success] },
    ...overrides,
  });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue(spec, config);
  return { root, config, store, job };
}

function buildClaim(f) {
  f.store.update(f.job.id, { stage: 'build', nextAt: 0 });
  return nextTurn(f.store, f.job.id);
}

test('legacy string role arrays stay valid and normalize to plain names', async t => {
  const f = fixture(t, { roles: { research: ['product-analyst', 'market-scout'] } });
  const claim = await nextTurn(f.store, f.job.id);
  assert.equal(claim.action, 'host');
  assert.equal(claim.turn.stage, 'research');
  assert.deepEqual(claim.turn.role, ['product-analyst', 'market-scout']);
  assert.match(claim.turn.prompt, /Turn roles/);
  assert.doesNotMatch(claim.turn.prompt, /Seat pins:/);
});

test('RoleSeatSchema accepts legacy strings and pinned objects with defaults', () => {
  assert.equal(RoleSeatSchema.parse('developer'), 'developer');
  assert.deepEqual(
    RoleSeatSchema.parse({ name: 'architect-review', provider: 'grok', fresh: true }),
    { name: 'architect-review', provider: 'grok', fresh: true },
  );
  assert.deepEqual(RoleSeatSchema.parse({ name: 'developer' }), { name: 'developer', fresh: false });
  assert.equal(RoleSeatSchema.safeParse({}).success, false);
  assert.equal(RoleSeatSchema.safeParse({ provider: 'grok' }).success, false);
  assert.equal(RoleSeatSchema.safeParse({ name: '' }).success, false);
});

test('ConfigSchema accepts pinned object seats and keeps legacy strings', () => {
  const config = ConfigSchema.parse({
    stateDir: '/tmp/roles-config', workspaceRoot: '/tmp/roles-workspaces', packageTarget: 'simulator',
    verification: { checks: [success], runtime: [success] },
    roles: { build: [{ name: 'developer', provider: 'grok', fresh: true }, 'ui-designer'] },
  });
  assert.deepEqual(config.roles.build, [{ name: 'developer', provider: 'grok', fresh: true }, 'ui-designer']);
});

test('legacy host turns preserve configured pinned and plain role ordering', async t => {
  const f = fixture(t, { roles: { build: [{ name: 'architect-review', provider: 'grok', fresh: true }, 'developer'] } });
  const claim = await buildClaim(f);
  assert.equal(claim.action, 'host');
  assert.deepEqual(claim.turn.role, ['architect-review', 'developer']);
});

