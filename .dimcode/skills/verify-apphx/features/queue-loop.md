# 队列主循环

## Sub-features

`init`（生成 factory.json）、`enqueue`（冻结需求入队）、`next`（取 host/step/wait/done 动作）、`complete`（host 轮收尾）、`status`/`events`（持久化状态）、`abandon`（放弃轮次）。

## How to get to it (user POV)

在控制项目目录写 `factory.json`（init 生成）与 `requirement.json`（冻结验收），然后 `apphx enqueue requirement.json --config factory.json --build-only` 得到 JOB_ID；之后的一切由 `apphx next JOB_ID` 驱动。

## Driving it with exec + apphx

```sh
cd "$RUN_ROOT"
apphx init --framework swift --platform ios --package-target simulator --autopilot --config factory.json
apphx enqueue requirement.json --config factory.json --build-only   # -> JOB_ID
apphx next "$JOB_ID" --config factory.json --build-only            # action: host, stage: research
apphx complete "$JOB_ID" "$TURN_ID" research.json --config factory.json --build-only
apphx next "$JOB_ID" --config factory.json --build-only            # action: host, stage: build
apphx complete "$JOB_ID" "$TURN_ID" --config factory.json --build-only
```

## Gotchas

- `init` 拒绝覆盖已有 factory.json；`--autopilot` 会同时写入 `allowLocalExecution: true` 与 `autopilot: true`。
- 同一产品 id+平台+渠道+版本重复入队会被拒：需求未改时是 “is already queued; retry its task or use a new product version”，需求被改写时是 “submit a new version instead of editing its task”。终态作业续跑有两条互斥路径：`baseJobId`（从前任作业工作区导入已验证源码，iOS App Store 场景可自动选最近完成前任）或 `project.sourceDir`（从外部目录导入），二者不能同时用；版本号由 owner 提交（身份字段，不自动递增）。
- `next` 返回 `wait` 表示有到期时间或阻塞，按 status 的 nextAt 等，不要在循环里忙轮询。
- `complete` 的 verdict 必须逐字覆盖全部冻结验收；评审证据变了会拒绝交接。
