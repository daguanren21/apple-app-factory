#!/usr/bin/env node
// Run `node benchmarks/peer-context.mjs prepare /absolute/fresh-directory`, then
// `... baseline /absolute/directory` and, after rebuilding externally,
// `... compare /absolute/directory /absolute/candidate/dist`.
// No build, test runner, publisher, SDK, or external service is invoked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus, loadavg, platform, release, arch } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const worker = join(here, 'peer-context-worker.mjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const save = (path, value) => fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
function treeHash(root) {
  const hash = createHash('sha256');
  function walk(directory, prefix = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const path = join(directory, name), relative = `${prefix}${name}`;
      if (fs.statSync(path).isDirectory()) walk(path, `${relative}/`);
      else hash.update(relative).update('\0').update(fs.readFileSync(path));
    }
  }
  walk(root);
  return hash.digest('hex');
}
function snapshot(root, name, dist) {
  const target = join(root, name);
  fs.mkdirSync(target, { mode: 0o700 });
  fs.cpSync(dist, join(target, 'dist'), { recursive: true });
  save(join(target, 'package.json'), { type: 'module' });
  for (const dependency of ['yaml', 'zod']) {
    fs.cpSync(fs.realpathSync(join(packageRoot, 'node_modules', dependency)), join(target, 'node_modules', dependency), { recursive: true });
  }
  return { dist: join(target, 'dist'), digest: treeHash(target), dependencies: Object.fromEntries(['yaml', 'zod'].map(name => [name, json(join(target, 'node_modules', name, 'package.json')).version])) };
}
function number(value, fallback, minimum) {
  const result = value === undefined ? fallback : Number(value);
  assert(Number.isSafeInteger(result) && result >= minimum, `Expected integer >= ${minimum}`);
  return result;
}
function reset(root) {
  const manifest = json(join(root, 'manifest.json'));
  assert.equal(manifest.owner, 'apphx-peer-context-benchmark-v1');
  const state = join(root, 'state');
  fs.rmSync(state, { recursive: true, force: true });
  fs.cpSync(join(root, 'seed-state'), state, { recursive: true });
}
export function runWorker(command, args, path, stderrPath, timeout = 300000) {
  fs.rmSync(path, { force: true });
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  fs.writeFileSync(stderrPath, result.stderr ?? '');
  let data;
  try {
    data = json(path);
    assert(data && typeof data === 'object' && !Array.isArray(data), 'Expected a report object');
    assert(Array.isArray(data.errors) && data.errors.every(error => error && typeof error.message === 'string'), 'Expected structured errors');
    assert(Number.isFinite(data.wallMs) && data.wallMs >= 0, 'Expected a finite nonnegative wallMs');
    assert(Number.isSafeInteger(data.operations) && data.operations >= 0, 'Expected a nonnegative operation count');
  } catch (error) {
    data = { errors: [{ operation: 'worker-report', message: `Missing or malformed fresh worker report: ${error.message}` }], wallMs: null, operations: 0 };
  }
  if (result.error) data.errors.push({ operation: 'worker-process', message: `Worker spawn failed: ${result.error.message}` });
  if (result.signal) data.errors.push({ operation: 'worker-process', message: `Worker terminated by signal ${result.signal}` });
  if (result.status !== 0) data.errors.push({ operation: 'worker-process', message: `Worker exited with status ${result.status}` });
  data.exitStatus = result.status;
  data.signal = result.signal;
  save(path, data);
  return data;
}
function sample(root, label, name, options = []) {
  reset(root);
  const path = join(root, `${name}.json`);
  return runWorker(process.execPath, [worker, root, label, path, ...options], path, join(root, `${name}.stderr`));
}
function summarize(samples) {
  const times = samples.map(value => value.wallMs).filter(value => value !== null).sort((a, b) => a - b);
  return { samples: samples.length, measuredSamples: times.length, medianMs: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.ceil((times.length - 1) / 2)]) / 2 : null,
    rangeMs: times.length ? [times[0], times.at(-1)] : null,
    operations: samples.reduce((sum, value) => sum + (value.operations ?? 0), 0), errors: samples.reduce((sum, value) => sum + value.errors.length, 0),
    rawMs: samples.map(value => value.wallMs) };
}
async function prepare(root, args) {
  const apps = number(args[0], 10, 2), files = number(args[1], 128, 1), bytes = number(args[2], 4096, 128), samples = number(args[3], 5, 5);
  fs.mkdirSync(root, { mode: 0o700 }); // Refuse an existing directory, including somebody else's fixture.
  const baseline = snapshot(root, 'baseline', join(packageRoot, 'dist'));
  const { ConfigSchema } = await import(pathToFileURL(join(baseline.dist, 'schemas.js')));
  const { Store } = await import(pathToFileURL(join(baseline.dist, 'store.js')));
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator', maxJobHours: 87600, verification: { checks: [[process.execPath, '--version']], runtime: [[process.execPath, '--version']] } });
  save(join(root, 'factory.json'), config);
  const store = new Store(config.stateDir);
  const jobs = [];
  try {
    for (let app = 0; app < apps; app++) {
      const spec = { id: `peer-benchmark-${app}`, name: `Peer workload ${app}`, framework: 'flutter', platform: 'ios', channel: 'app-store', version: '1.0.0', purpose: `Record collection ${app}`, audience: `Collection keepers ${app}`, differentiators: [`Collection workflow ${app}`], acceptance: [`Preserve collection ${app}`], apple: { appId: `${100000 + app}`, bundleId: `invalid.benchmark.peer${app}`, buildNumber: '1', locale: 'en-US', description: `Deterministic workload ${app}; not a submitted app`, keywords: 'records', supportUrl: 'https://example.invalid/support', privacyPolicyUrl: 'https://example.invalid/privacy', reviewNotes: 'Performance fixture, not App Review evidence', copyright: 'Fixture', manualSetupConfirmed: true, contact: { firstName: 'Test', lastName: 'Only', email: 'test@example.invalid', phone: '+12025550123' } } };
      const job = store.enqueue(spec, config);
      fs.mkdirSync(join(job.workspace, 'lib'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(join(job.workspace, 'pubspec.yaml'), `name: peer_benchmark_${app}\ndependencies:\n  flutter: {sdk: flutter}\n`, { mode: 0o600 });
      for (let file = 0; file < files; file++) {
        const seed = sha(`peer-context-fixed-seed-v1:${app}:${file}`);
        fs.writeFileSync(join(job.workspace, 'lib', `source-${String(file).padStart(5, '0')}.dart`), `// ${seed.repeat(Math.ceil(bytes / seed.length))}`.slice(0, bytes), { mode: 0o600 });
      }
      jobs.push(job);
    }
  } finally { store.close(); }
  fs.cpSync(config.stateDir, join(root, 'seed-state'), { recursive: true });
  const manifest = { owner: 'apphx-peer-context-benchmark-v1', baseline, node: process.version, executable: process.execPath, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, seed: 'peer-context-fixed-seed-v1', apps, files, bytes, samples, jobs, workspaceDigest: treeHash(config.workspaceRoot), seedDigest: treeHash(join(root, 'seed-state')), timing: 'Fresh process; warm OS file cache; imports, fixture reset and oracle creation excluded. Timed 10 claims + 10 resumes include JSON serialization, consumption and exact output assertions. Separate CLI correctness and CPU/instrumented runs.' };
  save(join(root, 'manifest.json'), manifest);
  console.log(JSON.stringify({ root, apps, sourceFiles: apps * (files + 1), payloadBytes: apps * files * bytes, baseline: baseline.digest }));
}
async function main() {
  const [command, input, ...args] = process.argv.slice(2);
  assert(input && ['prepare', 'baseline', 'compare'].includes(command), 'Usage: peer-context.mjs prepare ROOT [apps=10 files=128 bytes=4096 samples=5] | baseline ROOT | compare ROOT CANDIDATE_DIST');
  const root = resolve(input);
  if (command === 'prepare') return prepare(root, args);
  const manifest = json(join(root, 'manifest.json'));
  assert.equal(manifest.node, process.version, 'Node version changed');
  assert.equal(treeHash(join(root, 'baseline')), manifest.baseline.digest, 'Frozen baseline changed');
  assert.equal(treeHash(join(root, 'workspaces')), manifest.workspaceDigest, 'Fixture source changed');
  assert.equal(treeHash(join(root, 'seed-state')), manifest.seedDigest, 'Fixture initial state changed');
  const report = { command, loadBefore: loadavg(), machine: { node: process.version, cpu: cpus()[0]?.model, platform: platform(), release: release(), arch: arch() }, samples: {} };
  if (command === 'compare') {
    assert(args[0], 'Candidate dist directory required');
    manifest.candidate = snapshot(root, 'candidate', resolve(args[0]));
    assert.deepEqual(manifest.candidate.dependencies, manifest.baseline.dependencies, 'Dependency versions differ');
    save(join(root, 'manifest.json'), manifest);
  }
  const labels = command === 'compare' ? ['baseline', 'candidate'] : ['baseline'];
  report.warmups = Object.fromEntries(labels.map(label => [label, sample(root, label, `${command}-${label}-warmup`)]));
  for (let index = 0; index < manifest.samples; index++) {
    for (const label of index % 2 ? [...labels].reverse() : labels) {
      (report.samples[label] ??= []).push(sample(root, label, `${command}-${label}-${index}`));
    }
  }
  report.summary = Object.fromEntries(labels.map(label => [label, summarize(report.samples[label])]));
  report.correctness = Object.fromEntries(labels.map(label => [label, sample(root, label, `${command}-${label}-correctness`, ['--correctness'])]));
  report.profiles = Object.fromEntries(labels.map(label => [label, sample(root, label, `${command}-${label}-profile`, ['--instrument'])]));
  report.loadAfter = loadavg();
  save(join(root, `${command}-report.json`), report);
  console.log(JSON.stringify({ summary: report.summary, correctness: Object.fromEntries(labels.map(label => [label, report.correctness[label].errors])), profiles: Object.fromEntries(labels.map(label => [label, report.profiles[label].work])) }, null, 2));
  if (Object.values(report.summary).some(value => value.errors || value.measuredSamples !== manifest.samples) || [...Object.values(report.warmups), ...Object.values(report.correctness), ...Object.values(report.profiles)].some(value => value.errors.length)) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
