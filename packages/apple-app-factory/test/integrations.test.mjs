import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installIntegration, updateIntegration, inspectIntegration, uninstallIntegration } from '../dist/integrations.js';

const marker = '.apphx-install.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const projectPaths = {
  codex: '.agents/skills', claude: '.claude/skills', cursor: '.cursor/skills',
  pi: '.pi/skills', gemini: '.gemini/skills', opencode: '.opencode/skills', deepseek: '.dsh/skills', hermes: '.hermes/skills',
  qoder: '.qoder/skills', 'oh-my-pi': '.omp/skills', dimagent: '.dimcode/skills',
};

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apphx-integration-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function environment(t, changes) {
  const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// A historical format-1 install is durable input, not a substitute installer.
function saveHistoricalManifest(path, manifest) {
  manifest.metadataDigest = sha(JSON.stringify([manifest.format, manifest.owner, manifest.skill, manifest.host, manifest.version, Object.entries(manifest.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]));
  writeFileSync(join(path, marker), `${JSON.stringify(manifest, null, 2)}\n`);
}

for (const [host, directory] of Object.entries(projectPaths)) {
  test(`${host}: project discovery location, inspection, idempotence and owned uninstall`, t => {
    const root = fixture(t);
    if (host === 'hermes') mkdirSync(join(root, '.git'));
    const expected = join(root, directory, 'apphx');
    assert.equal(inspectIntegration(host, { project: root }).installed, false);
    assert.equal(existsSync(join(root, directory)), false, 'inspection must not create host configuration');
    const installed = installIntegration(host, { project: root });
    assert.equal(installed.path, expected);
    assert.equal(installed.scope, 'project');
    assert.equal(installed.changed, true);
    assert.equal(installed.installed, true);
    assert.ok(lstatSync(join(expected, 'SKILL.md')).isFile());
    const manifest = JSON.parse(readFileSync(join(expected, marker), 'utf8'));
    assert.equal(manifest.owner, 'apphx');
    assert.equal(manifest.skill, 'apphx');
    assert.equal(manifest.host, host);
    assert.equal(inspectIntegration(host, { project: root }).current, true);
    const before = statSync(join(expected, 'SKILL.md'));
    assert.equal(installIntegration(host, { project: root }).changed, false);
    assert.equal(updateIntegration(host, { project: root }).changed, false);
    assert.equal(statSync(join(expected, 'SKILL.md')).ino, before.ino, 'idempotence must not rewrite files');
    assert.equal(statSync(join(expected, 'SKILL.md')).mtimeMs, before.mtimeMs);
    const unrelated = join(dirname(expected), 'user-skill');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'SKILL.md'), 'user owned');
    assert.equal(uninstallIntegration(host, { project: root }).changed, true);
    assert.equal(existsSync(expected), false);
    assert.equal(readFileSync(join(unrelated, 'SKILL.md'), 'utf8'), 'user owned');
    assert.equal(uninstallIntegration(host, { project: root }).changed, false);
  });
}

test('default scope is the working project, never the home directory', t => {
  const root = fixture(t);
  const old = process.cwd();
  process.chdir(root);
  try {
    const result = installIntegration('claude');
    assert.equal(result.path, join(root, '.claude/skills/apphx'));
    assert.equal(result.scope, 'project');
  } finally { process.chdir(old); }
});

test('explicit global installs use documented home locations and leave the project untouched', t => {
  const root = fixture(t);
  environment(t, { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: undefined, GEMINI_CLI_HOME: undefined, PI_CODING_AGENT_DIR: undefined, OMP_PROFILE: undefined, PI_PROFILE: undefined, DSH_HOME: undefined, HERMES_HOME: undefined, XDG_CONFIG_HOME: undefined });
  const globalPaths = { ...projectPaths, pi: '.pi/agent/skills', 'oh-my-pi': '.omp/agent/skills', dimagent: '.dimcode/v2/skills', opencode: '.config/opencode/skills' };
  for (const [host, directory] of Object.entries(globalPaths)) {
    const result = installIntegration(host, { global: true });
    assert.equal(result.scope, 'global');
    assert.equal(result.path, join(root, directory, 'apphx'));
    assert.equal(inspectIntegration(host, { global: true }).installed, true);
    assert.equal(uninstallIntegration(host, { global: true }).changed, true);
  }
});

