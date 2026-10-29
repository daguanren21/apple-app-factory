import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  changeViewBackgroundColor,
  createRenameContext,
  getMissClassName,
  getSetProName,
  isPassObjectName,
  isPassMethodName,
  isPassPropertyName,
  methodNameListInLine,
  obfuscateObjcContent,
  ocPropertyNameTup,
  renameObjcSymbols,
  replaceMethodNameInLine,
  replacePropertyNameInLine,
  swiftCppPropertyNameTup,
} from '../dist/objc-symbols.js';
import { walkProject } from '../dist/common.js';

function tempProject(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'objc-symbols-'));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function read(root, files) {
  return Object.fromEntries(files.map((entry) => [entry.relative, readFileSync(entry.absolute, 'utf8')]));
}

const fixtures = () => ({
  'MyView.h': '@import <UIKit/UIKit.h>\n@interface MyView : UIView\n@property (nonatomic, strong) NSString *userName;\n@property (nonatomic, copy) NSString *profileSummary;\n- (void)viewDidLoad;\n- (void)doFetchData;\n- (void)legacy_specialMethod;\n@end\n',
  'MyView.m': '#import "MyView.h"\n@implementation MyView\n- (void)viewDidLoad { [super viewDidLoad]; self.userName = @"x"; }\n- (void)doFetchData { [self doFetchData]; }\n@end\n',
  'AppDelegate.h': '@interface AppDelegate : UIResponder\n@end\n',
});

test('filter predicates skip known framework and dangerous names', () => {
  assert.equal(isPassMethodName('viewDidLoad', false), true);
  assert.equal(isPassMethodName('drawRect', false), true);
  assert.equal(isPassMethodName('application', false), true);
  assert.equal(isPassMethodName('doFetchData', false), false);
  assert.equal(isPassMethodName('doFetchData', true), false);

  assert.equal(isPassPropertyName('userName'), true);
  assert.equal(isPassPropertyName('textColor'), true);
  assert.equal(isPassPropertyName('customProp'), false);

  const ctx = createRenameContext({}, 'seed');
  assert.equal(isPassObjectName('AppDelegate', ctx), true);
  assert.equal(isPassObjectName('ViewController', ctx), true);
  assert.equal(isPassObjectName('MyView', ctx), false);
});

test('methodNameListInLine extracts OC selector segments', () => {
  assert.deepEqual(methodNameListInLine('- (void)doFoo:(id)x;'), ['doFoo:']);
  assert.deepEqual(methodNameListInLine('- (void)doFoo:(id)x bar:(id)y;'), ['doFoo', 'bar']);
  assert.deepEqual(methodNameListInLine('void doSomething(int x);'), ['doSomething']);
});

test('ocPropertyNameTup and swiftCppPropertyNameTup extract names and are seeded', () => {
  const a = createRenameContext({ algorithmType: 0 }, 'prop-seed');
  const b = createRenameContext({ algorithmType: 0 }, 'prop-seed');
  const oc = ocPropertyNameTup('@property (nonatomic, strong) NSString *customProp;', undefined, a);
  const oc2 = ocPropertyNameTup('@property (nonatomic, strong) NSString *customProp;', undefined, b);
  assert.ok(oc, 'should extract customProp');
  assert.equal(oc[0], 'customProp');
  assert.equal(oc[1], oc2[1]);
  assert.notEqual(oc[1], 'customProp');

  const swift = swiftCppPropertyNameTup('let customProp: String', undefined, false, createRenameContext({ algorithmType: 0 }, 'swift-seed'));
  assert.ok(swift);
  assert.equal(swift[0], 'customProp');
  assert.notEqual(swift[1], 'customProp');
});

test('replaceMethodNameInLine and replacePropertyNameInLine protect string literals', () => {
  const line = 'NSString *s = @"doFetchData"; [self doFetchData];';
  const out = replaceMethodNameInLine(line, 'doFetchData', 'renamed', false);
  assert.equal(out.includes('"doFetchData"'), true);
  assert.equal(out.includes('[self renamed]'), true);

  const propLine = 'self.userName = @"userName";';
  const propOut = replacePropertyNameInLine(propLine, 'userName', 'renamedProp', false, false, false);
  assert.equal(propOut.includes('self.renamedProp'), true);
  assert.equal(propOut.includes('"userName"'), true);
});

