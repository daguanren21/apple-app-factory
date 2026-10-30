# apphx

## 2.1.0

### Minor Changes

- Add an installable `apphx-obfuscator` skill alongside `apphx`: every host gains a direct trigger (`/apphx-obfuscator`, `$apphx-obfuscator`, `/skill:apphx-obfuscator`) for the bundled deterministic obfuscator without enqueuing a job. `apphx install/update/uninstall <host>` and `doctor --host` now manage and report both skills.

## 2.0.1

### Patch Changes

- Add qoder, oh-my-pi, and dimagent host integrations with verified skill directory conventions

## 2.0.0

### Major Changes

- Remove automatic Apple policy audits, App Store Connect upload/submission/monitor, the authorize/feedback commands and publication permissions (allowSubmit/allowRelease). apphx now produces and verifies local iOS/Android/macOS packages only; store submission, account setup and platform review are manual human work outside the tool.

  The internal gate becomes real verification proofs plus a fresh independent review with an honest differentiation and quality checklist: research returns {viable, distinctness, risks, plan} and review returns {approved, findings, acceptanceEvidence}; the Apple appStoreAudit and policySources wire fields are removed. Apple metadata remains optional owner documentation. Keep the honest-differentiation and identity safeguards — never forge identity/IP, mutate hashes, hide sensitive features or script replies, and never promise Apple approval.

- Support native Java/Swift, Flutter, React Native, Expo and uni-app with pinned existing-project snapshots, independent platform/channel verification and verified command-based packaging; migrate queue snapshots to v3.

### Minor Changes

- Add local MyGo macOS app and DMG delivery with preserved native/web projects, Go workspace dependency proof and real desktop artifact validation.

- Replace per-channel store policy research with an honest differentiation and quality checklist covering real value, visual identity, developer/app metadata, exercised functionality and code identity, together with a fresh independent review of every acceptance criterion. Store submission and platform review remain manual human work outside the tool.

- Add an owner-configured deterministic obfuscation stage between build and verify: the bundled `obfuscator` rewrites project config names, renames directories/resources with reference rewrites, perturbs image hashes, recolors PNGs, scrubs sensitive words and source colors, and transforms code in place. Verified and packaged artifacts are the obfuscated code; changing the obfuscation config invalidates prior verification proof.

## 1.1.0

### Minor Changes

- Unify the npm package, CLI and Skill as apphx. The app-factory command and apple-app-factory Skill are replaced; uninstall old unmodified Skills before upgrading, then install apphx in the same scope. Configuration schemas, application data and task state are preserved. For SSH, update remote.json's executable to the absolute apphx path on the Mac host. Update existing scheduler command and Skill references to apphx.

## 1.0.0

### Major Changes

- Launch apphx 1.0.0 with native Harness installation and explicit skill updates, including Hermes support and package-manager-compatible asset resolution. Keep the app-factory command and apple-app-factory skill stable. Package the CLI, skills, and examples as one public workspace package, built with tsdown and verified through repoctl's native release gates.

  Preserve verified predecessor workspaces on the supported Node release toolchain without weakening the no-overwrite or source-fingerprint checks.

  License the project and its published package under MIT.

  Use Turborepo to coordinate builds, type checks, and uncached runtime tests, with complete local build-artifact caching.
