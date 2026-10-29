import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveHash, seededRandom, walkProject } from '../dist/common.js';
import {
  analyzeDartClassLine,
  analyzeDartMethodLine,
  analyzeDartVariableLine,
  capitalize,
  deleteDartComments,
  generateClassName,
  generateMethodName,
  generateVariableName,
  generateResourceName,
  getFileMd5Value,
  isXcodeUuid,
  md5Hex,
  normalizeFlutterOptions,
  obscureClassNameByMyRule,
  obscureMethodNameByMyRule,
  obscureResourceNameByMyRule,
  obscureVariableNameByMyRule,
  perturbResourceHash,
  randomCodeString,
  remapPbxprojUuids,
  renameFlutterSymbols,
  replaceClassNameInLine,
  replaceMethodNameInLine,
  replaceVariableNameInLine,
  rewriteDartResourceReferences,
  rewriteYamlResourceReferences,
  splitCamel,
} from '../dist/flutter.js';

const opts = normalizeFlutterOptions();

function tempProject(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'obfuscator-flutter-'));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function projectSnapshot(root) {
  return Object.fromEntries(walkProject(root).files.map(entry => [entry.relative, readFileSync(entry.absolute, 'utf8')]));
}

test('capitalize and splitCamel match the Python helpers', () => {
  assert.equal(capitalize('widget'), 'Widget');
  assert.equal(capitalize('WIDGET'), 'Widget');
  assert.deepEqual(splitCamel('MyWidget'), ['', 'My', 'Widget']);
  assert.deepEqual(splitCamel('totalBetCount'), ['total', 'Bet', 'Count']);
});

test('class/method/variable/resource my-rule naming is deterministic and preserves the tail word', () => {
  const a = seededRandom(deriveHash('s', 'flutter'));
  const b = seededRandom(deriveHash('s', 'flutter'));
  const ca = obscureClassNameByMyRule('MyWidget', '', a);
  const cb = obscureClassNameByMyRule('MyWidget', '', b);
  assert.equal(ca, cb);
  assert.match(ca, /Widget$/);
  assert.notEqual(ca, 'MyWidget');

  const m1 = obscureMethodNameByMyRule('doSomething', '', seededRandom(deriveHash('s', 'flutter')));
  const m2 = obscureMethodNameByMyRule('doSomething', '', seededRandom(deriveHash('s', 'flutter')));
  assert.equal(m1, m2);

  const v1 = obscureVariableNameByMyRule('userName', '', seededRandom(deriveHash('s', 'flutter')));
  const v2 = obscureVariableNameByMyRule('userName', '', seededRandom(deriveHash('s', 'flutter')));
  assert.equal(v1, v2);
  assert.match(v1, /Name$/);

  const r1 = obscureResourceNameByMyRule('icon', '', seededRandom(deriveHash('s', 'flutter')));
  const r2 = obscureResourceNameByMyRule('icon', '', seededRandom(deriveHash('s', 'flutter')));
  assert.equal(r1, r2);
});

test('generators respect whitelists, MyApp and prefix#', () => {
  const rng = seededRandom(deriveHash('s', 'flutter'));
  assert.equal(generateClassName('MyApp', '', rng, opts), 'MyApp');
  assert.equal(generateClassName('Secret', '', rng, { ...opts, classWhiteList: ['Secret'] }), 'Secret');
  assert.equal(generateClassName('Foo', 'X#', rng, opts), 'XFoo');
  assert.equal(generateMethodName('build', '', rng, opts), 'build');
  assert.equal(generateVariableName('size', '', rng, opts), 'size');
});

test('dart line analysis detects declarations and skips ignored/structural cases', () => {
  assert.deepEqual(analyzeDartClassLine('class MyWidget {'), { name: 'MyWidget' });
  assert.equal(analyzeDartClassLine('  class Indented {}'), undefined);
  assert.equal(analyzeDartMethodLine('  Widget build(BuildContext context) {'), undefined);
  assert.deepEqual(analyzeDartMethodLine('  Widget doSomething() {'), { name: 'doSomething' });
  assert.deepEqual(analyzeDartVariableLine('  final String userName = \'x\';'), { kind: 'declaration', name: 'userName' });
  assert.deepEqual(analyzeDartVariableLine('  String city;'), { kind: 'declaration', name: 'city' });
  const constructor = analyzeDartVariableLine('  const MoreBetWidget({required this.totalBetCount});');
  assert.deepEqual(constructor, { kind: 'constructor', names: ['totalBetCount'] });
});

test('whole-word replacement protects string literals like the original', () => {
  assert.equal(replaceClassNameInLine('MyWidget widget = MyWidget();', 'MyWidget', 'Xyzzy'), 'Xyzzy widget = Xyzzy();');
  assert.equal(replaceMethodNameInLine('call("doSomething"); doSomething();', 'doSomething', 'obf'), 'call("doSomething"); obf();');
  assert.equal(replaceVariableNameInLine('print(\'userName\'); print(userName);', 'userName', 'obf'), 'print(\'userName\'); print(obf);');
  assert.equal(replaceVariableNameInLine('userName(\'x\');', 'userName', 'obf'), 'userName(\'x\');');
  assert.equal(replaceVariableNameInLine('import "userName"; userName = 1;', 'userName', 'obf'), 'import "userName"; userName = 1;');
});

