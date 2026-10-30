---
name: apphx-obfuscator
description: Run the deterministic apphx obfuscator directly on an owned project copy from a JSON rules file. Supports ObjC/Swift symbol renaming, XOR string encryption, Flutter symbol/resource obfuscation, DFA sensitive-word filtering, junk code/files, resource cleaning, project identity renames and image transforms. Use for review-hardening a local app before verification or packaging; never use it to evade lawful review of code the owner cannot lawfully ship.
---

# apphx-obfuscator

Run the bundled deterministic obfuscator on a project you own. Same CLI, config and determinism contract as the `obfuscate` stage of the apphx pipeline, but triggered directly, without enqueuing a job.

## Prerequisites and command form

The `apphx` CLI owns the bundled obfuscator. Use the project's package manager form when `apphx` is a local dependency: `pnpm exec apphx`, `yarn exec apphx` or `npm exec --offline --package=apphx -- apphx`. Confirm with `apphx --version`, then run:

```text
apphx obfuscator <project> --config <rules.json> [--framework <stack>] [--seed <text>]
```

- `<project>`: absolute or relative path to the project copy to transform in place.
- `--config`: obfuscator rules as JSON (required; see below). Relative paths resolve against the current directory.
- `--framework`: `flutter|android-java|swift|react-native|expo|uni-app|mygo` (required unless set in config).
- `--seed`: determinism seed. Defaults to `config.seed`, then a hash of the rules file.

## Rules file

JSON matching the obfuscator schema. At least one section must be present; every subsection is optional and empty subsections are no-ops.

```json
{
  "framework": "swift",
  "seed": "my-seed",
  "code": {
    "removeComments": true,
    "encryptStrings": { "excludes": [] },
    "renameIdentifiers": { "mappings": {}, "patterns": [], "generated": 32 },
    "junkCode": { "lines": 2 },
    "keywords": {}
  },
  "resources": {
    "rename": { "mappings": {}, "generated": 64 },
    "hashPerturb": { "bytes": 16 },
    "images": { "recolor": [{ "from": "#ff0000", "to": "#00ff00", "tolerance": 20 }], "scale": { "width": 512 }, "flatten": { "bgColor": "#ffffff" } }
  },
  "project": { "name": { "from": "Demo", "to": "Acme" }, "directories": [], "uuids": true },
  "content": { "sensitiveWords": {}, "dfa": { "words": [], "replace": "*", "keywordMix": { "prefix": "zm" } } },
  "objc": {
    "symbols": { "algorithmType": 0, "methodPrefix": "zk", "propertyPrefix": "zk", "classPrefix": "ZF", "replaceClassPrefix": { "from": "Demo", "to": "ZF" }, "magicColor": {} },
    "stringEncryption": { "encryptionNum": 77, "encryptedName": "NNC_NSSTRING" },
    "junkCode": { "amount": 2, "rubPrefix": "OBFObj" },
    "junkFiles": { "count": 2, "amount": 1, "language": "OC" },
    "cleanResources": { "ignore": [] },
    "projectIdentity": { "projectName": "Acme", "folderPrefix": "zk", "imagePrefix": "img", "imageAlgorithm": 0 }
  },
  "flutter": {
    "prefixWord": "zk",
    "missAlgorithmType": 0,
    "classWhiteList": ["MyApp"],
    "methodWhiteList": [],
    "variableWhiteList": [],
    "features": { "variable": true, "className": true, "method": true, "resourceName": true, "resourceHash": true, "deleteNotes": true, "uuid": true }
  }
}
```

`objc` covers iOS/ObjC/Swift symbol renaming, XOR string encryption with `.pch`/Swift decryptor injection, junk code/files, unused-resource cleaning and project identity renames (project name, folders, xcassets images, xib/storyboard references). `flutter` covers Dart class/method/variable renaming, resource names and hash perturbation, UUID remapping and comment removal. `content.dfa` is a DFA sensitive-word filter over a built-in lexicon plus your extra words.

## Determinism and safety

- Identical project + rules + seed produce byte-identical output. No wall-clock, locale or `Math.random` state is consulted.
- The obfuscator only writes inside the walked project and skips generated/vendor directories. Run it on a **copy** of the project, never on the only checkout, unless the user explicitly says otherwise.
- Obfuscation changes the code that verification, review and packaging see. In the apphx pipeline, changing the obfuscation config invalidates prior verification proof and requires renewed verification and review.
- Keep the app buildable: after obfuscating, run the normal build/verify steps; any breakage is a rules-file problem to fix and retry.
- Do not weaken acceptance, verification or signing to accommodate obfuscation output.
