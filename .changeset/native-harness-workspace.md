---
"apphx": major
---

Launch apphx 1.0.0 with native Harness installation and explicit skill updates, including Hermes support and package-manager-compatible asset resolution. Keep the app-factory command and apple-app-factory skill stable. Package the CLI, skills, and examples as one public workspace package, built with tsdown and verified through repoctl's native release gates.

Preserve verified predecessor workspaces on the supported Node release toolchain without weakening the no-overwrite or source-fingerprint checks.

License the project and its published package under MIT.

Use Turborepo to coordinate builds, type checks, and uncached runtime tests, with complete local build-artifact caching.
