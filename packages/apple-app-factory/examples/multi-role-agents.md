# 多角色 Agent 团队设计（apphx 宿主式）

apphx 不启动自己的 coding agent，角色全部由**宿主会话**执行；apphx 只做三件事：命名角色、
把角色随回合发给宿主、用确定性控制面分配工作。本文档是角色到流水线的完整映射、自动分配
算法、模型矩阵与验收 agent 定义。

## 1. 角色 ↔ 流水线映射

| 角色 | 流水线位置 | 职责 | 输出 / 关卡 |
| --- | --- | --- | --- |
| 产品 / 需求分析 agent | `research` 回合（宿主） | 需求整理、可行性、诚实差异化、隐私、实施计划 | 类型化 research 结论（viable/distinctness/plan） |
| 架构设计 agents ×N | `build` 回合第一步 | N 份独立方案 → 互相 critique → 合成决定 | 工作区内 `docs/architecture.md` |
| 开发 agents ×N | `build` 回合 | 按合成设计并行实现模块切片 | 源码 |
| 测试 agent | `build`（编写测试）+ `verify`（确定性执行） | 测试编写；checks + 设备真实验收 | 验证通过 + 源码/依赖摘要前后一致 |
| 架构师 review | `review` 回合 | 对照设计文档审查实现与模块边界 | findings（可阻断） |
| 质量工程师 agent | `review` 回合 | 空态/错误态、可访问性、边界、质量 | findings（可阻断） |
| 验收 agent | `review` 回合（逐条验收证据）+ `package` 产物校验 | 每条 acceptance 给出具体证据；产物非空且摘要记录 | approved + artifact |
| 项目管理 agent | 控制面（无回合） | 队列排序、预算、重试、repair、通知、终局审计 | 队列状态与事件日志 |
| 补充角色（自由命名） | 任意回合 | `roles` 配置加名字即可 | 宿主按 role 数组执行 |

`roles` 配置（factory.json，可选；默认如上表）：

```jsonc
{ "roles": {
    "research": ["product-analyst", "requirement-groomer"],
    "build": ["developer", "security-aware-developer"],
    "review": ["architect-review", "qa-engineer", "acceptance-reviewer", "performance-analyst"]
} }
```

每个回合的 `next` 返回负载带 `turn.role` 数组（[runner.ts](src/runner.ts) hostAction），
提示词尾部也会写明本回合角色；宿主按顺序或按其原生 delegation 并行采用。

## 2. AI 自动分配：确定性算法，不用模型

分配发生在控制面，与模型无关（loopx 同款原则：Kernel 检查 authority/frontier/quota，
Capability 才做领域判断）。`apphx next --any` 的分配顺序：

1. **priority 泳道**：P0 → P1 → P2（同泳道才比较到期时间）；
2. **到期时间**：`nextAt` 最早的先做；
3. **入队序**：稳定排序兜底；
4. **资格过滤**：过期/预算耗尽/有活动回合/命令组恢复中/被另一 worker 持有的任务一律跳过，
   继续取下一个 safe action。

为什么不用 LLM 分配：

- 可审计可重放：同样的队列状态永远得到同样的分配；
- 无幻觉：LLM 不会"记错"到期时间或预算；
- 幂等安全：分配本身不改状态，claim 由事务完成（turn token / worker 锁）。

模型只出现在**需要判断的环节**：research、设计讨论、实现、三类 review。分配动作零模型。

## 3. 模型矩阵（以宿主为准）

apphx 不管理模型凭据；`roles` 只声明角色名，角色→模型的绑定写在宿主的 role 配置里。
矩阵按角色类别给出建议（型号以宿主实际可用为准）：

| 角色 | 模型类别 | 建议 | 独立性要求 |
| --- | --- | --- | --- |
| 产品 / 需求分析 | 长上下文强推理 | o3/Opus/R1 类推理模型 | 与开发不同上下文 |
| 架构设计 ×N | 强推理 | N 份方案尽量不同厂商/模型，最大化多样性 | 相互独立会话 |
| 开发 | 编码模型 | Sonnet/Opus/Codex 类编码模型 | 按模块切片可并行 |
| 测试编写 | 编码 + 推理 | 编码模型即可 | 与开发不同上下文更佳 |
| 架构师 review | 强推理 | **与开发者不同厂商**的推理模型 | 未参与实现的新会话 |
| 质量工程师 | 编码 + 推理 | 与架构师可相同、与开发者不同 | 未参与实现的新会话 |
| 验收 agent | 推理 | 与实现者不同模型/厂商 | 未参与实现的新会话 |
| 项目管理 / 分配 | **无模型** | 确定性队列（见上节） | — |

独立性规则（skill 已强制）：实现者不能自审；验收证据由 harness 门禁（typed 结果 +
未变摘要），reviewer 只能 approve/reject，不能改证据、不能替跑 verify。

## 4. 验收 agent 定义

"验收"不是单个 agent 的一句话，而是三层门禁 + 一个独立评审：

1. **verify（确定性）**：配置的 checks + runtime 真实验收全过，且验证前后源码/依赖摘要
   完全一致，截图目录摘要一致；
2. **review（acceptance-reviewer）**：逐条 acceptance 给出"文件/符号 + 实际观察到的命令或
   设备场景"证据，覆盖全部条目才可能 approved；
3. **package（确定性）**：非空常规产物、摘要落盘；built 之后 `notify` 通知作者。

验收 agent 无法"自证"：它只产出 typed 结论，harness 用摘要门禁决定是否采信。

## 5. 扩展新角色

需要新 agent（如 security-review）时只改两处：

1. `factory.json` 的 `roles.<stage>` 数组加名字；
2. 宿主的角色提示词库加对应定义（skill 的 turn.role 会把它随回合带来）。

不需要改 CLI、状态机或队列。

## 6. 宿主能力与降级规则（所有 AI agent 是否都支持）

多角色不需要宿主支持"子代理"——**独立上下文是会话级属性**，任何宿主都能做到；只是
执行形态不同。`apphx hosts` 输出里每行带 `delegation` 说明（以宿主版本为准）：

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

降级规则（skill 强制，任何宿主都不允许静默降级独立性）：

1. **review 三角色**必须各自 fresh、非实现者上下文；宿主无子代理时顺序开独立会话，
   由控制会话收集 typed 结论，**恰好一个会话**完成 token。
2. **verdict 聚合**：findings 取并集；acceptanceEvidence 逐条覆盖且注明"哪个角色观察
   到什么证据"；任一角色有阻断 finding 即不通过；**某角色零证据 = 该角色缺席**，不算通过。
3. **设计讨论**（build 内）：多样性而非独立性——无子代理时同一会话顺序产出 N 份方案
   也可接受，但记录"同会话、同模型"的局限性。
4. 角色→模型绑定是宿主侧配置（参考 [roles.example.json](roles.example.json) 的
   fresh/independentOf 约定）；apphx 只命名角色、随回合下发，不管理模型凭据。

## 7. 为什么不把 review 拆成多个 token

review 三角色共用一个 token、由单个 completing 会话聚合，而不是拆成三段独立 token：

- 独立性已由"fresh 会话"规则保证（对无子代理宿主更通用）；
- 聚合 verdict 仍受 harness 门禁（typed 结果 + 未变摘要），不会因聚合而放宽；
- 拆 token 要改阶段状态机与迁移，收益只是把"会话边界"搬到"token 边界"，不新增保证。

若某宿主连多会话都做不到（例如只能单进程单会话），stock Pi 规则已覆盖：暂停并请
所有者人工开启独立会话完成 review。