test('comment deletion strips line and block comments and drops blank comment lines', () => {
  assert.equal(deleteDartComments('int x; // inline\n// full line\n/* block */\nint y;\n'), 'int x; \nint y;\n');
  assert.equal(deleteDartComments('const s = "value"; // real\n'), 'const s = "value"; \n');
  assert.equal(deleteDartComments('/* multi\nline\ncomment */\nint z;\n'), 'int z;\n');
});

test('resource reference rewrite matches dart and yaml patterns', () => {
  const map = new Map([['icon', 'obfIcon']]);
  assert.equal(
    rewriteDartResourceReferences("Image.asset('assets/icon.png');\n", map),
    "Image.asset('assets/obfIcon.png');\n",
  );
  assert.equal(
    rewriteYamlResourceReferences('  - assets/icon.png\n', map),
    '  - assets/obfIcon.png\n',
  );
});

test('md5 helpers and resource hash padding are deterministic', () => {
  assert.equal(md5Hex('test'), '098f6bcd4621d373cade4e832627b4f6');
  assert.equal(getFileMd5Value(Buffer.from('test')), '098f6bcd4621d373cade4e832627b4f6');
  const rng = seededRandom(deriveHash('s', 'flutter'));
  const pad = randomCodeString(4, rng);
  assert.match(pad, /^#[#&]{5}$/);
  const a = perturbResourceHash(Buffer.from('abc'), 'seed', 'assets/icon.png');
  const b = perturbResourceHash(Buffer.from('abc'), 'seed', 'assets/icon.png');
  assert.ok(a.equals(b));
  assert.equal(a.length, 9);
});

test('UUID detection and remapping', () => {
  assert.equal(isXcodeUuid('ABCDEF1234567890ABCDEF12'), true);
  assert.equal(isXcodeUuid('ABCDEF1234567890ABCDEF12G'), false); // 25 chars
  assert.equal(isXcodeUuid('abcdef1234567890abcdef12'), false); // not uppercase
  const source = 'ABCDEF1234567890ABCDEF12 = { isa = PBXFileReference; };\n';
  const once = remapPbxprojUuids(source, 'seed');
  const twice = remapPbxprojUuids(source, 'seed');
  assert.equal(once, twice);
  assert.notEqual(once, source);
  assert.ok(!once.includes('ABCDEF1234567890ABCDEF12'));
});

test('renameFlutterSymbols rewrites a small Flutter project deterministically', () => {
  const files = {
    'lib/main.dart': [
      '// remove me',
      "class MyWidget {",
      "  final String userName = 'Alice';",
      "  String city = 'Beijing';",
      "  Widget build(BuildContext context) {",
      "    return Text('Hi');",
      "  }",
      "  void doSomething() {",
      "    int count = 0;",
      "    print(userName);",
      "  }",
      '}',
      '',
    ].join('\n'),
    'pubspec.yaml': 'flutter:\n  assets:\n    - assets/icon.png\n',
    'assets/icon.png': 'PNGDATA',
    'ios/Runner.xcodeproj/project.pbxproj': 'ABCDEF1234567890ABCDEF12 = { isa = PBXFileReference; };\n',
  };

  const run = (t) => {
    const root = tempProject(t, files);
    const before = walkProject(root).files;
    const outcome = renameFlutterSymbols(before, {}, 'seed-1');
    assert.ok(outcome.changed > 0);
    return { root, outcome, snapshot: projectSnapshot(root) };
  };

  const first = run(test);
  const second = run(test);
  assert.deepEqual(first.snapshot, second.snapshot);

  const dart = first.snapshot['lib/main.dart'];
  assert.ok(!dart.includes('// remove me'));
  assert.ok(!dart.includes('class MyWidget'));
  assert.ok(dart.includes('Widget build(BuildContext context) {')); // ignored method stays
  assert.ok(!dart.includes('doSomething'));
  assert.ok(!dart.includes('userName'));
  assert.ok(!dart.includes('String city')); // renamed variable declaration
  assert.ok(dart.includes("'Alice'"));

  const yaml = first.snapshot['pubspec.yaml'];
  assert.ok(!yaml.includes('assets/icon.png'));

  const names = Object.keys(first.snapshot);
  assert.ok(!names.includes('assets/icon.png'));
  assert.ok(names.some(name => name.startsWith('assets/') && name.endsWith('.png')));

  const pbx = first.snapshot['ios/Runner.xcodeproj/project.pbxproj'];
  assert.ok(!pbx.includes('ABCDEF1234567890ABCDEF12'));
});
