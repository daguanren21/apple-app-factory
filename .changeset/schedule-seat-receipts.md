---
"apphx": minor
---

新增 `apphx schedule --host <id> [--format launchd|systemd|cron]`：生成 OS 级唤醒模板（launchd KeepAlive / systemd Restart=on-failure 崩溃自动拉起宿主会话，cron 兜底），内嵌固定 re-entry 提示词，只打印不安装。模板按 XML、systemd 和 cron/shell 语法转义路径及提示词；cron 使用 `flock -n` 防止同一状态目录与宿主的会话重叠。队列领取在锁内跳过活跃宿主进程持有的回合，原宿主退出后可续领且不重复扣预算。新增可选席位回执门禁 `roles.receipt`：按领取事务保存的 decision 索引只接受领取后追加的回执，同名席位分别计数；旧活跃 review 回合缺少索引时须 abandon 后重新领取。
