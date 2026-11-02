import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const spec = {
  id: 'project-context', name: 'Project context', framework: 'flutter', platform: 'ios',
  channel: 'local', version: '1.0.0', purpose: 'Keep user source in its selected project', audience: 'Project maintainers',
  screenshotsDir: 'build/screenshots',
  differentiators: ['Persistent source context'], acceptance: ['Existing source remains in the selected directory'],
};

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apphx-project-cli-')));
  const project = join(root, 'project'), other = join(root, 'unrelated'), home = join(root, 'home');
  for (const path of [project, other, home]) mkdirSync(path);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const invoke = (args, { cwd = project, input, code = 0 } = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd, input, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, code, result.stderr || result.stdout);
    if (code === 0) return JSON.parse(result.stdout);
    const errors = result.stderr.split(/\r?\n/).filter(line => line.startsWith('{"error":'));
    assert.equal(errors.length, 1, result.stderr);
    return JSON.parse(errors[0]);
  };
  const init = (extra = [], options) => invoke(['init', ...extra], options);
  const enqueue = (config, input = spec, cwd = project) => invoke(['enqueue', '-', '--config', config], { cwd, input: JSON.stringify(input) });
  const next = (config, id, cwd = project) => invoke(['next', id, '--host-pid', String(process.pid), '--config', config], { cwd });
  return { root, project, other, home, invoke, init, enqueue, next };
}

function flutter(root) {
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'pubspec.yaml'), 'name: existing_app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  writeFileSync(join(root, 'lib/main.dart'), 'void main() {}\n');
}

test('default CLI project remains the selected source across cwd changes and process restarts', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, 'owner-note.txt'), 'preserve this unrelated file');
  const initialized = f.init();
  assert.equal(initialized.projectRoot, f.project);
  assert.equal(initialized.projectMode, 'project');
  assert.equal(initialized.config, join(f.project, 'factory.json'));
  assert.equal(initialized.stateDir.startsWith(`${f.project}/`), false);
  assert.equal(initialized.workspaceRoot.startsWith(`${f.project}/`), false);
  const job = f.enqueue(initialized.config, spec, f.other);
  assert.equal(job.projectRoot, f.project);
  const claimed = f.next(initialized.config, job.id, f.other);
  assert.equal(claimed.action, 'host');
  assert.equal(claimed.turn.cwd, f.project);
  const resumed = f.next(initialized.config, job.id, f.project);
  assert.equal(resumed.turn.id, claimed.turn.id);
  assert.equal(resumed.turn.cwd, f.project);
  assert.equal(readFileSync(join(f.project, 'owner-note.txt'), 'utf8'), 'preserve this unrelated file');
  assert.equal(existsSync(join(f.project, 'workspaces')), false);
  assert.equal(existsSync(join(initialized.workspaceRoot, job.id)), false);
});