test('documented host home overrides select the same global locations as the hosts', t => {
  const root = fixture(t);
  const defaultHome = join(root, 'default-home');
  mkdirSync(defaultHome);
  writeFileSync(join(defaultHome, 'keep.txt'), 'default profile remains untouched');
  environment(t, { HOME: defaultHome, USERPROFILE: defaultHome, CLAUDE_CONFIG_DIR: join(root, 'claude-home'), GEMINI_CLI_HOME: join(root, 'gemini-home'), PI_CODING_AGENT_DIR: join(root, 'pi-home'), OMP_PROFILE: undefined, PI_PROFILE: undefined, DSH_HOME: join(root, 'dsh-home'), HERMES_HOME: join(root, 'hermes-home'), XDG_CONFIG_HOME: join(root, 'xdg') });
  for (const [host, expected] of [['claude', 'claude-home/skills'], ['gemini', 'gemini-home/.gemini/skills'], ['pi', 'pi-home/skills'], ['deepseek', 'dsh-home/skills'], ['hermes', 'hermes-home/skills'], ['opencode', 'xdg/opencode/skills']]) {
    const installed = installIntegration(host, { global: true });
    assert.equal(installed.path, join(root, expected, 'apphx'));
    assert.equal(inspectIntegration(host, { global: true }).installed, true);
    assert.equal(uninstallIntegration(host, { global: true }).changed, true);
    assert.equal(existsSync(installed.path), false);
  }
  assert.deepEqual(readdirSync(defaultHome), ['keep.txt']);
  assert.equal(readFileSync(join(defaultHome, 'keep.txt'), 'utf8'), 'default profile remains untouched');
});

test('Oh My Pi profile variables select the profile skill root the host reads', t => {
  const root = fixture(t);
  environment(t, { HOME: root, USERPROFILE: root, OMP_PROFILE: 'design', PI_PROFILE: undefined });
  const installed = installIntegration('oh-my-pi', { global: true });
  assert.equal(installed.path, join(root, '.omp', 'profiles', 'design', 'agent', 'skills', 'apphx'));
  assert.ok(lstatSync(join(installed.path, 'SKILL.md')).isFile());
  assert.equal(existsSync(join(root, '.omp', 'agent', 'skills')), false, 'the un-profiled root must not receive a profiled install');
  assert.equal(inspectIntegration('oh-my-pi', { global: true }).installed, true);
  assert.equal(uninstallIntegration('oh-my-pi', { global: true }).changed, true);
  assert.equal(existsSync(join(root, '.omp', 'profiles', 'design', 'agent', 'skills', 'apphx')), false);
});

test('PI_PROFILE alone selects the same Oh My Pi profile skill root', t => {
  const root = fixture(t);
  environment(t, { HOME: root, USERPROFILE: root, OMP_PROFILE: undefined, PI_PROFILE: 'ship' });
  assert.equal(installIntegration('oh-my-pi', { global: true }).path, join(root, '.omp', 'profiles', 'ship', 'agent', 'skills', 'apphx'));
  assert.equal(uninstallIntegration('oh-my-pi', { global: true }).changed, true);
});

test('conflicting Oh My Pi profile variables reject before writing anything', t => {
  const root = fixture(t);
  environment(t, { HOME: root, USERPROFILE: root, OMP_PROFILE: 'a', PI_PROFILE: 'b' });
  assert.throws(() => installIntegration('oh-my-pi', { global: true }), /different profiles/);
  assert.equal(existsSync(join(root, '.omp')), false, 'rejected install must not create the root');
});

test('an unusable Oh My Pi profile name rejects before writing anything', t => {
  const root = fixture(t);
  environment(t, { HOME: root, USERPROFILE: root, OMP_PROFILE: '../escape', PI_PROFILE: undefined });
  assert.throws(() => installIntegration('oh-my-pi', { global: true }), /not a usable profile name/);
  assert.equal(existsSync(join(root, '.omp')), false, 'rejected install must not create the root');
});

test('DeepSeek local discovery uses the nearest Git root, unlike cwd-local Pi', t => {
  const root = fixture(t);
  mkdirSync(join(root, '.git'));
  const nested = join(root, 'app', 'src');
  mkdirSync(nested, { recursive: true });
  assert.equal(installIntegration('deepseek', { project: nested }).path, join(root, '.dsh/skills/apphx'));
  assert.equal(installIntegration('pi', { project: nested }).path, join(nested, '.pi/skills/apphx'));
});


test('only explicit update upgrades an unchanged installation and removes obsolete owned assets', t => {
  const root = fixture(t);
  const { path, version } = installIntegration('claude', { project: root });
  const manifest = JSON.parse(readFileSync(join(path, marker), 'utf8'));
  manifest.version = '0.0.1';
  writeFileSync(join(path, 'SKILL.md'), 'historical skill content\n');
  manifest.files['SKILL.md'] = sha('historical skill content\n');
  writeFileSync(join(path, 'retired.json'), '{}\n');
  manifest.files['retired.json'] = sha('{}\n');
  saveHistoricalManifest(path, manifest);
  assert.equal(inspectIntegration('claude', { project: root }).installed, true);
  assert.equal(inspectIntegration('claude', { project: root }).current, false);
  assert.throws(() => installIntegration('claude', { project: root }));
  assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), 'historical skill content\n');
  assert.equal(readFileSync(join(path, 'retired.json'), 'utf8'), '{}\n');
  assert.equal(updateIntegration('claude', { project: root }).changed, true);
  assert.equal(existsSync(join(path, 'retired.json')), false);
  assert.equal(inspectIntegration('claude', { project: root }).version, version);
  assert.equal(inspectIntegration('claude', { project: root }).current, true);
  assert.equal(uninstallIntegration('claude', { project: root }).changed, true);
});

