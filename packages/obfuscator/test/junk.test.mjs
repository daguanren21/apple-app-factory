import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkProject } from '../dist/common.js';
import {
  cleanUnusedResources,
  createJunkFiles,
  generateObjCJunk,
  generateObjCMethod,
  generateObjCFile,
  generateSwiftJunk,
  generateSwiftMethod,
  generateSwiftFile,
  insertJunkCode,
  insertObjCHeaderJunk,
  insertObjCImplJunk,
  insertSwiftJunk,
  isIgnoredPath,
  isResourcePath,
  lineReferencesResource,
  objcGetMissObjName,
  resourceNameFromPath,
  swiftGetMissObjName,
} from '../dist/junk.js';

function tempProject(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'obfuscator-junk-'));
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

const MINIMAL_PBXPROJ = `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tobjectVersion = 50;
\tobjects = {

/* Begin PBXBuildFile section */
\t\tAABBCCDD0011223344556677 /* main.m in Sources */ = {isa = PBXBuildFile; fileRef = AABBCCDD0011223344556678 /* main.m */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
\t\tAABBCCDD0011223344556678 /* main.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = main.m; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXGroup section */
\t\tAABBCCDD0011223344556679 = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\tAABBCCDD0011223344556678 /* main.m */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXGroup section */

/* Begin PBXSourcesBuildPhase section */
\t\tAABBCCDD001122334455667A /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\tAABBCCDD0011223344556677 /* main.m in Sources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXSourcesBuildPhase section */
\t};
\trootObject = AABBCCDD0011223344556679 /* Project object */;
}
`;

// ---- template pools ----

test('generateObjCJunk is deterministic, seed-variant and produces compile-shaped ObjC', () => {
  const a = generateObjCJunk(2, 'OBFObj', 'seed', 'A');
  const b = generateObjCJunk(2, 'OBFObj', 'seed', 'A');
  const c = generateObjCJunk(2, 'OBFObj', 'seed', 'B');
  assert.equal(a.mCode, b.mCode);
  assert.equal(a.hCode, b.hCode);
  assert.notEqual(a.mCode, c.mCode);
  assert.match(a.hCode, /^- \(.+\)OBFObj/);
  assert.match(a.hCode, /@property \(nonatomic,/);
  assert.match(a.mCode, /alloc\] init\]/);
  assert.match(a.mCode, /return /);
});

test('generateSwiftJunk produces compile-shaped Swift with funcs and lazy properties', () => {
  const junk = generateSwiftJunk(2, 'OBFObj', 'seed', 'A');
  assert.match(junk.methodCode, /func OBFObj/);
  assert.match(junk.methodCode, /-> /);
  assert.ok(junk.propertyCode.includes('var '));
  assert.equal(generateSwiftJunk(2, 'OBFObj', 'seed', 'A').methodCode, junk.methodCode);
});

