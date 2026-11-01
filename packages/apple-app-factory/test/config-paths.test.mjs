import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, projectStorage, validateProjectSource } from '../dist/configuration/config.js';

const example = JSON.parse(readFileSync(new URL('../examples/factory.json', import.meta.url)));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-config-paths-'));
  const workspace = join(root, 'workspaces');
  const path = join(root, 'factory.json');
  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    workspace,
    load(directory) {
      writeFileSync(path, JSON.stringify({ ...example, projectMode: 'isolated', projectRoot: workspace, stateDir: join(root, 'state'), workspaceRoot: workspace, inbox: { directory } }));
      return loadConfig(path);
    },
  };
}

test('project mode binds the selected config directory and resolves external storage without writing it', t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-project-defaults-'));
  const path = join(root, 'factory.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = { ...example, projectMode: 'project' };
  delete input.stateDir;
  delete input.workspaceRoot;
  delete input.inbox;
  writeFileSync(path, JSON.stringify(input));
  const config = loadConfig(path);
  const storage = projectStorage(root);
  assert.equal(config.projectRoot, realpathSync(root));
  assert.deepEqual({ stateDir: config.stateDir, workspaceRoot: config.workspaceRoot }, storage);
  assert.equal(existsSync(storage.stateDir), false);
  assert.equal(existsSync(storage.workspaceRoot), false);
});

test('project sourceDir cannot widen project-mode authority', t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-project-source-'));
  const project = join(root, 'project');
  const other = join(root, 'other');
  mkdirSync(project);
  mkdirSync(other);
  const path = join(root, 'factory.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path, JSON.stringify({ ...example, projectMode: 'project', projectRoot: project, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces') }));
  const config = loadConfig(path);
  assert.throws(() => validateProjectSource({ project: { sourceDir: other } }, config), /canonical-match.*projectRoot|widen writable authority/);
  assert.equal(validateProjectSource({ project: { sourceDir: project } }, config), undefined);
});

for (const suffix of ['', 'inbox', 'nested/inbox']) {
  test(`configuration rejects a dangling inbox alias${suffix ? ` ancestor of ${suffix}` : ''} before its workspace target exists`, t => {
    const f = fixture(t);
    const target = join(f.workspace, 'future');
    const alias = join(f.root, 'alias');
    symlinkSync(target, alias, 'dir');
    assert.equal(existsSync(target), false);
    assert.throws(() => f.load(join(alias, suffix)), /Cannot resolve dangling symlink/);
    assert.equal(existsSync(target), false);
  });
}

test('configuration accepts an existing external inbox', t => {
  const f = fixture(t);
  const inbox = join(f.root, 'inbox');
  mkdirSync(inbox);
  assert.equal(f.load(inbox).inbox.directory, inbox);
});

test('configuration accepts an ordinary missing external inbox without creating it', t => {
  const f = fixture(t);
  const inbox = join(f.root, 'missing', 'nested', 'inbox');
  assert.equal(f.load(inbox).inbox.directory, inbox);
  assert.equal(existsSync(join(f.root, 'missing')), false);
});

test('configuration accepts an external symlink ancestor with a missing inbox child', t => {
  const f = fixture(t);
  const external = join(f.root, 'external');
  const alias = join(f.root, 'alias');
  mkdirSync(external);
  symlinkSync(external, alias, 'dir');
  const inbox = join(alias, 'missing', 'inbox');
  assert.equal(f.load(inbox).inbox.directory, inbox);
  assert.equal(existsSync(join(external, 'missing')), false);
});

test('configuration accepts an existing external inbox symlink', t => {
  const f = fixture(t);
  const external = join(f.root, 'external');
  const alias = join(f.root, 'alias');
  mkdirSync(external);
  symlinkSync(external, alias, 'dir');
  assert.equal(f.load(alias).inbox.directory, alias);
  assert.equal(realpathSync(alias), realpathSync(external));
});

test('configuration rejects an existing alias into the workspace', t => {
  const f = fixture(t);
  const target = join(f.workspace, 'agent-output');
  const alias = join(f.root, 'alias');
  mkdirSync(target);
  symlinkSync(target, alias, 'dir');
  assert.throws(() => f.load(alias), /inbox.directory must be outside workspaceRoot/);
  assert.throws(() => f.load(join(alias, 'future-inbox')), /inbox.directory must be outside workspaceRoot/);
});