test('renameObjcSymbols renames classes, methods and skips filters deterministically', (t) => {
  const a = tempProject(t, fixtures());
  const b = tempProject(t, fixtures());
  const filesA = walkProject(a).files;
  const filesB = walkProject(b).files;
  const options = { algorithmType: 0 };

  const reportA = renameObjcSymbols(filesA, options, 'seed-ios');
  const reportB = renameObjcSymbols(filesB, options, 'seed-ios');
  assert.deepEqual(reportA, reportB);

  const afterA = read(a, filesA);
  const afterB = read(b, filesB);
  assert.deepEqual(afterA, afterB);

  // Class rename: MyView -> derived name, import rewritten, AppDelegate untouched.
  const header = afterA['MyView.h'];
  assert.equal(header.includes('@interface MyView'), false);
  assert.equal(afterA['AppDelegate.h'].includes('@interface AppDelegate'), true);
  const className = header.match(/@interface (\w+) : UIView/)[1];
  assert.ok(className, 'derived class name present');
  assert.equal(afterA['MyView.m'].includes(`#import "${className}.h"`), true);
  assert.equal(afterA['MyView.m'].includes(`@implementation ${className}`), true);

  // Method rename: viewDidLoad (framework) untouched; doFetchData renamed consistently.
  assert.equal(header.includes('- (void)viewDidLoad;'), true);
  assert.equal(header.includes('doFetchData'), false);
  assert.match(header, /- \(void\)\w+;/);
  assert.equal(afterA['MyView.m'].includes('viewDidLoad'), true);

  // Property rename: userName is in the filter list, profileSummary is not.
  assert.equal(header.includes('userName'), true);
  assert.equal(header.includes('profileSummary'), false);
});

test('renameObjcSymbols applies method and property prefix replacement', (t) => {
  const root = tempProject(t, {
    'Demo.h': '@interface Demo : NSObject\n@property (nonatomic) int legacyCount;\n- (void)legacyRun;\n@end\n',
    'Demo.m': '#import "Demo.h"\n@implementation Demo\n- (void)legacyRun {}\n@end\n',
  });
  const files = walkProject(root).files;
  const outcome = renameObjcSymbols(files, {
    replaceMethodPrefix: { from: 'legacy', to: 'XYZ_' },
    replacePropertyPrefix: { from: 'legacy', to: 'XYZ_' },
  }, 'seed-prefix');
  assert.equal(outcome.changed, 2);
  const after = read(root, files);
  assert.equal(after['Demo.h'].includes('legacyRun'), false);
  assert.match(after['Demo.h'], /- \(void\)XYZ_Run;/);
  assert.equal(after['Demo.h'].includes('legacyCount'), false);
  assert.equal(after['Demo.m'].includes('legacyRun'), false);
});

test('renameObjcSymbols applies class prefix replacement', (t) => {
  const root = tempProject(t, {
    'OldView.h': '@interface OldView : UIView\n@end\n',
    'OldView.m': '#import "OldView.h"\n@implementation OldView\n@end\n',
  });
  const files = walkProject(root).files;
  renameObjcSymbols(files, { replaceClassPrefix: { from: 'Old', to: 'New' } }, 'seed-class');
  const after = read(root, files);
  assert.equal(after['OldView.h'].includes('@interface NewView'), true);
  assert.equal(after['OldView.m'].includes('#import "NewView.h"'), true);
});

test('changeViewBackgroundColor is deterministic and appends OC backgroundColor', () => {
  const ctx = createRenameContext({}, 'color-seed');
  const a = changeViewBackgroundColor('    [UIColor redColor];', false, { addColor: 1, textColor: 1, replaceColor: [-1, -1, -1] }, ctx);
  const ctx2 = createRenameContext({}, 'color-seed');
  const b = changeViewBackgroundColor('    [UIColor redColor];', false, { addColor: 1, textColor: 1, replaceColor: [-1, -1, -1] }, ctx2);
  assert.equal(a, b);

  const alloc = '    UILabel *title = [[UILabel alloc] init];';
  const colored = changeViewBackgroundColor(alloc, false, { addColor: 1, textColor: 1 }, createRenameContext({}, 'bg-seed'));
  assert.match(colored, /title\.backgroundColor = \[UIColor colorWithRed:/);
  assert.match(colored, /title\.textColor = \[UIColor colorWithRed:/);
});

test('changeViewBackgroundColor rewrites Swift color literals deterministically', () => {
  const ctx = createRenameContext({}, 'swift-color');
  const line = 'view.backgroundColor = UIColor.red';
  const out = changeViewBackgroundColor(line, true, { replaceColor: [1, -1, -1] }, ctx);
  assert.notEqual(out, line);
  assert.match(out, /UIColor\.init\(red: /);
});

test('obfuscateObjcContent is a deterministic pure single-content transform', () => {
  const content = '@interface Thing : NSObject\n@property (nonatomic, strong) NSString *title;\n- (void)viewDidLoad;\n- (void)doWork;\n@end\n';
  const a = obfuscateObjcContent(content, { algorithmType: 0 }, 'pure-seed');
  const b = obfuscateObjcContent(content, { algorithmType: 0 }, 'pure-seed');
  assert.equal(a, b);
  assert.equal(a.includes('viewDidLoad'), true);
  assert.equal(a.includes('doWork'), false);
});

test('getSetProName and getMissClassName are deterministic', () => {
  assert.equal(getSetProName('fooBar'), 'setFooBar');
  const ctx = createRenameContext({ algorithmType: 0 }, 'cls');
  const ctx2 = createRenameContext({ algorithmType: 0 }, 'cls');
  assert.equal(getMissClassName('MyViewController', undefined, ctx), getMissClassName('MyViewController', undefined, ctx2));
});
