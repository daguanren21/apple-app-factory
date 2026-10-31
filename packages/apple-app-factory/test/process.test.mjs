import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { run, processGroupAlive, inspectProcessGroup, signalOwnedProcessGroup } from '../dist/process.js';

const posix = { skip: process.platform === 'win32', timeout: 15000 };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-process-barrier-'));
  const controllers = [], pending = [], groups = new Map();
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    for (const [pid, identity] of groups) {
      try { signalOwnedProcessGroup(pid, identity, 'SIGKILL'); } catch {}
    }
    await Promise.allSettled(pending);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, groups,
    start(argv, options = {}) {
      const controller = new AbortController();
      controllers.push(controller);
      const promise = run(argv, {
        timeoutMs: 5000, ...options, signal: controller.signal,
        onSpawn(pid, metadata) {
          groups.set(pid, metadata.identity);
          return options.onSpawn?.(pid, metadata);
        },
      });
      pending.push(promise);
      promise.catch(() => {});
      return { promise, controller };
    },
  };
}

test('tracked commands wait for metadata acknowledgement and preserve argv, stdin, env, cwd and group ownership', posix, async t => {
  const f = fixture(t);
  const committed = join(f.root, 'committed'), effect = join(f.root, 'effect'), log = join(f.root, 'command.log');
  const acknowledgement = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const args = ['with spaces', '', 'line\nbreak', '$(not-a-shell)', "quote'\"value"];
  const input = 'input with spaces and unicode λ\n'.repeat(4096);
  let metadata, pid;
  const source = `const fs=require('node:fs');
    if(!fs.existsSync(${JSON.stringify(committed)})) throw new Error('Payload preceded ownership commit');
    fs.writeFileSync(${JSON.stringify(effect)},'started');
    let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',value=>input+=value);
    process.stdin.on('end',()=>{
      console.error('command stderr');
      console.log(JSON.stringify({pid:process.pid,parentPid:process.ppid,argv:process.argv.slice(1),cwd:process.cwd(),input,env:process.env.BARRIER_VALUE,token:process.env.APPLE_APP_FACTORY_COMMAND_TOKEN}));
    });`;
  const active = f.start([process.execPath, '-e', source, '--', ...args], {
    cwd: f.root, env: { PATH: process.env.PATH, BARRIER_VALUE: 'preserved value' }, input, logPath: log,
    async onSpawn(value, details) {
      pid = value; metadata = details;
      entered.resolve();
      await acknowledgement.promise;
      writeFileSync(committed, JSON.stringify({ pid, metadata }));
    },
  });
  await entered.promise;
  await sleep(200);
  assert.equal(existsSync(effect), false, 'Even a delayed metadata commit must precede payload execution');
  assert.equal(inspectProcessGroup(pid, metadata.identity), 'owned', 'The waiting bootstrap carries its recovery token');
  acknowledgement.resolve();
  const result = await active.promise;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, 'command stderr\n');
  const observed = JSON.parse(result.stdout);
  assert.equal(Number.isSafeInteger(observed.pid), true);
  assert.notEqual(observed.pid, pid, 'Registered ownership belongs to the group supervisor, not the payload PID');
  assert.deepEqual(observed, { pid: observed.pid, parentPid: pid, argv: args, cwd: realpathSync(f.root), input, env: 'preserved value', token: metadata.identity.token });
  assert.equal(existsSync(effect), true);
  assert.equal(processGroupAlive(pid), false);
  assert.match(readFileSync(log, 'utf8'), /command stderr/);
});

test('an ownership callback failure retires the waiting group without executing payload', posix, async t => {
  const f = fixture(t), effect = join(f.root, 'forbidden');
  const rejected = new Error('Ownership transaction rejected');
  let pid;
  const active = f.start([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(effect)},'wrong')`], {
    async onSpawn(value) { pid = value; await sleep(200); throw rejected; },
  });
  await assert.rejects(active.promise, error => error === rejected);
  assert.equal(processGroupAlive(pid), false);
  assert.equal(existsSync(effect), false);
});

for (const mode of ['abort', 'timeout']) {
  test(`${mode} during metadata acknowledgement never permits a late payload`, posix, async t => {
    const f = fixture(t), effect = join(f.root, 'forbidden');
    const entered = Promise.withResolvers(), acknowledgement = Promise.withResolvers();
    let pid;
    const active = f.start([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(effect)},'wrong')`], {
      timeoutMs: mode === 'timeout' ? 300 : 5000,
      onSpawn(value) { pid = value; entered.resolve(); return acknowledgement.promise; },
    });
    await entered.promise;
    if (mode === 'abort') active.controller.abort();
    await assert.rejects(active.promise, mode === 'abort' ? /interrupted/ : /timed out/);
    acknowledgement.resolve();
    await sleep(100);
    assert.equal(processGroupAlive(pid), false);
    assert.equal(existsSync(effect), false);
  });
}

