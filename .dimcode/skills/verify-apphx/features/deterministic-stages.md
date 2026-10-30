# 确定性阶段 + 交付

## Sub-features

`step`（obfuscate/verify/package 确定性执行）、验证证据（build-for-testing + 真实运行时验收 + 截图 digest）、`built` 产物记录（kind/path/digest）、`report`（JSON/MD checklist + `--collect` 源码副本与产物）。

## How to get to it (user POV)

build 轮完成后，队列自动进入 obfuscate → verify → review → package；agent 对 `action:"step"` 每次执行一次 `apphx step JOB_ID`。全部通过后 `apphx report JOB_ID --out results --collect` 拿交付物。

## Driving it with exec + apphx

```sh
IOS_DEVICE_ID=<已启动模拟器 UDID> apphx step "$JOB_ID" --config factory.json --build-only   # 每阶段一次
apphx status "$JOB_ID" --config factory.json --build-only                                  # 期望 status: built
apphx report "$JOB_ID" --out results --collect --config factory.json --build-only
```

## Gotchas

- verify 的 `runtime` 若包含 UI 测试，`IOS_DEVICE_ID` 必须在环境里；模拟器冲突（多会话共用同一 UDID）会 BUILD INTERRUPTED，一次只跑一个队列。
- verify 通过后不要再动源码或 `build/screenshots`，否则证据 digest 失效、评审交接被拒（需走 build 修复轮重新 verify）。
- `step` 失败会打回 build 等待修复轮；`retry` 对终态 failed 拒绝，此时按 queue-loop 的「新版本重入队」续跑。
- 每个阶段默认尝试预算 8（`maxAttempts`），AI 修复循环下通常足够。
