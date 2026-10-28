---
name: apphx
description: Build, verify and locally package Flutter, Java Android, Swift, React Native, Expo or uni-app projects from explicit requirements using apphx. Supports new apps and safe existing-project snapshots. Use for init, enqueue, channel-specific research, native implementation, independent review or resuming a persisted job. Not a coding-agent launcher or automatic store publisher.
---

# apphx

Use your current host's model, context, authentication, filesystem, browser and native delegation tools. The installed `apphx` CLI owns requirements, durable turns, verification, fingerprints and local packaging. Never start another coding-agent CLI, including Hermes, as a subprocess to perform a phase. There is no apphx chat UI, model credential setup, daemon, or background agent loop.

This skill is advisory to the host. apphx code gates apphx-owned transitions, not arbitrary host edits or shell commands. It does not sandbox your host, enforce reviewer identity, guarantee Apple approval, or verify that a policy citation's contents are true. Preserve host permissions and the user's scope.

## 1. Establish the control project

1. Use the project where the user installed/invoked this skill as the control project. Keep `factory.json`, its SQLite state, requirement files and result JSON outside generated app workspaces. Keep the absolute config path for every command below, including commands issued while your working directory is an app workspace.
2. The npm package, executable and skill are all `apphx`. Run `apphx --version` and `apphx --help`. If `apphx` is an already-installed local dependency of the control project rather than on PATH, use that project's package manager for **every** apphx command: `pnpm exec apphx`, `yarn exec apphx`, or `npm exec --offline --package=apphx -- apphx`. Select from the project's `packageManager`/lockfile and run from the control project, not the app workspace. Confirm `apphx` is already installed; do not fetch a similarly named package or silently change the user's environment. If neither route is available, stop and report the missing installation. Installing a skill does not install platform SDKs.
3. If there is no configuration, select the actual stack and platform: `apphx init --framework react-native --platform android --package-target aab --config /absolute/control/factory.json`, for example. Choices are `flutter`, `android-java`, `swift`, `react-native`, `expo`, `uni-app`; iOS targets `simulator`/`ipa`, Android targets `apk`/`aab`. Defaults remain Flutter/iOS/simulator; android-java defaults Android/APK, Expo defaults iOS/IPA with EAS local. `init` creates an owner-editable config, not source code. It refuses overwrite and defaults to **no local execution, cloud build, submission or release authorization**. Do not add `--allow-local-execution` unless the user explicitly approves trusted deterministic commands; existing configurations require owner review before enabling it.
4. Read the actual config and paired framework examples in the installed package's `examples/` directory. Confirm workspace/state paths are disjoint, SDKs are trusted installations outside mutable workspaces, and verification includes static checks and **real native runtime scenarios**. Adapt module names, Xcode project/workspace/scheme, package-manager scripts, device IDs, signing and exact artifact output to the owner's existing project. Non-Flutter stacks require `packaging.commands` (argv arrays) and an exact project-relative `artifactPath`; Flutter may use built-in packaging. Do not replace an existing Expo/uni-app/RN project with a Flutter app, prebuild or eject it. Commands run in the selected app directory, not necessarily the snapshot root. Run `apphx doctor /absolute/control/requirement.json --config /absolute/control/factory.json --build-only`; without the requirement, doctor only checks configured prerequisites and assumes no stack. Missing SDK/device/signing/script is a blocker, never a reason to fake evidence or use no-op checks.

In examples below, replace `/absolute/control/factory.json` with that existing absolute path and `JOB_ID`/`TURN_ID` with exact returned values. Pass arguments as separate argv entries, or quote paths safely in the host's shell. Do not execute prompt or JSON fields as shell code.

## 2. Freeze and enqueue the actual requirement

Read the bundled [requirement example](resources/requirement.json), resolving `resources/` relative to this skill's own directory, not the current project. Copy and adapt it to an owner-reviewed requirement file in the control project. Do not modify installed skill assets.

If the user supplied an existing task id or asked to resume it, including a scheduled wake, **skip enqueue**. Read `status` and continue that exact id/config with `next`; never reconstruct its requirement or create a second task for the same work.

