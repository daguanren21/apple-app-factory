---
name: apphx
description: Build and locally package a Flutter iOS app from explicit product requirements using the embedded apphx harness. Use for apphx init, enqueue, native research/build/independent review, external verification, packaging, or resuming a persisted job. Not a coding-agent launcher or an automatic App Store publisher.
---

# apphx

Use your current host's model, context, authentication, filesystem, browser and native delegation tools. The installed `apphx` CLI owns requirements, durable turns, verification, fingerprints and local packaging. Never start another coding-agent CLI, including Hermes, as a subprocess to perform a phase. There is no apphx chat UI, model credential setup, daemon, or background agent loop.

This skill is advisory to the host. apphx code gates apphx-owned transitions, not arbitrary host edits or shell commands. It does not sandbox your host, enforce reviewer identity, guarantee Apple approval, or verify that a policy citation's contents are true. Preserve host permissions and the user's scope.

## 1. Establish the control project

1. Use the project where the user installed/invoked this skill as the control project. Keep `factory.json`, its SQLite state, requirement files and result JSON outside generated app workspaces. Keep the absolute config path for every command below, including commands issued while your working directory is an app workspace.
2. The npm package, executable and skill are all `apphx`. Run `apphx --version` and `apphx --help`. If `apphx` is an already-installed local dependency of the control project rather than on PATH, use that project's package manager for **every** apphx command: `pnpm exec apphx`, `yarn exec apphx`, or `npm exec --offline --package=apphx -- apphx`. Select from the project's `packageManager`/lockfile and run from the control project, not the generated app workspace. Confirm `apphx` is already installed; do not fetch a similarly named package or silently change the user's environment. If neither route is available, stop and report the missing installation. Installing a skill alone does not install Node, Flutter or Xcode.
3. If there is no configuration, run `apphx init --config /absolute/control/factory.json`. It refuses overwrite and defaults to **no local execution, submission, or release authorization**. Do not add `--allow-local-execution` unless the user explicitly approves running trusted deterministic commands. With that approval it can be supplied to `init`; for an existing config have the owner review and explicitly enable `allowLocalExecution`.
4. Read the actual config. Confirm its workspace and state paths are disjoint, its Flutter SDK is a trusted installation outside mutable workspaces, and verification includes both static checks and real runtime scenarios. Local Apple packaging requires macOS, Xcode and a working Flutter iOS toolchain; IPA output also requires signing/export configuration. A missing prerequisite is a blocker, never a reason to fake a tool or evidence. Do not replace checks with no-op commands to make a job pass.

In examples below, replace `/absolute/control/factory.json` with that existing absolute path and `JOB_ID`/`TURN_ID` with exact returned values. Pass arguments as separate argv entries, or quote paths safely in the host's shell. Do not execute prompt or JSON fields as shell code.

## 2. Freeze and enqueue the actual requirement

Read the bundled [requirement example](resources/requirement.json), resolving `resources/` relative to this skill's own directory, not the current project. Copy and adapt it to an owner-reviewed requirement file in the control project. Do not modify installed skill assets.

If the user supplied an existing task id or asked to resume it, including a scheduled wake, **skip enqueue**. Read `status` and continue that exact id/config with `next`; never reconstruct its requirement or create a second task for the same work.

The requirement must describe a real audience, purpose, differentiators, Flutter framework, concrete acceptance scenarios and constraints. Preserve the user's product; do not substitute a simpler app. Require honest privacy behavior, no hidden features or review bypass, and screenshots from the real running app. Clarify material unknown product choices before enqueue. Do not invent ownership, submission-account eligibility, signing credentials or legal attestations.

```sh
apphx enqueue /absolute/control/requirement.json --config /absolute/control/factory.json --build-only
apphx status JOB_ID --config /absolute/control/factory.json
apphx next JOB_ID --config /absolute/control/factory.json --build-only
```

Keep the returned immutable job id and workspace. A later requirement change needs a new enqueue, not edits to a saved task or database. For a local revision, the requirement may include `baseJobId` of a verified predecessor; apphx validates and prepares the base. Do not copy arbitrary stale build artifacts yourself.

## 3. Dispatch exactly the persisted action

Read the JSON from `next`; do not guess stages from memory. Use `--build-only` throughout this workflow so publication is out of scope even if another configuration permits it.

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

