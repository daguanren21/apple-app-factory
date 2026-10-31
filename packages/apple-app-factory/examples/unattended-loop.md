# 无人值守接线手册（harness + loop）

loopx 的循环模型：控制面编译每轮 packet、**runner 拥有 wake**、每次回写后重算
`continue | wait | ask | replan | repair | terminal`。apphx 的对应物：

| loopx 概念 | apphx 实现 |
| --- | --- |
| CLI packet（每轮重读） | `apphx drive` 返回的 `{action, job, turn, nextDueAt, summary, failed, intake}` |
| frontier ingestion | drive 每轮先扫 `inbox`，`submit` 的需求自动入队 |
| continue/wait | `action: host/step/wait` + `nextDueAt`（下次唤醒时间） |
| ask | `needs-owner`（跳过继续，终局报告列出，`retry` 恢复） |
| repair | 预算内自动修复回 build（autopilot 契约） |
| terminal audit | `action: done` + `summary`（built/failed/needsOwner 计数） |
| quota / evidence | maxAttempts/maxHostTurns/maxJobHours + 摘要门禁 |
| re-entry body | 下面的固定唤醒指令（不含任何任务状态） |

## 固定 re-entry 指令（所有宿主通用）

> 在控制项目目录运行 `apphx drive --once --config factory.json --build-only`。
> `action: host` → 按 turn.role 完成该回合（autopilot：绝不向用户提问），然后
> `apphx complete <id> <turn> [result]`，再跑一次 drive --once。
> `action: step` → 继续跑 drive --once（确定性阶段自动执行）。
> `action: wait` → 读 `nextDueAt`，安排在那个时间再唤醒，然后结束本次会话。
> `action: done` → 对每个 built 任务跑 `apphx report <id> --out results --collect`，
> 跑 `apphx notify --any`，汇报 summary（含 needs-owner 清单），结束。
> 不要在指令里写入任何 job id、prompt 或结论——每轮 packet 由 drive 重新给出。

## 各宿主 wake 接线

**Hermes（推荐，文档化路径）**：`apphx install hermes --global`；用 hermes cron
按上面的 re-entry 指令定时唤醒（cron 必须附加 skill 与绝对 workdir，见 Hermes
调度文档）。间隔建议 ≥ `pollMs`；`wait` 返回的 `nextDueAt` 优先于固定间隔。

**DimAgent**：长开桌面会话 + `schedule_wakeup`（会话级定时，最长 24h，最多 3 个
待唤醒）。每次唤醒注入固定 re-entry 指令；`wait.nextDueAt` 超过 24h 时先排一个
24h 的唤醒接力。宿主应用重启后需人工重开会话。

**Codex / Claude Code / 任意宿主 + 系统 cron**：cron/launchd 定时启动宿主的
headless 会话（如 `codex exec` / `claude -p`）注入固定 re-entry 指令；或最简做法——
cron 只跑 `apphx drive --once` 并把 JSON 输出投给宿主处理。注意：确定性阶段可以
无宿主执行，但 `action: host` 必须由宿主会话完成，纯 CLI cron 推不完整循环。

**无子代理宿主（stock Pi / Gemini）**：不满足 autopilot 独立评审，按 skill 规定
诚实降级为非 autopilot 流程（人工开评审会话），不要无人值守跑。

## 防中断要点（已在 main 落地）

- 可修复障碍（lint/verify/review 失败）→ autopilot 契约要求修复迭代，不许提问；
- 预算耗尽/研究拒绝 → `needs-owner` 跳过继续，不阻塞队列；
- 崩溃/会话中断 → SQLite 持久化 + turn token 恢复，下次唤醒续跑同一任务；
- 唯一允许的停止：安全红线（泄露凭据/伪造证据/绕过验收），以诚实结论报告。
