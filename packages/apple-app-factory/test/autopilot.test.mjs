import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../dist/process.js';
import { validateJobConfig } from '../dist/schemas.js';

const cli = resolve('dist/cli.js');
const spec = { id: 'autopilot-fixture', name: 'Autopilot fixture', purpose: 'Exercise unattended execution', audience: 'Harness maintainers', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Unattended decisions'], acceptance: ['Deterministic checks gate progress'] };


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

