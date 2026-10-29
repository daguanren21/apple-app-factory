import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { transformCode, stripComments, encryptStringLiterals, renameIdentifiers, insertJunkCode, extractDeclaredIdentifiers, generateIdentifierMappings } from '../dist/code.js';
import { walkProject } from '../dist/common.js';
import { applyObfuscation } from '../dist/obfuscate.js';
import { buildPNG, encodePNG, insertPngChunk, parsePNG } from '../dist/png.js';
import { planResourceRenames, applyResourceRenames, perturbImageHashes, recolorImages } from '../dist/resources.js';
import { renameProjectConfig, obfuscateDirectories, remapUuids } from '../dist/project.js';
import { filterSensitiveWords, recolorSourceColors } from '../dist/content.js';

const dist = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

// ---- Independent PNG fixtures (own CRC so png.ts is not self-validated) ----

function crc32(data) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let value = n;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      table[n] = value >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crc]);
}

/** Minimal non-interlaced 8-bit RGBA PNG built outside png.ts. */
function fixturePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function tempProject(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'obfuscator-'));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function entries(root) {
  return Object.fromEntries(walkProject(root).files.map(entry => [entry.relative, readFileSync(entry.absolute, 'utf8')]));
}

const red = Buffer.from([0xff, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff]);

// ---- code.ts ----

test('stripComments removes comments but keeps literals and line structure', () => {
  const dart = "void main() {\n  final s = '//not a comment';\n  // a real comment\n  print(s);\n}\n";
  const out = stripComments(dart, 'dart');
  assert.equal(out.includes("'//not a comment'"), true);
  assert.equal(out.includes('a real comment'), false);
  assert.equal(out.split('\n').length, dart.split('\n').length);
});

test('encryptStringLiterals decodes deterministically and respects excludes and URLs', () => {
  const dart = "final a = 'hello';\nfinal b = 'https://x.dev/y';\nfinal c = 'keep me';\n";
  const out = encryptStringLiterals(dart, 'dart', ['^keep'], 'seed');
  assert.match(out, /String\.fromCharCodes\(const \[104, 101, 108, 108, 111\]\)/);
  assert.equal(out.includes("'https://x.dev/y'"), true);
  assert.equal(out.includes("'keep me'"), true);
  assert.equal(encryptStringLiterals(dart, 'dart', ['^keep'], 'seed'), out);
});

test('renameIdentifiers never touches string literals', () => {
  const dart = "void main() { print(main); }\nconst t = 'main';\n";
  const out = renameIdentifiers(dart, 'dart', { main: 'entry' }, []);
  assert.match(out, /void entry\(\) \{ print\(entry\); \}/);
  assert.equal(out.includes("'main'"), true);
});