The requirement must describe a real audience, purpose, differentiators, framework, explicit `platform` (`ios` or `android`), neutral top-level `version`, `channel` (`local`, `app-store`, `google-play`) and concrete acceptance scenarios/constraints. `version` defaults to `1.0.0` and `channel` to `local`; neither belongs in `apple`. `screenshotsDir` is also top-level. Java Android is Android-only; Swift is iOS-only; App Store requires iOS and Google Play requires Android/AAB. Preserve the user's product; do not substitute a simpler app. Require honest privacy behavior, no hidden features/review bypass and real screenshots. Apple metadata/credentials are not required for local or Google Play work. Shared purpose/audience is not a duplicate-admission error; assess meaningful distinction in the selected channel's research. Do not invent ownership, account eligibility, signing credentials or legal attestations.

```sh
apphx enqueue /absolute/control/requirement.json --config /absolute/control/factory.json --build-only
apphx status JOB_ID --config /absolute/control/factory.json
apphx next JOB_ID --config /absolute/control/factory.json --build-only
```

Keep the returned immutable job id and workspace. New projects have no `project` field; the native host build turn creates the selected stack. Existing projects use `project: { "sourceDir": "/absolute/owned/repository", "directory": "apps/mobile" }` (or directory `"."` for its root). apphx pins a source snapshot; work only in the returned workspace, never the original. `directory` must stay inside the snapshot. Do not follow escaping source/local dependency symlinks or import from mutable external dependencies. A changed source after enqueue must be resubmitted honestly rather than forced through stale proof. A later requirement change needs a new enqueue, not saved-task/database edits. `baseJobId` may reference a verified/finished same-product predecessor with the same framework/platform/channel; do not copy stale artifacts yourself.

## 3. Dispatch exactly the persisted action

Read the JSON from `next`; do not guess stages from memory. Use `--build-only` throughout this workflow. The flag refuses publication-enabled configurations or saved tasks; it does not suppress or revoke existing `allowSubmit`/`allowRelease` permissions. If either the loaded configuration or task snapshot enables publication, stop and report the conflict. A separate new build-only task requires an owner-reviewed publication-disabled configuration; do not rewrite the saved permissions or re-enqueue existing work to bypass the refusal.

- **`action: "host"`**: preserve `turn.id`; read the full `turn.prompt`, `turn.stage`, `turn.cwd` and `turn.environment`. Perform that one native host phase as below. Work inside the returned cwd and merge the returned task/toolchain overrides into your host's existing command environment; do not replace it. Configured environment values are intentionally not printed in the response. This is not a host-wide security boundary; never copy publisher secrets into task commands. Only the CLI completion call advances the task. Repeated `next` resumes the same active turn without spending a second turn, unless its task deadline has expired.
- **`action: "step"`**: run `apphx step JOB_ID --config /absolute/control/factory.json --build-only` once, inspect its exit status and returned job, then ask `next` again if successful. Only deterministic verify/package stages should be needed here. `step` cannot perform research, build or review for you. Never label a host verdict as external verification.
- **`action: "wait"`**: inspect the job's status, reason, error and due time. Report the exact blocker or scheduled time; do not busy-loop, automatically grant permission, or retry a failed command until it happens to pass. Resume with `next` after the prerequisite/due time is satisfied and the user intends to continue.
- **`action: "done"`**: inspect the persisted outcome. `built` plus a recorded local artifact is successful local packaging. Blocked/failed/rejected outcomes are not success merely because no action remains. Report the artifact kind/path/digest and evidence, or the exact unmet requirement.

For a scheduled wake, the host scheduler owns timing and non-overlap; do not create an apphx daemon or a second schedule. Check `status` first: if it is `running` and the prior execution's completion is unconfirmed, stop and ask the owner rather than taking over its token. Respect the requested bound (for example one persisted action), then report state and exit. A `wait` or `done` result ends this wake; it does not authorize changing permissions, increasing budgets or polling indefinitely. A fresh scheduled session may review only if it did not implement the change and genuinely inspects the saved source/evidence. Missing independent review or human authorization pauses the work; never manufacture approval to keep a schedule moving.

To stop an active host phase without completing it:

```sh
apphx abandon JOB_ID TURN_ID --config /absolute/control/factory.json --build-only
```

