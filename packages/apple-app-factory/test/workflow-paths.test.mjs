import test from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowNodeSchema, WorkflowPhaseSchema } from '../dist/schemas.js';
import { readyWorkflowNodes, workflowNodeConflict } from '../dist/workflow.js';

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
