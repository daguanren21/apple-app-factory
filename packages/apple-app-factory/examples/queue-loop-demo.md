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
  r = apphx next --any --config factory.json --build-only
  action host → 按 turn.prompt 完成该回合 → apphx complete <id> <turn> [result.json]
  action step → apphx step <id> --config factory.json --build-only（一次）
  built 出现 → apphx notify <id>（或收尾时统一 notify --any）给作者发邮件
  重复，直到 idle → 读 summary 做终局审计 → 按 nextAt 汇报并退出
```

## 3. 逐轮示意

```text
#1  next --any → { "action": "host", "job": { "id": "…01", "product": "pack-checklist" },
                  "turn": { "stage": "research", "prompt": "…" } }
    宿主完成 research → apphx complete …01 <turn> research-result.json

#2  next --any → host（…01, stage=build）→ 实现 → apphx complete …01 <turn>（无 result）
    注意：P0 未完工前不会被跳过，但它的 build 回合结束后下一轮会先跑它的确定性阶段。

#3  next --any → { "action": "step", "job": { "id": "…01", "stage": "verify" } }
    apphx step …01 → verify 通过 → 任务进入 review

#4  next --any → host（…01, stage=review）→ 独立评审返回 approved + 逐条证据
    apphx complete …01 <turn> review-result.json

#5  next --any → { "action": "step", "job": { "id": "…01", "stage": "package" } }
    apphx step …01 → status=built，artifact 记录 kind/path/digest
    # 通过门禁（verify+review 全过才可能 built）→ 发邮件给作者
    apphx notify …01 → { "id": "…01", "notifiedTo": "author@example.org",
                          "messageId": "…", "error": null }
    # 失败会记 notifyError，重跑 notify 只补发未成功的，不会重复发

#6  next --any → host（…02 pomodoro-timer, P1, research）… 同 #1-#5 走完 → built

#7  next --any → host（…03 daily-notes, P2, research）… → built

#8  next --any → { "action": "idle",
                   "summary": { "total": 3, "built": 3, "failed": 0, "blocked": 0,
                                "waiting": 0, "queued": 0, "running": 0 },
                   "nextAt": null, "pendingErrors": [] }
    终局审计：全部 built → 队列真正结束，汇报三个产物。
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
在控制项目目录用 apphx status 查看队列，然后循环执行
apphx next --any --config factory.json --build-only：
host → 执行该回合并用 apphx complete <id> <turn> [result] 收尾；
step → apphx step <id> 一次；built → apphx notify --any；
重复直到 idle。
idle 时读 summary：全部 built/failed 才是队列结束，存在 blocked/waiting 只是暂停；
按 nextAt 安排下次唤醒，汇报状态后退出。一个唤醒内不超过所有者设定的动作上限。
```

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

- 一个 session 同一时间只应拥有一个队列；worker 锁和 turn token 防确定性阶段重叠。
- `next --any` 每轮重读持久化状态，任何一轮的结论都不能靠"记得上一轮"。
- 商店上传、提交、审核不在本工具内；`built` ≠ 上架/过审。