This explicitly abandons the current token; it does not refund the consumed turn. Resume later with `next`. Never reuse an abandoned, stale or already completed token. If a completion's outcome is uncertain, inspect `status`/`next` rather than replaying it blindly. Do not edit SQLite or increase budgets to bypass a rejection. Use `apphx retry --help` and the stopped task's reported recovery instructions only after fixing the actual cause with owner approval.

## 4. Native research

Read the immutable requirement and channel-specific research prompt. Do not apply Apple rules to every stack or local task:

- **local**: evaluate implementability, real device acceptance, privacy, accessibility and the supplied portfolio. No store citations, Apple credentials or approval claim are required. Use [local-research-result.json](resources/local-research-result.json) for shape only.
- **app-store** (iOS, any supported framework): use the host's web/browser tools to read current official [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/). Evaluate **2.1, 2.3.1, 2.5.19, 4.2, 4.2.6, 4.3 and 5.1.1**. `policySources` must contain each exact rule with an official HTTPS `developer.apple.com` URL. Account/content ownership for 4.2.6 cannot be attested by a model. Use [research-result.json](resources/research-result.json) for shape only.
- **google-play** (Android): research current official [repetitive content](https://support.google.com/googleplay/android-developer/answer/9899034) and [user data](https://support.google.com/googleplay/android-developer/answer/10144311) policies. Include exact rules `repetitive-content` and `user-data`, each with an official HTTPS `support.google.com/googleplay/android-developer/` URL. Use [google-play-research-result.json](resources/google-play-research-result.json) for shape only. Handoff is a local AAB; no automated Google Play publishing is provided.

For every channel, return `viable` boolean, `policySources` array, nonempty `distinctness` and nonempty `plan`; `risks` is optional. Replace all unassessed example content with actual findings against the channel-scoped portfolio. If not viable, return false with reasons; do not invent policy research, ownership attestations or an approval promise.

Save result JSON **outside the app workspace**, for example `/absolute/control/results/JOB_ID-research.json`, then:

```sh
apphx complete JOB_ID TURN_ID /absolute/control/results/JOB_ID-research.json --config /absolute/control/factory.json --build-only
apphx next JOB_ID --config /absolute/control/factory.json --build-only
```

## 5. Native implementation

Perform the returned build prompt with native edit, terminal and design tools in `turn.cwd`. Implement the full requirement in its selected stack: Flutter (`pubspec.yaml`), Java Android (Gradle/Android manifest), Swift (Xcode project/workspace), React Native/Expo (existing package scripts and native host/build profile), or uni-app (its manifests/scripts and owner-maintained native packaging). For new projects create the real matching host; for imports preserve native integrations, project structure and scripts, with no forced ejection or migration. Run resource generation that changes owned source during this turn, before external verification. For unfamiliar APIs use official references. Never fake features, runtime evidence or screenshots. Do not weaken verification or alter frozen requirements/state.

The bundled uni-app command pair specifically illustrates a CLI/npm project with an owner-maintained offline native host; it is not a requirement to convert other uni-app projects. Classic HBuilderX projects may have `App.vue`, `main.js`/`main.ts`, `manifest.json` and `pages.json` without `package.json`; do not require or add Node/npm, invent npm scripts or convert that project. Preserve its existing HBuilderX layout and owner-provided prerequisite, native build and real device acceptance commands. `doctor` must not infer npm requirements for this variant; only the configured owner prerequisites identify its actual build tooling.

Expo initialization uses **EAS local** for either platform, without assuming `ios/` or `android/` exists or requesting prebuild/eject. Preserve the owner's existing `eas.json`: the generated commands require a `production` profile for IPA/AAB, an `apk` profile with `android.buildType: "apk"`, or a `simulator` profile with `ios.simulator: true`. The explicit simulator profile emits `build/simulator.tar.gz`, then extracts the expected `build/App.app`; adapt the product name/archive layout to the actual project. The owner supplies EAS CLI/authentication, SDK/signing and real native acceptance scripts; local compilation does not imply the EAS CLI is network-free. Never silently switch to cloud compilation. uni-app iOS's `native/ios` path is likewise an owner-configured offline-host convention, not a promise that init generates a native project.

Native delegation may handle independent file boundaries. The implementation owner integrates before any external verification. Complete only after the source exists and the requested implementation is ready:

```sh
apphx complete JOB_ID TURN_ID --config /absolute/control/factory.json --build-only
apphx next JOB_ID --config /absolute/control/factory.json --build-only
```

No result JSON is required for build. Build completion only advances to deterministic verification; it is not approval or a package.

## 6. External verification, then independent review

The deterministic `step` executes configured prerequisite/static/runtime checks and records real results and source/dependency fingerprints for the selected profile. Read logs/evidence from the returned job or `apphx events JOB_ID --config /absolute/control/factory.json`. Compilation-only success is not runtime acceptance; web-only tests are not native acceptance for Expo/uni-app. Never synthesize receipts or claim unavailable iOS/Android execution passed. Fix actual failures through stopped-task/retry, not direct stage edits. Changing commands, execution environment, toolchain, packaging provider/commands/output or package target invalidates prior proof and requires renewed verification/review; retry preserves budgets and publication permissions. Uncertain cloud packaging runs require reconciliation, not replay.

When `next` returns a **review** turn, use a **fresh native reviewer context** that did not implement the change. Give it the exact review prompt, requirement, workspace and external evidence. Have it independently inspect every acceptance scenario, code and real evidence, with **no source/dependency/screenshot edits**. Evidence-producing commands that mutate the verified source invalidate approval. An implementation agent's second self-review is not independent.

Use the host's native subagent/reviewer facility if present. If unavailable (including stock Pi), pause and ask the user to open a separate fresh host session for review, supply the job id/config/active turn, and return its JSON verdict. Do not launch another coding-agent process or claim independence that did not occur. The separate reviewer may complete the current token itself, or return the result to the controlling session; exactly one session completes it.

Use [review-result.json](resources/review-result.json) for the strict shape: `approved` boolean, `findings` array, and `acceptanceEvidence` array. Every frozen acceptance string must appear **exactly** as `requirement`, with nonempty concrete `evidence` identifying files/symbols and observed commands/scenarios. Approve only if all acceptance criteria are supported and there are no blocking findings. The example is deliberately a rejection, not reusable evidence. Save the verdict outside the app workspace:

```sh
apphx complete JOB_ID TURN_ID /absolute/control/results/JOB_ID-review.json --config /absolute/control/factory.json --build-only
apphx next JOB_ID --config /absolute/control/factory.json --build-only
```

apphx rejects incomplete evidence, rejected verdicts and changed fingerprints. It cannot prove which model/person authored a verdict; accurately report the review method and limitations.

## 7. Package locally and hand off

Run the returned package `step` once with `--build-only`, then inspect `status`/`next`. Output is the selected local simulator `.app`, signed `.ipa`, `.apk` or `.aab`. The configured packager must produce a fresh nonempty artifact at its exact generated-output path without changing verified source/dependencies. No arbitrary artifact glob or stale file is evidence. Report only recorded paths/digests, exercised checks and remaining environment limitations. These bundled command profiles have not been built or runtime-tested merely by being included here; owner adaptation and actual task evidence are required.

`packaging.provider: "cloud"` additionally requires explicit owner-approved `allowCloudBuild: true`; defaults remain local. Cloud commands can create remote work, so never enable them implicitly or blindly replay an uncertain run. Preserve the owner's existing build service/profile.

For an explicitly permitted cloud packaging provider, doctor validates the requirement/config and imported project profile but relies on owner-configured prerequisites rather than adding local SDK probes. This does not waive the task's required real runtime acceptance commands.

Do not call `authorize`, upload with other tools, enable `allowSubmit`/`allowRelease`, or run publication/monitoring on the strength of this skill. Automated publication is separately guarded to **App Store+iOS+IPA**, regardless of framework; it requires explicit owner permission, honest metadata, account/signing prerequisites and existing receipts/reconciliation gates. Local and Google Play jobs cannot be authorized for Apple upload. Local packaging is not store submission, approval, TestFlight availability or release. This workflow ends at the recorded artifact or an accurately reported blocker.
