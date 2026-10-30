# 无人值守（autopilot / 卡点自愈 / 免确认授权）

## Sub-features

`--autopilot` 一次预授权（init 时写入 autopilot:true + allowLocalExecution:true，授权主体是 owner 而非运行时 decision-maker）、AUTOPILOT 轮次指令（不提问/决策者/失败派工/全新上下文评审/卡点自愈/终态重入队）、ui-designer 双模式（designRef 忠实还原 / 无稿按内置指南产 ui-design.md）。

## How to get to it (user POV)

`apphx init --autopilot …` 后，宿主 agent 描述需求即可全自动跑完整条流水线；过程中不需要任何用户输入。

## Driving it with exec + apphx

```sh
apphx init --framework swift --platform ios --package-target simulator --autopilot --config factory.json
python3 - <<'EOF'
import json; d=json.load(open('factory.json'))
assert d['autopilot'] is True and d['allowLocalExecution'] is True
EOF
apphx enqueue requirement.json --config factory.json --build-only
apphx next "$JOB_ID" --config factory.json --build-only   # turn.prompt 含 "AUTOPILOT MODE" 与 "Stuck states are host work"
```

## Gotchas

- autopilot 只在 `factory.json` 显式 `"autopilot": true` 时生效；非 autopilot 任务行为不变。
- autopilot 不是绕过验收的许可：诚实降级、不伪造证据、安全红线仍强制。
- 评审必须用未实现过该改动的全新上下文；无原生 subagent 的宿主应诚实降级回非 autopilot，不得自评冒充。
- `maxAttempts`（默认 8）与 `maxHostTurns`（默认 16）耗尽仍会终态，此时走「新版本重入队」自愈，而不是问用户。
