import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Session } from 'node:inspector';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, label, output, mode] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(join(root, 'manifest.json'), 'utf8'));
const dist = manifest[label].dist;
const sha = value => createHash('sha256').update(value).digest('hex');
const report = { label, mode: mode ?? 'timing', wallMs: null, operations: 0, errors: [], claims: 0, resumes: 0, outputBytes: 0, expectedRejections: 0, work: {} };
const { Store } = await import(pathToFileURL(join(dist, 'store.js')));
const { nextTurn, completeTurn } = await import(pathToFileURL(join(dist, 'runner.js')));
const store = new Store(join(root, 'state'));
const jobs = store.list();
assert.equal(jobs.length, manifest.apps);
// Independent oracle over the deliberately simple fixture: no production fingerprint helper.
function sourceHash(directory) {
  const hash = createHash('sha256');
  function visit(path) {
    for (const name of fs.readdirSync(path).sort()) {
      if (path === directory && name === '.dart_tool') continue;
      const file = join(path, name), stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink());
      if (stat.isDirectory()) visit(file);
      else hash.update(relative(directory, file)).update('\0').update(`${stat.size}:${stat.mode & 0o777}\0`).update(fs.readFileSync(file));
    }
  }
  visit(directory);
  return hash.digest('hex');
}
const expected = new Map(jobs.map(job => {
  const peers = jobs.filter(peer => peer.spec.id !== job.spec.id).sort((a, b) => a.id.localeCompare(b.id)).map(peer => ({ jobId: peer.id, spec: peer.spec, source: peer.workspace, importedSource: peer.sourceDirectory, directory: '.', revision: { source: sourceHash(peer.workspace), dependencies: sha('factory-dependency-resolution-v1\0missing') } }));
  return [job.id, { peers: JSON.parse(JSON.stringify(peers)), digest: sha(JSON.stringify(peers)) }];
}));
const prompts = {};
const goldenPath = join(root, 'expected-prompts.json');
const golden = fs.existsSync(goldenPath) ? JSON.parse(fs.readFileSync(goldenPath, 'utf8')) : null;
let instrumentation = false;
let session;
const post = (method, parameters = {}) => new Promise((resolve, reject) => session.post(method, parameters, (error, result) => error ? reject(error) : resolve(result)));
if (mode === '--instrument') {
  for (const name of ['readFileSync', 'readdirSync', 'lstatSync', 'realpathSync', 'existsSync']) {
    const original = fs[name];
    fs[name] = function (...args) {
      if (!instrumentation) return Reflect.apply(original, this, args);
      const entry = report.work[name] ??= { calls: 0, bytes: 0, microseconds: 0 };
      const start = process.hrtime.bigint();
      try {
        const value = Reflect.apply(original, this, args);
        entry.calls++;
        if (name === 'readFileSync') {
          entry.bytes += Buffer.byteLength(value);
          const path = String(args[0]);
          if (path.includes('/workspaces/') && /\/(?:source-\d+\.dart|pubspec\.yaml)$/.test(path)) {
            const key = path.endsWith('pubspec.yaml') ? 'manifestReads' : 'payloadReads';
            const count = report.work[key] ??= { calls: 0, bytes: 0 };
            count.calls++;
            count.bytes += Buffer.byteLength(value);
          }
        }
        return value;
      } finally { entry.microseconds += Number(process.hrtime.bigint() - start) / 1000; }
    };
  }
  syncBuiltinESMExports();
  const list = Store.prototype.list;
  Store.prototype.list = function (...args) {
    if (instrumentation) report.work.storeListCalls = (report.work.storeListCalls ?? 0) + 1;
    return Reflect.apply(list, this, args);
  };
  session = new Session();
  session.connect();
  await post('Profiler.enable');
  await post('Profiler.start');
}
function consume(action, job, resumed) {
  const serialized = JSON.stringify(action);
  report.outputBytes += Buffer.byteLength(serialized);
  const result = JSON.parse(serialized);
  assert.equal(result.action, 'host');
  assert.equal(result.job.id, job.id);
  assert.equal(result.job.stage, 'research');
  assert.equal(result.job.status, 'running');
  assert.equal(result.job.hostTurns, 1);
  assert.deepEqual(result.job.attempts, { research: 1 });
  assert.equal(result.turn.id, result.job.turn.id);
  assert.match(result.turn.id, /^[a-f0-9-]{36}$/);
  assert.equal(result.turn.cwd, job.workspace);
  assert.equal(result.turn.stage, 'research');
  assert.deepEqual(result.turn.environment, { CI: '1' });
  assert.equal(result.job.turn.policyContextDigest, expected.get(job.id).digest);
  const marker = 'Other same-channel products, including pending batch packages (read-only comparison): ';
  const start = result.turn.prompt.indexOf(marker);
  assert(start >= 0);
  const peerLine = result.turn.prompt.slice(start + marker.length).split('\n')[0];
  assert.deepEqual(JSON.parse(peerLine), expected.get(job.id).peers);
  if (resumed) assert.deepEqual(result.turn, prompts[job.id].turn);
  else prompts[job.id] = { hash: sha(result.turn.prompt), turn: result.turn };
  if (golden) assert.equal(sha(result.turn.prompt), golden[job.id], 'Full prompt differs from frozen baseline');
  return result;
}
const cpuStart = process.cpuUsage();
const started = process.hrtime.bigint();
instrumentation = mode === '--instrument';
try {
  for (const resumed of [false, true]) {
    for (const job of jobs) {
      report.operations++;
      try {
        consume(await nextTurn(store, job.id), job, resumed);
        report[resumed ? 'resumes' : 'claims']++;
      } catch (error) { report.errors.push({ operation: resumed ? 'resume' : 'claim', job: job.id, message: error.stack }); }
    }
  }
} finally {
  report.wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  report.cpu = process.cpuUsage(cpuStart);
  instrumentation = false;
}
if (session) {
  const { profile } = await post('Profiler.stop');
  fs.writeFileSync(output.replace(/\.json$/, '.cpuprofile'), JSON.stringify(profile));
  session.disconnect();
  const hits = new Map();
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  for (const id of profile.samples ?? []) {
    const frame = nodes.get(id).callFrame;
    const key = `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
  }
  report.profile = { samples: profile.samples?.length ?? 0, top: [...hits].sort((a, b) => b[1] - a[1]).slice(0, 25) };
}
if (!golden && !report.errors.length) {
  assert.equal(label, 'baseline');
  fs.writeFileSync(goldenPath, JSON.stringify(Object.fromEntries(Object.entries(prompts).map(([id, value]) => [id, value.hash])), null, 2), { flag: 'wx', mode: 0o600 });
}
if (mode === '--correctness' && !report.errors.length) {
  async function rejectsPeerChange(name, mutate, restore) {
    const target = jobs[0], before = store.get(target.id);
    try {
      mutate();
      await assert.rejects(nextTurn(store, target.id), /peer comparison context changed/);
      report.expectedRejections++;
      assert.throws(() => completeTurn(store, target.id, before.turn.id, {}), /peer comparison context changed/);
      report.expectedRejections++;
      assert.deepEqual(store.get(target.id), before, `${name} stale rejection mutated the claimed task`);
    } catch (error) { report.errors.push({ operation: name, message: error.stack }); }
    finally { restore(); }
    consume(await nextTurn(store, target.id), target, true);
  }
  try {
    // Exercise the native CLI boundary, consume all output, and preserve the exact claim.
    for (const job of jobs) {
      const child = spawnSync(process.execPath, [join(dist, 'cli.js'), 'next', job.id, '--config', join(root, 'factory.json')], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(child.status, 0, child.stderr);
      consume(JSON.parse(child.stdout), job, true);
      report.cliResumes = (report.cliResumes ?? 0) + 1;
    }
    const peer = jobs[1], file = join(peer.workspace, 'lib', 'source-00000.dart');
    const bytes = fs.readFileSync(file), stat = fs.statSync(file);
    await rejectsPeerChange('same-size peer source with restored mtime', () => {
      const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
      fs.writeFileSync(file, changed); fs.utimesSync(file, stat.atime, stat.mtime);
    }, () => { fs.writeFileSync(file, bytes); fs.utimesSync(file, stat.atime, stat.mtime); });
    const dependencyDirectory = join(peer.workspace, '.dart_tool');
    await rejectsPeerChange('generated dependency resolution', () => {
      fs.mkdirSync(dependencyDirectory);
      fs.writeFileSync(join(dependencyDirectory, 'package_config.json'), JSON.stringify({ configVersion: 2, packages: [] }));
    }, () => fs.rmSync(dependencyDirectory, { recursive: true, force: true }));
    const originalSpec = store.get(peer.id).spec;
    await rejectsPeerChange('peer metadata', () => store.update(peer.id, { spec: { ...originalSpec, purpose: `${originalSpec.purpose} changed` } }), () => store.update(peer.id, { spec: originalSpec }));
    // Scheduler bookkeeping must not invalidate peer comparison inputs.
    store.update(peer.id, { feedback: 'Scheduling-only marker', nextAt: peer.nextAt + 1 });
    consume(await nextTurn(store, jobs[0].id), jobs[0], true);
    report.schedulingOnlyStable = true;
  } catch (error) { report.errors.push({ operation: 'correctness', message: error.stack }); }
}
report.promptHashes = Object.fromEntries(Object.entries(prompts).map(([id, value]) => [id, value.hash]));
report.memory = process.memoryUsage();
store.close();
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
if (report.errors.length) process.exitCode = 1;
