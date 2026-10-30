import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareExportOptions, prepareNativeExportCommands } from '../dist/export-options.js';
import { run } from '../dist/process.js';
import { loadConfig } from '../dist/config.js';
import { Store } from '../dist/store.js';
import { executeStep } from '../dist/runner.js';
import { sourceDigest } from '../dist/workspace.js';
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
  delete spec.screenshotsDir;
  spec.channel = 'local';
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

function nativeFixture(t, scenario, destination = 'export', wrapped = false) {
  const root = mkdtempSync(join(tmpdir(), 'factory-native-export-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'Original.plist');
  const marker = join(root, 'commands.jsonl');
  const compiler = join(root, 'xcodebuild');
  writeFileSync(source, JSON.stringify({ method: 'app-store-connect', ...(destination ? { destination } : {}) }));
  // Controlled executable records dispatch and plist bytes; no Xcode or upload is used.
  writeFileSync(compiler, `#!${process.execPath}
const fs=require('node:fs'), cp=require('node:child_process');
const args=process.argv.slice(2), exporting=args.includes('-exportArchive');
if (!exporting) {
  fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({archive:true})+'\\n');
  ${scenario === 'mutation' ? `fs.writeFileSync(${JSON.stringify(source)},JSON.stringify({destination:'upload'}));` : ''}
} else {
  const path=args[args.indexOf('-exportOptionsPlist')+1];
  const decoded=cp.spawnSync('/usr/bin/plutil',['-convert','json','-o','-',path],{encoding:'utf8'});
  if(decoded.status!==0) throw new Error(decoded.stderr);
  fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({path,options:JSON.parse(decoded.stdout)})+'\\n');
  ${scenario === 'failure' ? 'process.exit(17);' : ''}
  fs.mkdirSync('build',{recursive:true});fs.writeFileSync('build/fixture.ipa','Controlled recorder output, not an IPA');
}
`, { mode: 0o700 });
  const launcher = join(root, 'xcrun');
  if (wrapped) writeFileSync(launcher, `#!${process.execPath}\nconst cp=require('node:child_process');const r=cp.spawnSync(process.argv[2],process.argv.slice(3),{stdio:'inherit'});if(r.error)throw r.error;process.exit(r.status??1);\n`, { mode: 0o700 });
  const prefix = wrapped ? [launcher, compiler] : [compiler];
  const exportArgs = scenario === 'missing' ? [] : scenario === 'missing-value' ? ['-exportOptionsPlist'] : scenario === 'equals' ? [`-exportOptionsPlist=${source}`] : ['-exportOptionsPlist', source, ...(scenario === 'duplicate' ? ['-exportOptionsPlist', source] : [])];
  const commands = [[compiler, 'archive'], [...prefix, '-exportArchive', ...exportArgs]];
  if (scenario === 'late-upload') {
    const unsafe = join(root, 'Unsafe.plist');
    writeFileSync(unsafe, JSON.stringify({ destination: 'upload' }));
    commands.push([compiler, '-exportArchive', '-exportOptionsPlist', unsafe]);
  }
  const configFile = join(root, 'factory.json');
  writeFileSync(configFile, JSON.stringify({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'),
    allowLocalExecution: true, packageTarget: 'ipa',
    verification: { prerequisites: [], checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] },
    packaging: { commands, artifactPath: 'build/fixture.ipa' },
  }));
  const config = loadConfig(configFile);
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No Apple request is authorized'); });
  const spec = { id: 'native-export', name: 'Recorder', purpose: 'Controlled export recorder', audience: 'Test', framework: 'swift', platform: 'ios', channel: 'local', differentiators: ['Fixture'], acceptance: ['Recorder only'] };
  const job = store.enqueue(spec, config);
  mkdirSync(job.workspace, { recursive: true });
  writeFileSync(join(job.workspace, 'main.swift'), '// Controlled source');
  const ready = store.update(job.id, { stage: 'package', verifiedDigest: sourceDigest(job.workspace, true, 'swift'), verifiedDependencyDigest: dependencyDigest(job.workspace, 'swift'), review: { approved: true, findings: [], acceptanceEvidence: [{ requirement: 'Recorder only', evidence: 'Controlled fixture' }] } });
  return { root, source, marker, config, store, ready };
}

for (const scenario of ['upload', 'missing', 'missing-value', 'duplicate', 'equals', 'late-upload']) {
  test(`native IPA prevalidates the whole build-only sequence: ${scenario}`, { skip: process.platform !== 'darwin' }, async t => {
    const f = nativeFixture(t, scenario, scenario === 'upload' ? 'upload' : 'export');
    const result = await executeStep(f.store, f.ready);
    assert.equal(result.status, 'blocked', result.error);
    assert.equal(result.stage, 'package');
    assert.equal(existsSync(f.marker), false, 'archive must not start before every export is validated');
    assert.deepEqual(result.receipt, {});
    assert.equal(result.hostTurns, 0);
    assert.equal(readdirSync(f.config.stateDir).some(name => name.startsWith('export-options-')), false);
  });
}

for (const destination of [undefined, 'export']) {
  for (const wrapped of [false, true]) {
    test(`native IPA snapshots ${destination ?? 'default'} before archive mutation; xcrun=${wrapped}`, { skip: process.platform !== 'darwin' }, async t => {
      const f = nativeFixture(t, 'mutation', destination ?? null, wrapped);
      const result = await executeStep(f.store, f.ready);
      assert.equal(result.status, 'built', result.error);
      const records = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(records[0], { archive: true });
      assert.equal(records[1].options.destination, 'export');
      assert.equal(records[1].options.method, 'app-store-connect');
      assert.notEqual(records[1].path, f.source);
      assert.equal(JSON.parse(readFileSync(f.source, 'utf8')).destination, 'upload');
      assert.equal(existsSync(records[1].path), false);
      assert.deepEqual(result.receipt, {});
      assert.equal(readdirSync(f.config.stateDir).some(name => name.startsWith('export-options-')), false);
    });
  }
}

test('native IPA snapshot is removed when export fails', { skip: process.platform !== 'darwin' }, async t => {
  const f = nativeFixture(t, 'failure');
  const result = await executeStep(f.store, f.ready);
  assert.notEqual(result.status, 'built');
  const records = readFileSync(f.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(existsSync(records[1].path), false);
  assert.equal(readdirSync(f.config.stateDir).some(name => name.startsWith('export-options-')), false);
});

test('native export preparation preserves caller argv and resolves relative options', { skip: process.platform !== 'darwin' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-native-argv-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'Options.plist'), JSON.stringify({ destination: 'export' }));
  const commands = [['xcodebuild', 'archive'], ['xcrun', 'xcodebuild', '-exportArchive', '-exportOptionsPlist', 'Options.plist']];
  const original = structuredClone(commands);
  const prepared = await prepareNativeExportCommands(commands, root, root, run);
  try {
    assert.deepEqual(commands, original);
    assert.deepEqual(prepared.commands[0], original[0]);
    assert.notEqual(prepared.commands[1][4], 'Options.plist');
    assert.equal(existsSync(prepared.commands[1][4]), true);
  } finally { prepared.cleanup(); }
  assert.equal(existsSync(prepared.commands[1][4]), false);
  prepared.cleanup();
});

