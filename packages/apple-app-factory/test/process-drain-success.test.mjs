import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../dist/process.js';

const posix = { skip: process.platform === 'win32' };

function successDrainCommand(root, { holdMs = 2500, keepAlive = false } = {}) {
  const pidFile = join(root, 'grandchild.pid');
  const grandchild = `
    const { setTimeout: wait } = require('node:timers/promises');
    process.stdout.write('grandchild-output');
    ${keepAlive ? 'setInterval(()=>{},1000);' : `setTimeout(()=>{},${holdMs});`}
  `;
  const leader = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const grand = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: ['ignore', 1, 2] });
    writeFileSync(${JSON.stringify(pidFile)}, String(grand.pid));
    grand.unref();
    process.stdout.write('leader-complete');
  `;
  return {
    pidFile,
    argv: [process.execPath, '-e', leader],
    grandchildPid() {
      try { return Number(readFileSync(pidFile, 'utf8')); } catch { return undefined; }
    },
  };
}

test('a successful command resolves within the success drain grace when a detached descendant retains its pipes', { ...posix, timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-drain-success-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = successDrainCommand(root, { holdMs: 2500 });
  const started = Date.now();
  const result = await run(command.argv, { timeoutMs: 60000 });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /leader-complete/);
  assert.match(result.stdout, /grandchild-output/);
  assert.ok(Date.now() - started >= 1000, 'the failure grace window must have passed before the pipe was released');
});

test('a successful command still resolves success when the detached descendant exhausts the success drain grace', { ...posix, timeout: 45000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-drain-success-'));
  const command = successDrainCommand(root, { keepAlive: true });
  let grandchild;
  t.after(() => {
    if (grandchild) { try { process.kill(grandchild, 'SIGKILL'); } catch {} }
    rmSync(root, { recursive: true, force: true });
  });
  const started = Date.now();
  const result = await run(command.argv, { timeoutMs: 60000 });
  grandchild = command.grandchildPid();
  assert.equal(result.code, 0);
  assert.match(result.stdout, /leader-complete/);
  assert.ok(Date.now() - started >= 30000, 'the success drain grace must have been exhausted before resolving');
});
