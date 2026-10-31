# 队列循环演示：三个需求从 enqueue 到 built

loopx 风格的 agent loop 在 apphx 中的完整走法：一个宿主会话（或每次定时唤醒）用
`apphx next --any` 逐轮消费队列，直到 `idle` 且 `summary` 显示全部 `built`/`failed`。

本文档是工作流示例；JSON 输出为**缩略示意**（真实 job id、turn id、digest 与逐字
输出不同），不作为任何运行证据。真实验收需要 macOS、完整 Xcode 与模拟器/设备，
商店提交始终是工具之外的人工工作。

## 1. 控制项目与三个需求

```sh
apphx init --framework flutter --platform ios --package-target simulator
# 按项目校准 factory.json：真实验收命令、allowLocalExecution 等（见 Skill/README）
apphx doctor
```

三个需求文件放在控制目录（此处只展示决定循环行为的关键字段）：

```jsonc
// requirements/checklist-p0.json —— 高优先级修复
{ "id": "pack-checklist", "name": "行李核对", "framework": "flutter",
  "platform": "ios", "channel": "local", "version": "1.0.0",
  "priority": "P0",  // P0 优先扫描；不改变验收门槛
  "differentiators": ["离线核对清单"], "acceptance": ["重启后清单完整"] }

// requirements/timer-p1.json —— 常规新应用
{ "id": "pomodoro-timer", "priority": "P1", "acceptance": ["计时结束有可及性提示"] }

// requirements/notes-p2.json —— 后台补量
{ "id": "daily-notes", "priority": "P2", "acceptance": ["导出恢复一致"] }
```

```sh
apphx enqueue requirements/checklist-p0.json --config factory.json
apphx enqueue requirements/timer-p1.json     --config factory.json
apphx enqueue requirements/notes-p2.json     --config factory.json
# 或走 inbox：apphx submit ... 三份后 apphx scan --config factory.json
```

## 2. Agent 循环（每一轮都是同一步）

```text
loop:
  r = apphx drive --once --config factory.json --build-only
  host + turn.kind=plan → 模型调查后生成依赖/角色/读写范围/验收 DAG → complete <id> <turn> plan.json
  host + turn.kind=node → 按唯一节点 packet 派工 → complete <id> <turn> node-result.json
  host 无 kind → 仅旧静态配置按原阶段协议处理
  step → 继续 drive（本轮确定性步骤已执行）；built → notify --any
  wait 且仍有本会话 worker → 收集结果、complete，再 drive；没有 owned work 才按 nextDueAt 退出
  done → 读 summary 做终局审计，report 每个 built 作业并 notify --any
```

## 3. 逐轮示意

```text
#1  drive → host / research / kind=plan
    模型根据实际需求规划，例如 scope、risk 两个只读节点汇合到 decision；节点数和角色不是固定要求。
    complete …01 <planner-token> plan.json → 图及 revision 持久化。

#2  drive → host / kind=node / nodeId=scope
    再 drive → host / kind=node / nodeId=risk；依赖未完成的 decision 不会被领取。
    每个 worker 只处理自己的范围，以 {outcome,summary,evidence,result?} 完成独立 token。

#3  drive → host / kind=node / nodeId=decision
    final 的 result 内提交 typed research verdict → 进入 build 的模型规划，不会自动派固定设计/开发团队。
    模型按实际工程产生构建 DAG；全部节点汇合且工程检查通过后进入 verify。

#4  drive → step（实际运行冻结检查和 runtime）→ review
    模型规划只读、fresh 的 review DAG；final 汇总逐项产品证据，不能复用失效的验证或回执。

#5  drive → step（package）→ built + artifact kind/path/digest
    report 收集需求 checklist、节点结果和历史；notify …01 仅对门禁通过的作业发信。

#6  同一队列继续 …02、…03；P0 的 live 节点不会阻塞其他 eligible 作业。
    wait 时仍有 owned worker 就先收集它们，不能重复派发同一个显式 next token。

#7  drive → done + summary（全部 built/failed/needs-owner）
    汇报产物与 owner deferral。blocked/waiting/running 不是完成；没有本会话工作后按 nextDueAt 再唤醒。
```

## 4. 循环中常见的三种分支

**评审拒绝（repair 自动回到 build）**

```text
next --any → host（review）→ 评审返回 approved=false + findings
apphx complete …02 <turn> review-result.json → 任务自动回到 stage=build、status=waiting
# 下一轮 next --any 仍返回 …02 的 build 回合；不新建任务、不问用户
```

**验证失败（verify → repair → build，attempts 扣减）**

```text
apphx step …02 → Verification failed (1) … → status=waiting, stage=build, attempts={verify:1}
```

**P0 阻塞不冻结队列（next safe action）**

```text
…01 (P0) 处于 waiting（等待 retryDelayMs）且 nextAt 在未来 → next --any 跳过它
→ 返回 …02 (P1) 的 host 回合；P0 到期后重新被扫描到。
```

## 5. 定时唤醒的固定 re-entry 指令

cron/Hermes 每次唤醒只注入这一段，不带任何任务细节（job id、prompt、结论都
由 CLI 在唤醒时重新给出）：

```text
在控制项目目录循环执行 apphx drive --once --config factory.json --build-only：
host → 按 turn.kind 处理模型计划或唯一节点，以严格 JSON 完成对应 token；无 kind 的旧配置按原阶段处理；
step → 再 drive；built → report 与 notify --any；
wait → 先收集、完成本会话仍在运行的 worker 并继续 drive；只有没有 owned work 时才按 nextDueAt 安排唤醒并退出；
done → 读 summary 审计 built/failed/needs-owner，汇报后退出。不得把 blocked/waiting/running 当成完成。
```
可用 `apphx schedule --host <id> --format launchd|systemd|cron --config /absolute/control/factory.json`
生成模板和固定 re-entry 提示词。替换宿主的 headless 启动命令后由所有者安装；CLI 不安装或启动系统服务。
cron 模板要求其 `PATH` 中有支持 `flock -n <file> <command>` 的可执行文件，并保持 headless 命令前台运行；
同一状态目录、同一宿主共用锁，执行结束或进程退出后释放。路径及提示词按各格式语法转义，勿手工删掉转义或引号。


`factory.json` 中的邮件配置（密码只在发送时从环境变量读取，不落盘、不打日志）：

```jsonc
{
  "notify": {
    "email": {
      "from": "factory@example.org",
      "to": "author@example.org",      // 默认收件人；需求里 authorEmail 可覆盖
      "smtpHost": "smtp.example.org",
      "smtpPort": 465,
      "secure": true,
      "user": "factory@example.org",
      "passwordEnv": "SMTP_PASSWORD"   // 环境变量名，不是密码本身
    }
  }
}
```

## 6. 边界

- `drive`/`next --any` 在领取锁内跳过活跃宿主进程持有的回合，继续扫描其他作业；原宿主退出后续领原 token，不重复扣回合和尝试预算。
- CLI 以父进程 PID 标识会话；应由持续存活的宿主进程调用，而非会立刻退出的中间包装进程。库调用默认使用当前进程，也可传入 `ownerPid`。PID 存活检查是保守的本机并发保护，不是身份认证。
- `next <id>` 保留显式检查/恢复活跃 token 的能力；它不是第二个无人值守队列驾驶员。`next --any` 每轮重读持久化状态，任何结论都不能靠“记得上一轮”。
- 商店上传、提交、审核不在本工具内；`built` ≠ 上架/过审。
