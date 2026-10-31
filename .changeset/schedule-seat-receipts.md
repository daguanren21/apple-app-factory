---
"apphx": minor
---

新增 `apphx schedule --host <id> [--format launchd|systemd|cron]`：生成 OS 级唤醒模板（launchd KeepAlive / systemd Restart=on-failure 崩溃自动拉起宿主会话，cron 兜底），内嵌固定 re-entry 提示词，只打印不安装。新增可选席位回执门禁 `roles.receipt`：开启后 review 完成要求本回合内每个评审席位都有 `apphx decide` 回执（role + rationale，防陈旧时间戳），缺席位拒绝完成。
