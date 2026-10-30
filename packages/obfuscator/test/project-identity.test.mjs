import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkProject } from '../dist/common.js';
import {
  createMissImageName,
  getIdDestinationMissName,
  getMissFolderName,
  getNewImageName,
  getStringKeywords,
  getXibStoryboardMap,
  parsePbxGroups,
  renameProjectIdentity,
  replaceImageNameLine,
  replaceProjectNameInLine,
  replaceStringKeywords,
} from '../dist/project-identity.js';

function tempProject(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'obfuscator-identity-'));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function snapshot(root) {
  const result = {};
  for (const entry of walkProject(root).files) {
    result[entry.relative] = entry.relative.endsWith('.png') ? '<binary>' : readFileSync(entry.absolute, 'utf8');
  }
  return result;
}

const FIXTURE = () => ({
  'MyApp.xcodeproj/project.pbxproj': `// !$*UTF8*$!
{
	archiveVersion = 1;
	objectVersion = 50;
	objects = {

/* Begin PBXGroup section */
		1A2B3C4D5E6F7A8B9C0D1E2F /* Models */ = {
			isa = PBXGroup;
			children = (
				2A2B3C4D5E6F7A8B9C0D1E2F /* Model.swift */,
			);
			path = Models;
			sourceTree = "<group>";
		};
		3A2B3C4D5E6F7A8B9C0D1E2F /* MyApp */ = {
			isa = PBXGroup;
			children = (
				1A2B3C4D5E6F7A8B9C0D1E2F /* Models */,
			);
			path = MyApp;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin PBXFileReference section */
		2A2B3C4D5E6F7A8B9C0D1E2F /* Model.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = Model.swift; sourceTree = "<group>"; };
/* End PBXFileReference section */

	};
	rootObject = 3A2B3C4D5E6F7A8B9C0D1E2F;
}
`,
  'MyApp/Models/Model.swift': 'import UIKit\nlet logo = UIImage(named: "logo")\n',
  'MyApp/Assets.xcassets/logo.imageset/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'MyApp/Assets.xcassets/logo.imageset/Contents.json': '{\n  "images" : [\n    {\n      "filename" : "logo.png",\n      "idiom" : "universal",\n      "scale" : "1x"\n    }\n  ],\n  "info" : { "version" : 1, "author" : "xcode" }\n}\n',
  'MyApp/Base.lproj/Main.storyboard': '<?xml version="1.0" encoding="UTF-8"?>\n<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0">\n    <scenes>\n        <scene sceneID="abc-def-ghi">\n        </scene>\n    </scenes>\n</document>\n',
  'MyApp/Base.lproj/Main.strings': '"abc-def-ghi.title" = "Hello";\n',
});

// ---- Pure functions ----

test('getMissFolderName keeps the last fragment and is deterministic', () => {
  const a = getMissFolderName('Models', 'seed');
  const b = getMissFolderName('Models', 'seed');
  assert.equal(a, b);
  assert.match(a, /^[A-Z][a-zA-Z]+Models$/);
  assert.notEqual(a, 'Models');
  // Digits and dots are stripped; only meaningful fragments remain.
  assert.match(getMissFolderName('common_ios_2.1.4', 'seed'), /^[A-Z][a-zA-Z]+commonios$/);
});

test('createMissImageName / getNewImageName are deterministic and preserve count suffixes', () => {
  const a = createMissImageName('logo', 'seed');
  assert.equal(createMissImageName('logo', 'seed'), a);
  assert.match(a, /^[a-z][A-Za-z]+Logo$/);
  const renamed = getNewImageName('logo', '', 'seed', 0);
  assert.equal(renamed, a);
  assert.notEqual(renamed, 'logo');
  // Count-suffixed variants are preserved (original default behavior).
  assert.equal(getNewImageName('hl_new_call_1', '', 'seed', 0), 'hl_new_call_1');
});

test('getIdDestinationMissName renames only well-formed 3-part hyphen ids', () => {
  const a = getIdDestinationMissName('abc-def-ghi', 'seed');
  assert.equal(getIdDestinationMissName('abc-def-ghi', 'seed'), a);
  assert.match(a, /^[A-Za-z0-9]{3}-[A-Za-z0-9]{3}-[A-Za-z0-9]{3}$/);
  assert.notEqual(a, 'abc-def-ghi');
  assert.equal(getIdDestinationMissName('ab-cd', 'seed'), null);
  assert.equal(getIdDestinationMissName('ab:cd-ef-gh', 'seed'), null);
  assert.equal(getIdDestinationMissName('中文-abc-def', 'seed'), null);
});

test('parsePbxGroups maps child comment names to group rows', () => {
  const content = '/* Begin PBXGroup section */\n\t\t1A2B /* Models */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t2A2B /* Model.swift */,\n\t\t\t);\n\t\t\tpath = Models;\n\t\t\tsourceTree = "<group>";\n\t\t};\n/* End PBXGroup section */\n';
  const map = parsePbxGroups(content, 'seed', '');
  assert.equal(map.size, 1);
  const row = map.get('Model.swift');
  assert.equal(row.name, 'Models');
  assert.equal(row.udid, '1A2B');
  assert.equal(row.path, 'Models');
  assert.equal(row.missName, getMissFolderName('Models', 'seed'));
});

test('getXibStoryboardMap discovers custom id-like attributes but not pass keywords', () => {
  const line = '<segue destination="abc-def-ghi" customRef="lmn-opq-rst"></segue>';
  const result = getXibStoryboardMap(line, ['initialViewController', 'sceneID'], ['id', 'destination', 'firstItem', 'secondItem']);
  assert.deepEqual([...result.map.keys()], ['customRef']);
  assert.ok(result.keywords.includes('customRef'));
  assert.equal(result.keywords.includes('destination'), false);
});

