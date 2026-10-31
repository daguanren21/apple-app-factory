import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const success = [process.execPath, '-e', 'process.exit(0)'];
const special = 'Research & <Lab> \' "100%ready" \\% ${HOME} $(echo unsafe)';
const hasFlock = process.platform !== 'win32' && spawnSync('/bin/sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).status === 0;

function fixture(t, { directory = '', stateDir = 'state', configName = 'factory.json' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'apphx-schedule-'));
  const root = join(base, directory);
  mkdirSync(root, { recursive: true });
  const children = [], pending = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    }
    await Promise.all(pending);
    rmSync(base, { recursive: true, force: true });
  });
  const configPath = join(root, configName);
  writeFileSync(configPath, JSON.stringify({
    stateDir, workspaceRoot: 'workspaces', packageTarget: 'simulator',
    allowLocalExecution: true,
    verification: { prerequisites: [], checks: [success], runtime: [success] },
  }));
  return { root, configPath, stateDir: join(root, stateDir), children, pending };
}

function schedule(f, args = []) {
  return spawnSync(process.execPath, [cli, 'schedule', ...args, '--config', f.configPath], { encoding: 'utf8' });
}

function readPlist(t, f, content) {
  const path = join(f.root, 'wake.plist');
  writeFileSync(path, content);
  const result = process.platform === 'darwin'
    ? spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' })
    : spawnSync('python3', ['-c', 'import json, plistlib, sys; print(json.dumps(plistlib.load(sys.stdin.buffer)))'], { input: content, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    t.skip('Requires plutil or Python plistlib to parse the generated launchd document');
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function cronCommand(content) {
  const line = content.split('\n').find(value => value && !value.startsWith('#'));
  const raw = line.replace(/^\S+(?:\s+\S+){4}\s+/, '');
  let command = '';
  // Model cron's pre-shell scan: only an escaped percent remains in the command.
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    assert.notEqual(char, '%', 'An unescaped percent makes cron truncate the command and send the rest to stdin');
    if (char === '\\' && index + 1 < raw.length) {
      const next = raw[++index];
      command += next === '%' ? '%' : `\\${next}`;
    } else command += char;
  }
  return command;
}

function captureHost(f) {
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const capture = join(f.root, 'capture.cjs');
  const record = join(f.root, 'sessions.jsonl');
  const release = join(f.root, 'release');
  writeFileSync(capture, `const fs = require('node:fs');
fs.appendFileSync(process.env.SCHEDULE_RECORD, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
if (process.env.SCHEDULE_HOLD === '1') {
  const timer = setInterval(() => { if (fs.existsSync(process.env.SCHEDULE_RELEASE)) clearInterval(timer); }, 10);
}
`);
  for (const command of ['apphx', 'codex-headless-command', 'dimagent-headless-command']) {
    writeFileSync(join(bin, command), '#!/bin/sh\nexec "$SCHEDULE_NODE" "$SCHEDULE_CAPTURE" "$@"\n', { mode: 0o700 });
  }
  return {
    record, release,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SCHEDULE_NODE: process.execPath, SCHEDULE_CAPTURE: capture, SCHEDULE_RECORD: record, SCHEDULE_RELEASE: release },
  };
}

function launchShell(f, command, env) {
  const child = spawn('/bin/sh', ['-c', command], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  f.children.push(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  f.pending.push(done.catch(() => {}));
  return { child, done };
}

test('schedule prints a launchd template with crash revival and the fixed re-entry prompt', t => {
  const f = fixture(t);
  const result = schedule(f, ['--host', 'dimagent', '--format', 'launchd']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.host, 'dimagent');
  assert.equal(parsed.format, 'launchd');
  const plist = readPlist(t, f, parsed.content);
  if (!plist) return;
  assert.equal(plist.KeepAlive.SuccessfulExit, false);
  assert.deepEqual(plist.ProgramArguments, ['dimagent-headless-command', parsed.reentry]);
  assert.equal(plist.StandardOutPath, join(f.root, 'state', 'schedule.log'));
  assert.match(parsed.reentry, /drive --once/);
  assert.equal(parsed.reentry.includes(f.configPath), true);
});

test('schedule prints a systemd template with Restart on failure', t => {
  const f = fixture(t);
  const result = schedule(f, ['--host', 'codex', '--format', 'systemd']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.format, 'systemd');
  assert.match(parsed.content, /Restart=on-failure/);
  assert.match(parsed.content, /OnCalendar=\*:0\/5/);
  assert.match(parsed.content, /codex-headless-command/);
});

test('schedule defaults to a cron line with instance locking', t => {
  const f = fixture(t);
  const result = schedule(f, ['--host', 'hermes']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.format, 'cron');
  assert.match(parsed.content, /\*\/5 \* \* \* \*/);
  assert.match(parsed.content, /hermes-headless-command/);
  assert.equal(cronCommand(parsed.content).startsWith(`cd '${f.root}' && flock -n `), true);
});

test('launchd preserves XML-sensitive paths and prompt as literal plist values', t => {
  const f = fixture(t, { directory: special, stateDir: special, configName: 'factory & <config> \'"100%.json' });
  const result = schedule(f, ['--host', 'codex', '--format', 'launchd']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const plist = readPlist(t, f, parsed.content);
  if (!plist) return;
  assert.equal(plist.Label, 'apphx.codex.loop');
  assert.deepEqual(plist.ProgramArguments, ['codex-headless-command', parsed.reentry]);
  assert.equal(plist.WorkingDirectory, f.root);
  assert.equal(plist.StandardOutPath, join(f.stateDir, 'schedule.log'));
  assert.equal(plist.StandardErrorPath, join(f.stateDir, 'schedule.log'));
  assert.deepEqual(plist.KeepAlive, { SuccessfulExit: false });
});

test('systemd preserves literal specifiers, dollar expressions, quotes and backslashes', t => {
  const f = fixture(t, { directory: special, stateDir: special });
  const result = schedule(f, ['--host', 'codex', '--format', 'systemd']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const directives = Object.fromEntries(parsed.content.split('\n').filter(line => line.includes('=')).map(line => {
    const equal = line.indexOf('=');
    return [line.slice(0, equal), line.slice(equal + 1)];
  }));
  const expandSpecifiers = value => value.replace(/%%|%./g, token => {
    assert.equal(token, '%%', `Unexpected systemd specifier ${token}`);
    return '%';
  });
  // Path directives take raw paths; quote characters and backslashes are literal here.
  assert.equal(expandSpecifiers(directives.WorkingDirectory), `${f.root}/`);
  assert.equal(expandSpecifiers(directives.StandardOutput), `append:${join(f.stateDir, 'schedule.log')}`);
  assert.equal(expandSpecifiers(directives.StandardError), `append:${join(f.stateDir, 'schedule.log')}`);
  const command = directives.ExecStart.match(/^(\S+) (".*")$/);
  assert.ok(command, 'ExecStart must contain one complete quoted prompt argument');
  assert.equal(command[1], 'codex-headless-command');
  const prompt = expandSpecifiers(JSON.parse(command[2])).replace(/\$\$|\$/g, token => {
    assert.equal(token, '$$', 'A literal dollar must not expand as a systemd environment variable');
    return '$';
  });
  assert.equal(prompt, parsed.reentry);
  assert.equal(parsed.reentry.includes('100%ready'), true);
  assert.equal(parsed.reentry.includes('100%%ready'), false);
});

test('the re-entry instruction shell-quotes its config argument', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t, { directory: special, configName: 'factory \'"100%.json' });
  const result = schedule(f, ['--host', 'codex']);
  assert.equal(result.status, 0, result.stderr);
  const { reentry } = JSON.parse(result.stdout);
  const command = reentry.match(/^Drive the apphx loop: run (.*?) --build-only\./s);
  assert.ok(command);
  const host = captureHost(f);
  const executed = spawnSync('/bin/sh', ['-c', `${command[1]} --build-only`], { env: host.env, encoding: 'utf8' });
  assert.equal(executed.status, 0, executed.stderr);
  const captured = JSON.parse(readFileSync(host.record, 'utf8'));
  assert.deepEqual(captured.args, ['drive', '--once', '--config', f.configPath, '--build-only']);
});

test('cron preserves shell-sensitive and percent paths, prompt and log through execution', { skip: !hasFlock }, t => {
  const f = fixture(t, { directory: special, stateDir: special, configName: 'factory \'"100%.json' });
  const result = schedule(f, ['--host', 'codex']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const host = captureHost(f);
  const executed = spawnSync('/bin/sh', ['-c', cronCommand(parsed.content)], { env: host.env, encoding: 'utf8' });
  assert.equal(executed.status, 0, executed.stderr);
  assert.deepEqual(JSON.parse(readFileSync(host.record, 'utf8')), { cwd: f.root, args: [parsed.reentry] });
  assert.equal(existsSync(join(f.stateDir, 'schedule.log')), true);
});

test('cron holds a nonblocking per-state-directory and host lock for the full headless session', { skip: !hasFlock, timeout: 10000 }, async t => {
  const f = fixture(t, { directory: special, stateDir: special });
  const result = schedule(f, ['--host', 'codex']);
  assert.equal(result.status, 0, result.stderr);
  const command = cronCommand(JSON.parse(result.stdout).content);
  const host = captureHost(f);
  const first = launchShell(f, command, { ...host.env, SCHEDULE_HOLD: '1' });
  const deadline = Date.now() + 5000;
  while (!existsSync(host.record) && Date.now() < deadline) await sleep(10);
  assert.equal(existsSync(host.record), true, 'First headless session did not start');
  const alternateConfig = join(f.root, 'alternate-config.json');
  writeFileSync(alternateConfig, readFileSync(f.configPath));
  const alternateSchedule = schedule({ ...f, configPath: alternateConfig }, ['--host', 'codex']);
  assert.equal(alternateSchedule.status, 0, alternateSchedule.stderr);
  const second = await launchShell(f, cronCommand(JSON.parse(alternateSchedule.stdout).content), host.env).done;
  assert.equal(second.code, 1, second.output);
  assert.equal(first.child.exitCode, null);
  assert.equal(readFileSync(host.record, 'utf8').trim().split('\n').length, 1);

  const otherHost = schedule(f, ['--host', 'dimagent']);
  assert.equal(otherHost.status, 0, otherHost.stderr);
  const independent = await launchShell(f, cronCommand(JSON.parse(otherHost.stdout).content), host.env).done;
  assert.equal(independent.code, 0, independent.output);
  const otherState = fixture(t);
  const otherSchedule = schedule(otherState, ['--host', 'codex']);
  assert.equal(otherSchedule.status, 0, otherSchedule.stderr);
  const other = await launchShell(f, cronCommand(JSON.parse(otherSchedule.stdout).content), host.env).done;
  assert.equal(other.code, 0, other.output);

  writeFileSync(host.release, 'release');
  const completed = await first.done;
  assert.equal(completed.code, 0, completed.output);
  const resumed = await launchShell(f, command, host.env).done;
  assert.equal(resumed.code, 0, resumed.output);
  assert.equal(readFileSync(host.record, 'utf8').trim().split('\n').length, 4);
});

test('schedule requires a known host and a supported format', t => {
  const f = fixture(t);
  const missingHost = schedule(f, []);
  assert.equal(missingHost.status, 1);
  assert.match(missingHost.stderr, /requires --host/);
  const unknown = schedule(f, ['--host', 'unknown-host']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unsupported host/);
  const badFormat = schedule(f, ['--host', 'codex', '--format', 'timex']);
  assert.equal(badFormat.status, 1);
  assert.match(badFormat.stderr, /--format must be launchd, systemd or cron/);
});
