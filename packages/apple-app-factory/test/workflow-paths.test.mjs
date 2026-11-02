import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowNodeSchema, WorkflowPhaseSchema } from '../dist/contracts/schemas.js';
import { readyWorkflowNodes, workflowNodeConflict } from '../dist/workflow/graph.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'apphx-workflow-paths-'));
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace };
}

function node(id, overrides = {}) {
  return WorkflowNodeSchema.parse({
    id, role: 'developer', instructions: `Work only on ${id}`, acceptance: [`Observed ${id}`],
    readPaths: [], ...overrides,
  });
}

function runningPhase(definitions) {
  const phase = WorkflowPhaseSchema.parse({
    status: 'running', revision: 1, reason: 'Compare actual claim resources',
    nodes: definitions.map(definition => ({ definition, status: 'pending', attempts: 0, turn: null })),
  });
  const first = phase.nodes[0];
  first.status = 'running';
  first.attempts = 1;
  first.turn = {
    id: '00000000-0000-4000-8000-000000000001', stage: 'build', kind: 'node',
    nodeId: first.definition.id, planRevision: 1, createdAt: 1,
    ownerPid: process.pid, contextDigest: 'a'.repeat(64),
  };
  return phase;
}

function assertConflict(left, right, workspace, expected = true) {
  assert.equal(workflowNodeConflict(left, right, workspace), expected);
  assert.equal(workflowNodeConflict(right, left, workspace), expected);
}

function identity(path) {
  const info = statSync(path, { bigint: true });
  return [info.dev, info.ino];
}

function snapshot(root) {
  const entries = [];
  function visit(path) {
    const absolute = join(root, path);
    const info = lstatSync(absolute, { bigint: true });
    entries.push([path, info.dev, info.ino, info.mode, info.mtimeNs, info.ctimeNs,
      info.isFile() ? readFileSync(absolute, 'utf8') : null]);
    if (info.isDirectory()) for (const name of readdirSync(absolute).sort()) visit(path === '.' ? name : `${path}/${name}`);
  }
  visit('.');
  return entries;
}

function populate(directory, count) {
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index++) writeFileSync(join(directory, `entry-${index}`), '');
}