test('replaceProjectNameInLine rewrites standalone names and bridging headers', () => {
  assert.equal(replaceProjectNameInLine('PRODUCT_NAME = MyApp;', 'MyApp', 'Hidden', 'MyApp-Bridging-Header.h', 'Hidden-Bridging-Header.h'), 'PRODUCT_NAME = Hidden;');
  // The original only guards the left boundary: a name preceded by a letter is not a standalone occurrence.
  assert.equal(replaceProjectNameInLine('PRODUCT_NAME = XMyApp;', 'MyApp', 'Hidden', 'MyApp-Bridging-Header.h', 'Hidden-Bridging-Header.h'), 'PRODUCT_NAME = XMyApp;');
  // A name followed by a letter is still rewritten (left boundary is clean).
  assert.equal(replaceProjectNameInLine('PRODUCT_NAME = MyAppKit;', 'MyApp', 'Hidden', 'MyApp-Bridging-Header.h', 'Hidden-Bridging-Header.h'), 'PRODUCT_NAME = HiddenKit;');
  assert.equal(replaceProjectNameInLine('SWIFT_OBJC_BRIDGING_HEADER = MyApp/Bridge.h;', 'MyApp', 'Hidden', 'MyApp-Bridging-Header.h', 'Hidden-Bridging-Header.h'), 'SWIFT_OBJC_BRIDGING_HEADER = Hidden/Bridge.h;');
});

test('replaceImageNameLine rewrites Swift image references', () => {
  assert.equal(replaceImageNameLine('let a = UIImage(named: "logo")', 'logo', 'brand', 'x.swift'), 'let a = UIImage(named: "brand")');
});

test('string keyword extraction and replacement use the xib miss map', () => {
  assert.deepEqual(getStringKeywords('"abc-def-ghi.title" = "Hello";'), ['abc-def-ghi']);
  assert.equal(replaceStringKeywords('"abc-def-ghi.title" = "Hello";', new Map([['abc-def-ghi', 'xyz-123-uvw']])), '"xyz-123-uvw.title" = "Hello";');
});

// ---- Batch pipeline ----

test('renameProjectIdentity renames project, folders, images, xib ids and strings', t => {
  const root = tempProject(t, FIXTURE());
  const outcome = renameProjectIdentity(walkProject(root).files, { projectName: 'HiddenApp' }, 'seed');

  assert.ok(outcome.changed >= 5, JSON.stringify(outcome));

  assert.equal(existsSync(join(root, 'MyApp.xcodeproj/project.pbxproj')), false);
  assert.equal(existsSync(join(root, 'HiddenApp.xcodeproj/project.pbxproj')), true);
  assert.equal(existsSync(join(root, 'MyApp')), false);
  assert.equal(existsSync(join(root, 'HiddenApp')), true);

  // Folder rename from the PBXGroup.
  assert.equal(existsSync(join(root, 'HiddenApp/Models')), false);

  // xcassets image + Contents.json + .imageset directory renamed.
  assert.equal(existsSync(join(root, 'HiddenApp/Assets.xcassets/logo.imageset')), false);
  const after = snapshot(root);
  const imageset = Object.keys(after).find(rel => rel.endsWith('.imageset/Contents.json'));
  assert.ok(imageset, 'renamed imageset Contents.json should exist');
  const newStem = imageset.split('/')[2].replace('.imageset', '');
  assert.notEqual(newStem, 'logo');
  assert.match(after[imageset], new RegExp(`"${newStem}.png"`));
  assert.equal(after[`HiddenApp/Assets.xcassets/${newStem}.imageset/${newStem}.png`], '<binary>');

  // Source reference rewritten.
  const swift = Object.keys(after).find(rel => rel.endsWith('Model.swift'));
  assert.ok(swift, 'renamed Model.swift should exist');
  assert.match(after[swift], new RegExp(`UIImage\\(named: "${newStem}"\\)`));

  // xib id renamed; strings key follows the same map.
  const storyboard = after[Object.keys(after).find(rel => rel.endsWith('Main.storyboard'))];
  assert.equal(storyboard.includes('abc-def-ghi'), false);
  const newId = storyboard.match(/sceneID="([A-Za-z0-9]{3}-[A-Za-z0-9]{3}-[A-Za-z0-9]{3})"/)[1];
  assert.ok(newId);
  const strings = after[Object.keys(after).find(rel => rel.endsWith('Main.strings'))];
  assert.equal(strings.includes('abc-def-ghi.title'), false);
  assert.ok(strings.includes(`${newId}.title`), strings);
});

test('renameProjectIdentity is deterministic for a fixed seed', t => {
  const first = tempProject(t, FIXTURE());
  const second = tempProject(t, FIXTURE());
  renameProjectIdentity(walkProject(first).files, { projectName: 'HiddenApp' }, 'seed');
  renameProjectIdentity(walkProject(second).files, { projectName: 'HiddenApp' }, 'seed');
  assert.deepEqual(snapshot(first), snapshot(second));
});

test('renameProjectIdentity differs across seeds', t => {
  const a = tempProject(t, FIXTURE());
  const b = tempProject(t, FIXTURE());
  renameProjectIdentity(walkProject(a).files, { projectName: 'HiddenApp' }, 'seed-a');
  renameProjectIdentity(walkProject(b).files, { projectName: 'HiddenApp' }, 'seed-b');
  assert.notDeepEqual(snapshot(a), snapshot(b));
});
