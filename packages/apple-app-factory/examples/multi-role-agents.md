# Legacy 静态配置的多角色示例（apphx 宿主式）

**适用范围：仅未启用 `workflow`、且 `turn.kind` 不存在的旧静态回合。** 本文固定角色表与单 token 聚合方式不是新任务的默认架构，也不能覆盖 dynamic planner/node packet。

apphx 不启动自己的 coding agent；角色由持久**宿主 controller**通过原生工具执行。动态模式中，模型根据真实需求、依赖与资源范围生成 DAG；控制面校验并调度已批准图，持久化每个节点的独立 token、证据和预算。`roles.<stage>` 只是 owner 的最低席位约束（包括重复席位及 provider/fresh pins），不是固定团队或执行顺序。完整动态协议见 [apphx skill](../skills/apphx/SKILL.md)。

## 1. Legacy 角色 ↔ 流水线示例

| 角色 | 流水线位置 | 职责 | 输出 / 关卡 |
| --- | --- | --- | --- |
| 产品 / 需求分析 agent | `research` 回合（宿主） | 需求整理、可行性、诚实差异化、隐私、实施计划 | 类型化 research 结论（viable/distinctness/plan） |
| 架构设计 agents ×N | `build` 回合第一步 | N 份独立方案 → 互相 critique → 合成决定 | 工作区内 `docs/architecture.md` |
| 开发 agents ×N | `build` 回合 | 按合成设计并行实现模块切片 | 源码 |
| 测试 agent | `build`（编写测试）+ `verify`（确定性执行） | 测试编写；checks + 设备真实验收 | 验证通过 + 源码/依赖摘要前后一致 |
| 架构师 review | `review` 回合 | 对照设计文档审查实现与模块边界 | findings（可阻断） |
| 质量工程师 agent | `review` 回合 | 空态/错误态、可访问性、边界、质量 | findings（可阻断） |
| 验收 agent | `review` 回合（逐条验收证据） | 每条 acceptance 的具体观察；产物另由确定性 package gate 校验 | typed review；不是 agent 自称产物可交付 |
| 队列控制面 | 无单独模型回合 | 资格、排序、预算、证据与终局审计 | 持久化状态和事件；领域诊断由实际 host work 完成 |
| 补充角色（自由命名） | 受阶段协议约束的宿主回合 | owner 在 enqueue 前配置 `roles` | 静态 role 数组；动态则要求独立匹配节点 |

`roles` 配置示例（factory.json，可选；不是必须采用的团队）：

```jsonc
{ "roles": {
    "research": ["product-analyst", "requirement-groomer"],
    "build": ["developer", "security-aware-developer"],
    "review": ["architect-review", "qa-engineer", "acceptance-reviewer", "performance-analyst"]
} }
```

静态 `next` 负载带 `turn.role` 数组，宿主按提示中实际依赖采用角色。静态默认是 research `product-analyst`、build `ui-designer/developer`、review `architect-review/qa-engineer/acceptance-reviewer`；上表额外设计/测试角色是示意，不是控制面另设的回合。

## 2. 区分模型派工与确定性队列选择

动态 DAG 的任务分解、角色、依赖和修订由模型提出；不能把队列排序称为“无需模型的工作架构设计”。控制面负责拒绝不合格图与冲突 claim，并在可执行工作中确定性选择。`apphx next --any` 的队列顺序：

1. **priority 泳道**：P0 → P1 → P2（同泳道才比较到期时间）；
2. **到期时间**：`nextAt` 最早的先做；
3. **入队序**：稳定排序兜底；
4. **资格过滤**：过期、预算耗尽、被另一 worker 持有或命令组恢复中的工作不能领取。动态模式还受依赖、实际读写资源冲突、maxParallel 和活动节点 token 约束；一个任务可有多个不冲突节点，但活动 token 不重派。

候选选择和持久化 claim 是不同动作；claim 由事务建立所有权。动态 planner 消耗真实 turn，其计划还须为后续必需 checkpoint 留出最低预算。重规划不退回 attempts；移除的节点 ID 不能从历史复活来清空消耗。不能为保持循环而自动加预算、替换任务或弱化验收。

## 3. 模型能力建议（以宿主真实可用能力为准）

apphx 不管理模型凭据，不能观察或认证宿主内部 provider。配置有 pin 时必须如实使用；没有所需能力就报告限制并 defer，而不是换模型后仍宣称符合 pin。下表仅为 legacy 角色选型建议，不要求固定型号、厂商数量或代理数量：

| 角色 | 模型类别 | 建议 | 独立性要求 |
| --- | --- | --- | --- |
| 产品 / 需求分析 | 长上下文推理 | 能处理实际需求、证据和约束的已授权模型 | 记录实际上下文来源 |
| 架构设计 | 设计与实现推理 | 仅在真实边界需要比较时提出备选方案 | 如实说明方案是否共享上下文 |
| 开发 | 编码能力 | 适合当前技术栈、宿主已可用的模型 | 仅在真实独立所有权范围内并行 |
| 测试编写 | 编码 + 推理 | 编写真正可失败的验收，而非结果回声 | 不能把编写者声明当运行结果 |
| 架构师 / QA / 验收 review | 审查与证据推理 | 遵守 owner pins；可选多样性不是身份凭证 | 必须是未参与实现的 fresh 上下文 |
| 队列选择与 claim | 无模型 | 确定性调度已经获准的工作 | 不决定产品方案或角色拆分 |