test('caller Node preload hooks run only in the acknowledged payload', posix, async t => {
  const f = fixture(t), preloadEffect = join(f.root, 'preload-effect'), payloadEffect = join(f.root, 'payload-effect');
  const preload = join(f.root, 'preload.cjs');
  writeFileSync(preload, `require('node:fs').appendFileSync(${JSON.stringify(preloadEffect)},${JSON.stringify('loaded\n')});`);
  const entered = Promise.withResolvers(), acknowledgement = Promise.withResolvers();
  const active = f.start([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(payloadEffect)},'payload')`], {
    env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` },
    onSpawn() { entered.resolve(); return acknowledgement.promise; },
  });
  await entered.promise;
  await sleep(200);
  assert.equal(existsSync(preloadEffect), false);
  assert.equal(existsSync(payloadEffect), false);
  acknowledgement.resolve();
  const result = await active.promise;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(preloadEffect, 'utf8'), 'loaded\n');
  assert.equal(readFileSync(payloadEffect, 'utf8'), 'payload');
});

test('tracked exec resolves PATH relative to cwd and preserves executable failures', posix, async t => {
  const f = fixture(t), bin = join(f.root, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'owned-node'));
  const result = await f.start(['owned-node', '-e', 'process.stdout.write("resolved")'], { cwd: f.root, env: { PATH: 'bin' } }).promise;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'resolved');
  const missing = join(f.root, 'missing');
  await assert.rejects(f.start([missing]).promise, error => error.code === 'ENOENT' && error.syscall === `spawn ${missing}` && error.path === missing);
  const denied = join(f.root, 'denied');
  writeFileSync(denied, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  await assert.rejects(f.start([denied]).promise, error => error.code === 'EACCES');
  await assert.rejects(f.start([bin]).promise, error => error.code === 'EACCES');
  await assert.rejects(f.start([process.execPath], { cwd: missing }).promise, error => error.code === 'ENOENT');
  const missingInterpreter = join(f.root, 'missing-interpreter');
  writeFileSync(missingInterpreter, `#!${missing}\nexit 0\n`, { mode: 0o700 });
  await assert.rejects(f.start([missingInterpreter]).promise, error => error.code === 'ENOENT' && error.syscall === `spawn ${missingInterpreter}`);
  const invalidExecutable = join(f.root, 'invalid-executable');
  writeFileSync(invalidExecutable, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), { mode: 0o700 });
  const outcome = promise => promise.then(result => ({ result }), error => ({ error: { code: error.code, errno: error.errno, syscall: error.syscall, path: error.path, spawnargs: error.spawnargs } }));
  assert.deepEqual(await outcome(f.start([invalidExecutable]).promise), await outcome(run([invalidExecutable], { timeoutMs: 5000 })));
});

test('supervised and untracked commands do not depend on optional execve support', { timeout: 10000 }, async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'execve');
  Object.defineProperty(process, 'execve', { configurable: true, writable: true, value: undefined });
  t.after(() => { if (descriptor) Object.defineProperty(process, 'execve', descriptor); else delete process.execve; });
  let spawned = false;
  const tracked = run([process.execPath, '-e', 'process.stdout.write("supervised")'], { timeoutMs: 5000, onSpawn() { spawned = true; } });
  if (process.platform === 'win32') {
    await assert.rejects(tracked, { code: 'PROCESS_START_UNSUPPORTED' });
    assert.equal(spawned, false);
  } else {
    const supervised = await tracked;
    assert.equal(supervised.code, 0, supervised.stderr);
    assert.equal(supervised.stdout, 'supervised');
    assert.equal(spawned, true);
  }
  const ordinary = await run([process.execPath, '-e', 'process.stdout.write("ordinary")'], { timeoutMs: 5000 });
  assert.equal(ordinary.code, 0, ordinary.stderr);
  assert.equal(ordinary.stdout, 'ordinary');
});
