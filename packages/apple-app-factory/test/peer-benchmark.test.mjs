import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker } from '../benchmarks/peer-context.mjs';

const valid = { errors: [], wallMs: 12, operations: 20 };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'apphx-peer-worker-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = join(root, 'sample.json');
  const stderr = join(root, 'sample.stderr');
  writeFileSync(report, JSON.stringify({ ...valid, wallMs: 999, stale: true }));
  const execute = (source, timeout) => runWorker(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; const path = ${JSON.stringify(report)}; ${source}`], report, stderr, timeout);
  const writeReport = `fs.writeFileSync(path, ${JSON.stringify(JSON.stringify(valid))});`;
  return { root, report, stderr, execute, writeReport };
}
function assertFailure(f, result, pattern) {
  assert(result.errors.some(error => pattern.test(error.message)), JSON.stringify(result));
  assert.equal(result.stale, undefined);
  assert.deepEqual(JSON.parse(readFileSync(f.report, 'utf8')), result);
}

test('benchmark rerun cannot reuse a stale successful report when child exits before writing', t => {
  const f = fixture(t);
  const result = f.execute('process.exit(7);');
  assert.equal(result.exitStatus, 7);
  assert.equal(result.wallMs, null);
  assert.equal(result.operations, 0);
  assertFailure(f, result, /Missing or malformed fresh worker report/);
  assertFailure(f, result, /status 7/);
});

test('benchmark records a nonzero exit even when child writes a valid success report', t => {
  const f = fixture(t);
  const result = f.execute(`${f.writeReport} process.exit(9);`);
  assert.equal(result.wallMs, valid.wallMs);
  assert.equal(result.operations, valid.operations);
  assertFailure(f, result, /status 9/);
});

test('benchmark records signal termination despite a fresh success report', t => {
  const f = fixture(t);
  const result = f.execute(`${f.writeReport} process.kill(process.pid, 'SIGTERM');`);
  assert.equal(result.signal, 'SIGTERM');
  assertFailure(f, result, /signal SIGTERM/);
});

test('benchmark records spawn errors and deletes the old report', t => {
  const f = fixture(t);
  const result = runWorker(join(f.root, 'nonexistent-executable'), [], f.report, f.stderr);
  assert.equal(result.wallMs, null);
  assertFailure(f, result, /Worker spawn failed:.*ENOENT/);
});

test('benchmark rejects a missing fresh report even when child exits successfully', t => {
  const f = fixture(t);
  const result = f.execute('process.exit(0);');
  assert.equal(result.exitStatus, 0);
  assert.equal(result.wallMs, null);
  assertFailure(f, result, /Missing or malformed fresh worker report/);
});

for (const [name, content] of [
  ['invalid JSON', '{'],
  ['invalid error list', JSON.stringify({ ...valid, errors: 'none' })],
  ['invalid timing', JSON.stringify({ ...valid, wallMs: null })],
  ['invalid operation count', JSON.stringify({ ...valid, operations: -1 })],
]) test(`benchmark rejects ${name} in a fresh report`, t => {
  const f = fixture(t);
  const result = f.execute(`fs.writeFileSync(path, ${JSON.stringify(content)});`);
  assert.equal(result.exitStatus, 0);
  assert.equal(result.wallMs, null);
  assertFailure(f, result, /Missing or malformed fresh worker report/);
});

test('benchmark removes stale output before spawn and accepts a genuinely fresh successful report', t => {
  const f = fixture(t);
  const result = f.execute(`if (fs.existsSync(path)) process.exit(8); ${f.writeReport}`);
  assert.deepEqual(result, { ...valid, exitStatus: 0, signal: null });
  assert.deepEqual(JSON.parse(readFileSync(f.report, 'utf8')), result);
});