function observeScan(observe) {
  const originals = { readdirSync: fs.readdirSync, lstatSync: fs.lstatSync, opendirSync: fs.opendirSync };
  const work = { reads: 0, entries: 0, largestArray: 0, stats: 0, opened: 0, closed: 0, peakOpen: 0, attempts: new Map() };
  fs.readdirSync = function (...args) {
    const entries = originals.readdirSync.apply(this, args);
    work.largestArray = Math.max(work.largestArray, entries.length);
    work.entries += entries.length;
    return entries;
  };
  fs.lstatSync = function (...args) {
    work.stats++;
    return originals.lstatSync.apply(this, args);
  };
  fs.opendirSync = function (path, ...args) {
    work.attempts.set(path, (work.attempts.get(path) ?? 0) + 1);
    const directory = originals.opendirSync.call(this, path, ...args);
    work.opened++;
    work.peakOpen = Math.max(work.peakOpen, work.opened - work.closed);
    const read = directory.readSync.bind(directory), close = directory.closeSync.bind(directory);
    directory.readSync = () => {
      work.reads++;
      const entry = read();
      if (entry) work.entries++;
      return entry;
    };
    directory.closeSync = () => {
      const result = close();
      work.closed++;
      return result;
    };
    return directory;
  };
  syncBuiltinESMExports();
  try {
    return { result: observe(), work };
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}

test('future paths conservatively fold case and canonical Unicode without creating filesystem probes', t => {
  const { workspace } = fixture(t);
  const before = snapshot(workspace);
  const aliases = [
    ['Sources/Main.swift', 'sources/main.swift'],
    ['Sources', 'sources/Nested/Main.swift'],
    ['Sources/Caf\u00e9.swift', 'SOURCES/Cafe\u0301.swift'],
    ['Caf\u00e9', 'Cafe\u0301/child.swift'],
    ['Stra\u00dfe/File.swift', 'STRASSE/file.swift'],
    ['\u03a3.swift', '\u03c2.swift'],
  ];
  for (const [a, b] of aliases) {
    const writer = node('writer', { writePaths: [a] });
    const reader = node('reader', { readPaths: [b] });
    assertConflict(writer, reader, workspace);
    assertConflict(writer, reader, undefined);
    assertConflict(writer, node('other-writer', { writePaths: [b] }), workspace);
    assertConflict(node('reader-a', { readPaths: [a] }), reader, workspace, false);
  }
  for (const [a, b] of [
    ['Sources/App', 'sources/application'], ['Sources/App', 'sources/app.swift'],
    ['Sources/a.swift', 'sources/b.swift'], ['first/new', 'second/new'],
  ]) {
    assertConflict(node('a', { writePaths: [a] }), node('b', { readPaths: [b] }), workspace, false);
  }
  assert.deepEqual(snapshot(workspace), before, 'claim inspection must not write or probe filesystem case behavior');
});

test('existing case and Unicode aliases serialize whether the volume merges or distinguishes their inodes', t => {
  const { workspace } = fixture(t);
  for (const [original, alias] of [['Main.swift', 'main.swift'], ['Caf\u00e9.swift', 'Cafe\u0301.swift']]) {
    const first = join(workspace, original), second = join(workspace, alias);
    writeFileSync(first, 'real source input');
    const existingAlias = statSync(second, { bigint: true, throwIfNoEntry: false });
    if (existingAlias) {
      assert.deepEqual(identity(first), [existingAlias.dev, existingAlias.ino]);
    } else {
      writeFileSync(second, 'distinct source on a case-sensitive or normalization-sensitive volume');
      assert.notDeepEqual(identity(first), identity(second));
    }
    const writer = node('writer', { writePaths: [original] });
    const aliasWriter = node('alias', { writePaths: [alias] });
    const independent = node('independent', { writePaths: ['independent.swift'] });
    const before = snapshot(workspace);
    assertConflict(writer, aliasWriter, workspace);
    assert.deepEqual(readyWorkflowNodes(runningPhase([writer, aliasWriter, independent]), workspace)
      .map(current => current.definition.id), ['independent']);
    assert.deepEqual(snapshot(workspace), before);
  }
});

test('hardlink identity fences writes and directory ancestor reads without serializing identical independent files', t => {
  const { workspace } = fixture(t);
  for (const directory of ['left/nested', 'right/nested', 'separate']) mkdirSync(join(workspace, directory), { recursive: true });
  const original = 'left/nested/source.swift', alias = 'right/nested/alias.swift', independent = 'separate/source.swift';
  writeFileSync(join(workspace, original), 'same source bytes');
  linkSync(join(workspace, original), join(workspace, alias));
  writeFileSync(join(workspace, independent), 'same source bytes');
  assert.deepEqual(identity(join(workspace, original)), identity(join(workspace, alias)));
  assert.notEqual(realpathSync(join(workspace, original)), realpathSync(join(workspace, alias)));
  assert.notDeepEqual(identity(join(workspace, original)), identity(join(workspace, independent)));
  const before = snapshot(workspace);
  for (const [a, b] of [
    [original, alias], ['left', alias], [original, 'right'], ['left', 'right'], ['left/nested', 'right/nested'],
  ]) {
    assertConflict(node('a', { writePaths: [a] }), node('b', { writePaths: [b] }), workspace);
    assertConflict(node('a', { readPaths: [a] }), node('b', { writePaths: [b] }), workspace);
    assertConflict(node('a', { writePaths: [a] }), node('b', { readPaths: [b] }), workspace);
    assertConflict(node('a', { readPaths: [a] }), node('b', { readPaths: [b] }), workspace, false);
  }
  for (const [a, b] of [[original, independent], ['left', 'separate'], ['left', 'right/new.swift']]) {
    assertConflict(node('a', { writePaths: [a] }), node('b', { readPaths: [b] }), workspace, false);
  }
  const phase = runningPhase([
    node('reader', { readPaths: ['left'] }),
    node('alias-writer', { writePaths: [alias] }),
    node('alias-reader', { readPaths: ['right'] }),
    node('independent', { writePaths: [independent] }),
  ]);
  assert.deepEqual(readyWorkflowNodes(phase, workspace).map(current => current.definition.id), ['alias-reader', 'independent']);
  assert.deepEqual(snapshot(workspace), before);
});

test('realpath directory aliases fence existing and future descendants while disjoint children stay parallel', t => {
  const { workspace } = fixture(t);
  mkdirSync(join(workspace, 'actual/nested'), { recursive: true });
  writeFileSync(join(workspace, 'actual/nested/source.swift'), 'source');
  symlinkSync('actual', join(workspace, 'alias'), 'dir');
  assert.deepEqual(identity(join(workspace, 'actual')), identity(join(workspace, 'alias')));
  for (const [a, b] of [
    ['actual/nested/source.swift', 'alias/nested/source.swift'],
    ['actual', 'alias/nested/source.swift'],
    ['actual/nested', 'alias/nested/future.swift'],
    ['actual/New/File.swift', 'alias/new/file.swift'],
    ['actual/New', 'alias/new/nested/file.swift'],
  ]) assertConflict(node('a', { writePaths: [a] }), node('b', { readPaths: [b] }), workspace);
  for (const [a, b] of [['actual/first.swift', 'alias/second.swift'], ['actual/nested', 'alias/new.swift']]) {
    assertConflict(node('a', { writePaths: [a] }), node('b', { readPaths: [b] }), workspace, false);
  }
});

test('ready checks refresh real identities at every claim boundary instead of caching replaced hardlinks', t => {
  const { workspace } = fixture(t);
  mkdirSync(join(workspace, 'left'));
  mkdirSync(join(workspace, 'right'));
  writeFileSync(join(workspace, 'left/source.swift'), 'unchanged content');
  const phase = runningPhase([
    node('writer', { writePaths: ['left'] }),
    node('alias', { writePaths: ['right/alias.swift'] }),
    node('independent', { writePaths: ['right/independent.swift'] }),
  ]);
  const before = structuredClone(phase);
  const ready = () => readyWorkflowNodes(phase, workspace).map(current => current.definition.id);
  assert.deepEqual(ready(), ['alias', 'independent']);
  linkSync(join(workspace, 'left/source.swift'), join(workspace, 'right/alias.swift'));
  assert.deepEqual(ready(), ['independent']);
  unlinkSync(join(workspace, 'right/alias.swift'));
  writeFileSync(join(workspace, 'right/alias.swift'), 'unchanged content');
  assert.notDeepEqual(identity(join(workspace, 'left/source.swift')), identity(join(workspace, 'right/alias.swift')));
  assert.deepEqual(ready(), ['alias', 'independent']);
  assert.deepEqual(phase, before, 'resource observations do not mutate persisted claims or proof');
});

test('unresolvable resource scopes serialize writes without blocking readers or modifying the workspace', t => {
  const { root, workspace } = fixture(t);
  writeFileSync(join(workspace, 'not-a-directory'), 'regular file');
  symlinkSync('missing-target', join(workspace, 'dangling'));
  symlinkSync('loop', join(workspace, 'loop'));
  mkdirSync(join(workspace, 'uncertain-tree'));
  symlinkSync('missing-target', join(workspace, 'uncertain-tree/dangling'));
  symlinkSync(root, join(workspace, 'outside'), 'dir');
  const before = snapshot(workspace);
  for (const path of ['not-a-directory/child', 'dangling/child', 'loop/child', 'uncertain-tree', 'outside/child']) {
    assertConflict(node('uncertain', { writePaths: [path] }), node('independent', { readPaths: ['other/new'] }), workspace);
    assertConflict(node('uncertain-reader', { readPaths: [path] }), node('reader', { readPaths: ['other/new'] }), workspace, false);
  }
  const missingWorkspace = join(workspace, 'not-created');
  assertConflict(node('writer', { writePaths: ['first'] }), node('reader', { readPaths: ['second'] }), missingWorkspace);
  assertConflict(node('reader-a', { readPaths: ['first'] }), node('reader-b', { readPaths: ['second'] }), missingWorkspace, false);
  assert.deepEqual(snapshot(workspace), before);
});

test('wide scopes stream bounded ownership evidence, retain aliases and stop blocking after active work drains', t => {
  const { workspace } = fixture(t);
  const wide = join(workspace, 'wide');
  populate(wide, 8192);
  populate(join(workspace, 'other'), 1);
  linkSync(join(wide, 'entry-8191'), join(workspace, 'other/alias'));
  const definitions = [
    node('writer', { writePaths: ['wide'] }),
    node('reader', { readPaths: ['other/entry-0'] }),
    node('other-writer', { writePaths: ['other/new'] }),
    node('alias-reader', { readPaths: ['other/alias'] }),
  ];
  const phase = runningPhase(definitions);
  const { result, work } = observeScan(() => readyWorkflowNodes(phase, workspace));
  assert.deepEqual(result, [], 'incomplete ownership evidence must serialize even lexically disjoint scopes');
  assert.ok(work.reads > 0 && work.reads <= 4096);
  assert.ok(work.entries <= 4096);
  assert.ok(work.stats <= 4096 + 2 * definitions.length);
  assert.equal(work.largestArray, 0, 'a single wide directory must not allocate a readdir array');
  assert.equal(work.attempts.get(realpathSync(wide)), 1, 'cache an exhausted tree for the rest of this claim calculation');
  assert.equal(work.opened, work.closed, 'early exhaustion must close its directory handle');
  assert.equal(work.peakOpen, 1);

  const readers = observeScan(() => workflowNodeConflict(
    node('reader-a', { readPaths: ['wide'] }), node('reader-b', { readPaths: ['other'] }), workspace));
  assert.equal(readers.result, false);
  assert.equal(readers.work.entries, 0, 'read/read independence requires no tree inspection');
  const narrow = observeScan(() => workflowNodeConflict(
    node('narrow-writer', { writePaths: ['wide/entry-0'] }), node('narrow-reader', { readPaths: ['other/entry-0'] }), workspace));
  assert.equal(narrow.result, false);
  assert.equal(narrow.work.entries, 0, 'narrow file ownership stays parallel even in a huge parent tree');

  phase.nodes[0].status = 'passed';
  phase.nodes[0].turn = null;
  const drained = observeScan(() => readyWorkflowNodes(phase, workspace).map(current => current.definition.id));
  assert.deepEqual(drained.result, ['reader', 'other-writer', 'alias-reader']);
  assert.equal(drained.work.entries, 0, 'pending work can be claimed after active ownership drains');

  rmSync(wide, { recursive: true });
  populate(wide, 4095);
  const refreshed = observeScan(() => readyWorkflowNodes(runningPhase(definitions), workspace).map(current => current.definition.id));
  assert.deepEqual(refreshed.result, ['reader', 'other-writer', 'alias-reader'],
    'a complete scan at the budget boundary is independent; an earlier exhausted observation must not persist');
  assert.equal(refreshed.work.reads, 4096, 'the shared budget includes the EOF read that proves the tree complete');
});

test('all resource comparisons at one claim boundary share a single scan budget without blocking narrow siblings', t => {
  const { workspace } = fixture(t);
  populate(join(workspace, 'active'), 1);
  const definitions = [node('active', { writePaths: ['active/entry-0'] })];
  for (let index = 0; index < 6; index++) {
    populate(join(workspace, `scope-${index}`), 1500);
    definitions.push(node(`candidate-${index}`, { writePaths: [`scope-${index}`] }));
  }
  definitions.push(node('narrow', { writePaths: ['other/new'] }));
  const { result, work } = observeScan(() => readyWorkflowNodes(runningPhase(definitions), workspace)
    .map(current => current.definition.id));
  assert.deepEqual(result, ['candidate-0', 'candidate-1', 'narrow']);
  assert.ok(work.reads <= 4096 && work.entries <= 4096, 'the budget is not reset for each candidate directory');
  assert.ok(work.stats <= 4096 + definitions.length + 1);
  assert.equal(work.largestArray, 0);
  assert.equal(work.opened, work.closed);
});

test('deep branching ownership trees stop at bounded work and close every directory before continuing', t => {
  const { workspace } = fixture(t);
  let directory = join(workspace, 'deep');
  for (let depth = 0; depth < 256; depth++) {
    populate(directory, 20);
    directory = join(directory, 'd');
  }
  populate(join(workspace, 'other'), 1);
  const { result, work } = observeScan(() => workflowNodeConflict(
    node('deep-writer', { writePaths: ['deep'] }), node('reader', { readPaths: ['other'] }), workspace));
  assert.equal(result, true, 'a partially observed deep tree cannot prove independence');
  assert.ok(work.reads > 0 && work.reads <= 4096);
  assert.ok(work.entries <= 4096 && work.stats <= 4096 + 2);
  assert.ok(work.opened > 1);
  assert.equal(work.opened, work.closed);
  assert.equal(work.peakOpen, 1, 'deep ownership scanning must not retain a stack of open directory handles');
  assert.equal(work.largestArray, 0);
});

test('unreadable directory evidence is cached conservatively within a claim and refreshed at the next boundary', t => {
  const { workspace } = fixture(t);
  const unreadable = join(workspace, 'unreadable');
  populate(unreadable, 1);
  const definitions = [
    node('writer', { writePaths: ['unreadable'] }),
    node('reader', { readPaths: ['first/new'] }),
    node('other-writer', { writePaths: ['second/new'] }),
  ];
  chmodSync(unreadable, 0);
  try {
    let denied = false;
    try {
      const directory = fs.opendirSync(unreadable);
      directory.closeSync();
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
      denied = true;
    }
    if (!denied) {
      t.skip('The current filesystem identity bypasses directory read permissions');
      return;
    }
    const { result, work } = observeScan(() => readyWorkflowNodes(runningPhase(definitions), workspace));
    assert.deepEqual(result, []);
    assert.equal(work.attempts.get(realpathSync(unreadable)), 1, 'do not repeat an unreadable tree scan inside one calculation');
  } finally { chmodSync(unreadable, 0o700); }
  assert.deepEqual(readyWorkflowNodes(runningPhase(definitions), workspace).map(current => current.definition.id),
    ['reader', 'other-writer']);
});
