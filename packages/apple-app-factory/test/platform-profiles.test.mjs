import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlatformProfile } from '../dist/configuration/profiles.js';
import { ConfigSchema } from '../dist/contracts/schemas.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apphx-platform-profile-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// A real relocated package catches accidental return to example-driven init.
// It uses installed dependencies without installing tools or executing an SDK.
test('relocated CLI initialization ignores missing and poisoned documentation examples', t => {
  const root = fixture(t), runtime = join(root, 'package'), home = join(root, 'home');
  mkdirSync(runtime); mkdirSync(home);
  cpSync(new URL('../dist/', import.meta.url), join(runtime, 'dist'), { recursive: true });
  cpSync(new URL('../package.json', import.meta.url), join(runtime, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(runtime, 'node_modules'), 'dir');
  const invoke = (name, args) => {
    const project = join(root, name), path = join(root, `${name}.factory.json`);
    const result = spawnSync(process.execPath, [join(runtime, 'dist/cli.js'), 'init', '--project', project, '--config', path, ...args], {
      cwd: root, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    return { config: JSON.parse(readFileSync(path, 'utf8')), path, project };
  };
  const first = invoke('without-examples', ['--framework', 'flutter']);
  assert.equal(first.config.allowLocalExecution, false);
  assert.equal(first.config.uiQuality, true);
  assert.equal(first.config.projectRoot, first.project);
  assert.equal(first.config.verification.runtime[0][0], 'flutter');
  const examples = join(runtime, 'examples');
  mkdirSync(examples);
  const poisoned = JSON.stringify({ allowLocalExecution: true, allowCloudBuild: true, uiQuality: false,
    verification: { checks: [['unexpected-command']], runtime: [['unexpected-command']] },
    packaging: { provider: 'cloud', commands: [['unexpected-command']], artifactPath: 'build/not-the-selected-app.aab' } });
  writeFileSync(join(examples, 'react-native.factory.json'), poisoned);
  const second = invoke('poisoned-example', ['--framework', 'react-native', '--platform', 'android', '--package-target', 'apk']);
  const config = ConfigSchema.parse(second.config);
  assert.equal(config.allowLocalExecution, false);
  assert.equal(config.allowCloudBuild, false);
  assert.equal(config.packaging.provider, 'local');
  assert.equal(config.packaging.artifactPath, 'android/app/build/outputs/apk/release/app-release.apk');
  assert.ok(config.packaging.commands[0].includes(':app:assembleRelease'));
  assert.equal(config.verification.runtime[0][0], 'npm');
  assert.equal(readFileSync(join(examples, 'react-native.factory.json'), 'utf8'), poisoned);
  const repeat = spawnSync(process.execPath, [join(runtime, 'dist/cli.js'), 'init', '--project', second.project, '--config', second.path, '--framework', 'react-native'], {
    cwd: root, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(repeat.status, 1);
  assert.deepEqual(JSON.parse(readFileSync(second.path, 'utf8')), second.config);
});

test('mutating a selected profile cannot change a later task or a different packaging target', () => {
  const selected = createPlatformProfile('expo', 'android', 'apk');
  selected.executionEnv.push('UNRELATED_SETTING');
  selected.verification.runtime[0][0] = 'unexpected-command';
  selected.packaging.commands[0][0] = 'unexpected-command';
  selected.packaging.artifactPath = 'build/wrong.aab';
  selected.obfuscation.options.code.removeComments = false;
  selected.workflow.maxParallel = 32;
  const next = createPlatformProfile('expo', 'android', 'apk');
  assert.equal(next.executionEnv.includes('UNRELATED_SETTING'), false);
  assert.equal(next.verification.runtime[0][0], 'npm');
  assert.equal(next.packaging.commands[0][0], 'eas');
  assert.equal(next.packaging.artifactPath, 'build/app.apk');
  assert.equal(next.obfuscation.options.code.removeComments, true);
  assert.equal(ConfigSchema.parse({ ...next, stateDir: '/state', workspaceRoot: '/work' }).workflow.maxParallel, 4);
  const simulator = createPlatformProfile('expo', 'ios', 'simulator');
  assert.equal(simulator.packaging.artifactPath, 'build/App.app');
  assert.ok(simulator.packaging.commands[0].includes('simulator'));
  assert.equal(simulator.packaging.commands[1][0], 'tar');
});

test('invalid framework/platform/target combinations do not create the selected project or configuration', t => {
  const root = fixture(t);
  for (const [framework, platform, target] of [['swift', 'android', 'apk'], ['android-java', 'ios', 'ipa'], ['mygo', 'macos', 'aab']]) {
    const project = join(root, `${framework}-project`), path = join(root, `${framework}-control/factory.json`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'init', '--project', project, '--config', path,
      '--framework', framework, '--platform', platform, '--package-target', target], { encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 1);
    assert.equal(existsSync(project), false);
    assert.equal(existsSync(path), false);
  }
});

test('JavaScript profile consumers cannot select an unregistered stack or platform', () => {
  for (const selectors of [['unregistered-stack', 'android', 'apk'], ['unregistered-stack', 'ios', 'ipa'], ['flutter', 'unregistered-platform', 'apk'], ['flutter', 'ios', 'unregistered-target']]) {
    assert.throws(() => createPlatformProfile(...selectors));
  }
});
