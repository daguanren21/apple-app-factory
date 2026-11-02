import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '@earendil-works/pi-schema';
import { ObfuscatorConfigSchema } from '../dist/core/config.js';

test('obfuscator config uses a native schema and compiled validation', () => {
  const parsed = ObfuscatorConfigSchema.parse({ project: {} });
  const validator = compile(ObfuscatorConfigSchema.schema);
  assert.equal(validator.check(parsed), true);
  assert.deepEqual(parsed, { project: { directories: [] } });
});

test('obfuscator config defaults are independent and preserve false/zero', () => {
  const first = ObfuscatorConfigSchema.parse({
    code: { removeComments: false, junkCode: { lines: 0 }, renameIdentifiers: { mappings: { first: 'one' } } },
    project: {},
    content: { dfa: {} },
    objc: { cleanResources: {} },
  });
  const second = ObfuscatorConfigSchema.parse({
    code: { renameIdentifiers: { mappings: { second: 'two' } } },
    project: {},
    content: { dfa: {} },
    objc: { cleanResources: {} },
  });
  first.project.directories.push('assets');
  first.content.dfa.words.push('secret');
  first.objc.cleanResources.ignore.push('generated');
  first.code.renameIdentifiers.mappings.extra = 'value';
  assert.deepEqual(second.project.directories, []);
  assert.deepEqual(second.content.dfa.words, []);
  assert.deepEqual(second.objc.cleanResources.ignore, []);
  assert.deepEqual(second.code.renameIdentifiers.mappings, { second: 'two' });
  assert.equal(first.code.removeComments, false);
  assert.equal(first.code.junkCode.lines, 0);
});

test('obfuscator config keeps strict maps, refinements and numeric rules', () => {
  assert.equal(ObfuscatorConfigSchema.safeParse({ code: { unknown: true } }).success, false);
  assert.equal(ObfuscatorConfigSchema.safeParse({ content: { controlColors: { '#xyzxyz': '#ffffff' } } }).success, false);
  assert.equal(ObfuscatorConfigSchema.safeParse({ code: { renameIdentifiers: { mappings: { a: 'b' }, patterns: [{ match: '[', replacement: 'x' }] } } }).success, false);
  assert.equal(ObfuscatorConfigSchema.safeParse({ objc: { symbols: { magicColor: { addColor: Infinity } } } }).success, false);
  assert.equal(ObfuscatorConfigSchema.safeParse({ resources: { images: { scale: { width: Number.MAX_SAFE_INTEGER + 1 } } } }).success, false);
  assert.equal(ObfuscatorConfigSchema.safeParse({ project: { directories: null } }).success, false);
});

test('obfuscator config preserves legacy prototype-key map behavior', () => {
  const parsed = ObfuscatorConfigSchema.parse(JSON.parse('{"code":{"keywords":{"__proto__":123,"owned":"safe"}}}'));
  assert.deepEqual(parsed.code?.keywords, { owned: 'safe' });
  const protoOnly = ObfuscatorConfigSchema.safeParse(JSON.parse('{"code":{"renameIdentifiers":{"mappings":{"__proto__":123}}}}'));
  assert.equal(protoOnly.success, false);
  if (!protoOnly.success) assert.deepEqual(protoOnly.error.issues[0]?.path, ['code', 'renameIdentifiers']);
  const strictRoot = ObfuscatorConfigSchema.safeParse(JSON.parse('{"__proto__":123,"code":{}}'));
  assert.equal(strictRoot.success, false);
});
