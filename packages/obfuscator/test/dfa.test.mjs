import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DFAFilter,
  deleteNotesInLine,
  deleteObjCNotes,
  detectProjectLanguage,
  findConstKeyword,
  judgeKeywordNone,
  mixKeywords,
} from '../dist/dfa.js';
import { filterList, wordFilterList, wordFilterStr } from '../dist/lexicon-data.js';

// ---- lexicon-data.ts ----

test('lexicon data exports a complete sensitive-word list', () => {
  assert.ok(wordFilterStr.length > 0);
  assert.equal(wordFilterList.length, 43);
  assert.equal(wordFilterStr, wordFilterList.join(','));
  for (const word of ['gambling', '赌博', '张福杰', 'confusedly']) {
    assert.ok(wordFilterList.includes(word), `lexicon contains ${word}`);
  }
  assert.ok(filterList.length > 0);
  assert.ok(filterList.includes('enable'));
});

// ---- DFA filter ----

test('DFAFilter replaces sensitive words and preserves unmatched text', () => {
  const filter = new DFAFilter();
  assert.equal(filter.filter('gambling'), '********');
  assert.equal(filter.filter('no match here'), 'no match here');
  assert.equal(filter.filter(''), '');
  assert.equal(filter.filter('I like gambling and 赌博 ok', '#'), 'I like ######## and ## ok');
});

test('DFAFilter is case-sensitive on the message, lower-casing only the word list', () => {
  const filter = new DFAFilter();
  assert.equal(filter.filter('Gambling'), 'Gambling');
  assert.equal(filter.filter('gambling'), '********');
});

test('DFAFilter accepts a custom word list and addSensitiveWords', () => {
  const custom = new DFAFilter(['Hello', 'world']);
  assert.equal(custom.filter('say hello to the world'), 'say ***** to the *****');

  const empty = new DFAFilter([]);
  empty.addSensitiveWords('SecretCode');
  assert.equal(empty.filter('my secretcode is here'), 'my ********** is here');
});

test('DFAFilter matches the longest sensitive word at a position', () => {
  const filter = new DFAFilter(['Hello', 'hell']);
  assert.equal(filter.filter('hell'), '****');
});

// ---- Keyword mixing ----

test('keyword mixing replaces const/static/#define identifiers with seeded names', () => {
  const source = [
    'static NSString * const kAppSecretKey = @"abc";',
    'const int maxRetryCount = 5;',
    '#define SERVER_HOST @"https://api.example.com"',
  ].join('\n');

  const result = mixKeywords(source, { seed: 'unit-seed', prefix: 'zf_' });

  assert.equal(result.count, 3);
  assert.ok(result.content.includes('zf_kobf'));
  assert.ok(!result.content.includes('kAppSecretKey'));
  assert.ok(!result.content.includes('maxRetryCount'));
  assert.ok(!result.content.includes('SERVER_HOST'));
});

test('keyword mixing is deterministic per seed and varies across seeds', () => {
  const source = 'const int maxRetryCount = 5;\nstatic int g_counter = 0;\n';
  const a = mixKeywords(source, { seed: 'seed-a', prefix: 'p_' });
  const b = mixKeywords(source, { seed: 'seed-a', prefix: 'p_' });
  const c = mixKeywords(source, { seed: 'seed-b', prefix: 'p_' });

  assert.equal(a.content, b.content);
  assert.notEqual(a.content, c.content);
  assert.equal(a.count, b.count);
});

test('keyword mixing returns count 0 and unchanged content when nothing matches', () => {
  const source = 'int x = 1;\n- (void)viewDidLoad {}\n';
  const result = mixKeywords(source, { seed: 'seed' });
  assert.equal(result.count, 0);
  assert.equal(result.content, source);
});

test('findConstKeyword extracts const and #define identifiers', () => {
  assert.deepEqual(findConstKeyword('const int maxRetryCount = 5;\n'), { keyword: 'maxRetryCount', isNeedAddK: true });
  assert.deepEqual(findConstKeyword('#define SERVER_HOST @"https://api.example.com"\n'), { keyword: 'SERVER_HOST', isNeedAddK: true });
  assert.equal(findConstKeyword('int x = 1;\n'), null);
});

test('judgeKeywordNone rejects short and reserved identifiers', () => {
  assert.equal(judgeKeywordNone('count'), null);
  assert.equal(judgeKeywordNone('UIView'), null);
  assert.equal(judgeKeywordNone('maxRetryCount'), 'maxRetryCount');
});

// ---- Language detection ----

test('detectProjectLanguage counts source extensions and picks the majority', () => {
  assert.deepEqual(detectProjectLanguage(['AppDelegate.m', 'ViewController.m', 'Helper.swift']), {
    language: 'OC',
    counts: { OC: 2, Swift: 1, Cpp: 0 },
  });
  assert.deepEqual(detectProjectLanguage(['main.swift', 'a.swift', 'b.swift']), {
    language: 'Swift',
    counts: { OC: 0, Swift: 3, Cpp: 0 },
  });
  assert.deepEqual(detectProjectLanguage(['core.cpp', 'util.cc', 'wrap.hpp']), {
    language: 'C++',
    counts: { OC: 0, Swift: 0, Cpp: 3 },
  });
  assert.deepEqual(detectProjectLanguage([]), { language: 'OC', counts: { OC: 0, Swift: 0, Cpp: 0 } });
});

// ---- Comment removal ----

test('deleteObjCNotes removes inline, doc and multi-line comments', () => {
  const source = [
    '#import <UIKit/UIKit.h>',
    '// single line comment',
    'int x = 1; // trailing comment',
    '/* block comment */ int y = 2;',
    '/** doc comment */',
    'int z = 3; /* inline */',
    '/* multi',
    '   line',
    '   comment */',
    'int w = 4;',
  ].join('\n') + '\n';

  const expected = '#import <UIKit/UIKit.h>\nint x = 1; \n  int y = 2;\n \nint z = 3;  \n\n\n\nint w = 4;\n';
  assert.equal(deleteObjCNotes(source), expected);
});

test('deleteNotesInLine drops the interior of a multi-line block comment', () => {
  const state = { inBlockComment: false };
  assert.equal(deleteNotesInLine('/* open\n', state), '\n');
  assert.equal(state.inBlockComment, true);
  assert.equal(deleteNotesInLine('still inside\n', state), null);
  assert.equal(deleteNotesInLine('now closed */\n', state), '\n\n');
  assert.equal(state.inBlockComment, false);
});

test('deleteNotesInLine preserves #pragma once', () => {
  const state = { inBlockComment: false };
  assert.equal(deleteNotesInLine('#pragma once\n', state), '#pragma once\n');
});
