import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { nextTurn, completeTurn } from '../dist/runner.js';
import { runStep } from '../dist/scheduler.js';

const research = { viable: true, distinctness: 'A controlled design-gate fixture.', risks: [], plan: ['Implement the gated design.'] };
function researchFor() { return { ...research, risks: [...research.risks], plan: [...research.plan] }; }
const spec = { id: 'design-gate-fixture', name: 'Design gate fixture', purpose: 'Assert the architecture gate surfaces in build and review turns', audience: 'Harness maintainers', framework: 'flutter', platform: 'ios', channel: 'app-store', version: '1.0.0', differentiators: ['gated design'], acceptance: ['gated design'] };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-design-gate-'));
  const marker = join(root, 'executed');
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator', allowLocalExecution: true, retryDelayMs: 1,
    verification: { checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)},'runtime')`]] } });
  const stores = [];
  const open = () => { const store = new Store(config.stateDir); stores.push(store); return store; };
  const store = open();
  t.after(() => { for (const item of stores) item.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue(spec, config);
  return { root, marker, config, store, job, open };
}

test('build turn prompt carries the architecture design gate', async t => {
  const f = fixture(t);
  const first = await nextTurn(f.store, f.job.id);
  completeTurn(f.store, f.job.id, first.turn.id, researchFor());
  const build = await nextTurn(f.store, f.job.id);
  assert.equal(build.turn.stage, 'build');
  assert.match(build.turn.prompt, /competing design sketches/);
  assert.match(build.turn.prompt, /module map/);
  assert.match(build.turn.prompt, /design-red-flags/);
  assert.match(build.turn.prompt, /apphx decide/);
});

test('review turn prompt carries the design-smell blocking instruction', async t => {
  const f = fixture(t);
  const first = await nextTurn(f.store, f.job.id);
  completeTurn(f.store, f.job.id, first.turn.id, researchFor());
  const build = await nextTurn(f.store, f.job.id);
  writeFileSync(join(build.turn.cwd, 'pubspec.yaml'), 'name: design_gate_fixture\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(build.turn.cwd, 'main.dart'), 'void main() {}\n');
  completeTurn(f.store, f.job.id, build.turn.id);
  const verified = await runStep(f.store, f.config, f.job.id);
  assert.equal(verified.stage, 'review');
  const review = await nextTurn(f.store, f.job.id);
  assert.equal(review.turn.stage, 'review');
  assert.match(review.turn.prompt, /design smells/);
  assert.match(review.turn.prompt, /name the specific file/);
});

test('bundled design-red-flags reference ships inside the package', () => {
  const reference = fileURLToPath(new URL('../skills/apphx/references/design-red-flags.md', import.meta.url));
  assert.equal(existsSync(reference), true);
});