test('single-method generators are deterministic and self-contained', () => {
  const oc = generateObjCMethod('OBFObj', 'seed', 'x');
  assert.match(oc.hDeclaration, /^- \(.+\)OBFObj.+;$/);
  assert.match(oc.methodCode, /^\s*return |\{\n/);
  assert.equal(generateObjCMethod('OBFObj', 'seed', 'x').methodCode, oc.methodCode);

  const swift = generateSwiftMethod('OBFObj', 'seed', 'x');
  assert.match(swift.declaration, /^func OBFObj/);
  assert.match(swift.methodCode, /func OBFObj/);
});

test('name generators derive CamelCase tokens without non-identifier chars', () => {
  const oc = objcGetMissObjName('XiYouQiYuanServiceGZipEncoder', 'seed');
  assert.match(oc, /^[A-Z][A-Za-z0-9]+$/);
  const swift = swiftGetMissObjName('Label', 'seed');
  assert.match(swift, /Label$/);
});

// ---- insertion positions ----

test('insertObjCHeaderJunk inserts UIKit import after first import and hCode before @end', () => {
  const src = '#import <Foundation/Foundation.h>\n\n@interface Foo : NSObject\n@end\n';
  const out = insertObjCHeaderJunk(src, 'Foo', '- (void)OBFObjx;\n');
  assert.ok(out.includes('#import <UIKit/UIKit.h>'));
  assert.ok(out.indexOf('#import <UIKit/UIKit.h>') < out.indexOf('@interface Foo'));
  assert.ok(out.indexOf('- (void)OBFObjx;') < out.lastIndexOf('@end'));
  // idempotent shape: does not double-add UIKit
  const twice = insertObjCHeaderJunk(out, 'Foo', '- (void)OBFObjx;\n');
  assert.equal((twice.match(/#import <UIKit\/UIKit.h>/g) ?? []).length, 1);
});

test('insertObjCImplJunk inserts method bodies before @end of @implementation', () => {
  const src = '#import "Foo.h"\n\n@implementation Foo\n@end\n';
  const out = insertObjCImplJunk(src, 'Foo', '- (void)OBFObjx {\n}\n', '');
  assert.ok(out.indexOf('- (void)OBFObjx {') < out.lastIndexOf('@end'));
  assert.match(out, /@implementation Foo/);
});

test('insertSwiftJunk inserts property and method code right after class brace', () => {
  const src = 'import UIKit\n\nclass Foo: UIViewController {\n}\n';
  const out = insertSwiftJunk(src, 'Foo', '    var a: CGFloat! = 0.0\n', '    func OBFObjx() {}\n');
  assert.match(out, /class Foo: UIViewController \{/);
  assert.ok(out.includes('var a: CGFloat! = 0.0'));
  assert.ok(out.includes('func OBFObjx()'));
});

// ---- batch insertJunkCode ----

test('insertJunkCode injects into h/m/swift deterministically and positions correctly', t => {
  const files = () => ({
    'Foo.h': '#import <Foundation/Foundation.h>\n\n@interface Foo : NSObject\n@end\n',
    'Foo.m': '#import "Foo.h"\n\n@implementation Foo\n@end\n',
    'Bar.swift': 'import UIKit\n\nclass Bar: UIViewController {\n}\n',
  });
  const a = tempProject(t, files());
  const b = tempProject(t, files());
  const first = insertJunkCode(walkProject(a).files, { amount: 1 }, 'seed');
  const second = insertJunkCode(walkProject(b).files, { amount: 1 }, 'seed');
  assert.deepEqual(first, second);
  assert.ok(first.changed >= 3);

  const after = entries(a);
  assert.match(after['Foo.h'], /^- \(.+\)OBFObj/m);
  assert.ok(after['Foo.h'].indexOf('- (') < after['Foo.h'].lastIndexOf('@end'));
  assert.ok(after['Foo.m'].indexOf('OBFObj') < after['Foo.m'].lastIndexOf('@end'));
  assert.match(after['Bar.swift'], /func OBFObj/);

  const otherRoot = tempProject(t, files());
  insertJunkCode(walkProject(otherRoot).files, { amount: 1 }, 'seed-2');
  const otherAfter = entries(otherRoot);
  assert.notEqual(after['Foo.h'], otherAfter['Foo.h']);
});

test('insertJunkCode skips Pods/AppDelegate/category paths', t => {
  const root = tempProject(t, {
    'Pods/Dep.h': '@interface Dep : NSObject\n@end\n',
    'AppDelegate.h': '@interface AppDelegate : UIResponder\n@end\n',
    'Foo+Bar.h': '@interface Foo+Bar : NSObject\n@end\n',
  });
  const outcome = insertJunkCode(walkProject(root).files, { amount: 1 }, 'seed');
  assert.equal(outcome.changed, 0);
  assert.deepEqual(outcome.changedPaths, []);
});

// ---- createJunkFiles ----

test('createJunkFiles (OC) writes .h/.m and registers pbxproj', t => {
  const root = tempProject(t, {
    'App.xcodeproj/project.pbxproj': MINIMAL_PBXPROJ,
    'main.m': '#import <UIKit/UIKit.h>\n',
  });
  const files = walkProject(root).files;
  const outcome = createJunkFiles(root, files, { count: 1, amount: 1 }, 'seed');
  assert.equal(outcome.changed, 3); // .h + .m + pbxproj

  const after = entries(root);
  const folder = Object.keys(after).find(p => /^[A-Z][a-z]+[A-Z][a-z]+/.test(p) && p.includes('.h'))?.split('/')[0];
  assert.ok(folder, `expected created folder in ${Object.keys(after)}`);
  const hPath = Object.keys(after).find(p => p.endsWith('.h'));
  const mPath = Object.keys(after).find(p => p.endsWith('.m'));
  assert.match(after[hPath], /@interface /);
  assert.match(after[hPath], /@end/);
  assert.match(after[mPath], /@implementation /);
  assert.match(after[mPath], /@end/);

  const pbx = after['App.xcodeproj/project.pbxproj'];
  assert.ok(pbx.includes(`path = ${folder};`));
  assert.ok(pbx.includes('sourcecode.c.h'));
  assert.ok(pbx.includes('sourcecode.c.objc'));
  assert.ok(pbx.includes(' in Sources */'));
});

test('createJunkFiles (Swift) writes .swift and registers pbxproj', t => {
  const root = tempProject(t, {
    'App.xcodeproj/project.pbxproj': MINIMAL_PBXPROJ,
    'main.swift': 'import UIKit\n',
  });
  const outcome = createJunkFiles(root, walkProject(root).files, { count: 1, amount: 1, language: 'Swift' }, 'seed');
  assert.equal(outcome.changed, 2); // .swift + pbxproj
  const after = entries(root);
  const swiftPath = Object.keys(after).find(p => p.endsWith('.swift'));
  assert.ok(swiftPath);
  assert.match(after[swiftPath], /class .+:/);
  assert.match(after[swiftPath], /import UIKit/);
  assert.ok(after['App.xcodeproj/project.pbxproj'].includes('sourcecode.swift'));
});

// ---- resource cleanup ----

test('lineReferencesResource and resource predicates are consistent', () => {
  assert.equal(isResourcePath('Assets/logo.png'), true);
  assert.equal(isResourcePath('Assets/logo.txt'), false);
  assert.equal(resourceNameFromPath('Assets/logo@2x.png'), 'logo@2x');
  const names = new Set(['logo', 'logo@2x', 'keep']);
  assert.deepEqual(lineReferencesResource('UIImage(named: "logo")', names), ['logo']);
  assert.deepEqual(lineReferencesResource('"keep.png"', names), ['keep']);
  assert.deepEqual(lineReferencesResource('"logo@2x"', names), ['logo@2x']);
  assert.equal(isIgnoredPath('/Pods/AFNetworking/AFNetworking.h'), true);
});

test('cleanUnusedResources deletes unreferenced imagesets and loose files, rewrites pbxproj', t => {
  const root = tempProject(t, {
    'App.xcodeproj/project.pbxproj': MINIMAL_PBXPROJ,
    'Assets.xcassets/logo.imageset/Contents.json': '{"images":[]}',
    'Assets.xcassets/logo.imageset/logo@2x.png': 'PNGDATA',
    'Assets.xcassets/stale.imageset/Contents.json': '{"images":[]}',
    'Assets.xcassets/stale.imageset/stale@2x.png': 'PNGDATA',
    'res/keep.png': 'PNGDATA',
    'res/drop.png': 'PNGDATA',
    'App/main.swift': 'import UIKit\nlet a = UIImage(named: "logo")\nlet b = UIImage(named: "keep")\n',
  });
  const outcome = cleanUnusedResources(walkProject(root).files, {});
  assert.ok(outcome.changed >= 2);
  assert.ok(outcome.changedPaths.includes('Assets.xcassets/stale.imageset'));
  assert.ok(outcome.changedPaths.includes('res/drop.png'));

  assert.equal(existsSync(join(root, 'Assets.xcassets/stale.imageset')), false);
  assert.equal(existsSync(join(root, 'res/drop.png')), false);
  assert.equal(existsSync(join(root, 'Assets.xcassets/logo.imageset')), true);
  assert.equal(existsSync(join(root, 'res/keep.png')), true);
});

test('cleanUnusedResources honors ignore names', t => {
  const root = tempProject(t, {
    'res/drop.png': 'PNGDATA',
    'App/main.swift': 'import UIKit\n',
  });
  const outcome = cleanUnusedResources(walkProject(root).files, { ignore: ['drop'] });
  assert.equal(outcome.changed, 0);
  assert.equal(existsSync(join(root, 'res/drop.png')), true);
});
