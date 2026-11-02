# 确定性阶段 + 交付

## Sub-features

`step`（obfuscate/verify/package 确定性执行）、验证证据（owner 配置的静态/runtime 命令和截图 digest）、`built` 产物记录（kind/path/digest）、`report`（JSON/MD checklist、live source/execution 路径及 --collect 次级源码快照）。

## How to get to it (user POV)

build 完成后进入 verify（配置了 obfuscation 时先生成/处理执行副本）→ review → package。按实际 action 推进；全部通过后运行 `apphx report JOB_ID --collect`，从 delivery.sourcePath 获取下一轮继续开发的源码目录，不把内部 UUID 副本当主项目。

## Driving it with exec + apphx

```sh
IOS_DEVICE_ID=<已启动模拟器 UDID> apphx step "$JOB_ID" --config factory.json --build-only   # 每阶段一次
apphx status "$JOB_ID" --config factory.json --build-only                                  # 期望 status: built
apphx report "$JOB_ID" --collect --config factory.json --build-only
```

## Gotchas

- harness 不注入 `IOS_DEVICE_ID`；若配置的 runtime 命令需要它（如 UI 测试），调用 `step` 时必须在环境里提供；模拟器冲突（多会话共用同一 UDID）会 BUILD INTERRUPTED，一次只跑一个队列。
- verify 通过后不要再动源码或 `build/screenshots`，否则证据 digest 失效、评审交接被拒（需走 build 修复轮重新 verify）。
- 动态工作流的普通本地失败返回携带证据的 build 修复计划；旧静态任务按其记录的阶段/恢复原因处理。权限、工具链、未知副作用和预算耗尽保持停止，只有 owner 明确恢复后才 retry；不得通过新版本/baseJobId 重入队重置同一任务的预算。
- 每个阶段默认尝试预算 8（`maxAttempts`），AI 修复循环下通常足够。
