import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { JobSchema } from '../dist/contracts/schemas.js';
import { UI_QUALITY_CHECKS, UiQualitySchema, minimumUiQualityBytes } from '../dist/contracts/ui-quality.js';
import { combineUiQuality, validateUiQuality } from '../dist/projects/ui-quality.js';

// Real PNG containers with compressed scanlines and CRCs exercise the public byte
// validator. These parser fixtures are not claimed as rendered application proof.
function png(width, height) {
  function chunk(name, data) {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(name, 4, 'ascii');
    data.copy(bytes, 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(4, -4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4);
    return bytes;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const smallPng = png(32, 64), widePng = png(96, 64);
const trace = Buffer.from(JSON.stringify({ surface: 'test fixture', events: [{ time: 0, state: 'open' }, { time: 120, state: 'closed', reducedMotion: true }] }));
// A baseline JPEG frame with one DC/AC Huffman code, one quantization table and
// an encoded one-pixel grayscale scan; no image decoder or external process needed.
const jpeg = Buffer.from([
  0xff, 0xd8,
  0xff, 0xdb, 0, 67, 0, ...Array(64).fill(1),
  0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
  0xff, 0xc4, 0, 20, 0, 1, ...Array(15).fill(0), 0,
  0xff, 0xc4, 0, 20, 0x10, 1, ...Array(15).fill(0), 0,
  0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x3f, 0xff, 0xd9,
]);

function capture(project, path, bytes, kind, width = 32, height = 64) {
  mkdirSync(dirname(join(project, path)), { recursive: true });
  writeFileSync(join(project, path), bytes);
  return {
    path, sha256: createHash('sha256').update(bytes).digest('hex'), kind,
    viewport: { width, height }, device: 'Parser fixture, scale 1', state: 'Fixture observation state',
  };
}

function fixture(t, spec = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apphx-ui-quality-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const job = JobSchema.parse({
    id: 'ui-gate', spec: {
      id: 'ui-gate', name: 'UI gate', purpose: 'Validate local visual evidence', audience: 'App reviewers',
      framework: 'flutter', platform: 'ios', screenshotsDir: 'build/screenshots',
      differentiators: ['Local evidence'], acceptance: ['Observe platform adaptation'], ...spec,
    },
    requestSpec: null,
    config: {
      stateDir: join(root, 'state'), workspaceRoot: root, projectMode: 'isolated', uiQuality: true,
      packageTarget: 'simulator', verification: { checks: [['unused']], runtime: [['unused']] },
    },
    stage: 'review', status: 'waiting', createdAt: 0, updatedAt: 0, nextAt: 0,
    attempts: {}, hostTurns: 0, groups: [], receipt: {}, logs: [], workspace, projectRoot: workspace,
  });
  const project = join(workspace, spec.project?.directory ?? '.');
  const captures = [
    capture(project, 'build/screenshots/small.png', smallPng, 'image'),
    capture(project, 'build/screenshots/wide.png', widePng, 'image', 96, 64),
    capture(project, 'build/screenshots/motion.json', trace, 'trace'),
  ];
  const observations = {
    'system-insets': 'Observed the primary controls clear of native system bars and gesture areas.',
    'responsive-layout': 'Observed narrow and wide layouts with all primary controls reachable.',
    'keyboard-focus': 'Observed keyboard opening, dismissal, reachable inputs and focus restoration.',
    'text-scaling': 'Observed enlarged system text without clipped labels or inaccessible controls.',
    motion: 'Observed interrupted and reversed transitions, reduced motion and preserved focus.',
    'visual-design': 'Observed composition and hierarchy against the existing project design intent.',
  };
  const quality = {
    captures,
    checks: UI_QUALITY_CHECKS.map(id => ({
      id, status: 'passed', observation: observations[id],
      capturePaths: id === 'responsive-layout' ? captures.slice(0, 2).map(entry => entry.path)
        : [captures[id === 'motion' ? 2 : 0].path],
    })),
  };
  return { root, project, job, quality };
}

function replaceBytes(f, index, bytes) {
  const entry = f.quality.captures[index];
  writeFileSync(join(f.project, entry.path), bytes);
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
}

function replaceCapture(f, index, entry) {
  const oldPath = f.quality.captures[index].path;
  f.quality.captures[index] = entry;
  for (const check of f.quality.checks) check.capturePaths = check.capturePaths.map(path => path === oldPath ? entry.path : path);
}

test('final approval accepts complete, hash-bound local evidence in a selected monorepo project', t => {
  const f = fixture(t, { project: { directory: 'apps/ios' } });
  const approved = validateUiQuality(f.job, f.quality);
  assert.equal(approved.checks.length, 6);
  assert.equal(approved.captures[1].viewport.width, 96);
  // Revalidation reads current bytes; changing a previously approved file vetoes it.
  writeFileSync(join(f.project, approved.captures[0].path), widePng);
  assert.throws(() => validateUiQuality(f.job, approved), /SHA-256 mismatch/);
});

test('missing evidence and incomplete specialist coverage cannot approve the final review', t => {
  const f = fixture(t);
  assert.throws(() => validateUiQuality(f.job, undefined));
  assert.throws(() => validateUiQuality(f.job, { captures: [], checks: [] }), /missing required check/);
  for (const id of UI_QUALITY_CHECKS) {
    const partial = { ...f.quality, checks: f.quality.checks.filter(check => check.id !== id) };
    assert.equal(UiQualitySchema.safeParse(partial).success, true);
    assert.throws(() => validateUiQuality(f.job, partial), new RegExp(`missing required check: ${id}`));
  }
});

for (const id of UI_QUALITY_CHECKS) {
  test(`a failed ${id} remains an approval veto`, t => {
    const f = fixture(t);
    f.quality.checks.find(check => check.id === id).status = 'failed';
    assert.throws(() => validateUiQuality(f.job, f.quality), new RegExp(`check failed: ${id}`));
  });
}

for (const id of ['system-insets', 'responsive-layout', 'text-scaling', 'visual-design']) {
  test(`${id} cannot claim not-applicable`, t => {
    const f = fixture(t);
    f.quality.checks.find(check => check.id === id).status = 'not-applicable';
    assert.throws(() => validateUiQuality(f.job, f.quality), /cannot be not-applicable/);
  });
}

for (const id of ['keyboard-focus', 'motion']) {
  test(`${id} non-applicability requires observed explanation and local evidence without language heuristics`, t => {
    const f = fixture(t);
    const check = f.quality.checks.find(entry => entry.id === id);
    check.status = 'not-applicable';
    check.observation = id === 'motion' ? '已观察全部界面与状态：静态展示，没有动画或过渡。' : '已观察当前只读展示界面：没有输入控件或可聚焦交互。';
    assert.equal(validateUiQuality(f.job, f.quality).checks.find(entry => entry.id === id).status, 'not-applicable');
    check.capturePaths = [];
    assert.throws(() => validateUiQuality(f.job, f.quality), /requires referenced captures/);
    check.capturePaths = [f.quality.captures[0].path];
    check.observation = '  ';
    assert.throws(() => validateUiQuality(f.job, f.quality));
  });
}

test('every passed check references a declared capture, not an arbitrary file or an empty list', t => {
  const f = fixture(t);
  for (const check of f.quality.checks) {
    const paths = check.capturePaths;
    check.capturePaths = [];
    assert.throws(() => validateUiQuality(f.job, f.quality), /requires referenced captures/);
    check.capturePaths = ['build/screenshots/undeclared.png'];
    assert.throws(() => validateUiQuality(f.job, f.quality), /unknown capture/);
    check.capturePaths = paths;
  }
});

test('responsive coverage requires two image geometries, not repeated paths, traces or filenames', t => {
  const f = fixture(t);
  const check = f.quality.checks.find(entry => entry.id === 'responsive-layout');
  check.capturePaths = [f.quality.captures[0].path, f.quality.captures[0].path];
  assert.throws(() => validateUiQuality(f.job, f.quality), /two distinct viewport geometries/);
  check.capturePaths = [f.quality.captures[0].path, f.quality.captures[2].path];
  f.quality.captures[2].viewport = { width: 1000, height: 900 };
  assert.throws(() => validateUiQuality(f.job, f.quality), /two distinct viewport geometries/);
  replaceCapture(f, 1, capture(f.project, 'build/screenshots/second.png', smallPng, 'image'));
  check.capturePaths = f.quality.captures.slice(0, 2).map(entry => entry.path);
  assert.throws(() => validateUiQuality(f.job, f.quality), /two distinct viewport geometries/);
});

test('screenshots alone cannot pass motion and traces cannot stand in for visual/inset images', t => {
  const f = fixture(t);
  for (const id of ['system-insets', 'visual-design', 'motion']) {
    const check = f.quality.checks.find(entry => entry.id === id), paths = check.capturePaths;
    check.capturePaths = [f.quality.captures[id === 'motion' ? 0 : 2].path];
    assert.throws(() => validateUiQuality(f.job, f.quality), /requires an image|requires video or trace/);
    check.capturePaths = paths;
  }
});

test('header dimensions, PNG chunks and JPEG frame/scan headers are validated independently of hashes', t => {
  const f = fixture(t);
  f.quality.captures[0].viewport.width++;
  assert.throws(() => validateUiQuality(f.job, f.quality), /dimensions do not match/);
  f.quality.captures[0].viewport.width--;
  replaceBytes(f, 0, smallPng.subarray(0, 33));
  assert.throws(() => validateUiQuality(f.job, f.quality), /PNG/);
  replaceBytes(f, 0, Buffer.from('not an image'));
  assert.throws(() => validateUiQuality(f.job, f.quality), /PNG/);
  replaceCapture(f, 0, capture(f.project, 'build/screenshots/small.jpg', jpeg, 'image', 1, 1));
  assert.equal(validateUiQuality(f.job, f.quality).captures[0].path, 'build/screenshots/small.jpg');
  replaceBytes(f, 0, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.throws(() => validateUiQuality(f.job, f.quality), /JPEG/);
});

test('unsupported image formats and mismatched filename types are rejected', t => {
  const f = fixture(t);
  replaceCapture(f, 0, capture(f.project, 'build/screenshots/small.svg', Buffer.from('<svg/>'), 'image'));
  assert.throws(() => validateUiQuality(f.job, f.quality), /PNG or JPEG/);
  replaceCapture(f, 0, capture(f.project, 'build/screenshots/small.jpg', smallPng, 'image'));
  assert.throws(() => validateUiQuality(f.job, f.quality), /JPEG/);
});

test('video headers and trace types are checked without executing their contents', t => {
  const f = fixture(t);
  replaceCapture(f, 2, capture(f.project, 'build/screenshots/motion.txt', Buffer.from('Observed reduced motion; process.exit(99) is inert text.'), 'trace'));
  assert.equal(validateUiQuality(f.job, f.quality).captures[2].kind, 'trace');
  replaceBytes(f, 2, Buffer.from(' \n '));
  assert.throws(() => validateUiQuality(f.job, f.quality), /contain observed evidence/);
  replaceCapture(f, 2, capture(f.project, 'build/screenshots/motion.js', trace, 'trace'));
  assert.throws(() => validateUiQuality(f.job, f.quality), /JSON or TXT/);
  replaceCapture(f, 2, capture(f.project, 'build/screenshots/motion.mp4', trace, 'video'));
  assert.throws(() => validateUiQuality(f.job, f.quality), /MP4 or WebM/);
  // This container-header fixture establishes only structural admission, not that
  // playback occurred or animation was independently reviewed.
  const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
  replaceBytes(f, 2, mp4);
  assert.equal(validateUiQuality(f.job, f.quality).captures[2].kind, 'video');
  const scaling = f.quality.checks.find(check => check.id === 'text-scaling');
  scaling.capturePaths = [f.quality.captures[2].path];
  assert.throws(() => validateUiQuality(f.job, f.quality), /text-scaling requires image or trace/);
});

for (const path of ['/tmp/a.png', 'C:/a.png', 'C:a.png', '\\\\host\\a.png', '../a.png', 'build/../a.png', './build/a.png', 'build//a.png', 'build/a*.png', 'build/a?.png', 'build/[a].png', 'build/{a,b}.png', 'build/a\0.png', 'build/a\\b.png', 'build/CON.png', 'build/a.']) {
  test(`capture schema rejects unsafe or nonportable path ${JSON.stringify(path)}`, t => {
    const f = fixture(t);
    f.quality.captures[0].path = path;
    assert.equal(UiQualitySchema.safeParse(f.quality).success, false);
    assert.throws(() => validateUiQuality(f.job, f.quality));
  });
}

test('strict schema rejects duplicate IDs, duplicate captures, unbounded fields and invented properties', t => {
  const f = fixture(t);
  const mutate = change => {
    const value = structuredClone(f.quality);
    change(value);
    assert.equal(UiQualitySchema.safeParse(value).success, false);
  };
  mutate(value => { value.checks[1].id = value.checks[0].id; });
  mutate(value => { value.captures.push(value.captures[0]); });
  mutate(value => { value.extra = true; });
  mutate(value => { value.captures[0].extra = true; });
  mutate(value => { value.captures[0].viewport.scale = 2; });
  mutate(value => { value.checks[0].extra = true; });
  mutate(value => { value.captures[0].sha256 = 'a'.repeat(63); });
  mutate(value => { value.captures[0].device = ' '; });
  mutate(value => { value.captures[0].device = 'a'.repeat(301); });
  mutate(value => { value.captures[0].state = 'a'.repeat(2001); });
  mutate(value => { value.checks[0].observation = 'a'.repeat(10001); });
  mutate(value => { value.checks[0].capturePaths = Array(33).fill(value.captures[0].path); });
  for (const width of [0, -1, 1.5, 16385, NaN, Infinity]) mutate(value => { value.captures[0].viewport.width = width; });
  mutate(value => { value.captures = Array.from({ length: 33 }, (_, index) => ({ ...value.captures[0], path: `build/screenshots/${index}.png` })); });
  f.quality.captures[0].sha256 = f.quality.captures[0].sha256.toUpperCase();
  assert.equal(validateUiQuality(f.job, f.quality).captures[0].sha256, createHash('sha256').update(smallPng).digest('hex'));
});

test('captures cannot leave the configured screenshot directory even for existing project files', t => {
  const f = fixture(t);
  replaceCapture(f, 0, capture(f.project, 'build/elsewhere/small.png', smallPng, 'image'));
  assert.throws(() => validateUiQuality(f.job, f.quality), /inside the workspace/);
});

for (const directory of [undefined, 'screenshots', 'lib/build/screenshots', 'node_modules/build/screenshots', '.git/build/screenshots', '../screenshots', '/tmp/screenshots']) {
  test(`screenshotsDir cannot widen source trust: ${String(directory)}`, t => {
    const f = fixture(t);
    f.job.spec.screenshotsDir = directory;
    if (directory && !directory.startsWith('/') && !directory.startsWith('..')) mkdirSync(join(f.project, directory), { recursive: true });
    assert.throws(() => validateUiQuality(f.job, f.quality));
  });
}

for (const target of ['file', 'capture-parent', 'screenshots', 'project', 'workspace-ancestor']) {
  test(`symlink ${target} cannot supply UI evidence even when it aliases owned bytes`, t => {
    const f = fixture(t);
    let path;
    if (target === 'file') path = join(f.project, f.quality.captures[0].path);
    else if (target === 'capture-parent') {
      replaceCapture(f, 0, capture(f.project, 'build/screenshots/nested/small.png', smallPng, 'image'));
      path = join(f.project, 'build/screenshots/nested');
    } else if (target === 'screenshots') path = join(f.project, 'build/screenshots');
    else if (target === 'project') path = f.project;
    else path = f.root;
    const original = `${path}-original`;
    renameSync(path, original);
    symlinkSync(original, path, target === 'file' ? 'file' : 'dir');
    if (target === 'workspace-ancestor') t.after(() => rmSync(original, { recursive: true, force: true }));
    assert.throws(() => validateUiQuality(f.job, f.quality), /symlink/);
  });
}

test('nonregular, missing, empty, oversized and unused invalid captures cannot be smuggled into evidence', t => {
  const f = fixture(t), path = join(f.project, f.quality.captures[0].path);
  rmSync(path);
  assert.throws(() => validateUiQuality(f.job, f.quality), /ENOENT/);
  mkdirSync(path);
  assert.throws(() => validateUiQuality(f.job, f.quality), /regular file/);
  rmSync(path, { recursive: true });
  writeFileSync(path, '');
  assert.throws(() => validateUiQuality(f.job, f.quality), /nonempty/);
  truncateSync(path, 64 * 1024 * 1024 + 1);
  assert.throws(() => validateUiQuality(f.job, f.quality), /64 MiB/);
  writeFileSync(path, smallPng);
  f.quality.captures.push(capture(f.project, 'build/screenshots/unused.png', Buffer.from('invalid PNG'), 'image'));
  assert.throws(() => validateUiQuality(f.job, f.quality), /PNG/);
});

test('specialist coverage combines with final evidence and never loses a failed veto in either order', t => {
  const f = fixture(t);
  const specialist = { captures: [f.quality.captures[0]], checks: [{ ...f.quality.checks[0], status: 'failed', observation: 'Primary action remains hidden by the native status bar.' }] };
  for (const entries of [[specialist, f.quality], [f.quality, specialist]]) {
    const merged = combineUiQuality(entries);
    assert.equal(merged.captures.length, 3);
    assert.equal(merged.checks.find(check => check.id === 'system-insets').status, 'failed');
    assert.match(merged.checks[0].observation, /hidden by the native status bar/);
    assert.throws(() => validateUiQuality(f.job, merged), /check failed: system-insets/);
  }
});

test('partial specialists merge agreeing checks and preserve all distinct observed evidence', t => {
  const f = fixture(t);
  const small = { captures: [f.quality.captures[0]], checks: [{ ...f.quality.checks[1], capturePaths: [f.quality.captures[0].path], observation: 'Narrow layout observed.' }] };
  const wide = { captures: [f.quality.captures[1]], checks: [{ ...f.quality.checks[1], capturePaths: [f.quality.captures[1].path], observation: 'Wide layout observed.' }] };
  const rest = { captures: [f.quality.captures[0], f.quality.captures[2]], checks: f.quality.checks.filter(check => check.id !== 'responsive-layout') };
  const merged = combineUiQuality([small, undefined, wide, rest]);
  assert.equal(validateUiQuality(f.job, merged).checks.length, 6);
  const responsive = merged.checks.find(check => check.id === 'responsive-layout');
  assert.match(responsive.observation, /Narrow layout observed/);
  assert.match(responsive.observation, /Wide layout observed/);
  assert.equal(responsive.capturePaths.length, 2);
  assert.equal(combineUiQuality([]), undefined);
  assert.equal(combineUiQuality([undefined, null, { captures: [], checks: [] }]), undefined);
  assert.throws(() => combineUiQuality([{ checks: [{ id: 'motion', status: 'failed' }] }]), /captures|observation|capturePaths/);
});

test('capture identity conflicts cannot silently select final claims over specialist evidence', t => {
  const f = fixture(t);
  for (const change of [
    entry => { entry.sha256 = 'f'.repeat(64); },
    entry => { entry.viewport.width++; },
    entry => { entry.viewport.height++; },
    entry => { entry.kind = 'trace'; },
    entry => { entry.device = 'Different device'; },
    entry => { entry.state = 'Different observed state'; },
  ]) {
    const conflicting = structuredClone(f.quality);
    change(conflicting.captures[0]);
    assert.throws(() => combineUiQuality([f.quality, conflicting]), /Conflicting UI capture identity/);
    assert.throws(() => combineUiQuality([conflicting, f.quality]), /Conflicting UI capture identity/);
  }
});

test('contradictory applicability rejects while a failed observation remains a veto across all statuses', t => {
  const f = fixture(t);
  const check = f.quality.checks.find(entry => entry.id === 'motion');
  const absent = { captures: [], checks: [{ ...check, status: 'not-applicable', observation: 'No transitions observed on the read-only screen.' }] };
  assert.throws(() => combineUiQuality([f.quality, absent]), /Conflicting UI quality applicability/);
  const failure = { captures: [], checks: [{ ...check, status: 'failed', observation: 'Transition did not respect reduced motion.' }] };
  const merged = combineUiQuality([f.quality, absent, failure]);
  assert.equal(merged.checks.find(entry => entry.id === 'motion').status, 'failed');
  assert.throws(() => validateUiQuality(f.job, merged), /check failed: motion/);
});

test('merging cannot silently truncate findings or capture bounds to make approval fit', t => {
  const f = fixture(t);
  const first = { captures: [], checks: [{ ...f.quality.checks[0], status: 'failed', observation: 'a'.repeat(6000) }] };
  const second = { captures: [], checks: [{ ...f.quality.checks[0], status: 'failed', observation: 'b'.repeat(6000) }] };
  assert.throws(() => combineUiQuality([first, second]));
  const many = Array.from({ length: 33 }, (_, index) => ({ captures: [{ ...f.quality.captures[0], path: `build/screenshots/${index}.png` }], checks: [] }));
  assert.throws(() => combineUiQuality(many));
});

test('minimum UI receipt overhead is a byte lower bound for real accepted evidence', t => {
  const f = fixture(t);
  const accepted = validateUiQuality(f.job, f.quality);
  const wrapper = ',"uiQuality":';
  const minimum = minimumUiQualityBytes(f.job.spec.screenshotsDir);
  assert.ok(minimum > 0);
  assert.ok(minimum < Buffer.byteLength(wrapper + JSON.stringify(accepted)));
  const ascii = minimumUiQualityBytes('build/screenshots');
  const unicode = minimumUiQualityBytes('build/截屏');
  // Two capture definitions plus seven check references repeat this directory.
  assert.equal(unicode - ascii, 9 * (Buffer.byteLength('build/截屏') - Buffer.byteLength('build/screenshots')));
  assert.throws(() => minimumUiQualityBytes('../source'));
});