for (const argv of [
  ['xcodebuild', '-exportArchive', '-exportOptionsPlist', '-exportPath', 'build'],
  ['xcodebuild', '-exportArchive', '-exportArchive', '-exportOptionsPlist', 'Options.plist'],
  ['xcodebuild', '-exportArchive=yes', '-exportOptionsPlist', 'Options.plist'],
  ['xcodebuild', '-exportArchive', '-exportOptionsPlist', 'Options.plist', '--'],
  ['xcrun', '--sdk', 'iphoneos', 'xcodebuild', '-exportArchive', '-exportOptionsPlist', 'Options.plist'],
]) {
  test(`ambiguous native export arguments fail closed: ${JSON.stringify(argv)}`, async () => {
    await assert.rejects(prepareNativeExportCommands([argv], '.', '.', async () => {
      throw new Error('Ambiguous argv must fail before plist conversion');
    }), { code: 'SETUP_REQUIRED' });
  });
}

test('nonexport commands remain unchanged without treating owner scripts as a sandbox', async () => {
  const commands = [['xcodebuild', 'archive'], ['owner-script', '-exportArchive'], ['xcrun', 'swift', '--version']];
  const prepared = await prepareNativeExportCommands(commands, '.', '.', async () => {
    throw new Error('No export options should be read');
  });
  assert.deepEqual(prepared.commands, commands);
  prepared.cleanup();
});

test('isolated native export receives only its immutable plist capability, not control state', { skip: process.platform !== 'darwin' }, async t => {
  const f = nativeFixture(t, 'isolation');
  const compiler = join(f.root, 'xcodebuild');
  writeFileSync(compiler, `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
fs.mkdirSync('build',{recursive:true});
assert.throws(()=>fs.readFileSync(${JSON.stringify(join(f.config.stateDir, 'queue.sqlite'))}));
assert.throws(()=>fs.readFileSync(${JSON.stringify(f.source)}));
if(process.argv.includes('-exportArchive')){
  const path=process.argv[process.argv.indexOf('-exportOptionsPlist')+1];
  const decoded=cp.spawnSync('/usr/bin/plutil',['-convert','json','-o','-',path],{encoding:'utf8'});
  assert.equal(decoded.status,0,decoded.stderr);
  assert.equal(JSON.parse(decoded.stdout).destination,'export');
  assert.throws(()=>fs.writeFileSync(path,'untrusted replacement'));
  fs.writeFileSync('build/export-proof.json',JSON.stringify({destination:'export',snapshotRead:true,snapshotWriteDenied:true,stateReadDenied:true}));
  fs.writeFileSync('build/fixture.ipa','Controlled recorder output, not an IPA');
} else fs.writeFileSync('build/archive-proof','isolated archive');
`, { mode: 0o700 });
  const job = f.store.update(f.ready.id, { config: { ...f.ready.config, isolation: { mode: 'macos-sandbox', readOnlyPaths: ['/usr/bin/plutil'], network: 'deny' } } });
  const result = await executeStep(f.store, job);
  assert.equal(result.status, 'built', result.error);
  assert.deepEqual(JSON.parse(readFileSync(join(job.workspace, 'build/export-proof.json'))), { destination: 'export', snapshotRead: true, snapshotWriteDenied: true, stateReadDenied: true });
  assert.equal(readFileSync(join(job.workspace, 'build/archive-proof'), 'utf8'), 'isolated archive');
  assert.equal(JSON.parse(readFileSync(f.source)).destination, 'export');
  assert.equal(readdirSync(f.config.stateDir).some(name => name.startsWith('export-options-') || name.startsWith('isolated-command-')), false);
});
