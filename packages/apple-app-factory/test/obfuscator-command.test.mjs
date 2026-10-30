import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('apphx obfuscator forwards an explicit empty --seed to the bundled binary', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apphx-obf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'main.dart'), 'void main() {}\n');
  const configPath = join(root, 'obfuscator.json');
  writeFileSync(configPath, JSON.stringify({ code: { removeComments: true } }));
  const result = spawnSync(process.execPath, [cli, 'obfuscator', root, '--config', configPath, '--framework', 'flutter', '--seed', ' '], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /seed must be a non-empty string/);
});

test('apphx obfuscator runs the bundled binary end to end', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apphx-obf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'main.dart'), '// gone\nvoid main() {}\n');
  const configPath = join(root, 'obfuscator.json');
  writeFileSync(configPath, JSON.stringify({ code: { removeComments: true } }));
  const result = spawnSync(process.execPath, [cli, 'obfuscator', root, '--config', configPath, '--framework', 'flutter'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  assert.equal(report.transforms.code, 1);
  assert.equal(result.stdout.includes('// gone'), false);
});
