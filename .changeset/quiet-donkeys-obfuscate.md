---
"apphx": minor
---

Add an owner-configured deterministic obfuscation stage between build and verify: the bundled `obfuscator` rewrites project config names, renames directories/resources with reference rewrites, perturbs image hashes, recolors PNGs, scrubs sensitive words and source colors, and transforms code in place. Verified and packaged artifacts are the obfuscated code; changing the obfuscation config invalidates prior verification proof.
