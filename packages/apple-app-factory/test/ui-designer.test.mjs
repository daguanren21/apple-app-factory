import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, RequirementSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { nextTurn } from '../dist/runner.js';

const success = [process.execPath, '-e', 'process.exit(0)'];

const spec = {
  id: 'ui-designer-fixture', name: 'UI Designer fixture', purpose: 'Exercise ui-designer build guidance', audience: 'Harness maintainers',
  framework: 'flutter', platform: 'ios', channel: 'app-store', version: '1.0.0',
  differentiators: ['Design-token driven implementation'], acceptance: ['Preserve design tokens'],
};

function fixture(t, overrides = {}, specExtra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-ui-designer-'));
  const config = ConfigSchema.parse({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    allowLocalExecution: true, pollMs: 25,
    verification: { prerequisites: [], checks: [success], runtime: [success] },
    ...overrides,
  });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue({ ...spec, ...specExtra }, config);
  store.update(job.id, { stage: 'build', nextAt: 0 });
  return { root, config, store, job };
}

test('requirement schema accepts a https designRef and rejects non-URLs', () => {
  const url = 'https://www.figma.com/design/abc123/Screen?node-id=1-2';
  assert.equal(RequirementSchema.parse({ ...spec, designRef: url }).designRef, url);
  for (const bad of ['not-a-url', 'ht tp://example.com', '']) {
    assert.equal(RequirementSchema.safeParse({ ...spec, designRef: bad }).success, false, JSON.stringify(bad));
  }
});

test('build prompt guides ui-designer to produce docs/ui-design.md from the bundled guide when no designRef is supplied', async t => {
  const f = fixture(t);
  const claim = await nextTurn(f.store, f.job.id);
  assert.equal(claim.action, 'host');
  assert.deepEqual(claim.turn.role, ['ui-designer', 'developer']);
  assert.match(claim.turn.prompt, /ui-designer/);
  assert.match(claim.turn.prompt, /docs\/ui-design\.md/);
  assert.match(claim.turn.prompt, /ui-design-guide\.md/);
});

test('build prompt reproduces the referenced design faithfully and records the designRef URL', async t => {
  const url = 'https://www.figma.com/design/abc123/Screen?node-id=1-2';
  const f = fixture(t, {}, { designRef: url });
  const claim = await nextTurn(f.store, f.job.id);
  assert.equal(claim.action, 'host');
  assert.deepEqual(claim.turn.role, ['ui-designer', 'developer']);
  assert.match(claim.turn.prompt, /faithfully reproduce/);
  assert.match(claim.turn.prompt, /忠实还原/);
  assert.ok(claim.turn.prompt.includes(url), 'prompt must record the design reference URL');
  assert.match(claim.turn.prompt, /docs\/ui-design\.md/);
});