实现者不能自审。不同 provider 不等于独立上下文，同 provider 也不能靠伪造身份回执声称不同。模型结果只表达真实观察；Harness 仍要求新鲜的源码/依赖/运行证据。provider/context 披露是宿主诚实责任，不是加密 attestation。

## 4. 验收 agent 定义

"验收"不是单个 agent 的一句话，而是三层门禁 + 一个独立评审：

1. **verify（确定性）**：配置的 checks + runtime 真实验收全过，且验证前后源码/依赖摘要
   完全一致，截图目录摘要一致；
2. **review**：静态 completing session 汇总各角色的实际 typed 结论，最终证据覆盖全部产品 acceptance；动态每个节点独立提交结果，见下一段；
3. **package（确定性）**：校验实际新产物并记录摘要；built 后才可通知作者，绝不把模型自评当成运行/打包成功。

动态模式中，每个完成检查的 review 节点（`outcome: passed`）都必须返回 typed `ReviewSchema`：`{approved, findings, acceptanceEvidence}`。检查发现阻断问题仍是 `passed` 加 `approved:false`/findings；`passed` 表示所分配检查完成，不是产品获批。专家可只覆盖分配到的产品条目，甚至 `acceptanceEvidence: []`，但仍须证明每项 node acceptance。final 必须覆盖全部不可变产品 acceptance。Harness 汇总当前 proof-bound review 节点，任一拒绝或 finding 否决；final 无权丢弃负面子结果。旧 finding 只能由 invalidation 后的 fresh review 解决。`failed` 表示执行未完成（如独立上下文不可用），返回实际失败与可用证据后重新 planning；不要为未执行的 review 编造 verdict，未完成工作也不能通过 final gate。

## 5. 扩展新角色

在新的、尚未冻结的任务配置中，owner 可给 `roles.<stage>` 增加最低席位，并由宿主提供该角色的真实执行能力。动态模式不必为了每种新工作先改全局角色配置：planner 可按实际需求选择未被固定的角色，但仍须覆盖 owner 的所有已有 pins 与重复席位。

不要修改活动任务配置来临时绕过能力、权限或预算缺口；需要 owner 改动时使用明确恢复路径，历史与预算保留。不存在替换任务重置预算的自动逃生通道。

## 6. 宿主能力与诚实 deferral

独立上下文是实际执行属性，不能假定每个宿主都提供。查看当前安装版本的 `apphx hosts` delegation 说明，并确认实际可用能力；以下是 legacy 接线示意，不是所有版本的能力保证：

| 宿主 | 原生 subagents | 多角色执行形态 |
| --- | --- | --- |
| Codex | ✓（agents/tasks） | 单会话并行/串行 fresh contexts |
| Claude Code | ✓（subagents） | 单会话并行/串行 fresh contexts |
| Hermes | ✓（subagents + cron） | 单会话并行 + cron 无人唤醒 |
| DeepSeek Harness | 视 provider | 有则单会话，无则多会话 |
| Cursor | 视版本 | 无则每个角色独立 fresh 会话 |
| OpenCode | 视版本 | 无则每个角色独立 fresh 会话 |
| Pi（stock） | ✗（仓库已记录） | 每个角色人工启动独立会话 |
| Gemini CLI | ✗（未记录子代理） | 顺序 fresh 会话 |

无论静态或动态，都不允许静默降级独立性：

1. Legacy 配置要求的 review 角色各自使用 fresh 非实现者上下文，恰好一个 completing session 汇总 token；动态则每个 claimed review 节点有自己的上下文和 token。
2. 静态 completing session 忠实合并所有 typed 结论与 findings，任一拒绝不能变成最终通过；动态 Harness 直接聚合持久化节点结果并 enforce veto。专家不必各自覆盖完整产品，但最终仍须完整覆盖。
3. 如实记录实际模型、上下文与观察。不能用“不同角色名”“多份文档”或几条 decide 回执代替真实独立执行。
4. 宿主无法提供所需独立会话、provider pin 或真实 SDK/凭证等前提时，报告准确缺口并 defer；autopilot 可继续其他 eligible jobs，不可自审冒充通过、静默禁用 autopilot 或只因不是安全红线就强行推进。

## 7. Token 与 controller 生命周期

**仅 legacy** 的多个 review 角色共享一个阶段 token，由一个 completing session 汇总；这不意味着独立性被代码自动认证。动态模式已经为每个 review 节点分配独立 token 和结果，不能退回共享 token 的旧示例来丢弃专家结论。

controller 必须在所有已派 native workers 执行期间存活。`next`/`drive` 可通过 `--host-pid` 或继承 `APPHX_HOST_PID` 指向真实存活祖先；直接 CLI 默认父进程，已识别的 package-manager exec 包装器可跳过，未知包装器须显式接线。不要让一次性 pnpm/npm/shell 的 PID 代表整个会话；见 [无人值守接线](unattended-loop.md)。

`wait` 先收集 owned workers；取消/abandon 前先停止并收集对应 native 工作，不能因 CLI 退出就认为它们已停。SIGINT/SIGTERM 的 Harness drain 只覆盖跟踪命令，不覆盖任意 native tools。持久化 PID/incarnation 协调生命周期，但不是跨租户授权、模型身份保证或任意进程树的清理服务。
