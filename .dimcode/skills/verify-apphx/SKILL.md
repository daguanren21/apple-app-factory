---
name: verify-apphx
description: "Drive the apphx harness CLI the way an agent host does: fresh control project, requirement enqueue, host turns, deterministic verify/package stages and the report handoff. Use whenever the apphx repo or its installed skill changes and needs scripted proof, or when an apphx job misbehaves and needs a clean-room reproduction."
---

# verify-apphx

Project-local verification skill for **apphx** (packages/apple-app-factory in this repo). The surface a user touches is the `apphx` CLI and the apphx SKILL agents read; the loop it drives is 研究→构建→混淆→验证→评审→打包 plus `apphx report`. These instructions are read cold by an agent that has never seen the tool.

## Launch

Each verification run gets its own control project. Never drive the real control projects (`~/code/open-source/apple-app-factory`, `~/dim-agent/apphx-control`).

```sh
export RUN_ROOT=$(mktemp -d /tmp/verify-apphx-XXXX)
export APPHX_CONFIG="$RUN_ROOT/factory.json"
cd /Users/liyanchao/code/open-source/apple-app-factory   # repo checkout; CLI comes from the repo build
corepack pnpm --filter apphx build                       # dist used by tests; CLI may be run via node dist/cli.js
apphx init --framework swift --platform ios --package-target simulator --autopilot --config "$APPHX_CONFIG"
```

- Ready means: `apphx --version` prints 2.3.0+, `apphx doctor --host dimagent` reports every skill `installed`, and `node -v` satisfies `^22.23.4 || ^24.22.1 || >=26.12.1`.
- Teardown: `rm -rf "$RUN_ROOT"` plus any job dirs it created. Evidence (a `PROOF.md` and JSON outputs) must be copied out of `$RUN_ROOT` to `results/verify-apphx-<timestamp>/` **before** teardown; cleanup must not delete evidence.

## Doctor

One read-only check before driving anything:

```sh
apphx --version
apphx doctor --host dimagent            # all skills: installed
node -v                                 # engines range above
apphx status                            # lists task IDs; verify no active task is claimed by this run
```

If any check fails, fix the environment (reinstall skill, switch node) or report precisely; do not drive further.

## Drive

All interaction is the CLI itself; no browser, no simulator UI needed for the baseline features. `--build-only` on every mutating call. For a full end-to-end job use an existing verified requirement template (`requirements/ai-studio-ios.json` as shape reference) and the frozen command profile from `factory.json`; deterministic stages run with the simulator env: `IOS_DEVICE_ID=<booted UDID> apphx step JOB_ID --config factory.json --build-only`.

Host turns are driven exactly like a host agent: `apphx next JOB_ID` → for `action:"host"` perform the turn in `turn.cwd`, then `apphx complete JOB_ID TURN_ID [verdict.json]`; for `action:"step"` run `apphx step JOB_ID` once; for `action:"done"`/`"wait"` read status and report. Never skip a stage, never edit `.factory/` SQLite, never re-enqueue the same work while a task is live.

## Evidence

Capture into `results/verify-apphx-<timestamp>/`: the stdout JSON of every `status/next/complete/step/report` call (saved as files), the generated `factory.json`, and the final `apphx report JOB_ID --out <dir> --collect` output (report JSON/MD + source/ + artifact). Proof standards:

- Exercise real CLI paths only; no direct SQLite writes, no hand-crafted state.
- Record both the command and its resulting state (job JSON before/after).
- A passed verification = every stage's returned JSON matches the expected stage/status chain (`queued→running→…→built`) and the report checklist has zero `uncovered` for a finished job.
- Rate-limited/flaky external generation is out of scope for the baseline features; for jobs that exercise real UI acceptance, the job's own verify logs are the evidence.

## Cleanup

```sh
# evidence already copied out; then:
rm -rf "$RUN_ROOT"
```

Kill nothing by name; every run uses its own temp root and its own stateDir inside it. If a `step` was started, wait for it to finish or abandon the turn (`apphx abandon JOB_ID TURN_ID --config … --build-only`) before deleting the root.

## Helpers

No helper scripts ship with this skill; every step above is a direct CLI invocation. `PROOF.md` in the evidence dir is written by hand from the saved JSON outputs and must quote the exact commands that produced them.
