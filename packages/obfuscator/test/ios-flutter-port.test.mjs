import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyObfuscation } from '../dist/obfuscate.js';
import { walkProject } from '../dist/common.js';
import { buildPNG } from '../dist/png.js';

// End-to-end wiring test for the iOS/Flutter ported pipeline sections:
// objc.projectIdentity, content.dfa, objc.symbols, objc.stringEncryption and flutter.
// Fixture names are chosen outside every built-in filter/whitelist list so renames are guaranteed.

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'port-e2e-'));
  const pbx = join(root, 'Runner.xcodeproj');
  mkdirSync(pbx, { recursive: true });
  writeFileSync(join(pbx, 'project.pbxproj'), `// !$*UTF8*$!
{
  archiveVersion = 1;
  objectVersion = 56;
  objects = {
/* Begin PBXGroup section */
    100000000000000000000001 /* Demo */ = {
      isa = PBXGroup;
      children = (
        100000000000000000000002 /* ShopDetailView.m */,
        100000000000000000000003 /* ShopDetailView.h */,
        100000000000000000000004 /* Prefix.pch */,
        100000000000000000000005 /* PaymentGateway.swift */,
      );
      path = Demo;
      sourceTree = "<group>";
    };
/* End PBXGroup section */

    100000000000000000000002 /* ShopDetailView.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = ShopDetailView.m; sourceTree = "<group>"; };
  };
  rootObject = 100000000000000000000001 /* Project object */;
}
`);
  const demo = join(root, 'Demo');
  mkdirSync(demo, { recursive: true });
  writeFileSync(join(demo, 'Prefix.pch'), `#ifdef __OBJC__
#import <UIKit/UIKit.h>
#endif
`);
  writeFileSync(join(demo, 'ShopDetailView.h'), `#import <UIKit/UIKit.h>

@interface ShopDetailView : UIViewController
@property (nonatomic, strong) NSString *vendorLedgerBalance;
- (void)reserveVendorLedger;
@end
`);
  writeFileSync(join(demo, 'ShopDetailView.m'), `#import "ShopDetailView.h"

@implementation ShopDetailView

- (void)reserveVendorLedger {
    self.vendorLedgerBalance = @"hello world";
}

@end
`);
  writeFileSync(join(demo, 'PaymentGateway.swift'), `import UIKit

class PaymentGateway {
    let appTitle = "sample"
}
`);
  const lib = join(root, 'lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'main.dart'), `import 'package:flutter/material.dart';

class HomePage extends StatefulWidget {
  // lazily created counter
  int shoppingCount = 0;

  void fetchAccountData() {
    /* block comment */
    shoppingCount += 1;
  }
}
`);
  const assets = join(root, 'Assets', 'logo.imageset');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'logo.png'), buildPNG({ width: 1, height: 1, pixels: new Uint8Array([255, 0, 0, 255]) }));
  writeFileSync(join(assets, 'Contents.json'), `{
  "images" : [
    { "filename" : "logo.png", "idiom" : "universal" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
`);
  writeFileSync(join(root, 'notes.txt'), 'release notes: gambling is forbidden\n');
  return root;
}

function snapshot(root) {
  return walkProject(root).files
    .map(entry => [entry.relative, readFileSync(entry.absolute).toString('base64')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const config = {
  framework: 'swift',
  seed: 'port-e2e',
  objc: {
    projectIdentity: { folderPrefix: 'zk', imagePrefix: 'img' },
    symbols: { methodPrefix: 'zk', classPrefix: 'Obf' },
    stringEncryption: {},
  },
  flutter: { features: { className: true, method: true, variable: true, deleteNotes: true } },
  content: { dfa: {} },
};

test('iOS/Flutter ported pipeline sections apply end to end and deterministically', () => {
  const first = buildFixture();
  const second = buildFixture();
  try {
    const report = applyObfuscation(first, config, 'seed-A', 'swift');
    for (const key of ['objcProjectIdentity', 'dfaFilter', 'objcSymbols', 'objcStringEncryption', 'flutterSymbols']) {
      assert.ok(report.transforms[key] > 0, `${key} should have changed files, got ${report.transforms[key]}`);
    }
    assert.ok(report.changedFiles > 0);

    const files = walkProject(first).files;
    const mFile = files.find(entry => entry.relative.endsWith('.m'));
    const pchFile = files.find(entry => entry.relative.endsWith('.pch'));
    const swiftFile = files.find(entry => entry.relative.endsWith('.swift'));
    const dartFile = files.find(entry => entry.relative.endsWith('.dart'));
    const txtFile = files.find(entry => entry.relative.endsWith('.txt'));
    assert.ok(mFile && pchFile && swiftFile && dartFile && txtFile, 'all fixture files survived');

    const m = readFileSync(mFile.absolute, 'utf8');
    assert.ok(!m.includes('reserveVendorLedger'), 'ObjC method renamed');
    assert.ok(!m.includes('vendorLedgerBalance'), 'ObjC property renamed');
    assert.ok(!m.includes('@"hello world"'), 'ObjC literal encrypted');
    assert.ok(m.includes('NNC_NSSTRING('), 'ObjC decrypt macro used');

    const pch = readFileSync(pchFile.absolute, 'utf8');
    assert.ok(pch.includes('decryptConstString'), 'ObjC decryptor injected into pch');
    assert.ok(pch.includes('#define'), 'ObjC macro defined in pch');

    const swift = readFileSync(swiftFile.absolute, 'utf8');
    assert.ok(swift.includes('OBF_NSSTRING'), 'Swift decryptor injected');

    const dart = readFileSync(dartFile.absolute, 'utf8');
    assert.ok(!dart.includes('HomePage'), 'dart class renamed');
    assert.ok(!dart.includes('shoppingCount'), 'dart variable renamed');
    assert.ok(!dart.includes('//') && !dart.includes('/*'), 'dart comments removed');

    const txt = readFileSync(txtFile.absolute, 'utf8');
    assert.ok(!txt.includes('gambling'), 'sensitive word filtered');
    assert.ok(txt.includes('********'), 'sensitive word replaced with mask');

    const renamed = walkProject(first).files.map(entry => entry.relative);
    assert.ok(!renamed.some(relative => relative.includes('logo.imageset')), 'imageset folder renamed');
    assert.ok(!renamed.some(relative => relative.startsWith('Demo/')), 'source folder renamed');

    // Same seed on a fresh copy => byte-identical result.
    applyObfuscation(second, config, 'seed-A', 'swift');
    assert.deepEqual(snapshot(first), snapshot(second));

    // Different seed => different output.
    const third = buildFixture();
    try {
      applyObfuscation(third, config, 'seed-B', 'swift');
      assert.notDeepEqual(snapshot(first), snapshot(third));
    } finally {
      rmSync(third, { recursive: true, force: true });
    }
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
