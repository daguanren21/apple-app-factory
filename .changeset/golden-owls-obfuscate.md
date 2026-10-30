---
"apphx": minor
---

Add an installable `apphx-obfuscator` skill alongside `apphx`: every host gains a direct trigger (`/apphx-obfuscator`, `$apphx-obfuscator`, `/skill:apphx-obfuscator`) for the bundled deterministic obfuscator without enqueuing a job. `apphx install/update/uninstall <host>` and `doctor --host` now manage and report both skills.
