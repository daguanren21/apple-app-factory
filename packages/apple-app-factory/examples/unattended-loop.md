# 无人值守接线手册（harness + loop）

loopx 的循环模型：控制面编译每轮 packet、**runner 拥有 wake**、每次回写后重算
`continue | wait | ask | replan | repair | terminal`。apphx 的对应物：

| loopx 概念 | apphx 实现 |
| --- | --- |
| CLI packet（每轮重读） | `apphx drive` 返回的 `{action, job, turn, nextDueAt, summary, failed, intake}` |
| frontier ingestion | drive 每轮先扫 `inbox`，`submit` 的需求自动入队 |
| continue/wait | `action: host/step/wait` + `nextDueAt`（下次唤醒时间） |
| ask | `needs-owner`（跳过继续，报告准确前提；仅 owner 明确恢复后 `retry`，历史/预算不重置） |
| repair | 普通动态本地检查/混淆/打包失败携带证据回 build planner，模型在现有预算内诊断修复 |
| terminal audit | `action: done` + `summary`（built/failed/needsOwner 计数） |
| quota / evidence | maxAttempts/maxHostTurns/maxJobHours + 摘要门禁 |
| re-entry body | 下面的固定唤醒指令（不含任何任务状态） |

## 固定 re-entry 指令（所有宿主通用）

> 在控制项目目录运行 `apphx drive --once --config factory.json --build-only`。
> `action: host` → 先读 `turn.kind`：plan 由模型生成严格 JSON DAG，node 只执行已领取节点；旧配置无 kind 时按原阶段协议处理。
> 用 `apphx complete <id> <turn> result.json` 完成唯一 token，再 drive；仅在依赖和读写范围独立、且有宿主容量时领取其他节点。
> `action: step` → 继续跑 drive --once（确定性阶段自动执行）。
> `action: wait` → 若本会话仍有 worker，先收集并 complete 后再 drive；只有没有 owned work 时才按 `nextDueAt` 安排唤醒并结束会话。
> `action: done` → 对每个 built 任务跑 `apphx report <id> --out results --collect`，
> 跑 `apphx notify --any`，汇报 summary（含 needs-owner 清单），结束。
> 不要在指令里写入任何 job id、prompt 或结论——每轮 packet 由 drive 重新给出。

## 持久宿主所有权：不要把短命 CLI/包管理器当 controller

`next`/`drive` 支持 `--host-pid <positive-pid>`，也可在持久 native controller 启动包装命令前继承 `APPHX_HOST_PID`；显式 flag 优先。这个 PID 必须是当前 CLI 的真实存活祖先，并覆盖全部已委派 worker 的生命周期。不要填 CLI 自己、pnpm/npm 子进程、另一个会话或 PID 1，也不要复用上一次会话的 PID。runner 在 claim/adopt 时重新读取并保存进程 incarnation，而不只记 PID。

直接调用 CLI 默认使用稳定父进程；只有被实际进程信息识别的 pnpm/npm/npx/yarn exec 链才会自动跳过。未知 launcher、脚本、一轮即退的 shell 或不可读信息会拒绝并提示 `--host-pid`，不会任意向上走到 PID 1。macOS `ps` 无法恢复原始 argv：Node 包装器须有与真实 executable/command 前缀匹配的 `npm_execpath`，否则需显式宿主 PID。独立运行的 `pnpm exec` 可能没有该元数据；不要伪造它。

让 native controller 通过自己的进程 API 传入实际 PID。只有控制 shell 本身持续存活时，下面的接线才正确：

```sh
# 在持久控制 shell 中设置一次；不能在一次性 tool shell 中取 $$。
export APPHX_HOST_PID=$$
pnpm exec apphx drive --once --config /absolute/control/factory.json --build-only
```

或者每次 `next`/`drive` 都传同一个实际祖先 `--host-pid`。Linux identity 来自 boot/start time；macOS boot/start stamp 为秒级，同秒内不可区分的 PID 重用会保守地按仍存活处理，不能借此抢占。身份不可读不是 owner 已死的证据。这不是跨租户权限认证，也不能证明 reviewer/provider 身份。

