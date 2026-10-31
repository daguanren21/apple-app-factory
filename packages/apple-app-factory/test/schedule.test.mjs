import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const success = [process.execPath, '-e', 'process.exit(0)'];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'apphx-schedule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'factory.json');
  writeFileSync(configPath, JSON.stringify({
    stateDir: 'state', workspaceRoot: 'workspaces', packageTarget: 'simulator',
    allowLocalExecution: true,
    verification: { prerequisites: [], checks: [success], runtime: [success] },
  }));
  return { root, configPath };
}

function schedule(f, args = []) {
  return spawnSync(process.execPath, [cli, 'schedule', ...args, '--config', f.configPath], { encoding: 'utf8' });
}

test('schedule prints a launchd template with crash revival and the fixed re-entry prompt', t => {
  const f = fixture(t);
  const result = schedule(f, ['--host', 'dimagent', '--format', 'launchd']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.host, 'dimagent');
  assert.equal(parsed.format, 'launchd');
  assert.match(parsed.content, /KeepAlive/);
  assert.match(parsed.content, /SuccessfulExit/);
  assert.match(parsed.content, /dimagent-headless-command/);
  assert.equal(parsed.content.includes(join(f.root, 'state', 'schedule.log')), true);
  assert.match(parsed.reentry, /drive --once/);
  assert.equal(parsed.reentry.includes(f.configPath), true);
  assert.match(parsed.install, /launchctl load/);
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
  assert.match(parsed.install, /systemctl enable --now apphx-codex-loop\.timer/);
});

test('schedule defaults to a cron line and points hermes at its native cron', t => {
  const f = fixture(t);
  const result = schedule(f, ['--host', 'hermes']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.format, 'cron');
  assert.match(parsed.content, /\*\/5 \* \* \* \*/);
  assert.match(parsed.content, /hermes-headless-command/);
  assert.equal(parsed.content.includes(`cd ${f.root}`), true);
  assert.match(parsed.install, /native cron/);
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
