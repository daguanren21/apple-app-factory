#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const help = `Actual apphx runtime workflows (no product build or installation of tools).
node scripts/runtime-smoke.mjs --out FRESH_DIRECTORY --stack android-java|mygo|all [options]
Android: --sdk SDK --java-home JDK [--gradle COMPATIBLE_CACHED_GRADLE] [--system-image system-images;android-35;google_apis;arm64-v8a]
MyGo: --go GO_BINARY --gopath CACHED_GOPATH --bun BUN_BINARY --frontend-modules EXISTING_NODE_MODULES [--go-cache CACHE]
Optional: --cli CURRENT_DIST_CLI --retained-root ORIGINAL_MYGO_FIXTURE_ROOT
All paths are owner supplied. Android uses a fresh AVD/home and private ADB server,
never user devices. Optional cached Gradle uses an empty user home and offline
built-in Exec project. Without --gradle the same owner-defined SDK pipeline runs
directly: aapt -> javac -> d8 -> ZIP -> zipalign -> ephemeral debug apksigner key.
MyGo dependencies must already be cached (GOPROXY=off); frontend node_modules are
copied from an owner-supplied installation. No package install runs. MyGo native
and WKWebView windows run serially on a logged-in macOS
desktop. Native uses actual AppKit accessibility button actions; Web invokes actual
DOM button handlers and Go bridge. Both relaunch and verify durable state. This is
not OS-pointer automation, Apple device testing, publication or store-policy proof.
Each CLI workflow abandons and reacquires an interrupted build turn under the same
job ID, then verifies, reviews and packages. No state/database editing is used.
Outputs include raw command logs, CLI transitions, source snapshots, runtime PNGs,
artifact validation and evidence.json. Original fixtures remain untouched.
`;
const args = process.argv.slice(2), options = {};
if (!args.length || args.includes('--help')) { console.log(help); process.exit(0); }
for (let i = 0; i < args.length; i += 2) {
  assert.match(args[i], /^--[a-z-]+$/); assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `Missing ${args[i]}`);
  options[args[i].slice(2)] = args[i + 1];
}
for (const key of Object.keys(options)) assert.ok(['out','stack','sdk','java-home','gradle','system-image','go','gopath','bun','frontend-modules','go-cache','cli','retained-root'].includes(key), `Unknown --${key}`);
assert.ok(options.out, '--out must be a fresh directory');
const root = resolve(options.out);
assert.ok(!existsSync(root), 'Refusing an existing output directory');
mkdirSync(root, { recursive: true });
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(packageRoot, 'examples/runtime');
const cli = resolve(options.cli ?? join(packageRoot, 'dist/cli.js'));
const stack = options.stack ?? 'all';
assert.ok(['all', 'android-java', 'mygo'].includes(stack));
const evidence = { root, cli, startedAt: new Date().toISOString(), runs: [], commands: [], limitations: ['Local build-only; no Apple devices, store approval or publishing', 'Acceptance drivers exercise native accessibility/DOM controls, not external physical input'], cleanup: [] };
let sequence = 0;
function command(argv, { cwd = root, env = process.env, input, timeout = 300000 } = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env, input, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  const log = join(root, `command-${String(++sequence).padStart(3, '0')}.json`);
  writeFileSync(log, JSON.stringify({ argv, cwd, status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2));
  evidence.commands.push(log);
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${argv.join(' ')} exited ${result.status}; see ${log}\n${result.stderr}`);
  return result.stdout;
}
function snapshot(directory) {
  const files = {};
  function walk(relative = '') {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Source symlink refused: ${name}`);
      if (entry.isDirectory()) walk(name);
      else files[name] = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
    }
  }
  walk(); return files;
}
function png(path) {
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(bytes.length > 1000); assert.ok(bytes.readUInt32BE(16) > 100 && bytes.readUInt32BE(20) > 100);
  return { path, bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function workflow(name, profile, environment, prepare = () => {}) {
  const control = join(root, name); mkdirSync(control);
  const source = join(control, 'source');
  cpSync(join(fixtures, name), source, { recursive: true, filter: path => !['build', 'dist', 'node_modules', '.gradle'].includes(path.split('/').at(-1)) });
  const before = snapshot(source);
  const spec = { id: `runtime-${name}`, name: profile.name, framework: profile.framework, platform: profile.platform, channel: 'local', version: '0.1.0', purpose: 'Exercise a real visible application and durable local records', audience: 'Application maintainers', differentiators: ['Real compiled application and persisted UI state'], acceptance: [profile.acceptance], screenshotsDir: 'build/screenshots', project: { sourceDir: source } };
  const config = { stateDir: join(control, 'state'), workspaceRoot: join(control, 'workspaces'), allowLocalExecution: true, allowSubmit: false, allowRelease: false, allowCloudBuild: false, timeoutMs: 300000, retryDelayMs: 1, packageTarget: profile.target, executionEnv: profile.executionEnv, verification: { prerequisites: profile.prerequisites, checks: [profile.build], runtime: profile.runtime }, packaging: { provider: 'local', commands: [profile.build], artifactPath: profile.artifact } };
  const configPath = join(control, 'factory.json'), specPath = join(control, 'requirement.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2)); writeFileSync(specPath, JSON.stringify(spec, null, 2));
  const transitions = [];
  function invoke(argv) { const value = JSON.parse(command([process.execPath, cli, ...argv, '--config', configPath, '--build-only'], { cwd: control, env: environment })); transitions.push({ argv, value }); writeFileSync(join(control, 'transitions.json'), JSON.stringify(transitions, null, 2)); return value; }
  const job = invoke(['enqueue', specPath]);
  let turn = invoke(['next', job.id]);
  const research = join(control, 'research.json');
  writeFileSync(research, JSON.stringify({ viable: true, policySources: [], distinctness: 'Local runtime validation only, no store differentiation or approval claim.', plan: ['Compile real application, interact with visible controls, relaunch durable state, validate signed artifact'] }));
  invoke(['complete', job.id, turn.turn.id, research]);
  turn = invoke(['next', job.id]); assert.equal(turn.turn.stage, 'build');
  const interrupted = turn.turn.id;
  invoke(['abandon', job.id, interrupted]);
  turn = invoke(['next', job.id]); assert.equal(turn.turn.stage, 'build'); assert.notEqual(turn.turn.id, interrupted); assert.equal(turn.job.id, job.id);
  const resumed = turn.turn.id;
  const workspace = turn.turn.cwd;
  prepare(workspace);
  invoke(['complete', job.id, turn.turn.id]);
  const verified = invoke(['step', job.id]); assert.equal(verified.stage, 'review', JSON.stringify(verified));
  const screenshots = profile.screenshots.map(path => png(join(workspace, path)));
  profile.assertRuntime(workspace);
  turn = invoke(['next', job.id]);
  const review = join(control, 'review.json');
  writeFileSync(review, JSON.stringify({ approved: true, findings: [], acceptanceEvidence: [{ requirement: spec.acceptance[0], evidence: `Actual compiled UI interaction and persisted relaunch succeeded in runtime logs; validated PNGs: ${screenshots.map(item => item.sha256).join(', ')}. This driver records observable acceptance, not an independent policy review.` }] }));
  invoke(['complete', job.id, turn.turn.id, review]);
  const built = invoke(['step', job.id]); assert.equal(built.status, 'built', JSON.stringify(built)); assert.equal(built.artifact.kind, profile.kind);
  profile.validateArtifact(join(workspace, profile.artifact), environment);
  const after = snapshot(source); assert.deepEqual(after, before);
  for (const [path, digest] of Object.entries(before)) assert.equal(createHash('sha256').update(readFileSync(join(workspace, path))).digest('hex'), digest, `Imported source changed: ${path}`);
  writeFileSync(join(control, 'source-snapshots.json'), JSON.stringify({ before, after }, null, 2));
  const events = invoke(['events', job.id]);
  evidence.runs.push({ name, jobId: job.id, control, workspace, artifact: built.artifact, screenshots, interruptedTurn: interrupted, resumedTurn: resumed, interruptionRecovery: 'CLI abandon + next retained job ID and issued a fresh build turn', sourceUnchanged: true, events });
}
async function freePort(preferred) {
  const server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(preferred ?? 0, '127.0.0.1', ok); });
  const port = server.address().port;
  await new Promise(ok => server.close(ok)); return port;
}
const retainedBefore = options['retained-root'] ? Object.fromEntries(['native-source','web-source'].map(name => [name, snapshot(join(options['retained-root'], name))])) : null;
async function android() {
  for (const key of ['sdk','java-home']) assert.ok(options[key], `Android requires --${key}`);
  const sdk = resolve(options.sdk), java = resolve(options['java-home']);
  const owned = join(root, 'android-device'); mkdirSync(owned);
  const avdHome = join(owned, 'avd'), home = join(owned, 'home'); mkdirSync(avdHome); mkdirSync(home);
  const env = { ...process.env, ANDROID_SDK_ROOT: sdk, ANDROID_HOME: sdk, JAVA_HOME: java, ANDROID_AVD_HOME: avdHome, ANDROID_USER_HOME: home, ANDROID_EMULATOR_HOME: home, GRADLE_USER_HOME: join(owned, 'gradle'), PATH: `${join(java,'bin')}:${process.env.PATH}` };
  const avd = `apphx-smoke-${randomBytes(8).toString('hex')}`, port = await freePort();
  let emulatorPort;
  for (let candidate = 5580; candidate < 5680; candidate += 2) { try { await freePort(candidate); await freePort(candidate + 1); emulatorPort = candidate; break; } catch {} }
  assert.ok(emulatorPort, 'No unused emulator console/ADB port pair');
  const serial = `emulator-${emulatorPort}`;
  env.ANDROID_ADB_SERVER_PORT = String(port); env.ADB_SERVER_SOCKET = `tcp:127.0.0.1:${port}`;
  const session = join(owned, 'session.json'); writeFileSync(session, JSON.stringify({ sdk, avd, serial, port }));
  const adb = (...args) => command([join(sdk, 'platform-tools/adb'), '-P', String(port), ...args], { env, timeout: 45000 });
  let emulator;
  const interrupted = signal => {
    if (emulator?.pid) emulator.kill('SIGKILL');
    try { adb('kill-server'); } catch {}
    evidence.status = 'interrupted'; evidence.error = signal;
    evidence.cleanup.push({ emulatorPid: emulator?.pid, adbPort: port, signalCleanupRequested: true });
    writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
    process.exit(130);
  };
  const onInterrupt = () => interrupted('SIGINT'), onTerminate = () => interrupted('SIGTERM');
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
  try {
    command([join(sdk, 'cmdline-tools/22.0/bin/avdmanager'), 'create', 'avd', '-n', avd, '-k', options['system-image'] ?? 'system-images;android-35;google_apis;arm64-v8a', '-p', join(avdHome, avd + '.avd')], { env, input: 'no\n' });
    adb('start-server');
    const fd = openSync(join(owned, 'emulator.log'), 'w');
    emulator = spawn(join(sdk, 'emulator/emulator'), ['-avd', avd, '-port', String(emulatorPort), '-no-snapshot', '-no-audio', '-no-boot-anim', '-gpu', 'swiftshader_indirect', '-camera-back', 'none', '-camera-front', 'none'], { env, stdio: ['ignore', fd, fd] }); closeSync(fd);
    let launchError; emulator.on('error', error => { launchError = error; });
    const deadline = Date.now() + 180000;
    let booted = false;
    while (Date.now() < deadline) {
      await new Promise(ok => setTimeout(ok, 1500));
      if (launchError) throw launchError;
      if (emulator.exitCode !== null) throw new Error(`Owned emulator exited ${emulator.exitCode}; see emulator.log`);
      const result = spawnSync(join(sdk, 'platform-tools/adb'), ['-P', String(port), '-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { env, encoding: 'utf8', timeout: 5000 });
      if (result.status === 0 && result.stdout.trim() === '1') { booted = true; break; }
    }
    assert.ok(booted, 'Owned emulator did not boot within 180s');
    adb('-s', serial, 'shell', 'input', 'keyevent', '82');
    const build = options.gradle ? [resolve(options.gradle), '--offline', '--no-daemon', '--console=plain', `-Pnode=${process.execPath}`, ':app:assembleDebug'] : [process.execPath, 'sdk-build.mjs'];
    await workflow('android-java', { name: 'apphx Local Records', framework: 'android-java', platform: 'android', target: 'apk', kind: 'apk', executionEnv: ['ANDROID_SDK_ROOT','ANDROID_HOME','JAVA_HOME','GRADLE_USER_HOME'], prerequisites: [[join(java,'bin/java'), '-version']], build, runtime: [[process.execPath, join(fixtures,'android-ui.mjs'), session]], artifact: 'build/records.apk', acceptance: 'Enter a record with native Android controls; save and force-stop/relaunch; visible text and SharedPreferences retain the exact record', screenshots: ['build/screenshots/saved.png','build/screenshots/relaunch.png'], assertRuntime: workspace => { const value = JSON.parse(readFileSync(join(workspace,'build/runtime-evidence.json'))); assert.equal(value.relaunched, true); assert.equal(value.avd,avd); }, validateArtifact: artifact => { assert.equal(readFileSync(artifact).subarray(0,2).toString(),'PK'); command([join(sdk,'build-tools/35.0.0/apksigner'),'verify','--verbose','--print-certs',artifact],{env}); command([join(sdk,'build-tools/35.0.0/aapt'),'dump','badging',artifact],{env}); } }, env);
  } finally {
    if (emulator && emulator.exitCode === null && emulator.signalCode === null) {
      emulator.kill('SIGTERM');
      await Promise.race([new Promise(ok => emulator.once('exit', ok)), new Promise(ok => setTimeout(ok,5000))]);
      if (emulator.exitCode === null && emulator.signalCode === null) {
        emulator.kill('SIGKILL');
        await new Promise(ok => emulator.once('exit', ok));
      }
      evidence.cleanup.push({ emulatorPid: emulator.pid, exitCode: emulator.exitCode, signal: emulator.signalCode, exited: true });
    }
    try { adb('kill-server'); evidence.cleanup.push({ adbPort:port, stopped:true }); } catch(error) { evidence.cleanup.push({ adbPort:port, error:error.message }); }
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
  }
}
async function mygo() {
  for (const key of ['go','gopath','bun','frontend-modules']) assert.ok(options[key], `MyGo requires --${key}`);
  const go = resolve(options.go), gopath = resolve(options.gopath);
  const env = { ...process.env, PATH: `${dirname(go)}:${dirname(resolve(options.bun))}:${process.env.PATH}`, GOPATH:gopath, GOMODCACHE:join(gopath,'pkg/mod'), GOCACHE:resolve(options['go-cache'] ?? join(root,'gocache')), GOPROXY:'off', GOSUMDB:'off', GOTOOLCHAIN:'local', GOWORK:'off', CGO_ENABLED:'0' };
  const build = [go,'tool','mygo','build','-platform',`darwin/${process.arch}`,'-sign','-','-skip-notarize','-skip-dmg','-o','build'];
  for (const mode of ['native','web']) {
    const name = mode === 'native' ? 'MyGo App' : 'MyGo Web App';
    const artifact = `build/darwin-${process.arch}/${name}.app`, executable = `${artifact}/Contents/MacOS/${name}`;
    const state = 'build/counter-state';
    const runtime = mode === 'native' ? [[executable,'-acceptance','first','-state-file',state,'-screenshot','build/screenshots/first.png'],[executable,'-acceptance','relaunch','-state-file',state,'-screenshot','build/screenshots/relaunch.png']] : [[executable,'-acceptance','-state-file',state,'-screenshot','build/screenshots/first.png'],[executable,'-acceptance','-relaunch','-state-file',state,'-screenshot','build/screenshots/relaunch.png']];
    await workflow(`mygo-${mode}`, { name, framework:'mygo', platform:'macos', target:'app', kind:'macos-app', executionEnv:['GOPATH','GOMODCACHE','GOCACHE','GOPROXY','GOSUMDB','CGO_ENABLED'], prerequisites:[[go,'version'],[go,'tool','mygo','version']], build, runtime, artifact, acceptance:mode === 'native' ? 'Visible AppKit buttons transition 1,2,1; relaunch restores 1 and Reset persists 0' : 'Visible WKWebView Add saves 3 through Go bridge; negative subtraction is rejected; fresh process restores visible 3', screenshots:['build/screenshots/first.png','build/screenshots/relaunch.png'], assertRuntime: workspace => assert.equal(readFileSync(join(workspace,state),'utf8'),mode === 'native' ? '0':'3'), validateArtifact: artifact => { command(['/usr/bin/codesign','--verify','--deep','--strict',artifact],{env}); const result = command(['/usr/bin/file',join(artifact,'Contents/MacOS',name)],{env}); assert.ok(result.includes('Mach-O')); } }, env, workspace => {
      if (mode === 'web') {
        const modules = resolve(options['frontend-modules']);
        assert.equal(JSON.parse(readFileSync(join(modules, 'mygo-runtime/package.json'))).version, '0.3.0');
        cpSync(modules, join(workspace, 'node_modules'), { recursive: true, dereference: true });
        command(build, { cwd: workspace, env });
      }
    });
  }
}
try {
  if (stack === 'all' || stack === 'android-java') await android();
  if (stack === 'all' || stack === 'mygo') await mygo();
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = error.stack; process.exitCode = 1;
} finally {
  if (retainedBefore) { const retainedAfter = Object.fromEntries(['native-source','web-source'].map(name => [name,snapshot(join(options['retained-root'],name))])); evidence.retainedOriginalsUnchanged = JSON.stringify(retainedBefore) === JSON.stringify(retainedAfter); if (!evidence.retainedOriginalsUnchanged) { evidence.status='failed'; process.exitCode=1; } }
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(join(root,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
}