for (const mutation of ['edited', 'missing', 'extra-file', 'extra-directory', 'metadata', 'wrong-host']) {
  test(`refuses ${mutation} content for install, update and uninstall without deleting user data`, t => {
    const root = fixture(t);
    const { path } = installIntegration('cursor', { project: root });
    const markerPath = join(path, marker);
    if (mutation === 'edited') writeFileSync(join(path, 'SKILL.md'), 'user edited content');
    if (mutation === 'missing') unlinkSync(join(path, 'SKILL.md'));
    if (mutation === 'extra-file') writeFileSync(join(path, 'personal.txt'), 'must survive');
    if (mutation === 'extra-directory') mkdirSync(join(path, 'personal'));
    if (mutation === 'metadata') {
      const manifest = JSON.parse(readFileSync(markerPath, 'utf8'));
      manifest.version = '0.0.1';
      writeFileSync(markerPath, JSON.stringify(manifest));
    }
    if (mutation === 'wrong-host') {
      const manifest = JSON.parse(readFileSync(markerPath, 'utf8'));
      manifest.host = 'codex';
      saveHistoricalManifest(path, manifest);
    }
    const before = readdirSync(path).sort();
    const metadata = readFileSync(markerPath, 'utf8');
    const inspection = inspectIntegration('cursor', { project: root });
    assert.equal(inspection.installed, false);
    assert.equal(inspection.status, 'conflict');
    assert.ok(inspection.reason);
    assert.throws(() => installIntegration('cursor', { project: root }));
    assert.throws(() => updateIntegration('cursor', { project: root }));
    assert.throws(() => uninstallIntegration('cursor', { project: root }));
    assert.deepEqual(readdirSync(path).sort(), before);
    assert.equal(readFileSync(markerPath, 'utf8'), metadata);
    if (mutation === 'edited') assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), 'user edited content');
    if (mutation === 'extra-file') assert.equal(readFileSync(join(path, 'personal.txt'), 'utf8'), 'must survive');
  });
}

test('foreign directories are never adopted even when their skill has the expected name', t => {
  const root = fixture(t);
  const path = join(root, '.claude/skills/apphx');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), 'foreign content');
  assert.equal(inspectIntegration('claude', { project: root }).installed, false);
  assert.throws(() => installIntegration('claude', { project: root }), /Foreign/);
  assert.throws(() => updateIntegration('claude', { project: root }), /Foreign/);
  assert.throws(() => uninstallIntegration('claude', { project: root }), /Foreign/);
  assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), 'foreign content');
});

for (const entry of ['.claude', '.claude/skills', '.claude/skills/apphx']) {
  test(`refuses symlink escape through ${entry}`, t => {
    const root = fixture(t);
    const outside = join(root, 'outside');
    const project = join(root, 'project');
    mkdirSync(outside);
    mkdirSync(project);
    writeFileSync(join(outside, 'keep.txt'), 'outside data');
    const link = join(project, entry);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link, 'dir');
    assert.equal(inspectIntegration('claude', { project }).installed, false);
    assert.throws(() => installIntegration('claude', { project }), /symlink/i);
    assert.throws(() => updateIntegration('claude', { project }), /symlink/i);
    assert.throws(() => uninstallIntegration('claude', { project }), /symlink/i);
    assert.deepEqual(readdirSync(outside), ['keep.txt']);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside data');
    assert.ok(lstatSync(link).isSymbolicLink());
  });
}

test('refuses symlinked project roots, dangling target links and linked installed resources', t => {
  const root = fixture(t);
  const project = join(root, 'project');
  mkdirSync(project);
  symlinkSync(project, join(root, 'alias'), 'dir');
  assert.throws(() => installIntegration('gemini', { project: join(root, 'alias') }), /symlink/i);
  assert.throws(() => updateIntegration('gemini', { project: join(root, 'alias') }), /symlink/i);
  const path = join(project, '.gemini/skills/apphx');
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(join(root, 'missing'), path, 'dir');
  assert.throws(() => installIntegration('gemini', { project }), /symlink/i);
  assert.throws(() => updateIntegration('gemini', { project }), /symlink/i);
  unlinkSync(path);
  installIntegration('gemini', { project });
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'unchanged');
  unlinkSync(join(path, 'SKILL.md'));
  symlinkSync(outside, join(path, 'SKILL.md'));
  assert.equal(inspectIntegration('gemini', { project }).installed, false);
  assert.throws(() => installIntegration('gemini', { project }), /symlink/i);
  assert.throws(() => updateIntegration('gemini', { project }), /symlink/i);
  assert.throws(() => uninstallIntegration('gemini', { project }), /symlink/i);
  assert.equal(readFileSync(outside, 'utf8'), 'unchanged');
});

