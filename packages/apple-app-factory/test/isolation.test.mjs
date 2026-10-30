import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer, connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { ConfigSchema } from '../dist/schemas.js';
import { loadConfig, normalizeIsolationPaths } from '../dist/config.js';
import { prepareIsolatedCommand, removeConfinedPath } from '../dist/isolation.js';
import { run, processGroupAlive } from '../dist/process.js';
import { Store } from '../dist/store.js';
import { nextTurn, completeTurn, executeStep } from '../dist/runner.js';
import { runStep } from '../dist/scheduler.js';

const mac = { skip: process.platform !== 'darwin' };
const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const product = { id: 'isolated-records', name: 'Isolated records', framework: 'flutter', platform: 'android', channel: 'local', purpose: 'Keep owned records', audience: 'Local users', version: '1.0.0', differentiators: ['Owned workspace'], acceptance: ['Persist and reload exact local records without reading control state'] };
function fixture(t, isolation = { mode: 'macos-sandbox', readOnlyPaths: [], network: 'deny' }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apphx-isolation-test-')));
  const stateDir = join(root, 'state'), workspaceRoot = join(root, 'workspaces'), workspace = join(workspaceRoot, 'owned');
  for (const path of [stateDir, workspace, join(root, 'tools'), join(workspaceRoot, 'sibling'), `${workspace}-other`]) mkdirSync(path, { recursive: true });
  const configPath = join(root, 'factory.json');
  const config = ConfigSchema.parse({ configPath, stateDir, workspaceRoot, packageTarget: 'apk', allowLocalExecution: true, retryDelayMs: 1, isolation, verification: { checks: [[process.execPath, '--check', 'model.mjs']], runtime: [[process.execPath, 'runtime.mjs']] } });
  writeFileSync(configPath, JSON.stringify(config));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace, configPath, config, env: { PATH: process.env.PATH, LANG: 'C', CI: '1' } };
}
async function isolated(argv, f, options = {}) {
  const prepared = prepareIsolatedCommand(argv, { config: f.config, workspace: f.workspace, cwd: f.workspace, env: f.env });
  try { return await run(prepared.argv, { cwd: f.workspace, env: prepared.env, timeoutMs: 10000, ...options }); }
  finally { prepared.cleanup(); }
}
async function listener(t) {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.end('owned-listener'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, connections: () => connections };
}

test('isolation configuration remains explicit and cannot expose state or sibling workspaces', t => {
  const f = fixture(t);
  const parsed = ConfigSchema.parse({ ...f.config, allowLocalExecution: false });
  assert.equal(parsed.allowLocalExecution, false);
  assert.equal(parsed.allowSubmit, undefined);
  for (const patch of [{ mode: 'unknown' }, { mode: 'macos-sandbox', network: true }, { mode: 'macos-sandbox', writablePaths: ['/'] }]) assert.throws(() => ConfigSchema.parse({ ...f.config, isolation: patch }));
  for (const path of [f.root, f.config.stateDir, join(f.config.stateDir, 'secret'), f.config.workspaceRoot, f.workspace, f.configPath]) {
    if (path.endsWith('secret')) writeFileSync(path, 'protected');
    const config = ConfigSchema.parse({ ...f.config, isolation: { mode: 'macos-sandbox', readOnlyPaths: [path] } });
    assert.throws(() => normalizeIsolationPaths(config));
  }
  const alias = join(f.root, 'state-alias'); symlinkSync(f.config.stateDir, alias, 'dir');
  assert.throws(() => normalizeIsolationPaths(ConfigSchema.parse({ ...f.config, isolation: { mode: 'macos-sandbox', readOnlyPaths: [alias] } })));
});