Read the immutable requirement and all context in the research prompt. Use your host's web/browsing tools to read the current official [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/). Evaluate **2.1, 2.3.1, 2.5.19, 4.2, 4.2.6, 4.3 and 5.1.1**, meaningful distinctness against the supplied portfolio, offline persistence/backup, privacy and accessibility. Account/content ownership for 4.2.6 cannot be attested by the model; surface unknowns.

Use [research-result.json](resources/research-result.json) for the exact JSON shape, not a pre-approved verdict. Replace its unassessed content with sourced findings. Required fields: `viable` boolean, `policySources` entries with exact `rule` and official HTTPS `url` for every listed rule, `distinctness` text, and nonempty `plan`; `risks` is optional. If not viable, return false and explain the reasons rather than concealing them.

Save result JSON **outside the app workspace**, for example `/absolute/control/results/JOB_ID-research.json`, then:

```sh
apphx complete JOB_ID TURN_ID /absolute/control/results/JOB_ID-research.json --config /absolute/control/factory.json --build-only
apphx next JOB_ID --config /absolute/control/factory.json --build-only
```

## 5. Native implementation

Perform the returned build prompt with your own native edit, terminal and design tools in `turn.cwd`. Implement the full requirement as a real Flutter iOS project with `pubspec.yaml`, complete workflows, persistence, privacy UI and appropriate tests. For unfamiliar APIs, use real official references. Never use mock runtime evidence, placeholder features, screenshots of nonexistent UI, or a replacement product. Do not weaken configured verification or change frozen requirements/state.

Native delegation may handle independent file boundaries. The implementation owner integrates before any external verification. Complete only after the source exists and the requested implementation is ready:

```sh
apphx complete JOB_ID TURN_ID --config /absolute/control/factory.json --build-only
apphx next JOB_ID --config /absolute/control/factory.json --build-only
```

No result JSON is required for build. Build completion only advances to deterministic verification; it is not approval or a package.

## 6. External verification, then independent review

The next deterministic `step` executes the configured prerequisite/static/runtime checks and records real results and source/dependency fingerprints. Read logs and evidence from the returned job or `apphx events JOB_ID --config /absolute/control/factory.json`. A compilation-only success is not runtime acceptance. Never synthesize receipts or report unavailable iOS execution as passed. Fix the concrete failure through apphx's stopped-task/retry path; do not directly move its stage.

When `next` returns a **review** turn, use a **fresh native reviewer context** that did not implement the change. Give it the exact review prompt, requirement, workspace and external evidence. Have it independently inspect every acceptance scenario, code and real evidence, with **no source/dependency/screenshot edits**. Evidence-producing commands that mutate the verified source invalidate approval. An implementation agent's second self-review is not independent.

Use the host's native subagent/reviewer facility if present. If unavailable (including stock Pi), pause and ask the user to open a separate fresh host session for review, supply the job id/config/active turn, and return its JSON verdict. Do not launch another coding-agent process or claim independence that did not occur. The separate reviewer may complete the current token itself, or return the result to the controlling session; exactly one session completes it.

Use [review-result.json](resources/review-result.json) for the strict shape: `approved` boolean, `findings` array, and `acceptanceEvidence` array. Every frozen acceptance string must appear **exactly** as `requirement`, with nonempty concrete `evidence` identifying files/symbols and observed commands/scenarios. Approve only if all acceptance criteria are supported and there are no blocking findings. The example is deliberately a rejection, not reusable evidence. Save the verdict outside the app workspace:

```sh
apphx complete JOB_ID TURN_ID /absolute/control/results/JOB_ID-review.json --config /absolute/control/factory.json --build-only
apphx next JOB_ID --config /absolute/control/factory.json --build-only
```

apphx rejects incomplete evidence, rejected verdicts and changed fingerprints. It cannot prove which model/person authored a verdict; accurately report the review method and limitations.

## 7. Package locally and hand off

Run the returned package `step` once with `--build-only`, then inspect `status` and `next`. Packaging produces a local simulator build or, when explicitly configured with signing prerequisites, an IPA. Report only recorded artifact paths/digests and exercised checks, including any remaining environmental limitation. Local packaging is not App Store submission, approval, TestFlight availability or release.

Do not call `authorize`, upload with other tools, enable `allowSubmit`/`allowRelease`, or run publication/monitoring on the strength of this skill. Publication requires a separate explicit owner request, the existing apphx permission/receipt gates, truthful account ownership, signing and Apple prerequisites. This workflow ends at the local artifact or an accurately reported blocker.