test('refuses hard-linked content rather than mutating a shared inode', t => {
  const root = fixture(t);
  const { path } = installIntegration('pi', { project: root });
  const original = readFileSync(join(path, 'SKILL.md'));
  const shared = join(root, 'shared.md');
  linkSync(join(path, 'SKILL.md'), shared);
  assert.equal(inspectIntegration('pi', { project: root }).installed, false);
  assert.throws(() => installIntegration('pi', { project: root }), /hard-linked/);
  assert.throws(() => updateIntegration('pi', { project: root }), /hard-linked/);
  assert.throws(() => uninstallIntegration('pi', { project: root }), /hard-linked/);
  assert.deepEqual(readFileSync(shared), original);
});

test('ownership metadata cannot address files outside its skill or hide unknown entries', t => {
  const root = fixture(t);
  const { path } = installIntegration('opencode', { project: root });
  const outside = join(root, 'keep.txt');
  writeFileSync(outside, 'private');
  const manifest = JSON.parse(readFileSync(join(path, marker), 'utf8'));
  manifest.files['../../../../keep.txt'] = sha('private');
  saveHistoricalManifest(path, manifest);
  assert.equal(inspectIntegration('opencode', { project: root }).installed, false);
  assert.throws(() => installIntegration('opencode', { project: root }), /metadata/);
  assert.throws(() => updateIntegration('opencode', { project: root }), /metadata/);
  assert.throws(() => uninstallIntegration('opencode', { project: root }), /metadata/);
  assert.equal(readFileSync(outside, 'utf8'), 'private');
});

test('a concurrent or interrupted install lock fails closed and is not removed', t => {
  const root = fixture(t);
  mkdirSync(join(root, '.claude'));
  const lock = join(root, '.claude/.apphx-install.lock');
  writeFileSync(lock, 'other owner');
  assert.throws(() => installIntegration('claude', { project: root }), /locked/);
  assert.equal(readFileSync(lock, 'utf8'), 'other owner');
  assert.equal(existsSync(join(root, '.claude/skills/apphx')), false);
});

test('unknown hosts and contradictory scopes reject before creating any directory', t => {
  const root = fixture(t);
  for (const operation of [installIntegration, updateIntegration, inspectIntegration, uninstallIntegration]) {
    assert.throws(() => operation('../not-a-host', { project: root }), /Unsupported host/);
    assert.throws(() => operation('claude', { project: root, global: true }), /either project or global/);
    assert.throws(() => operation('claude', { project: join(root, 'missing') }), /does not exist/);
  }
  assert.deepEqual(readdirSync(root), []);
});

test('update requires an existing installation and never creates a missing project or global profile', t => {
  const root = fixture(t);
  environment(t, { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: undefined });
  assert.throws(() => updateIntegration('claude', { project: root }));
  assert.throws(() => updateIntegration('claude', { global: true }));
  assert.deepEqual(readdirSync(root), []);
});

test('Hermes uses its owning Git root without granting trust, and rejects Git-less project installs', t => {
  const root = fixture(t);
  const profile = join(root, 'profile');
  mkdirSync(profile);
  const config = join(profile, 'config.yaml');
  writeFileSync(config, 'skills:\n  trusted_project_dirs: []\n');
  environment(t, { HERMES_HOME: profile });
  assert.throws(() => installIntegration('hermes', { project: root }), /Git root/);
  assert.equal(existsSync(join(root, '.hermes')), false);
  mkdirSync(join(root, '.git'));
  const nested = join(root, 'app');
  mkdirSync(nested);
  const result = installIntegration('hermes', { project: nested });
  assert.equal(result.path, join(root, '.hermes/skills/apphx'));
  assert.equal(inspectIntegration('hermes', { project: root }).installed, true);
  assert.equal(uninstallIntegration('hermes', { project: nested }).changed, true);
  const global = installIntegration('hermes', { global: true });
  assert.equal(global.path, join(profile, 'skills/apphx'));
  assert.equal(updateIntegration('hermes', { global: true }).changed, false);
  assert.equal(uninstallIntegration('hermes', { global: true }).changed, true);
  assert.equal(readFileSync(config, 'utf8'), 'skills:\n  trusted_project_dirs: []\n');
});