test('sandbox confines real parent and child file operations and blocks a reachable network listener', mac, async t => {
  const f = fixture(t), network = await listener(t);
  await new Promise((resolve, reject) => { const socket = connect(network.port, '127.0.0.1'); let data = ''; socket.on('data', value => { data += value; }); socket.on('error', reject); socket.on('end', () => { assert.equal(data, 'owned-listener'); resolve(); }); });
  const privateFile = join(f.root, 'private.txt'), stateFile = join(f.config.stateDir, 'protected.txt'), sibling = join(f.config.workspaceRoot, 'sibling/data'), prefix = `${f.workspace}-other/data`, tool = join(f.root, 'tools/input');
  for (const path of [privateFile, stateFile, sibling, prefix, tool]) writeFileSync(path, 'unchanged-sentinel');
  f.config.isolation.readOnlyPaths = [join(f.root, 'tools')]; normalizeIsolationPaths(f.config);
  const program = `const fs=require('node:fs'),a=require('node:assert/strict'),cp=require('node:child_process'),net=require('node:net');const protectedFiles=${JSON.stringify([privateFile, stateFile, sibling, prefix])};const denied=[];const refuse=(name,fn)=>{a.throws(fn,e=>['EPERM','EACCES'].includes(e.code));denied.push(name);};for(const [i,p]of protectedFiles.entries()){refuse('read'+i,()=>fs.readFileSync(p));refuse('write'+i,()=>fs.writeFileSync(p,'wrong'));}refuse('traversal',()=>fs.readFileSync('../sibling/data'));const alias=process.env.CHILD?'child-alias':'alias';fs.symlinkSync(protectedFiles[0],alias);refuse('symlink-read',()=>fs.readFileSync(alias));refuse('symlink-write',()=>fs.writeFileSync(alias,'wrong'));refuse('hardlink',()=>fs.linkSync(protectedFiles[0],process.env.CHILD?'child-hardlink':'hardlink'));a.equal(fs.readFileSync(${JSON.stringify(tool)},'utf8'),'unchanged-sentinel');refuse('readonly-write',()=>fs.writeFileSync(${JSON.stringify(tool)},'wrong'));const name=process.env.CHILD?'child.json':'parent.json';fs.writeFileSync(name,JSON.stringify(['keep','new']));a.deepEqual(JSON.parse(fs.readFileSync(name)),['keep','new']);const socket=net.connect(${network.port},'127.0.0.1');socket.on('connect',()=>{socket.destroy();throw new Error('Network escaped');});socket.on('error',error=>{a.equal(error.code,'EPERM');denied.push('network');if(!process.env.CHILD){const child=cp.spawnSync(process.execPath,['probe.cjs'],{env:{...process.env,CHILD:'1'},encoding:'utf8'});a.equal(child.status,0,child.stderr);a.deepEqual(JSON.parse(child.stdout).denied,denied);}console.log(JSON.stringify({denied,stored:JSON.parse(fs.readFileSync(name))}));});`;
  writeFileSync(join(f.workspace, 'probe.cjs'), program);
  const result = await isolated([process.execPath, 'probe.cjs'], f);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).stored, ['keep', 'new']);
  assert.deepEqual(JSON.parse(readFileSync(join(f.workspace, 'child.json'))), ['keep', 'new']);
  assert.equal(network.connections(), 1);
  for (const path of [privateFile, stateFile, sibling, prefix, tool]) assert.equal(readFileSync(path, 'utf8'), 'unchanged-sentinel');
  assert.equal(readdirSync(f.config.stateDir).some(name => name.startsWith('isolated-command-')), false);
});

test('network permission is explicit and does not widen file access', mac, async t => {
  const f = fixture(t, { mode: 'macos-sandbox', readOnlyPaths: [], network: 'allow' }), network = await listener(t);
  const privateFile = join(f.root, 'private'); writeFileSync(privateFile, 'protected');
  const script = `const net=require('node:net'),fs=require('node:fs'),a=require('node:assert/strict');a.throws(()=>fs.readFileSync(${JSON.stringify(privateFile)}));let data='';const s=net.connect(${network.port},'127.0.0.1');s.on('data',b=>data+=b);s.on('error',e=>{throw e});s.on('end',()=>{a.equal(data,'owned-listener');console.log(data)});`;
  const result = await isolated([process.execPath, '-e', script], f);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'owned-listener');
  assert.equal(network.connections(), 1);
});

test('sandbox wrapping preserves supervised timeout and inherited process cleanup', mac, async t => {
  const f = fixture(t);
  let metadata, pid;
  const child = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  await assert.rejects(isolated([process.execPath, '-e', parent], f, { timeoutMs: 1000, onSpawn(value, details) { pid = value; metadata = details; } }));
  assert.equal(processGroupAlive(pid), false);
  assert.equal(typeof metadata.identity.token, 'string');
  assert.equal(readdirSync(f.config.stateDir).some(name => name.startsWith('isolated-command-')), false);
});

