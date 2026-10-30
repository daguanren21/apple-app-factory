import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dependencyDigest, isGeneratedPath, validateLocalDependencies } from '../dist/dependencies.js';
import { closestOwnedGoWorkspace, parseGoManifest } from '../dist/go-dependencies.js';
import { prepareWorkspace, sourceDigest } from '../dist/workspace.js';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-go-dependencies-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function file(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function module(root, path = '.', extra = '') {
  file(root, join(path, 'go.mod'), `module example.com/app\n\ngo 1.27.1\nrequire github.com/egoist/mygo v0.3.0\n${extra}`);
  file(root, join(path, 'main.go'), 'package main\nfunc main() {}\n');
}

function proofs(root, directory = '.') {
  return [sourceDigest(root, true, 'mygo', directory), dependencyDigest(root, 'mygo', directory)];
}

test('Go directives parse blocks, Go-escaped quotes, tool declarations and comments without executing code', () => {
  const parsed = parseGoManifest(`module example.com/app
// require example.com/comment v1.0.0
require (
  "github.com/egoist/mygo" v0.3.0 // indirect
)
tool (
 github.com/egoist/mygo/cmd/mygo
)
replace (
 example.com/first v1.0.0 => "./local\\x20source" // local
 example.com/second => example.com/fork v1.2.3
)
`);
  assert.equal(parsed.requires.get('github.com/egoist/mygo'), 'v0.3.0');
  assert.equal(parsed.requires.has('example.com/comment'), false);
  assert.deepEqual(parsed.tools, ['github.com/egoist/mygo/cmd/mygo']);
  assert.deepEqual(parsed.replacements, [
    { module: 'example.com/first', version: 'v1.0.0', target: './local source' },
    { module: 'example.com/second', target: 'example.com/fork', targetVersion: 'v1.2.3' },
  ]);
  assert.deepEqual(parseGoManifest('go 1.27.1\nuse (\n "./local source" // owned\n)\n').uses, ['./local source']);
});

for (const block of [false, true]) {
  test(`Go ${block ? 'block' : 'single'} directives preserve arrows inside owned path tokens`, t => {
    const root = fixture(t);
    module(root, '.', block ? 'replace (\n example.com/lib => ./lib=>v2\n)\n' : 'replace example.com/lib => ./lib=>v2\n');
    module(root, 'lib=>v2');
    file(root, 'go.work', `go 1.27.1\nuse .\n${block ? 'use (\n ./lib=>v2\n)' : 'use ./lib=>v2'}\n`);
    assert.deepEqual(parseGoManifest('use ./lib=>v2\n').uses, ['./lib=>v2']);
    const before = dependencyDigest(root, 'mygo');
    file(root, 'lib=>v2/main.go', 'package main\nconst Value = 2\n');
    assert.notEqual(dependencyDigest(root, 'mygo'), before);
  });
}

for (const text of [
  'replace example.com/lib=> ./lib\n',
  'replace example.com/lib =>./lib\n',
  'replace example.com/lib=>./lib\n',
  'replace example.com/lib => => ./lib\n',
  'use =>\n',
]) {
  test(`Go replacement operator must be a complete token: ${JSON.stringify(text)}`, () => {
    assert.throws(() => parseGoManifest(text), /Cannot prove Go manifest/);
  });
}

for (const extra of [
  'replace example.com/dep => ../outside',
  'replace example.com/dep v1.0.0 => "../outside" // no escape',
  'replace (\n example.com/dep => "..\\x2foutside"\n)',
  'replace ( /* comment */\n example.com/dep v1.0.0 => `../outside` // quoted\n)',
  'replace example.com/dep => /tmp/outside',
  'replace example.com/dep => "C:\\\\outside"',
  'replace example.com/dep => "\\\\\\\\server\\\\share"',
  'replace example.com/dep => ./build/local',
  'replace example.com/dep => ./.mygo/local',
  'replace example.com/dep => ./dist/local',
  'replace example.com/dep => ./node_modules/local',
]) {
  test(`local Go replacement cannot escape owned source: ${extra}`, t => {
    const root = fixture(t);
    module(root, '.', `${extra}\n`);
    assert.throws(() => validateLocalDependencies(root, 'mygo'), /relative path|escapes|outside fingerprinted|does not exist/);
  });
}

test('versioned remote replacement is not mistaken for a local directory', t => {
  const root = fixture(t);
  module(root, '.', 'replace (\n example.com/old v1.0.0 => example.com/fork v1.2.3\n example.com/other => example.com/remote v0.1.0\n)\n');
  assert.doesNotThrow(() => proofs(root));
  for (const target of ['../outside', '/tmp/outside', 'C:/outside']) {
    module(root, '.', `replace example.com/old => "${target}" v1.0.0\n`);
    assert.throws(() => validateLocalDependencies(root, 'mygo'), /Invalid versioned Go replacement/);
  }
});

test('owned replacement closure includes sibling source and lib/build, not unrelated fixture modules', t => {
  const root = fixture(t);
  module(root, 'apps/desktop', 'replace example.com/lib => "../../lib"\n');
  module(root, 'lib', 'replace example.com/leaf => ../leaf\n');
  module(root, 'leaf');
  module(root, 'test/fixtures/unused', 'replace example.com/escape => ../../../../outside\n');
  file(root, 'lib/build/value.go', 'package lib\nconst Value = 1\n');
  const before = proofs(root, 'apps/desktop');
  file(root, 'lib/build/value.go', 'package lib\nconst Value = 2\n');
  const after = proofs(root, 'apps/desktop');
  assert.notEqual(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
  assert.equal(closestOwnedGoWorkspace(root, 'apps/desktop'), undefined);
  module(root, 'leaf', 'replace example.com/escape => ../../outside\n');
  assert.throws(() => proofs(root, 'apps/desktop'), /escapes/);
});

for (const target of ['alias', 'alias/child']) {
  test(`local replacement rejects an owned symlink alias: ${target}`, t => {
    const root = fixture(t);
    module(root, '.', `replace example.com/lib => ./${target}\n`);
    module(root, 'lib');
    module(root, 'lib/child');
    symlinkSync(join(root, 'lib'), join(root, 'alias'), 'dir');
    assert.throws(() => proofs(root), /symlink/);
  });
}

test('closest owned Go workspace selects only its declared modules and ignores outer environment', t => {
  const root = fixture(t);
  module(root, 'apps/desktop');
  module(root, 'lib');
  file(root, 'go.work', 'go 1.27.1\nuse (\n ./apps/desktop\n ./lib\n)\n');
  file(root, 'go.work.sum', 'example.com/remote v1.0.0 h1:first\n');
  const previous = process.env.GOWORK;
  process.env.GOWORK = '/outside/attacker/go.work';
  try {
    assert.equal(closestOwnedGoWorkspace(root, 'apps/desktop'), join(root, 'go.work'));
    const before = proofs(root, 'apps/desktop');
    file(root, 'go.work.sum', 'example.com/remote v1.0.0 h1:second\n');
    assert.notDeepEqual(proofs(root, 'apps/desktop'), before);
    file(root, 'apps/go.work', 'go 1.27.1\nuse ./desktop\n');
    assert.equal(closestOwnedGoWorkspace(root, 'apps/desktop'), join(root, 'apps/go.work'));
    assert.doesNotThrow(() => proofs(root, 'apps/desktop'));
  } finally {
    if (previous === undefined) delete process.env.GOWORK;
    else process.env.GOWORK = previous;
  }
});

for (const value of ['../outside', '/tmp/outside', 'C:/outside', './build/lib', './.mygo/lib', './alias']) {
  for (const block of [false, true]) {
    test(`workspace ${block ? 'block' : 'single'} use rejects unowned path ${value}`, t => {
      const root = fixture(t);
      module(root);
      module(root, 'owned');
      symlinkSync(join(root, 'owned'), join(root, 'alias'), 'dir');
      // Even a same-owner alias is forbidden; remove it for other cases so use is exercised.
      if (value !== './alias') rmSync(join(root, 'alias'));
      file(root, 'go.work', `go 1.27.1\nuse .\n${block ? `use (\n "${value}" // dependency\n)` : `use "${value}"`}\n`);
      assert.throws(() => proofs(root), /relative path|escapes|outside fingerprinted|does not exist|symlink/);
    });
  }
}

test('workspace replacements and active-module membership carry proof authority', t => {
  const root = fixture(t);
  module(root, 'desktop');
  module(root, 'lib');
  file(root, 'go.work', 'go 1.27.1\nuse ./lib\n');
  assert.throws(() => proofs(root, 'desktop'), /include the selected Go module/);
  file(root, 'go.work', 'go 1.27.1\nuse ./desktop\nreplace (\n example.com/lib v1.0.0 => ./lib\n)\n');
  const before = proofs(root, 'desktop');
  file(root, 'lib/main.go', 'package main\nconst Value = 2\n');
  const after = proofs(root, 'desktop');
  assert.notEqual(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
  file(root, 'go.work', 'go 1.27.1\nuse ./desktop\nreplace example.com/lib => ../outside\n');
  assert.throws(() => proofs(root, 'desktop'), /escapes/);
});

test('Go manifests and sums must be regular, owned files', t => {
  const root = fixture(t);
  module(root);
  file(root, 'owned.sum', 'owned sum\n');
  symlinkSync(join(root, 'owned.sum'), join(root, 'go.sum'));
  assert.throws(() => proofs(root), /symlink/);
  rmSync(join(root, 'go.sum'));
  file(root, 'owned.work', 'go 1.27.1\nuse .\n');
  symlinkSync(join(root, 'owned.work'), join(root, 'go.work'));
  assert.throws(() => closestOwnedGoWorkspace(root), /regular owned source file/);
});

test('MyGo cache exclusions do not discard native-looking or sibling-owned build source', t => {
  const root = fixture(t);
  module(root, 'desktop');
  for (const path of ['build/file', 'dist/file', 'desktop/build/file', 'desktop/dist/file', 'desktop/.mygo/cache', '.mygo/cache', 'desktop/node_modules/dep/index.js', 'desktop/.yarn/cache/archive.zip']) file(root, path, 'first');
  const before = proofs(root, 'desktop');
  for (const path of ['build/file', 'dist/file', 'desktop/build/file', 'desktop/dist/file', 'desktop/.mygo/cache', '.mygo/cache', 'desktop/node_modules/dep/index.js', 'desktop/.yarn/cache/archive.zip']) file(root, path, 'second');
  assert.deepEqual(proofs(root, 'desktop'), before);
  for (const path of ['lib/build/value.go', 'lib/dist/value.go', 'lib/.build/value.go', 'lib/Pods/value.go', 'lib/.gradle/value.go', 'lib/.dart_tool/value.go']) {
    assert.equal(isGeneratedPath(path, 'mygo'), false);
    const digest = sourceDigest(root, true, 'mygo', 'desktop');
    file(root, path, 'owned source');
    assert.notEqual(sourceDigest(root, true, 'mygo', 'desktop'), digest);
  }
});

for (const directory of ['.', 'frontend']) {
  test(`web ${directory} package locks and installed resolution metadata invalidate dependency proof`, t => {
    const root = fixture(t);
    module(root);
    file(root, join(directory, 'package.json'), JSON.stringify({ name: 'web', dependencies: { local: 'file:./local' } }));
    file(root, join(directory, 'local/package.json'), '{"name":"local"}');
    file(root, join(directory, 'local/index.js'), 'export const value = 1;');
    file(root, join(directory, 'package-lock.json'), '{"lockfileVersion":3}');
    file(root, join(directory, 'node_modules/.package-lock.json'), '{"lockfileVersion":3}');
    for (const [path, content] of [
      ['package-lock.json', '{"lockfileVersion":2}'],
      ['local/index.js', 'export const value = 2;'],
      ['node_modules/.package-lock.json', '{"lockfileVersion":2}'],
      ['.yarn/install-state.gz', 'resolution'],
      ['.pnp.data.json', '{"resolution":"changed"}'],
    ]) {
      const before = dependencyDigest(root, 'mygo');
      file(root, join(directory, path), content);
      assert.notEqual(dependencyDigest(root, 'mygo'), before);
    }
    const pkg = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'));
    pkg.dependencies.local = 'file:../../outside';
    file(root, join(directory, 'package.json'), JSON.stringify(pkg));
    assert.throws(() => proofs(root), /escapes/);
  });
}

test('owned vendor implementation and module index are fingerprinted, not a global cache', t => {
  const root = fixture(t);
  module(root);
  file(root, 'vendor/modules.txt', '# example.com/library v1.0.0\n');
  file(root, 'vendor/example.com/library/value.go', 'package library\nconst Value = 1\n');
  const before = proofs(root);
  file(root, 'vendor/example.com/library/value.go', 'package library\nconst Value = 2\n');
  const after = proofs(root);
  assert.notEqual(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
  symlinkSync(join(root, 'main.go'), join(root, 'vendor/external.go'));
  assert.throws(() => proofs(root), /symlink/);
});

for (const text of ['replace (\n example.com/dep => "../outside\n)', 'replace (\n example.com/dep => ../outside\n', 'replace example.com/dep => ./local extra unexpected\n', '/* unterminated', 'unknown (\n ../outside\n)\n']) {
  test(`unsupported or malformed Go syntax fails closed: ${JSON.stringify(text)}`, () => {
    assert.throws(() => parseGoManifest(text), /Cannot prove Go manifest/);
  });
}

test('Go module versions and checksum changes cannot retain dependency proof', t => {
  const root = fixture(t);
  module(root);
  const initial = proofs(root);
  file(root, 'go.sum', 'example.com/remote v1.0.0 h1:first\n');
  const withSum = proofs(root);
  assert.notEqual(withSum[0], initial[0]);
  assert.notEqual(withSum[1], initial[1]);
  file(root, 'go.sum', 'example.com/remote v1.0.0 h1:second\n');
  assert.notEqual(dependencyDigest(root, 'mygo'), withSum[1]);
  const beforeModule = dependencyDigest(root, 'mygo');
  module(root, '.', 'require example.com/remote v1.2.0\n');
  assert.notEqual(dependencyDigest(root, 'mygo'), beforeModule);
});

test('quoted UTF-8 Go byte escapes resolve the same owned local module', t => {
  const root = fixture(t);
  module(root, '.', 'replace example.com/local => "./caf\\xc3\\xa9"\n');
  module(root, 'café');
  assert.doesNotThrow(() => proofs(root));
});

test('successor snapshot retains a selected nested app and owned sibling replacement source', t => {
  const root = fixture(t);
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'app', allowLocalExecution: true,
    verification: { checks: [['go', 'vet', './...']], runtime: [['go', 'run', './cmd/acceptance']] }, packaging: { provider: 'local', commands: [['go', 'tool', 'mygo', 'build', '-platform', 'darwin/arm64', '-sign', '-', '-skip-notarize', '-skip-dmg', '-o', 'build']], artifactPath: 'build/darwin-arm64/MyGo App.app' } });
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  const spec = { id: 'mygo-owned-source', name: 'MyGo owned source', purpose: 'Retain local module ownership', audience: 'Desktop owners', framework: 'mygo', platform: 'macos', channel: 'local', version: '1.0.0',
    project: { directory: 'apps/desktop' }, differentiators: ['Owned modules'], acceptance: ['Retain sibling source'] };
  const base = store.enqueue(spec, config);
  module(base.workspace, 'apps/desktop', 'replace example.com/lib => ../../lib\n');
  file(base.workspace, 'apps/desktop/mygo.json', '{}');
  module(base.workspace, 'lib');
  file(base.workspace, 'lib/build/value.go', 'package lib\nconst Value = 1\n');
  file(base.workspace, 'apps/desktop/build/stale.app', 'stale output');
  file(base.workspace, 'apps/desktop/.mygo/cache', 'cache');
  const before = proofs(base.workspace, 'apps/desktop');
  store.update(base.id, { status: 'built', stage: 'package', verifiedDigest: before[0], verifiedDependencyDigest: before[1] });
  const next = store.enqueue({ ...spec, version: '1.1.0' }, config, base.id);
  prepareWorkspace(store, next);
  assert.deepEqual(proofs(next.workspace, 'apps/desktop'), before);
  assert.equal(readFileSync(join(next.workspace, 'lib/build/value.go'), 'utf8'), 'package lib\nconst Value = 1\n');
  assert.equal(existsSync(join(next.workspace, 'apps/desktop/build')), false);
  assert.equal(existsSync(join(next.workspace, 'apps/desktop/.mygo')), false);
  file(next.workspace, 'lib/build/value.go', 'package lib\nconst Value = 2\n');
  assert.equal(readFileSync(join(base.workspace, 'lib/build/value.go'), 'utf8'), 'package lib\nconst Value = 1\n');
});

const jsonInputs = [
  ['main', value => ({ main: value })],
  ['resources', value => ({ resources: [value] })],
  ['icon', value => ({ icon: value })],
  ['macos.icon', value => ({ macos: { icon: value } })],
  ['macos.entitlements', value => ({ macos: { entitlements: value } })],
  ['macos.helperEntitlements', value => ({ macos: { helperEntitlements: { 'bin/helper': value } } })],
  ['bindings', value => ({ bindings: value })],
  ['frontendDist', value => ({ frontendDist: value })],
  ['updates.privateKey', value => ({ updates: { privateKey: value } })],
  ['updates.changelog', value => ({ updates: { changelog: value } })],
  ['windows.certificate', value => ({ windows: { certificate: value } })],
];

for (const [field, config] of jsonInputs) {
  test(`selected MyGo JSON ${field} rejects unowned static paths`, t => {
    const root = fixture(t);
    module(root, 'desktop');
    file(root, 'owned/file', 'owned');
    for (const value of ['/tmp/outside', '../../outside', 'C:/outside', '\\\\server\\share', '../alias/file', 'build/input', '../build/input', '.mygo/input', 'node_modules/input', '../.factory-cache/input']) {
      // Generated inputs exist, so exclusion rather than absence must reject them.
      if (!value.includes('outside') && !value.includes('alias') && !value.startsWith('\\')) file(root, join('desktop', value), 'mutable');
      if (value.includes('alias')) symlinkSync(join(root, 'owned'), join(root, 'alias'), 'dir');
      file(root, 'desktop/mygo.json', JSON.stringify(config(value)));
      assert.throws(() => validateLocalDependencies(root, 'mygo', 'desktop'));
      if (value.includes('alias')) rmSync(join(root, 'alias'));
    }
  });
}

test('owned sibling JSON inputs and bindings bytes carry dependency authority through a snapshot', t => {
  const root = fixture(t);
  module(root, 'apps/desktop');
  for (const [path, content] of [
    ['shared/main/main.go', 'package main\nfunc main() {}\n'],
    ['shared/resources/message.txt', 'first'],
    ['shared/icon.png', 'image'],
    ['shared/app.plist', 'app entitlement'],
    ['shared/helper.plist', 'helper entitlement'],
    ['shared/frontend/index.html', '<h1>Owned frontend</h1>'],
    ['shared/client.ts', 'export const first = 1;'],
    ['shared/update.key', 'owned key'],
    ['shared/CHANGELOG.md', 'release notes'],
    ['shared/certificate.pfx', 'owned cert'],
    ['shared/lib/build/value', 'owned sibling build'],
  ]) file(root, path, content);
  file(root, 'apps/desktop/mygo.json', JSON.stringify({
    main: '../../shared/main', icon: '../../shared/icon.png', resources: ['../../shared/resources', '../../shared/lib/build'],
    frontendDist: '../../shared/frontend', bindings: '../../shared/client.ts',
    macos: { icon: '../../shared/icon.png', entitlements: '../../shared/app.plist', helperEntitlements: { 'bin/helper': '../../shared/helper.plist' } },
    updates: { privateKey: '../../shared/update.key', changelog: '../../shared/CHANGELOG.md' }, windows: { certificate: '../../shared/certificate.pfx' },
  }));
  for (const path of ['shared/main/main.go', 'shared/resources/message.txt', 'shared/icon.png', 'shared/app.plist', 'shared/helper.plist', 'shared/frontend/index.html', 'shared/client.ts', 'shared/update.key', 'shared/CHANGELOG.md', 'shared/certificate.pfx', 'shared/lib/build/value']) {
    const before = proofs(root, 'apps/desktop');
    file(root, path, `${readFileSync(join(root, path), 'utf8')}\nchanged`);
    const after = proofs(root, 'apps/desktop');
    assert.notEqual(after[0], before[0], path);
    assert.notEqual(after[1], before[1], path);
  }
  const control = fixture(t);
  const config = ConfigSchema.parse({ stateDir: join(control, 'state'), workspaceRoot: join(control, 'workspaces'), packageTarget: 'app', allowLocalExecution: true,
    verification: { checks: [['go', 'vet', './...']], runtime: [['go', 'run', './cmd/acceptance']] }, packaging: { provider: 'local', commands: [['go', 'tool', 'mygo', 'build', '-platform', 'darwin/arm64', '-sign', '-', '-skip-notarize', '-skip-dmg', '-o', 'build']], artifactPath: 'build/darwin-arm64/MyGo App.app' } });
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  const job = store.enqueue({ id: 'mygo-json-source', name: 'MyGo JSON source', purpose: 'Retain JSON inputs', audience: 'Desktop owners', framework: 'mygo', platform: 'macos', channel: 'local', version: '1.0.0',
    project: { sourceDir: root, directory: 'apps/desktop' }, differentiators: ['Owned inputs'], acceptance: ['Retain sibling inputs'] }, config);
  prepareWorkspace(store, job);
  assert.deepEqual(proofs(job.workspace, 'apps/desktop'), proofs(root, 'apps/desktop'));
  assert.equal(readFileSync(join(job.workspace, 'shared/resources/message.txt'), 'utf8'), 'first\nchanged');
});

test('JSON validation activates only the selected app config and fingerprints its declarations', t => {
  const root = fixture(t);
  module(root, 'desktop');
  module(root, 'fixtures/unused');
  file(root, 'fixtures/unused/mygo.json', '{"resources":["/outside"]}');
  file(root, 'desktop/mygo.json', '{"name":"First"}');
  const before = dependencyDigest(root, 'mygo', 'desktop');
  file(root, 'desktop/mygo.json', '{"name":"Second"}');
  assert.notEqual(dependencyDigest(root, 'mygo', 'desktop'), before);
  file(root, 'desktop/build/output', 'ordinary generated build');
  assert.doesNotThrow(() => validateLocalDependencies(root, 'mygo', 'desktop'));
});

test('implicit JSON resources reject embedded mutable caches and symlinks', t => {
  const root = fixture(t);
  module(root);
  file(root, 'mygo.json', '{}');
  file(root, 'resources/icon.png', 'default icon');
  const before = dependencyDigest(root, 'mygo');
  file(root, 'resources/icon.png', 'changed icon');
  assert.notEqual(dependencyDigest(root, 'mygo'), before);
  file(root, 'resources/node_modules/unreviewed', 'mutable');
  assert.throws(() => proofs(root), /excluded mutable input/);
  rmSync(join(root, 'resources/node_modules'), { recursive: true });
  file(root, 'resources/.mygo/unreviewed', 'mutable');
  assert.throws(() => proofs(root), /excluded mutable input/);
  rmSync(join(root, 'resources/.mygo'), { recursive: true });
  symlinkSync(join(root, 'main.go'), join(root, 'resources/alias'));
  assert.throws(() => validateLocalDependencies(root, 'mygo'), /symlink/);
});

for (const directory of ['.', 'apps/desktop']) test(`JSON generated frontendDist carries exact byte authority for ${directory}`, t => {
  const root = fixture(t);
  module(root, directory);
  file(root, join(directory, 'mygo.json'), '{"frontendDist":"dist"}');
  const absent = dependencyDigest(root, 'mygo', directory);
  const sourceBefore = sourceDigest(root, true, 'mygo', directory);
  file(root, join(directory, 'dist/index.html'), '<h1>First compiled frontend</h1>');
  const first = dependencyDigest(root, 'mygo', directory);
  assert.notEqual(first, absent);
  assert.equal(sourceDigest(root, true, 'mygo', directory), sourceBefore);
  file(root, join(directory, 'dist/index.html'), '<h1>Changed compiled frontend</h1>');
  const changed = dependencyDigest(root, 'mygo', directory);
  assert.notEqual(changed, first);
  file(root, join(directory, 'dist/second.js'), 'export const second = 1;');
  assert.notEqual(dependencyDigest(root, 'mygo', directory), changed);
  rmSync(join(root, directory, 'dist/second.js'));
  assert.equal(dependencyDigest(root, 'mygo', directory), changed);
  file(root, join(directory, 'dist/node_modules/unreviewed.js'), 'excluded mutable cache');
  assert.throws(() => dependencyDigest(root, 'mygo', directory));
});

test('JSON frontend input cannot alias external bytes or embed its own platform output', t => {
  const root = fixture(t);
  module(root);
  file(root, 'mygo.json', '{"frontendDist":"dist"}');
  mkdirSync(join(root, 'dist'));
  symlinkSync(join(root, 'main.go'), join(root, 'dist/alias'));
  assert.throws(() => dependencyDigest(root, 'mygo'));
  rmSync(join(root, 'dist'), { recursive: true });
  for (const frontendDist of ['build', 'build/darwin-arm64/frontend', 'build/darwin-universal']) {
    file(root, 'mygo.json', JSON.stringify({ frontendDist }));
    assert.throws(() => dependencyDigest(root, 'mygo'));
  }
});

test('JSON configured bindings may be new owned files, not untracked cache writes', t => {
  const root = fixture(t);
  module(root);
  file(root, 'mygo.json', '{"bindings":"src/generated/mygo.ts"}');
  assert.doesNotThrow(() => validateLocalDependencies(root, 'mygo'));
  const before = dependencyDigest(root, 'mygo');
  file(root, 'src/generated/mygo.ts', 'export const owned = true;');
  assert.notEqual(dependencyDigest(root, 'mygo'), before);
  file(root, 'mygo.json', '{"bindings":".factory-cache/generated.ts"}');
  assert.throws(() => validateLocalDependencies(root, 'mygo'), /outside fingerprinted/);
});

test('JSON field aliases follow Go case folding and ambiguous aliases fail closed', t => {
  const root = fixture(t);
  module(root);
  for (const config of [{ Resources: ['/tmp/outside'] }, { 'reſourceſ': ['/tmp/outside'] }, { MacOS: { Entitlements: '/tmp/outside' } }]) {
    file(root, 'mygo.json', JSON.stringify(config));
    assert.throws(() => validateLocalDependencies(root, 'mygo'), /relative path/);
  }
  file(root, 'mygo.json', '{"resources":[],"Resources":["owned"]}');
  assert.throws(() => validateLocalDependencies(root, 'mygo'), /duplicate field/);
});

test('JSON static inputs require explicit regular paths and bundle-relative helper names', t => {
  const root = fixture(t);
  module(root);
  for (const config of [{ icon: '' }, { resources: '/tmp/file' }, { main: null }, { icon: 'missing.png' }, { icon: '.' }, { macos: { helperEntitlements: { '../outside': 'main.go' } } }, { macos: { helperEntitlements: { '/outside': 'main.go' } } }, { updates: { privateKey: '~/outside' } }]) {
    file(root, 'mygo.json', JSON.stringify(config));
    assert.throws(() => validateLocalDependencies(root, 'mygo'), /nonempty|array|does not exist|regular owned|inside bundle/);
  }
});

for (const text of [
  '{"macos":{"entitlements":"/external/app.plist"},"macos":{}}',
  '{"macos":{"entitlements":"/external/app.plist","entitlements":"owned.plist"}}',
  '{"resources":["/external/resource"],"resources":[]}',
  '{"ma\\u0063os":{"entitlements":"/external/app.plist"},"macos":{}}',
]) test(`duplicate JSON fields cannot discard effective MyGo inputs: ${text}`, t => {
  const root = fixture(t);
  module(root);
  file(root, 'owned.plist', 'owned');
  file(root, 'mygo.json', text);
  assert.throws(() => dependencyDigest(root, 'mygo'));
});

test('escaped UTF-8 BOM bytes select the exact Go replacement and workspace module', t => {
  const root = fixture(t);
  const actual = '\ufefflib';
  module(root, 'app', 'replace example.com/lib => "../\\xef\\xbb\\xbflib"\n');
  module(root, 'lib');
  module(root, actual);
  file(root, 'go.work', 'go 1.27.1\nuse (\n ./app\n "./\\xef\\xbb\\xbflib"\n)\n');
  assert.equal(parseGoManifest('replace example.com/lib => "./\\xef\\xbb\\xbflib"\n').replacements[0].target, `./${actual}`);
  const before = dependencyDigest(root, 'mygo', 'app');
  file(root, `${actual}/main.go`, 'package main\nfunc main() { println("changed actual module") }\n');
  assert.notEqual(dependencyDigest(root, 'mygo', 'app'), before);
  module(root, actual, 'replace example.com/external => ../../outside-snapshot\n');
  assert.throws(() => dependencyDigest(root, 'mygo', 'app'));
});

for (const frontendDist of ['dist/node_modules/frontend', 'build/.mygo/frontend', 'dist/.git/frontend', 'dist/.factory-cache/frontend', 'build/.yarn/cache/frontend']) test(`frontend root never gains authority beneath cache ancestor ${frontendDist}`, t => {
  const root = fixture(t);
  module(root);
  file(root, 'mygo.json', JSON.stringify({ frontendDist }));
  assert.throws(() => dependencyDigest(root, 'mygo'));
  file(root, join(frontendDist, 'index.html'), '<h1>Cache content</h1>');
  assert.throws(() => dependencyDigest(root, 'mygo'));
});
