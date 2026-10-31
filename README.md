# apphx

给现有 AI agent 接入应用开发、验收与交付流程：新建或接管 **Java Android、Swift、Flutter、React Native、Expo、uni-app、MyGo macOS** 工程；复用宿主模型与工具，不启动另一套 coding agent。

## 操作流程

需要 Node.js **22.23.4+ / 24.22.1+ / 26.12.1+（安全补丁版本）**。先安装 CLI，再在控制项目中安装宿主工作流：

   ```sh
   apphx init --framework <stack> --platform <platform> --package-target <target> [--autopilot]
   ```

   `--framework`：`android-java` / `swift` / `flutter` / `react-native` / `expo` / `uni-app` / `mygo`；`--platform`：`ios` / `android` / `macos`（Java Android 仅 Android、Swift 仅 iOS、MyGo 仅 macOS）；`--package-target`：Android `apk`/`aab`、iOS `simulator`/`ipa`、MyGo `app`/`dmg`。`init` 只生成 `factory.json`；`--autopilot` 一次预授权无人值守本地构建（不再向用户提问）。
4. 写需求文件（复制 [examples](https://github.com/daguanren21/apple-app-factory/tree/main/packages/apple-app-factory/examples) 的成对示例改），可先体检：

   ```sh
   apphx doctor requirement.json --build-only
   apphx doctor --host <host>
   ```

   已有工程在需求里设 `project.sourceDir`（嵌套应用再设 `project.directory`），只改固定快照，不重写原工程。
5. 交给 agent 描述需求，agent 自动走 **研究→构建→验证→评审→打包**：用 `apphx next` 取动作——`host` 回合做完即 `apphx complete`；`step` 回合执行一次 `apphx step JOB_ID`；重复到 `built`。中断后继续原 `JOB_ID`，不要重复入队。
6. 全部命令见 `apphx --help`。

## 每个 agent 怎么用

| 宿主 | 启动工作流 | 直接触发混淆器 |
| --- | --- | --- |
| Codex | `$apphx <需求>` | `$apphx-obfuscator <需求>` |
| Claude Code / Cursor | `/apphx <需求>` | `/apphx-obfuscator <需求>` |
| Pi | `/skill:apphx <需求>` | `/skill:apphx-obfuscator <需求>` |
| Gemini / OpenCode / DeepSeek | 加载 apphx skill 后描述需求 | 加载 apphx-obfuscator skill |
| Hermes | `apphx install hermes --global` 后 `/apphx <需求>` | 同上 |

`apphx install <host>` 同时安装 `apphx` 与 `apphx-obfuscator` 两个 skill；其余宿主先 `apphx hosts` 查安装方式。项目本地装 CLI 时用原包管理器：`pnpm exec apphx` / `yarn exec apphx` / `npm exec --offline --package=apphx -- apphx`。

## 动态工作流

新 `apphx init` 配置默认启用 `workflow: {}`：宿主模型先根据需求和工程生成 JSON DAG，apphx 校验、持久化并按依赖调度。研究结论、真实验证、独立评审和打包是固定安全关口，关口内的节点、角色、读写范围、依赖和验收由模型决定，不是固定团队模板。模型仍由宿主提供，不启动另一套 agent CLI，也不执行任意生成脚本。

- `drive --once` 返回 `host` 时先读 `turn.kind`：`plan` 完成严格的任务图；`node` 只执行该节点，并提交带逐项观察证据的结果。节点格式与计划 schema 随 packet 给出，完整协议见 [apphx skill](packages/apple-app-factory/skills/apphx/SKILL.md)。
- 可连续领取互不冲突的 ready 节点，受 `maxParallel`、文件读写范围和预算约束；遇到等待先收集本会话仍在运行的 worker，不能提前退出并遗留工作。
- `apphx replan JOB_ID '新事实或失败原因'` 请求模型局部重规划：保留无关的已通过节点，明确失效节点及其依赖后再执行。`apphx cancel JOB_ID '原因'` 撤销 token，宿主负责停止原生子代理；显式 `retry` 不退还预算，并要求重新取得失效证据。
- `status JOB_ID`、`events JOB_ID` 和 `report JOB_ID` 显示节点、结果、修订历史和恢复状态。真实验证合同或验证代次改变时，旧评审结果和回执全部失效，即使源码字节未变。
- 普通动态本地验证、混淆或打包失败会返回带失败证据的 build 规划；修复仍须重新经过冻结检查和评审。每个完成检查的 review 节点提供 typed verdict，任一拒绝或阻断 finding 都否决最终批准，不能被汇总节点隐藏。
- 控制器必须在 native worker 生命周期内持续存活。`next`/`drive` 支持 `--host-pid` 或 `APPHX_HOST_PID` 指定真实存活祖先进程；可识别的包管理器包装层会被跳过，无法可靠识别时拒绝领取而非把短命包装器记成 owner。持久 shell 可设置 `export APPHX_HOST_PID=$$`；一次性 tool shell 的 `$$` 不满足此条件。
- 文件互斥保守处理大小写、Unicode、realpath 和已存在硬链接；可能把大小写不同但物理独立的路径串行化，不承诺 OS 沙箱。已退休节点 ID 不能重新引入以重置 attempts；席位约束、剩余回合数和最小结果大小不可满足时，在配置/计划准入时拒绝。

`workflow` 可配置每阶段 `maxNodes`（默认 64）、同时执行的 `maxParallel`（默认 4）和 `maxReplans`（默认 4）；新配置的**全作业** `maxHostTurns` 为 64，每个 planner 和 node 都消耗一次，接纳计划时为后续必需关口保留最低回合数，不会自动加预算。JSON 需求、计划和完成结果受 1 MiB 传输限制，不能把所有字段的上限同时理解为可提交大小。旧配置/已入队快照不会被改写，静态模式继续可用；已有控制项目添加 `workflow: {}` 后为新任务启用动态模式，已开始任务不能通过切换模式绕过门禁。未配置阶段的 `roles` 留给模型决定，显式席位是最低约束；所有 review 节点都必须新上下文、只读。


## 注意事项

- **执行权限**：默认不开本地执行或云构建，须由所有者确认命令可信后预授权（或 init `--autopilot`）。模型不自行改权限或预算；缺少凭据、工具链、独立上下文等前提时如实延期，不通过新版本重入队绕过限制。工作区不是安全沙箱，真实运行验收不可省略。
- **工具链**：iOS 本地构建需要 macOS、完整 Xcode 与模拟器；Android 需要匹配的 JDK、Android SDK 与模拟器。模块名/scheme/产物路径/签名按实际工程校准；`doctor` 通过不代表应用已运行。
- **Expo / uni-app / MyGo**：Expo 用 EAS local（需认证与签名，不要求 prebuild）；HBuilderX uni-app 保留原构建方式，WGT/H5 不能冒充 APK/IPA；MyGo 仅 macOS 本地 ad-hoc 签名，固定 v0.3.0 + Go 1.27.1。
- **源码与产物**：控制配置、状态目录、导入源必须分离；产物必须新生成，拒绝符号链接别名与旧产物。
- **渠道**：默认 `local`。商店上传、提交与审核都是人工工作，`built` 不等于上架或过审。
- **升级旧数据**：先结束活跃任务并备份 `.factory`；1.0 用户升级 CLI 前用原 `app-factory uninstall` 卸载旧 Skill 再装新 `apphx`。
- **预算**：每阶段/node 尝试次数默认 8（`factory.json` 的 `maxAttempts`）；所有者可事先按工作量校准。失败回修复不退还尝试，绝对 `maxJobHours` 同时限制命令时间和成功提交，耗尽后只能显式 owner 恢复。
- **宿主与调度**：更新/卸载保持原 `--project`/`--global` 作用域；多任务在 agent 内循环 `apphx next --any`（`host` 回合 `complete`，`step` 回合 `apphx step`）直到 `idle`。定时任务应唤醒宿主续跑，不要只定时执行 `next`。
- **子进程隔离**：可选 `isolation: { "mode": "macos-sandbox", "readOnlyPaths": [], "network": "deny" }` 约束 Harness 检查/打包子进程；后端不可用即阻塞，不回退降级。
- **执行生命周期**：受跟踪命令在所有权提交后才由短命 supervisor 启动，登记 PID 是进程组 supervisor，不一定是 payload PID；`drive`/`step` 中断先清理组再释放锁。当前依赖 Linux/macOS 的 POSIX 进程组，Windows 不支持的跟踪执行会明确拒绝，需使用受支持 worker。宿主自己的原生 subagent 仍由宿主停止和收集。
- **进程身份**：worker 和 host claim 记录 incarnation；Linux 使用 boot/start ticks，macOS 标准接口只有秒级启动时间，无法区分的同秒 PID 重用保守按存活处理。旧 PID-only 活跃锁、不可读身份和未知副作用保持 fail-closed；这些不是模型/provider 身份认证。

## 开发与发布（维护者）

```sh
pnpm install
pnpm test
pnpm run package:check
pnpm run package:pack
```

版本变更用 `pnpm change apphx --bump patch --summary "说明"` 记录，再 `pnpm run release:plan`；发布只走手动 Release 工作流。更多入口：`pnpm smoke:apps --help`、`pnpm eval:prepare`、`pnpm bench:peers`。

## License

[MIT](LICENSE)