test('existing projects retain source and an explicit monorepo subproject cwd', t => {
  const f = fixture(t);
  const app = join(f.project, 'apps/mobile');
  flutter(app);
  writeFileSync(join(f.project, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  writeFileSync(join(f.project, 'owner-changes.txt'), 'uncommitted owner changes');
  const configFile = join(f.root, 'control/factory.json');
  const initialized = f.init(['--project', f.project, '--framework', 'flutter', '--config', configFile], { cwd: f.other });
  const job = f.enqueue(initialized.config, { ...spec, project: { directory: 'apps/mobile' } }, f.other);
  const claimed = f.next(initialized.config, job.id, f.other);
  assert.equal(claimed.action, 'host');
  assert.equal(claimed.turn.cwd, app);
  assert.equal(job.delivery.sourcePath, app);
  assert.equal(job.delivery.runtime.cwd, app);
  assert.equal(readFileSync(join(app, 'lib/main.dart'), 'utf8'), 'void main() {}\n');
  assert.equal(readFileSync(join(f.project, 'owner-changes.txt'), 'utf8'), 'uncommitted owner changes');
});

test('an existing framework cannot silently become a replacement application', t => {
  const f = fixture(t);
  flutter(f.project);
  const rejected = f.invoke(['init', '--framework', 'expo'], { code: 1 });
  assert.equal(typeof rejected.error, 'string');
  assert.equal(existsSync(join(f.project, 'factory.json')), false);
  assert.equal(readFileSync(join(f.project, 'lib/main.dart'), 'utf8'), 'void main() {}\n');
  const initialized = f.init();
  assert.equal(initialized.framework, 'flutter');
});

test('requirement sourceDir cannot redirect writes outside the owner-selected project', t => {
  const f = fixture(t);
  flutter(f.project);
  flutter(f.other);
  const initialized = f.init();
  f.invoke(['enqueue', '-', '--config', initialized.config], {
    input: JSON.stringify({ ...spec, project: { sourceDir: f.other } }), code: 1,
  });
  assert.deepEqual(f.invoke(['status', '--config', initialized.config]), []);
  assert.equal(readFileSync(join(f.other, 'lib/main.dart'), 'utf8'), 'void main() {}\n');
  const job = f.enqueue(initialized.config, { ...spec, project: { sourceDir: f.project } });
  assert.equal(job.projectRoot, f.project);
  assert.equal(f.next(initialized.config, job.id).turn.cwd, f.project);
});

test('different task IDs cannot claim overlapping live project work concurrently', t => {
  const f = fixture(t);
  flutter(f.project);
  const initialized = f.init();
  const first = f.enqueue(initialized.config);
  const second = f.enqueue(initialized.config, { ...spec, id: 'second-change' });
  const active = f.next(initialized.config, first.id);
  const waiting = f.next(initialized.config, second.id);
  assert.equal(active.action, 'host');
  assert.equal(waiting.action, 'wait');
  assert.equal(waiting.turn, undefined);
  f.invoke(['abandon', first.id, active.turn.id, '--config', initialized.config]);
  assert.equal(f.next(initialized.config, second.id).action, 'host');
});

test('retry cannot retarget a persisted project to a different directory', t => {
  const f = fixture(t);
  flutter(f.project);
  flutter(f.other);
  const initialized = f.init();
  const job = f.enqueue(initialized.config);
  f.invoke(['cancel', job.id, 'Owner paused this change', '--config', initialized.config]);
  const config = JSON.parse(readFileSync(initialized.config, 'utf8'));
  config.projectRoot = f.other;
  writeFileSync(initialized.config, JSON.stringify(config));
  f.invoke(['retry', job.id, '--config', initialized.config], { code: 1 });
  const saved = f.invoke(['status', job.id, '--config', initialized.config]);
  assert.equal(saved.projectRoot, f.project);
  assert.equal(saved.status, 'needs-owner');
  assert.equal(readFileSync(join(f.other, 'lib/main.dart'), 'utf8'), 'void main() {}\n');
});

test('project admission rejects an SDK writable from the selected live source root', t => {
  const f = fixture(t);
  flutter(f.project);
  const initialized = f.init();
  const sdk = join(f.project, 'sdk');
  mkdirSync(join(sdk, 'bin'), { recursive: true });
  writeFileSync(join(sdk, 'bin/flutter'), 'This fixture must never be executed.');
  const config = JSON.parse(readFileSync(initialized.config, 'utf8'));
  config.toolchain = { flutterSdk: sdk };
  writeFileSync(initialized.config, JSON.stringify(config));
  f.invoke(['enqueue', '-', '--config', initialized.config], { input: JSON.stringify(spec), code: 1 });
  assert.deepEqual(f.invoke(['status', '--config', initialized.config]), []);
  assert.equal(readFileSync(join(sdk, 'bin/flutter'), 'utf8'), 'This fixture must never be executed.');
});

test('an unidentified native workspace requires explicit framework selection instead of Flutter defaults', t => {
  const f = fixture(t);
  mkdirSync(join(f.project, 'Existing.xcworkspace'));
  writeFileSync(join(f.project, 'Existing.xcworkspace/contents.xcworkspacedata'), '<Workspace><FileRef location="group:native/Existing.xcodeproj"/></Workspace>');
  mkdirSync(join(f.project, 'native/Existing.xcodeproj'), { recursive: true });
  writeFileSync(join(f.project, 'native/Existing.xcodeproj/project.pbxproj'), 'PBXProject existing-owner-project');
  f.invoke(['init'], { code: 1 });
  assert.equal(existsSync(join(f.project, 'factory.json')), false);
  const selected = f.init(['--framework', 'swift']);
  assert.equal(selected.framework, 'swift');
  assert.equal(readFileSync(join(f.project, 'native/Existing.xcodeproj/project.pbxproj'), 'utf8'), 'PBXProject existing-owner-project');
});

test('submit refuses an inbox inside live source before publishing any control file', t => {
  const f = fixture(t);
  flutter(f.project);
  const initialized = f.init();
  const config = JSON.parse(readFileSync(initialized.config, 'utf8'));
  const inbox = join(f.project, 'requests');
  config.inbox = { directory: inbox };
  writeFileSync(initialized.config, JSON.stringify(config));
  f.invoke(['submit', '-', '--config', initialized.config], { input: JSON.stringify(spec), code: 1 });
  assert.equal(existsSync(inbox), false);
  assert.equal(readFileSync(join(f.project, 'lib/main.dart'), 'utf8'), 'void main() {}\n');
});

for (const target of ['live', 'execution', 'default-workspace']) test(`CLI metadata and revocation survive a dangling ${target} ancestor`, t => {
  const f = fixture(t);
  const selected = join(f.root, 'selection/app');
  flutter(selected);
  const configPath = join(f.root, 'control/factory.json');
  f.init(['--project', selected, '--config', configPath]);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (target === 'default-workspace') delete config.workspaceRoot;
  else {
    config.workspaceRoot = join(f.root, 'execution-root/workspaces');
    mkdirSync(config.workspaceRoot, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config));
  const job = f.enqueue(configPath);
  const turn = f.next(configPath, job.id);
  const ancestor = join(f.root, target === 'execution' ? 'execution-root' : 'selection');
  renameSync(ancestor, `${ancestor}-retained`);
  symlinkSync(join(f.root, 'nonexistent-target'), ancestor, 'dir');
  const status = f.invoke(['status', job.id, '--config', configPath]);
  assert.equal(status.projectRoot, selected);
  assert.equal(status.turn.id, turn.turn.id);
  assert.equal(f.invoke(['status', '--config', configPath])[0].delivery.sourcePath, selected);
  assert(f.invoke(['events', job.id, '--config', configPath]).some(event => event.data.turn?.id === turn.turn.id));
  const refused = f.invoke(['next', job.id, '--host-pid', String(process.pid), '--config', configPath], { code: 1 });
  assert.ok(refused.error.includes(ancestor), refused.error);
  f.invoke(['abandon', job.id, turn.turn.id, '--config', configPath]);
  f.invoke(['cancel', job.id, 'Owner revoked work while repairing paths', '--config', configPath]);
  assert.equal(f.invoke(['status', job.id, '--config', configPath]).workflow.cancelled, true);
  assert.equal(existsSync(join(f.root, 'nonexistent-target')), false);
});
