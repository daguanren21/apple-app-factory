import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveEncryptionNum,
  objcStringDecryptor,
  swiftStringDecryptor,
  injectObjcStringDecryptor,
  injectSwiftStringDecryptor,
  encryptObjcStringLiterals,
  encryptSwiftStringLiterals,
  applyStringEncryption,
  findLast,
  isContainChinese,
  isPassObjCEncryptString,
  isCanMissObjCCodeInLine,
  getObjcCharArray,
  getSwiftEncryptCode,
} from '../dist/string-encrypt.js';

function tempProject(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'string-encrypt-'));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Simulate the injected `decryptConstString` byte-XOR logic on an ObjC char array. */
function decryptObjcArray(expr, key) {
  const match = expr.match(/\(\(char \[\]\) \{([^}]*)\}\)/);
  assert.ok(match, `expected ObjC char array, got: ${expr}`);
  const items = match[1]
    .split(',')
    .map((item) => item.trim())
    .map((item) => Number(item.replace(/^static_cast<char>\((\d+)\)$/, '$1')));
  return Buffer.from(items.slice(0, -1).map((value) => value ^ key)).toString('utf8');
}

/** Simulate the injected `OBF_NSSTRING` `map { $0 ^ key }` logic on a Swift array. */
function decryptSwiftArray(expr, key) {
  const match = expr.match(/\[([0-9, ]*)\]/);
  assert.ok(match, `expected Swift byte array, got: ${expr}`);
  const bytes = match[1].split(',').map((item) => Number(item.trim())).map((value) => value ^ key);
  return Buffer.from(bytes).toString('utf8');
}

test('resolveEncryptionNum validates explicit keys and derives deterministically from seed', () => {
  assert.equal(resolveEncryptionNum('seed', 42), 42);
  assert.throws(() => resolveEncryptionNum('seed', 256), /between 0 and 255/);
  assert.throws(() => resolveEncryptionNum('', undefined), /encryptionNum or a non-empty seed/);
  const a = resolveEncryptionNum('seed-A');
  const b = resolveEncryptionNum('seed-A');
  assert.equal(a, b);
  assert.ok(a >= 0 && a <= 255);
});

test('findLast strips the last // comment and finds the last mark position', () => {
  assert.equal(findLast('alpha // beta // gamma', 'a'), 12);
  assert.equal(findLast('alpha // a // b', '//'), 6);
  assert.equal(findLast('no marker here', 'z'), -1);
});

test('isContainChinese matches only U+4E00..U+9FFF', () => {
  assert.equal(isContainChinese('hello'), false);
  assert.equal(isContainChinese('你好'), true);
  assert.equal(isContainChinese('ok😀'), false);
});

