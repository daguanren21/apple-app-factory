import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareExportOptions } from '../dist/export-options.js';
import { run } from '../dist/process.js';
import { loadConfig } from '../dist/config.js';
import { Store } from '../dist/store.js';
import { executeStep, sourceDigest } from '../dist/runner.js';
import { dependencyDigest } from '../dist/dependencies.js';

for (const destination of [undefined, 'export']) {
  test(`local IPA export snapshot remains safe when the original configuration changes: ${destination ?? 'default'}`, { skip: process.platform !== 'darwin' }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'factory-export-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, 'source.plist');
    const options = { method: 'app-store-connect', ...(destination ? { destination } : {}), provisioningProfiles: { 'com.example.fixture': 'owned-fixture-profile' } };
    writeFileSync(source, JSON.stringify(options));
    const exec = (argv, settings) => run(argv, { ...settings, env: { PATH: '/usr/bin:/bin', HOME: root } });
    const snapshot = await prepareExportOptions(source, root, exec);
    writeFileSync(source, JSON.stringify({ destination: 'upload' }));
    const decoded = await exec(['/usr/bin/plutil', '-convert', 'json', '-o', '-', snapshot.path]);
    assert.equal(decoded.code, 0, decoded.stderr);
    assert.deepEqual(JSON.parse(decoded.stdout), { ...options, destination: 'export' });
    assert.notEqual(snapshot.path, source);
    assert.equal(readFileSync(snapshot.path, 'utf8').includes('<plist'), true);
    rmSync(snapshot.directory, { recursive: true });
    assert.equal(existsSync(snapshot.path), false);
  });
}

test('IPA destination=upload is blocked before the compiler and leaves no export snapshot', { skip: process.platform !== 'darwin' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-no-upload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const exportFile = join(root, 'ExportOptions.plist');
  writeFileSync(exportFile, JSON.stringify({ method: 'app-store-connect', destination: 'upload' }));
  const example = JSON.parse(readFileSync(new URL('../examples/factory.json', import.meta.url)));
  const configPath = join(root, 'factory.json');
  writeFileSync(configPath, JSON.stringify({ ...example, allowLocalExecution: true, packageTarget: 'ipa', apple: { exportOptionsPlist: exportFile }, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), verification: { prerequisites: [], checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] } }));
  const config = loadConfig(configPath);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const marker = join(root, 'compiler-started');
  writeFileSync(join(bin, 'flutter'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'forbidden compiler launch');\n`, { mode: 0o700 });
  const original = process.env.PATH;
  process.env.PATH = `${bin}:${original ?? ''}`;
  t.after(() => { if (original === undefined) delete process.env.PATH; else process.env.PATH = original; });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No Apple request is authorized'); });
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  const spec = JSON.parse(readFileSync(new URL('../examples/luggage.json', import.meta.url)));
  delete spec.apple.screenshotsDir;
  const job = store.enqueue(spec, config);
  mkdirSync(job.workspace, { recursive: true });
  writeFileSync(join(job.workspace, 'source.dart'), 'verified fixture');
  const result = await executeStep(store, store.update(job.id, { stage: 'package', verifiedDigest: sourceDigest(job.workspace), verifiedDependencyDigest: dependencyDigest(job.workspace), review: { approved: true, findings: [], acceptanceEvidence: spec.acceptance.map(requirement => ({ requirement, evidence: 'Controlled export fixture' })) } }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.stage, 'package');
  assert.equal(existsSync(marker), false);
  assert.deepEqual(result.receipt, {});
  assert.equal(result.hostTurns, 0);
  assert.equal(readdirSync(config.stateDir).some(name => name.startsWith('export-options-')), false);
});