## 各宿主 wake 接线

**Hermes（推荐，文档化路径）**：`apphx install hermes --global`；用 hermes cron
按上面的 re-entry 指令定时唤醒（cron 必须附加 skill 与绝对 workdir，见 Hermes
调度文档）。间隔建议 ≥ `pollMs`；`wait` 返回的 `nextDueAt` 优先于固定间隔。

**DimAgent**：长开桌面会话 + `schedule_wakeup`（会话级定时，最长 24h，最多 3 个
待唤醒）。每次唤醒注入固定 re-entry 指令；`wait.nextDueAt` 超过 24h 时先排一个
24h 的唤醒接力。宿主应用重启后需人工重开会话。

**Codex / Claude Code / 任意宿主 + 系统调度**：用 `apphx schedule --host <id>`
生成模板，替换为实际前台 headless 命令（如 `codex exec` / `claude -p`）并注入固定 re-entry 指令。
调度器必须启动持续存活的宿主会话，由它调用 `drive`、处理 `action: host` 并 `complete`，直到 `wait`/`done` 后退出。
不能只定时执行一次 `drive --once`，再把 JSON 移交另一个会话：显式或自动识别的 controller 必须在其 native worker 执行期间一直存活。包管理器退出后，不应因此把仍归持久 controller 的 token 续领或重派。
cron 模板还要求其 `PATH` 中有兼容的 `flock -n <file> <command>`；headless 命令保持前台，使锁覆盖整个宿主会话，而非只覆盖一次 CLI 调用。

**无独立上下文能力的宿主**：不能用自审满足 autopilot 独立评审。报告缺少 fresh 非实现者会话并 defer 该任务，继续其他合格工作；等待实际独立会话可用，不要静默关掉 autopilot、覆盖 provider pins 或伪造身份。

## 中断、修复与停止边界

- 普通动态本地 verify/obfuscate/package 失败 → 保留命令错误证据并回 build planning，由已领取节点诊断修复；保留独立成功工作，不能盲重试、退回消耗的 attempts 或跳过新 verify/review。
- 每个完成实际检查的动态 review 节点（`outcome: passed`）的 `result` 都是 `{approved, findings, acceptanceEvidence}`。检查发现阻断问题也用 `passed` 加 `approved:false`/findings，表示检查已完成，不是产品已通过。专家可仅覆盖部分产品验收或返回空 `acceptanceEvidence`，但须证明其全部 node acceptance。final 覆盖所有不可变产品验收；Harness 聚合当前 proof-bound 节点，任一拒绝或 finding 都否决。要消除旧 finding，必须 invalidate 后 fresh review。`failed` 只表示执行未完成，携带实际失败/可用证据并回 planning，不为未发生的检查编造 verdict，也不能越过 final gate。
- 权限、SDK/凭证等真实前提缺失、独立评审不可用、预算/绝对期限耗尽、取消或研究拒绝 → 按状态停止该任务并报告准确恢复条件，继续其他 eligible jobs。**安全红线不是唯一可停止的原因**；不承诺任意需求都能在缺少外部事实时完成。
- 不用同产品新版本/替换任务重置预算，不自动加大 timeout/maxHostTurns/maxAttempts/maxJobHours，不改变 permissions 或 acceptance。确实变更产品需求的新任务须由 owner 授权，不能充当修复逃生通道。
- SIGINT/SIGTERM 中断 `drive`/`step` 时，Harness 终止并 drain 自己跟踪的命令组后才释放 worker 锁；`drive` 不再领取后续工作。宿主 native tools/agents 不属于该进程组，controller 必须自己停止并收集；不能把 CLI 退出当作所有 worker 已停。
- 崩溃恢复先读 SQLite 持久化的 claim、incarnation、结果和事件。不要重派活动 token 或拿走另一个存活 controller 的工作；手工进程所有权不确定、云端执行结果不确定时维持 fail-closed，先按真实事实协调恢复，绝不盲重放或报告假成功。