test('ObjC decryptor snippet pins the XOR key and macro name', () => {
  const code = objcStringDecryptor(42);
  assert.match(code, /char c = string\[i\] \^ 0x2a;/);
  assert.match(code, /#define NNC_NSSTRING\(arr\) decryptConstString\(arr, sizeof\(arr\)-1\)/);
  assert.match(objcStringDecryptor(7, 'CUSTOM'), /#define CUSTOM\(arr\) decryptConstString/);
});

test('Swift decryptor snippet pins the XOR key and function name', () => {
  const code = swiftStringDecryptor(42);
  assert.match(code, /public func OBF_NSSTRING\(ucharArr: \[UInt8\]\) -> String/);
  assert.match(code, /\$0 \^ 42/);
});

test('encryptObjcStringLiterals rewrites literals, skips formats/CJK/comments and round-trips', () => {
  const source = [
    '#import <Foundation/Foundation.h>',
    '',
    '@interface Foo : NSObject',
    '@end',
    '',
    '@implementation Foo',
    '- (void)greet {',
    '    NSString *a = @"hello";',
    '    NSString *b = @"value=%@";',
    '    NSString *c = @"中文内容";',
    '    // a comment with @"ignored"',
    '}',
    '@end',
    '',
  ].join('\n') + '\n';

  const out = encryptObjcStringLiterals(source, { encryptionNum: 42 });
  assert.match(out, /NNC_NSSTRING\(\(\(char \[\]\) \{66, 79, 70, 70, 69, 0\}\)\)/);
  assert.equal(out.includes('@"value=%@"'), true);
  assert.equal(out.includes('@"中文内容"'), true);
  assert.equal(out.includes('// a comment with @"ignored"'), true);

  const literal = out.match(/NNC_NSSTRING\(\(\(char \[\]\) \{[^}]*\}\)\)/)[0];
  assert.equal(decryptObjcArray(literal.replace(/^NNC_NSSTRING\(/, '').replace(/\)$/, ''), 42), 'hello');

  const again = encryptObjcStringLiterals(source, { encryptionNum: 42 });
  assert.equal(out, again);
  assert.notEqual(out, encryptObjcStringLiterals(source, { encryptionNum: 43 }));
});

test('encryptObjcStringLiterals emits static_cast for .mm files', () => {
  const arr = getObjcCharArray('hi', 7, true);
  assert.equal(arr, '((char []) {static_cast<char>(111), static_cast<char>(110), static_cast<char>(0)})');
  assert.equal(decryptObjcArray(arr, 7), 'hi');
});

test('encryptSwiftStringLiterals injects the helper and encrypts non-format literals', () => {
  const source = [
    'import Foundation',
    '',
    'let greeting = "hello"',
    'let pureFormat = "%@-%@"',
    '',
  ].join('\n') + '\n';

  const out = encryptSwiftStringLiterals(source, { encryptionNum: 42 });
  assert.match(out, /public func OBF_NSSTRING\(ucharArr: \[UInt8\]\) -> String/);
  assert.match(out, /OBF_NSSTRING\(ucharArr: \[66, 79, 70, 70, 69\]\)/);
  assert.equal(out.includes('"%@-%@"'), true);

  assert.equal(getSwiftEncryptCode('hello', 42), '[66, 79, 70, 70, 69]');
  assert.equal(decryptSwiftArray('[66, 79, 70, 70, 69]', 42), 'hello');
});

test('skip predicates reproduce the recovered ObjC rules', () => {
  assert.equal(isContainChinese('选择游戏'), true);
  assert.equal(isCanMissObjCCodeInLine('NSString *s = @"x";'), true);
  assert.equal(isCanMissObjCCodeInLine('NSLog(@"%@")'), false);
  assert.equal(isCanMissObjCCodeInLine('static NSString *s = @"x";'), false);
  assert.equal(isPassObjCEncryptString('NSLog(@"log")'), true);
  assert.equal(isPassObjCEncryptString('return @"application/json";'), true);
  assert.equal(isPassObjCEncryptString('return @"plain";'), false);
});

test('injectObjcStringDecryptor inserts before the first #endif', () => {
  const pch = '#ifndef Prefix_pch\n#define Prefix_pch\n\n#endif\n';
  const out = injectObjcStringDecryptor(pch, 42);
  assert.match(out, /static NSString \* decryptConstString/);
  assert.match(out, /#define NNC_NSSTRING\(arr\) decryptConstString/);
  assert.ok(out.indexOf('decryptConstString') < out.indexOf('#endif'));
});

test('injectSwiftStringDecryptor inserts after the first import line', () => {
  const out = injectSwiftStringDecryptor('import UIKit\n\nlet s = "x"\n', 42);
  assert.match(out, /public func OBF_NSSTRING\(ucharArr: \[UInt8\]\) -> String/);
  assert.ok(out.indexOf('import UIKit') < out.indexOf('public func'));
});

test('applyStringEncryption transforms .pch/.m/.swift and leaves other files alone', (t) => {
  const root = tempProject(t, {
    'Prefix.pch': '#ifndef Prefix_pch\n#define Prefix_pch\n#endif\n',
    'App.m': '@implementation App\n- (void)run { NSString *s = @"hi"; }\n@end\n',
    'App.swift': 'import Foundation\nlet s = "hi"\n',
    'readme.txt': 'do not touch\n',
  });
  const outcome = applyStringEncryption(root, { seed: 'seed-1' });
  assert.equal(outcome.changed, 3);
  assert.deepEqual(outcome.changedPaths.sort(), ['App.m', 'App.swift', 'Prefix.pch']);

  const pch = readFileSync(join(root, 'Prefix.pch'), 'utf8');
  assert.match(pch, /static NSString \* decryptConstString/);

  const m = readFileSync(join(root, 'App.m'), 'utf8');
  assert.match(m, /NNC_NSSTRING\(\(\(char \[\]\) \{[^}]*\}\)\)/);

  const swift = readFileSync(join(root, 'App.swift'), 'utf8');
  assert.match(swift, /public func OBF_NSSTRING\(ucharArr: \[UInt8\]\) -> String/);
  assert.match(swift, /OBF_NSSTRING\(ucharArr: \[[0-9, ]*\]\)/);

  assert.equal(readFileSync(join(root, 'readme.txt'), 'utf8'), 'do not touch\n');
});