test('actual verify and package commands cannot read or replace harness control files', mac, async t => {
  const f = fixture(t); const store = new Store(f.config.stateDir); t.after(() => store.close());
  const job = store.enqueue(product, f.config);
  let action = await nextTurn(store, job.id);
  completeTurn(store, job.id, action.turn.id, { viable: true, distinctness: 'Controlled isolation workflow fixture', plan: ['Persist actual local records under isolation'] });
  action = await nextTurn(store, job.id);
  writeFileSync(join(job.workspace, 'pubspec.yaml'), 'name: isolated_records\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(job.workspace, 'model.mjs'), 'export const append=(values,value)=>[...values,value.trim()];\n');
  writeFileSync(join(job.workspace, 'runtime.mjs'), `import a from 'node:assert/strict';import fs from 'node:fs';import {append} from './model.mjs';a.throws(()=>fs.readFileSync(${JSON.stringify(join(f.config.stateDir, 'queue.sqlite'))}));const old=['keep'];const next=append(old,' new ');a.deepEqual(old,['keep']);a.deepEqual(next,['keep','new']);fs.mkdirSync('build',{recursive:true});fs.writeFileSync('build/records.json',JSON.stringify(next));a.deepEqual(JSON.parse(fs.readFileSync('build/records.json')),next);`);
  completeTurn(store, job.id, action.turn.id);
  assert.equal((await runStep(store, f.config, job.id)).stage, 'review');
  action = await nextTurn(store, job.id);
  const approved = completeTurn(store, job.id, action.turn.id, { approved: true, findings: [], acceptanceEvidence: product.acceptance.map(requirement => ({ requirement, evidence: 'Actual isolated Node runtime asserted records and denied queue access' })) });
  const sentinel = join(f.config.stateDir, 'protected'); writeFileSync(sentinel, 'unchanged');
  const packaging = { provider: 'local', commands: [[process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'wrong')`]], artifactPath: 'build/app.apk' };
  const configured = store.update(job.id, { config: { ...approved.config, packaging } });
  const blocked = await executeStep(store, configured);
  assert.notEqual(blocked.status, 'built');
  assert.equal(blocked.artifact, null);
  assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
  assert.deepEqual(JSON.parse(readFileSync(join(job.workspace, 'build/records.json'))), ['keep', 'new']);
});

test('isolated doctor gives imported source read-only access without creating a queue', mac, t => {
  const f = fixture(t); const source = join(f.root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'pubspec.yaml'), 'name: doctor_fixture\ndependencies:\n  flutter: {sdk: flutter}\n');
  const original = join(source, 'owned.txt'); writeFileSync(original, 'source-original');
  const check = [process.execPath, '-e', `const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('owned.txt','utf8'),'source-original');a.throws(()=>fs.writeFileSync('owned.txt','wrong'));console.log(JSON.stringify({read:true,writeDenied:true}));`];
  writeFileSync(f.configPath, JSON.stringify({ ...f.config, verification: { ...f.config.verification, prerequisites: [check] } }));
  const spec = join(f.root, 'spec.json'); writeFileSync(spec, JSON.stringify({ ...product, project: { sourceDir: source } }));
  const result = spawnSync(process.execPath, [cli, 'doctor', spec, '--config', f.configPath, '--build-only'], { encoding: 'utf8', timeout: 30000 });
  const report = JSON.parse(result.stdout);
  const prerequisite = report.checks.find(check => check.name === 'configured-prerequisite-1');
  assert.equal(prerequisite.available, true, prerequisite.detail);
  assert.deepEqual(JSON.parse(prerequisite.detail), { read: true, writeDenied: true });
  assert.equal(report.checks.find(check => check.name === 'subprocess-isolation').available, true);
  assert.equal(readFileSync(original, 'utf8'), 'source-original');
  assert.equal(existsSync(join(f.config.stateDir, 'queue.sqlite')), false);
});

test('changing isolation via actual retry invalidates accepted execution proof', t => {
  const f = fixture(t); const store = new Store(f.config.stateDir); t.after(() => store.close());
  const trusted = { ...f.config, isolation: undefined };
  const job = store.enqueue(product, trusted);
  store.update(job.id, { status: 'built', stage: 'package', verifiedDigest: 'a'.repeat(64), verifiedDependencyDigest: 'b'.repeat(64), review: { approved: true, findings: [], acceptanceEvidence: [] } });
  const result = spawnSync(process.execPath, [cli, 'retry', job.id, '--config', f.configPath, '--build-only'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const current = store.get(job.id);
  assert.equal(current.stage, 'verify');
  assert.equal(current.verifiedDigest, null);
  assert.equal(current.review, null);
  assert.equal(current.config.isolation.mode, 'macos-sandbox');
  assert.equal(current.config.allowSubmit, undefined);
});

if (process.platform !== 'darwin') test('selected macOS isolation never falls back on unsupported hosts', t => {
  const f = fixture(t);
  assert.throws(() => prepareIsolatedCommand([process.execPath, '--version'], { config: f.config, workspace: f.workspace, cwd: f.workspace, env: f.env }), error => error.code === 'SETUP_REQUIRED');
});

test('detached child cannot redirect parent artifact deletion outside the sandbox', mac, async t => {
  const f = fixture(t), store = new Store(f.config.stateDir); t.after(() => store.close());
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  const sentinel = join(outside, 'fixture.ipa'); writeFileSync(sentinel, 'outside-sentinel');
  const spec = { ...product, framework: 'swift', platform: 'ios' };
  const commands = Array.from({ length: 4 }, () => ['/usr/bin/xcodebuild', '-exportArchive', '-exportOptionsPlist', 'ExportOptions.plist']);
  const config = ConfigSchema.parse({ ...f.config, packageTarget: 'ipa', verification: { ...f.config.verification, prerequisites: [[process.execPath, 'prerequisite.cjs']] }, packaging: { provider: 'local', commands, artifactPath: 'build/output/fixture.ipa' } });
  const job = store.enqueue(spec, config); mkdirSync(join(job.workspace, 'build/output'), { recursive: true });
  writeFileSync(join(job.workspace, 'ExportOptions.plist'), '{"destination":"export"}');
  const helper = `const fs=require('node:fs');fs.writeFileSync('build/helper.pid',String(process.pid));let swapped=false;const end=Date.now()+5000;const timer=setInterval(()=>{try{if(!swapped&&fs.existsSync('build/validated')){fs.rmdirSync('build/output');fs.symlinkSync(${JSON.stringify(outside)},'build/output');swapped=true;fs.writeFileSync('build/swapped','yes');}fs.writeFileSync('build/heartbeat',String(Date.now()));}catch{}if(Date.now()>end){clearInterval(timer);process.exit(0)}},5);`;
  writeFileSync(join(job.workspace, 'prerequisite.cjs'), `const cp=require('node:child_process');const p=cp.spawn(process.execPath,['-e',${JSON.stringify(helper)}],{detached:true,stdio:'ignore'});p.unref();`);
  const original = fs.lstatSync;
  fs.lstatSync = function (path, ...args) {
    const value = original(path, ...args);
    if (String(path) === join(job.workspace, 'build/output/fixture.ipa')) writeFileSync(join(job.workspace, 'build/validated'), 'yes');
    return value;
  };
  syncBuiltinESMExports();
  try {
    const prepared = store.update(job.id, { stage: 'package', verifiedDigest: (await import('../dist/workspace.js')).sourceDigest(job.workspace, true, 'swift'), verifiedDependencyDigest: (await import('../dist/dependencies.js')).dependencyDigest(job.workspace, 'swift'), review: { approved: true, findings: [], acceptanceEvidence: [] } });
    const result = await executeStep(store, prepared);
    assert.equal(existsSync(join(job.workspace, 'build/swapped')), true);
    const pid = Number(readFileSync(join(job.workspace, 'build/helper.pid'), 'utf8'));
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.equal(readFileSync(sentinel, 'utf8'), 'outside-sentinel');
    assert.notEqual(result.status, 'built');
    assert.equal(result.artifact, null);
  } finally {
    fs.lstatSync = original; syncBuiltinESMExports();
    const path = join(job.workspace, 'build/helper.pid');
    if (existsSync(path)) try { process.kill(Number(readFileSync(path, 'utf8')), 'SIGKILL'); } catch {}
  }
});

test('scratch cleanup grants only its original root even if an intermediate path becomes a symlink', mac, t => {
  const f = fixture(t), owned = join(f.workspace, 'scratch'), outside = join(f.root, 'outside-cleanup');
  mkdirSync(owned); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'outside-sentinel');
  symlinkSync(outside, join(owned, 'redirect'), 'dir');
  removeConfinedPath(join(owned, 'redirect/keep'), owned);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'outside-sentinel');
  removeConfinedPath(owned, owned);
  assert.equal(existsSync(owned), false);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'outside-sentinel');
});
