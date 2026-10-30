import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../dist/process.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const profile = JSON.parse(readFileSync(new URL('../examples/mygo.factory.json', import.meta.url)));
const requirement = JSON.parse(readFileSync(new URL('../examples/mygo.json', import.meta.url)));

// Controlled executable probes only: this suite does not compile Go or build a native app.
function fixture(t, project, allowLocalExecution = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apphx-mygo-doctor-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const log = join(root, 'probes.jsonl');
  mkdirSync(bin);
  writeFileSync(join(bin, 'go'), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(['GOWORK', 'GOENV', 'GOTOOLCHAIN', 'GOFLAGS'].map(key => [key, process.env[key]])) }) + '\\n');\nconsole.log('controlled tool probe');\n`, { mode: 0o700 });
  // An unrelated control module must never satisfy a project-scoped tool probe.
  writeFileSync(join(root, 'go.mod'), 'module example.com/control\n\ngo 1.27.1\n');
  writeFileSync(join(root, 'go.work'), 'go 1.27.1\nuse .\n');
  const configPath = join(root, 'factory.json');
  writeFileSync(configPath, JSON.stringify({
    ...profile, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'),
    allowLocalExecution, executionEnv: ['GOWORK', 'GOENV', 'GOTOOLCHAIN', 'GOFLAGS'],
  }));
  const specPath = join(root, 'requirement.json');
  writeFileSync(specPath, JSON.stringify({ ...requirement, ...(project ? { project } : {}) }));
  return {
    root, log,
    async doctor() {
      const result = await run([process.execPath, cli, 'doctor', specPath, '--config', configPath, '--build-only'], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, GOWORK: join(root, 'go.work'), GOENV: join(root, 'host-go-env'), GOTOOLCHAIN: 'auto', GOFLAGS: '-mod=mod' },
      });
      assert.notEqual(result.stdout.trim(), '', result.stderr);
      return JSON.parse(result.stdout);
    },
    calls() { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; },
  };
}

for (const workspace of ['source', 'closest', 'off']) {
  test(`MyGo doctor probes the imported nested module with owned workspace ${workspace}`, async t => {
    const f = fixture(t, { sourceDir: 'imported', directory: 'apps/desktop' });
    const source = join(f.root, 'imported');
    const app = join(source, 'apps', 'desktop');
    mkdirSync(app, { recursive: true });
    const mod = 'module example.com/desktop\n\ngo 1.27.1\n\nrequire github.com/egoist/mygo v0.3.0\n\ntool github.com/egoist/mygo/cmd/mygo\n';
    writeFileSync(join(app, 'go.mod'), mod);
    writeFileSync(join(app, 'mygo.json'), '{}\n');
    let expectedWorkspace = 'off';
    if (workspace !== 'off') {
      expectedWorkspace = join(source, 'go.work');
      writeFileSync(expectedWorkspace, 'go 1.27.1\nuse ./apps/desktop\n');
    }
    if (workspace === 'closest') {
      expectedWorkspace = join(source, 'apps', 'go.work');
      writeFileSync(expectedWorkspace, 'go 1.27.1\nuse ./desktop\n');
    }
    const report = await f.doctor();
    const prerequisites = report.checks.filter(check => check.name.startsWith('configured-prerequisite-'));
    assert.equal(prerequisites.length, 2);
    assert.ok(prerequisites.every(check => check.available), JSON.stringify(prerequisites));
    const toolCalls = f.calls().filter(call => call.argv[0] === 'tool');
    assert.equal(toolCalls.length, 1);
    assert.deepEqual(toolCalls[0], {
      argv: ['tool', 'mygo', 'version'], cwd: app,
      env: { GOWORK: expectedWorkspace, GOENV: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly' },
    });
    assert.equal(readFileSync(join(app, 'go.mod'), 'utf8'), mod);
    assert.equal(readFileSync(join(app, 'mygo.json'), 'utf8'), '{}\n');
    assert.equal(existsSync(join(app, 'go.sum')), false);
    assert.equal(existsSync(join(f.root, 'workspaces')), false);
  });
}

for (const scenario of ['new-project', 'missing-source', 'missing-app']) {
  test(`MyGo doctor reports ${scenario} without probing a control-module tool`, async t => {
    const project = scenario === 'new-project' ? undefined : { sourceDir: 'not-created', directory: 'desktop' };
    const f = fixture(t, project);
    if (scenario === 'missing-app') mkdirSync(join(f.root, 'not-created'));
    const report = await f.doctor();
    const prerequisites = report.checks.filter(check => check.name.startsWith('configured-prerequisite-'));
    assert.equal(prerequisites.length, 2);
    for (const check of prerequisites) {
      assert.equal(check.available, false);
      assert.match(check.detail, /Project-scoped prerequisite cannot be checked yet/);
    }
    assert.equal(f.calls().some(call => call.argv[0] === 'tool'), false);
    assert.ok(f.calls().some(call => call.argv[0] === 'version'), 'generic Go availability may still be probed');
    assert.equal(existsSync(join(f.root, 'workspaces')), false);
    assert.equal(existsSync(join(f.root, 'not-created', 'desktop')), false);
  });
}

test('MyGo doctor retains the configured local-execution permission guard', async t => {
  const f = fixture(t, undefined, false);
  const report = await f.doctor();
  for (const check of report.checks.filter(check => check.name.startsWith('configured-prerequisite-'))) {
    assert.equal(check.available, false);
    assert.match(check.detail, /enable allowLocalExecution/);
  }
  assert.equal(f.calls().some(call => call.argv[0] === 'tool'), false);
});

test('doctor refuses a direct unsafe MyGo build prerequisite before invoking the tool', async t => {
  const f = fixture(t, { sourceDir: 'imported' });
  const app = join(f.root, 'imported');
  mkdirSync(app);
  writeFileSync(join(app, 'go.mod'), 'module example.com/desktop\ngo 1.27.1\nrequire github.com/egoist/mygo v0.3.0\ntool github.com/egoist/mygo/cmd/mygo\n');
  writeFileSync(join(app, 'mygo.json'), '{"macos":{"signingIdentity":"Developer ID Application: Not Authorized","notarize":{"keychainProfile":"not-authorized"}}}');
  const configPath = join(f.root, 'factory.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.verification.prerequisites = [['go', 'tool', 'mygo', 'build'], ['go', 'run', 'github.com/egoist/mygo/cmd/mygo', 'build']];
  writeFileSync(configPath, JSON.stringify(config));
  const report = await f.doctor();
  const prerequisites = report.checks.filter(check => check.name.startsWith('configured-prerequisite-'));
  assert.equal(prerequisites.length, 2);
  assert.ok(prerequisites.every(check => !check.available));
  assert.equal(f.calls().some(call => call.argv.includes('build')), false);
});
