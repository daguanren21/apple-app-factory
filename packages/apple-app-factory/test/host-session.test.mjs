import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectProcess, processIsAlive } from '../dist/process.js';

const hostModule = new URL('../dist/host-session.js', import.meta.url).href;
const posix = { skip: !['darwin', 'linux'].includes(process.platform), timeout: 30000 };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'apphx-host-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const probe = join(root, 'owner.mjs');
  writeFileSync(probe, `import {resolveHostOwner} from ${JSON.stringify(hostModule)};
    try {
      const explicit = process.argv[2] === 'self' ? String(process.pid) : process.argv[2];
      console.log(JSON.stringify({...resolveHostOwner(explicit), parentPid:process.ppid}));
    } catch(error) { console.error(error.message); process.exitCode=1; }
  `);
  const env = { ...process.env };
  delete env.APPHX_HOST_PID;
  return { root, probe, env };
}

function invoke(f, args = [], env = f.env) {
  const result = spawnSync(process.execPath, [f.probe, ...args], { env, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function owner(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('direct CLI defaults to its live parent incarnation, not a more distant Node ancestor', posix, t => {
  const f = fixture(t);
  const result = owner(invoke(f));
  assert.equal(result.parentPid, process.pid);
  assert.equal(result.ownerPid, process.pid);
  assert.equal(result.ownerIdentity, inspectProcess(process.pid).identity);
});

test('explicit ancestor and APPHX_HOST_PID resolve across a real intermediate process; flag wins', posix, t => {
  const f = fixture(t);
  const launcher = join(f.root, 'launcher.mjs');
  writeFileSync(launcher, `import {spawnSync} from 'node:child_process';
    const child=spawnSync(process.execPath, [${JSON.stringify(f.probe)}, ...process.argv.slice(2)], {env:process.env, encoding:'utf8'});
    process.stdout.write(child.stdout); process.stderr.write(child.stderr); process.exitCode=child.status ?? 1;
  `);
  const run = (args, env) => {
    const result = spawnSync(process.execPath, [launcher, ...args], { env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    return owner(result);
  };
  const explicit = run([String(process.pid)], { ...f.env, APPHX_HOST_PID: 'not-a-pid' });
  assert.notEqual(explicit.parentPid, process.pid);
  assert.equal(explicit.ownerPid, process.pid);
  assert.equal(explicit.ownerIdentity, inspectProcess(process.pid).identity);
  const inherited = run([], { ...f.env, APPHX_HOST_PID: String(process.pid) });
  assert.notEqual(inherited.parentPid, process.pid);
  assert.equal(inherited.ownerPid, process.pid);
});

test('invalid PIDs, the current CLI and PID 1 cannot become a native owner', posix, t => {
  const f = fixture(t);
  for (const value of ['', '0', '-1', '1.5', ' 2', '2x', '2147483648', 'self', '1']) {
    const result = invoke(f, [value]);
    assert.equal(result.status, 1, `${value}: ${result.stdout}`);
    assert.match(result.stderr, /--host-pid/);
  }
  const invalidEnvironment = invoke(f, [], { ...f.env, APPHX_HOST_PID: '' });
  assert.equal(invalidEnvironment.status, 1);
  assert.match(invalidEnvironment.stderr, /positive PID/);
});

test('a live sibling and an exited process are not controller ancestors', posix, async t => {
  const f = fixture(t);
  const sibling = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise((resolve, reject) => { sibling.once('error', reject); sibling.once('close', resolve); });
  t.after(async () => {
    if (sibling.exitCode === null && sibling.signalCode === null) sibling.kill('SIGKILL');
    await exited;
  });
  await new Promise((resolve, reject) => { sibling.once('message', resolve); sibling.once('error', reject); });
  const unrelated = invoke(f, [String(sibling.pid)]);
  assert.equal(unrelated.status, 1);
  assert.match(unrelated.stderr, /ancestor/);
  assert.equal(processIsAlive(sibling.pid), true, 'An invalid owner selection must not signal the unrelated live process');
  sibling.kill('SIGTERM');
  await exited;
  const dead = invoke(f, [String(sibling.pid)]);
  assert.equal(dead.status, 1);
  assert.match(dead.stderr, /--host-pid/);
});

test('an unrecognized one-shot shell fails closed, while an explicit controller traverses it', posix, t => {
  const f = fixture(t);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  // The trailing command keeps the real shell alive instead of exec-replacing it.
  const command = `${quote(process.execPath)} ${quote(f.probe)}; result=$?; exit "$result"`;
  const uncertain = spawnSync('/bin/sh', ['-c', command], { env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.ifError(uncertain.error);
  assert.equal(uncertain.status, 1, uncertain.stdout);
  assert.match(uncertain.stderr, /--host-pid/);
  const explicit = spawnSync('/bin/sh', ['-c', command], { env: { ...f.env, APPHX_HOST_PID: String(process.pid) }, encoding: 'utf8', timeout: 10000 });
  assert.ifError(explicit.error);
  const resolved = owner(explicit);
  assert.notEqual(resolved.parentPid, process.pid);
  assert.equal(resolved.ownerPid, process.pid);
});

test('overwritten package-manager-like process titles never become automatic owner evidence', posix, t => {
  const f = fixture(t);
  const launcher = join(f.root, 'retitled-launcher.mjs');
  writeFileSync(launcher, `import {spawnSync} from 'node:child_process';
    process.title='npm exec apphx';
    const child=spawnSync(process.execPath,[${JSON.stringify(f.probe)}],{env:process.env,encoding:'utf8'});
    process.stdout.write(child.stdout);process.stderr.write(child.stderr);process.exitCode=child.status ?? 1;
  `);
  const automatic = spawnSync(process.execPath, [launcher], { env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.ifError(automatic.error);
  assert.equal(automatic.status, 1, automatic.stdout);
  assert.match(automatic.stderr, /--host-pid/);
  const explicit = spawnSync(process.execPath, [launcher], { env: { ...f.env, APPHX_HOST_PID: String(process.pid) }, encoding: 'utf8', timeout: 10000 });
  assert.ifError(explicit.error);
  assert.equal(owner(explicit).ownerPid, process.pid);
});

test('module and Corepack-shaped dispatchers cannot become implicit persistent owners', posix, t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const name of ['pnpm.mjs', 'corepack.js', 'corepack']) {
    const launcher = join(f.root, name);
    // A real transient process with the OS entrypoint shape, not a substitute
    // package-manager implementation; installed pnpm is exercised separately.
    writeFileSync(launcher, `import {spawnSync} from 'node:child_process';
      const args=process.argv.slice(2);if(args[0]==='pnpm')args.shift();
      if(args.shift()!=='exec')throw new Error('Unexpected dispatcher fixture');
      const child=spawnSync(args.shift(),args,{env:process.env,encoding:'utf8'});
      process.stdout.write(child.stdout);process.stderr.write(child.stderr);process.exitCode=child.status ?? 1;
    `);
    const args = [launcher, ...(name.startsWith('corepack') ? ['pnpm'] : []), 'exec', process.execPath, f.probe];
    const env = { ...f.env }; delete env.npm_execpath;
    const automatic = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(automatic.error);
    if (name.startsWith('corepack')) assert.equal(automatic.status, 1, automatic.stdout);
    if (automatic.status === 0) assert.equal(owner(automatic).ownerPid, process.pid, 'A recognized module dispatcher must be skipped');
    else assert.match(automatic.stderr, /--host-pid/);
    const explicit = spawnSync(process.execPath, args, { env: { ...env, APPHX_HOST_PID: String(process.pid) }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(explicit.error);
    const selected = owner(explicit);
    assert.equal(selected.ownerPid, process.pid);
    assert.notEqual(selected.parentPid, process.pid);
    assert.equal(selected.ownerIdentity, inspectProcess(process.pid).identity);
  }
});