test('maskContent shields raw and plain triple-quoted strings whole, including inner quotes', () => {
  const cases = [
    "final a = r'''raw 'quoted' text''';\nfinal b = 'real';\n",
    'final a = r"""raw "quoted" text""";\nfinal b = \'real\';\n',
    'final a = """body with "quote" inside""";\nfinal b = \'real\';\n',
    "final a = '''body with 'quote' inside''';\nfinal b = 'real';\n",
  ];
  for (const dart of cases) {
    const out = encryptStringLiterals(dart, 'dart', [], 'seed');
    // The triple-quoted literal stays intact; only the ordinary 'real' literal is encrypted.
    assert.equal((out.match(/'''|"""|fromCharCodes/g) ?? []).filter(token => token === 'fromCharCodes').length, 1);
    assert.equal(out.includes("'real'"), false);
  }
  const withComment = "final a = '''/*not a comment*/''';\n// real comment\n";
  const stripped = stripComments(withComment, 'dart');
  assert.equal(stripped.includes('/*not a comment*/'), true);
  assert.equal(stripped.includes('real comment'), false);
});

test('encryptStringLiterals pins UTF-8 for java and kotlin decode expressions', () => {
  const java = encryptStringLiterals("String s = \"héllo\";", 'java', [], 'seed');
  assert.match(java, /java\.nio\.charset\.StandardCharsets\.UTF_8/);
  const kotlin = encryptStringLiterals("val s = \"héllo\"", 'kotlin', [], 'seed');
  assert.match(kotlin, /Charsets\.UTF_8/);
});

test('extractDeclaredIdentifiers finds top-level declarations but never methods or entrypoints', () => {
  const dart = "class Greeter {\n  void build() {}\n}\nvoid main() {}\nint helper() => 1;\nextension on int {}\n";
  const names = extractDeclaredIdentifiers(dart, 'dart');
  assert.equal(names.includes('Greeter'), true);
  assert.equal(names.includes('helper'), true);
  assert.equal(names.includes('build'), false); // indented method
  assert.equal(names.includes('main'), false); // entrypoint denylist
  assert.equal(names.includes('on'), false); // unnamed extension keyword
  const go = "func main() {}\nfunc Serve() {}\ntype Config struct{}\nfunc (s *Server) handle() {}\n";
  const goNames = extractDeclaredIdentifiers(go, 'go');
  assert.deepEqual(goNames.sort(), ['Config', 'Serve']);
});

test('generateIdentifierMappings is deterministic, count-limited and seed-variant', () => {
  const declared = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  const a = generateIdentifierMappings(declared, 2, 'seed-A');
  const b = generateIdentifierMappings(declared, 2, 'seed-A');
  const c = generateIdentifierMappings(declared, 2, 'seed-B');
  assert.deepEqual(a, b);
  assert.equal(Object.keys(a).length, 2);
  assert.notDeepEqual(a, c); // a different seed selects and/or names differently
  for (const value of Object.values(a)) assert.match(value, /^obf[0-9a-z]{8}$/);
  assert.equal(generateIdentifierMappings(['main'], 1, 'seed-A').main, undefined);
});

test('insertJunkCode is deterministic and path-salted', () => {
  const dart = 'void main() {}\n';
  const a = insertJunkCode(dart, 'dart', 2, 'seed', 'a.dart');
  const b = insertJunkCode(dart, 'dart', 2, 'seed', 'b.dart');
  assert.equal(insertJunkCode(dart, 'dart', 2, 'seed', 'a.dart'), a);
  assert.notEqual(a, b);
  assert.equal(insertJunkCode(dart, 'dart', 0, 'seed', 'a.dart'), dart);
});

test('transformCode runs the fixed pass order deterministically', () => {
  const source = '// comment\nvoid main() { final s = \'hi\'; }\n';
  const options = { removeComments: true, encryptStrings: { excludes: [] }, renameIdentifiers: { mappings: { main: 'entry' }, patterns: [] }, junkCode: { lines: 1 } };
  const a = transformCode(source, 'dart', options, 'seed', 'x.dart');
  const b = transformCode(source, 'dart', options, 'seed', 'x.dart');
  assert.equal(a, b);
  assert.equal(a.includes('// comment'), false);
  assert.match(a, /entry/);
});

// ---- png.ts ----

test('parsePNG decodes an independently built PNG', () => {
  const image = parsePNG(fixturePNG(2, 1, red));
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.deepEqual([...image.pixels], [...red]);
});

test('parsePNG rejects garbage, interlaced and truncated inputs', () => {
  assert.equal(parsePNG(Buffer.from('not a png')), undefined);
  const interlaced = fixturePNG(1, 1, red.subarray(0, 4));
  const ihdr = Buffer.alloc(13);
  interlaced.copy(ihdr, 0, 8, 21);
  ihdr[12] = 1; // Adam7 interlace
  ihdr.copy(interlaced, 8);
  assert.equal(parsePNG(interlaced), undefined);
  assert.equal(parsePNG(fixturePNG(1, 1, red.subarray(0, 4)).subarray(0, 20)), undefined);
});

test('buildPNG round-trips and encodePNG preserves ancillary chunks', () => {
  const source = buildPNG({ width: 2, height: 1, pixels: red });
  assert.deepEqual([...parsePNG(source).pixels], [...red]);
  const perturbed = insertPngChunk(source, 'tEXt', Buffer.from('Obfuscator\x00abcd'));
  assert.notEqual(perturbed.equals(source), true);
  assert.deepEqual([...parsePNG(perturbed).pixels], [...red]);
  const recolored = encodePNG(perturbed, parsePNG(perturbed));
  assert.equal(recolored.toString('latin1').includes('Obfuscator'), true);
  assert.deepEqual([...parsePNG(recolored).pixels], [...red]);
});

// ---- resources.ts ----

test('resource renames move files and rewrite references, leaving payloads intact', t => {
  const root = tempProject(t, {
    'assets/logo.png': fixturePNG(1, 1, red.subarray(0, 4)),
    'lib/main.dart': "final a = 'assets/logo.png';\n",
  });
  const files = walkProject(root).files;
  const plan = planResourceRenames(files, { logo: 'brandmark' });
  assert.deepEqual([...plan.renames], [['assets/logo.png', 'assets/brandmark.png']]);
  const outcome = applyResourceRenames(root, files, plan);
  assert.equal(outcome.changed, 2);
  const after = entries(root);
  assert.equal('assets/logo.png' in after, false);
  assert.equal(after['lib/main.dart'], "final a = 'assets/brandmark.png';\n");
  assert.equal(Buffer.isBuffer(readFileSync(join(root, 'assets/brandmark.png'))), true);
});

test('resource rename collisions keep the original path', t => {
  const root = tempProject(t, {
    'assets/logo.png': fixturePNG(1, 1, red.subarray(0, 4)),
    'assets/brandmark.png': fixturePNG(1, 1, red.subarray(0, 4)),
  });
  const files = walkProject(root).files;
  const plan = planResourceRenames(files, { logo: 'brandmark' });
  assert.equal(plan.renames.size, 0);
});

test('perturbImageHashes changes payload bytes but keeps PNGs decodable', t => {
  const root = tempProject(t, {
    'assets/a.png': fixturePNG(1, 1, red.subarray(0, 4)),
    'assets/b.svg': '<svg/>',
    'assets/c.ico': Buffer.from([0, 0, 1, 0]),
  });
  const files = walkProject(root).files;
  const before = readFileSync(join(root, 'assets/a.png'));
  const outcome = perturbImageHashes(files, 8, 'seed');
  assert.equal(outcome.changed, 1);
  assert.equal(outcome.unsupported, 2);
  const after = readFileSync(join(root, 'assets/a.png'));
  assert.notEqual(after.equals(before), true);
  assert.deepEqual([...parsePNG(after).pixels], [...red.subarray(0, 4)]);
  assert.equal(readFileSync(join(root, 'assets/b.svg'), 'utf8'), '<svg/>');
});

const green = Buffer.from([0x00, 0xff, 0x00, 0xff]);
const blue = Buffer.from([0x00, 0x00, 0xff, 0xff]);

test('recolorImages remaps exact colors and applies whole-image transforms', t => {
  // Each transform runs against a fresh single-file project so the cases never compound.
  const exactRoot = tempProject(t, { 'r.png': fixturePNG(1, 1, red.subarray(0, 4)), 'j.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  const exact = recolorImages(walkProject(exactRoot).files, { recolor: [{ from: '#FF0000', to: '#0000FF' }] }, 'seed');
  assert.equal(exact.changed, 1);
  assert.equal(exact.unsupported, 1);
  assert.deepEqual([...parsePNG(readFileSync(join(exactRoot, 'r.png'))).pixels], [0x00, 0x00, 0xff, 0xff]);

  const hueRoot = tempProject(t, { 'h.png': fixturePNG(1, 1, red.subarray(0, 4)) });
  const hue = recolorImages(walkProject(hueRoot).files, { recolor: [], recolorAll: { mode: 'hue-shift', degrees: 120 } }, 'seed');
  assert.equal(hue.changed, 1);
  assert.deepEqual([...parsePNG(readFileSync(join(hueRoot, 'h.png'))).pixels], [...green]);

  const invertRoot = tempProject(t, { 'i.png': fixturePNG(1, 1, red.subarray(0, 4)) });
  const invert = recolorImages(walkProject(invertRoot).files, { recolor: [], recolorAll: { mode: 'invert' } }, 'seed');
  assert.equal(invert.changed, 1);
  assert.deepEqual([...parsePNG(readFileSync(join(invertRoot, 'i.png'))).pixels], [0x00, 0xff, 0xff, 0xff]);

  const channelRoot = tempProject(t, { 'c.png': fixturePNG(1, 1, blue.subarray(0, 4)) });
  const channels = recolorImages(walkProject(channelRoot).files, { recolor: [], recolorAll: { mode: 'channels', order: 'BGR' } }, 'seed');
  assert.equal(channels.changed, 1);
  assert.deepEqual([...parsePNG(readFileSync(join(channelRoot, 'c.png'))).pixels], [0xff, 0x00, 0x00, 0xff]);
});

// ---- project.ts ----

test('renameProjectConfig touches framework config files only', t => {
  const root = tempProject(t, {
    'pubspec.yaml': 'name: demo_app\nversion: 1.0.0\n',
    'lib/main.dart': 'void demo_app() {}\n',
  });
  const outcome = renameProjectConfig(walkProject(root).files, 'flutter', { from: 'demo_app', to: 'hidden' });
  assert.equal(outcome.changed, 1);
  const after = entries(root);
  assert.equal(after['pubspec.yaml'], 'name: hidden\nversion: 1.0.0\n');
  assert.equal(after['lib/main.dart'], 'void demo_app() {}\n');
});

test('obfuscateDirectories renames seeded tokens and rewrites references', t => {
  const root = tempProject(t, {
    'lib/main.dart': "import 'package:app/lib/models.dart';\n",
    'lib/models.dart': 'class Model {}\n',
    'pubspec.yaml': 'name: app\n',
  });
  const files = walkProject(root).files;
  const outcome = obfuscateDirectories(root, files, ['lib'], 'seed');
  const after = entries(root);
  const token = Object.keys(after).find(relative => relative.startsWith('obf') && relative.endsWith('/main.dart'))?.split('/')[0];
  assert.match(token ?? '', /^obf[0-9a-z]{8}$/);
  assert.equal(after[`${token}/main.dart`], `import 'package:app/${token}/models.dart';\n`);
  assert.equal(outcome.changed, 3);
});

test('remapUuids preserves the internal reference graph deterministically', t => {
  const shared = '1A2B3C4D5E6F7A8B9C0D1E2F';
  const solo = 'ABCDEF1234567890ABCDEF12';
  const content = `A = ${shared};\nB = ${shared};\nC = ${solo};\nSHORT = 1234ABCDEF;\n`;
  const root = tempProject(t, { 'A.pbxproj': content, 'a.bin': content });
  const first = remapUuids(walkProject(root).files, 'seed');
  assert.equal(first.changed, 1);
  const after = entries(root)['A.pbxproj'];
  assert.match(after, /A = [0-9A-F]{24};/);
  assert.match(after, /B = [0-9A-F]{24};/);
  const a = after.match(/A = ([0-9A-F]{24});/)[1];
  const b = after.match(/B = ([0-9A-F]{24});/)[1];
  const c = after.match(/C = ([0-9A-F]{24});/)[1];
  assert.equal(a, b); // the same original always maps to the same derived value
  assert.notEqual(a, c);
  assert.notEqual(a, shared);
  assert.equal(after.includes('SHORT'), true); // sub-24-hex tokens are never touched
  assert.equal(entries(root)['a.bin'], content); // binary payloads are never touched
});

// ---- content.ts ----

test('filterSensitiveWords scrubs text and code, never binary payloads', t => {
  const root = tempProject(t, {
    'README.md': 'AcmeCorp builds widgets.',
    'lib/main.dart': "const brand = 'AcmeCorp';\n",
    'assets/font.bin': Buffer.from('AcmeCorp bytes'),
  });
  const outcome = filterSensitiveWords(walkProject(root).files, { AcmeCorp: 'GenericApp' });
  assert.equal(outcome.changed, 2);
  const after = entries(root);
  assert.equal(after['README.md'], 'GenericApp builds widgets.');
  assert.equal(after['lib/main.dart'], "const brand = 'GenericApp';\n");
  assert.equal(readFileSync(join(root, 'assets/font.bin'), 'utf8'), 'AcmeCorp bytes');
});

test('recolorSourceColors maps control before font colors without cascading', t => {
  const root = tempProject(t, {
    'theme.css': 'a { color: #FF0000; } b { color: #00FF00; } c { color: #123456; }',
  });
  const outcome = recolorSourceColors(walkProject(root).files, { '#ff0000': '#0000ff', '#00ff00': '#0000ff' }, { '#00ff00': '#abcdef' });
  assert.equal(outcome.changed, 1);
  const after = entries(root)['theme.css'];
  assert.equal(after, 'a { color: #0000ff; } b { color: #0000ff; } c { color: #123456; }');
});

// ---- obfuscate.ts end-to-end + CLI ----

const fullConfig = {
  framework: 'flutter',
  seed: 'test-seed',
  project: { name: { from: 'demo_app', to: 'hidden_app' }, directories: ['assets'], uuids: true },
  resources: { rename: { mappings: { logo: 'mark' } }, hashPerturb: { bytes: 8 }, images: { recolor: [{ from: '#FF0000', to: '#0000FF' }] } },
  content: { sensitiveWords: { AcmeCorp: 'GenericApp' }, controlColors: { '#00FF00': '#112233' } },
  code: { removeComments: true, encryptStrings: { excludes: [] }, junkCode: { lines: 1 } },
};

const fixtureFiles = () => ({
  'pubspec.yaml': 'name: demo_app\n',
  'assets/logo.png': fixturePNG(1, 1, red.subarray(0, 4)),
  'lib/main.dart': "// gone\nvoid main() { print('assets/logo.png'); }\n",
  'README.md': 'AcmeCorp #00FF00\n',
  'A.pbxproj': 'X = 1A2B3C4D5E6F7A8B9C0D1E2F;\n',
});

test('applyObfuscation transforms the whole project deterministically', t => {
  const first = tempProject(t, fixtureFiles());
  const second = tempProject(t, fixtureFiles());
  const reportA = applyObfuscation(first, fullConfig, 'test-seed', 'flutter');
  const reportB = applyObfuscation(second, fullConfig, 'test-seed', 'flutter');
  assert.deepEqual(reportA, reportB);
  assert.ok(reportA.changedFiles >= 5);
  for (const name of ['projectName', 'projectDirectories', 'projectUuids', 'resourceRename', 'resourceHash', 'imageRecolor', 'sensitiveWords', 'sourceColors', 'code']) {
    assert.ok(reportA.transforms[name] >= 0, `missing transform ${name}`);
  }
  assert.equal(reportA.transforms.resourceRename, 2); // move + reference rewrite
  assert.equal(reportA.transforms.imageRecolor, 1);
  assert.equal(reportA.skipped.unsupported, 0);
  const filesA = entries(first);
  const filesB = entries(second);
  assert.deepEqual(Object.keys(filesA).sort(), Object.keys(filesB).sort());
  for (const key of Object.keys(filesA)) assert.equal(filesA[key], filesB[key]);
  const main = filesA[Object.keys(filesA).find(key => key.endsWith('main.dart'))];
  assert.equal(main.includes('// gone'), false);
  assert.equal(filesA['README.md'], 'GenericApp #112233\n');
  assert.equal(filesA['pubspec.yaml'], 'name: hidden_app\n');
  assert.equal(filesA['A.pbxproj'] === 'X = 1A2B3C4D5E6F7A8B9C0D1E2F;\n', false);
});

test('seed-generated identifier renames differ across seeds and stay compile-consistent', t => {
  const sources = () => ({
    'lib/greeter.dart': 'class Greeter {\n  String greet() => \'hi\';\n}\n',
    'lib/main.dart': "import 'greeter.dart';\nvoid main() {\n  final g = Greeter();\n  print(g.greet());\n}\n",
    'lib/user.g.dart': 'class UserSerializer {\n  Greeter? field;\n}\n',
  });
  const config = { framework: 'flutter', seed: 's', code: { renameIdentifiers: { mappings: {}, patterns: [], generated: 1 } } };
  const first = tempProject(t, sources());
  const second = tempProject(t, sources());
  applyObfuscation(first, config, 'seed-A', 'flutter');
  applyObfuscation(second, config, 'seed-B', 'flutter');
  const a = entries(first), b = entries(second);
  const renamed = Object.keys(a).find(key => a[key] !== b[key] && key.endsWith('greeter.dart'));
  assert.ok(renamed, 'generated rename should differ across seeds');
  const tokenA = a[renamed].match(/^class (obf[0-9a-z]{8})/)?.[1];
  assert.ok(tokenA, `expected derived class token in ${a[renamed]}`);
  // The call site in main.dart follows the renamed class; entrypoint and generated code do not.
  assert.equal(a['lib/main.dart'].includes(`final g = ${tokenA}();`), true);
  assert.equal(a['lib/main.dart'].includes('void main()'), true);
  assert.equal(a['lib/user.g.dart'], 'class UserSerializer {\n  Greeter? field;\n}\n');
  assert.equal(a['lib/user.g.dart'], b['lib/user.g.dart']);
});

test('seed-generated resource renames differ across seeds and rewrite references', t => {
  const sources = () => ({
    'assets/banner.png': fixturePNG(1, 1, red.subarray(0, 4)),
    'assets/logo.png': fixturePNG(1, 1, red.subarray(0, 4)),
    'lib/main.dart': "final a = 'assets/banner.png';\nfinal b = 'assets/logo.png';\n",
  });
  const config = { framework: 'flutter', seed: 's', resources: { rename: { mappings: {}, generated: 1 } } };
  const first = tempProject(t, sources());
  const second = tempProject(t, sources());
  applyObfuscation(first, config, 'seed-A', 'flutter');
  applyObfuscation(second, config, 'seed-B', 'flutter');
  const dirsA = Object.keys(entries(first)).filter(key => key.startsWith('assets/')).sort();
  const dirsB = Object.keys(entries(second)).filter(key => key.startsWith('assets/')).sort();
  assert.notDeepEqual(dirsA, dirsB);
  assert.equal(dirsA.length, 2);
  const mainA = entries(first)['lib/main.dart'];
  for (const key of dirsA) {
    const stem = key.split('/')[1].replace('.png', '');
    assert.equal(mainA.includes(`assets/${stem}.png`), true, `reference to ${key} rewritten`);
  }
});

test('CLI applies the config file and prints a JSON report', t => {
  const root = tempProject(t, fixtureFiles());
  const configPath = join(root, '..', `obfuscator-config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(configPath, JSON.stringify(fullConfig));
  t.after(() => rmSync(configPath, { force: true }));
  const result = spawnSync(process.execPath, [dist, '--project', root, '--config', configPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.changedFiles >= 5);
  assert.equal(typeof report.transforms.code, 'number');
});

test('CLI rejects unknown frameworks and invalid configs', t => {
  const root = tempProject(t, { 'a.txt': 'x' });
  const configPath = join(root, '..', `obfuscator-fw-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(configPath, JSON.stringify({ code: { removeComments: true } }));
  t.after(() => rmSync(configPath, { force: true }));
  const bad = spawnSync(process.execPath, [dist, '--project', root, '--config', configPath, '--framework', 'cobol'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /framework must be one of/);
  const empty = spawnSync(process.execPath, [dist, '--project', root], { encoding: 'utf8' });
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /Invalid obfuscator configuration/);
});
