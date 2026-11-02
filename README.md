# apphx

给现有 AI agent 接入应用开发、验收与交付流程：新建或接管 **Java Android、Swift、Flutter、React Native、Expo、uni-app、MyGo macOS** 工程；复用宿主模型与工具，不启动另一套 coding agent。

## 操作流程

需要 Node.js **22.23.4+ / 24.22.1+ / 26.12.1+（安全补丁版本）**。先安装 CLI，再在宿主选定的项目中安装工作流。

1. 在当前对话的项目目录运行，或显式选择目标：

   ```sh
   apphx init --project /absolute/project --framework <stack> --platform <platform> --package-target <target> [--autopilot]
   ```

   不写 `--project` 时绑定调用目录；以后切换工具 cwd 不会改变已保存的项目根。已有清晰工程清单时可省略 framework，由本地清单识别；新空目录才默认 Flutter。支持 `android-java` / `swift` / `flutter` / `react-native` / `expo` / `uni-app` / `mygo`。目标为 Android `apk`/`aab`、iOS `simulator`/`ipa`、MyGo macOS `app`/`dmg`。
2. `init` 只写配置，不生成或覆盖源码。已有项目直接沿当前上下文做需求，保留原架构和未提交修改；Monorepo 在需求中指定 `project.directory`。只有明确选择 `--isolated` 才使用工厂快照模式。`--autopilot` 是所有者对既定范围内本地执行的一次预授权，不授权新增收件人、上传或发布。
3. 按 [examples](https://github.com/daguanren21/apple-app-factory/tree/main/packages/apple-app-factory/examples) 校准需求、真实验收命令与打包参数，可先运行：

   ```sh
   apphx doctor requirement.json --build-only
   apphx doctor --host <host>
   ```

4. 交给 agent 执行 **研究→构建→验证→评审→打包**。用 `drive --once` 或 `next` 读取实际动作，完成精确 token 后继续；中断后恢复原 job/config，不重复入队。不能用编译成功代替实际运行验收。
5. 交付运行 `apphx report JOB_ID --collect`，报告明确给出可继续开发的源码路径、运行命令/cwd、真实产物及报告路径。完整命令见 `apphx --help`。

## 每个 agent 怎么用

| 宿主 | 启动工作流 | 直接触发混淆器 |
| --- | --- | --- |
| Codex | `$apphx <需求>` | `$apphx-obfuscator <需求>` |
| Claude Code / Cursor | `/apphx <需求>` | `/apphx-obfuscator <需求>` |
| Pi | `/skill:apphx <需求>` | `/skill:apphx-obfuscator <需求>` |
| Gemini / OpenCode / DeepSeek | 加载 apphx skill 后描述需求 | 加载 apphx-obfuscator skill |
| Hermes | `apphx install hermes --global` 后 `/apphx <需求>` | 同上 |

`apphx install <host>` 同时安装 `apphx` 与 `apphx-obfuscator` 两个 skill；其余宿主先 `apphx hosts` 查安装方式。项目本地装 CLI 时用原包管理器：`pnpm exec apphx` / `yarn exec apphx` / `npm exec --offline --package=apphx -- apphx`。

## 项目上下文与交付

默认 `projectMode: "project"` 把 `projectRoot` 固定为宿主选定的源码目录，不再把新项目藏进 `workspaces/<UUID>`。状态和执行副本默认位于项目外的 `~/.apphx/projects/<项目根摘要>/`；需求 inbox、结果 JSON 和日志不能放进待验证源码。`project.sourceDir` 在此模式下只能匹配已授权根目录，不能由需求内容扩大写入范围。

研究/实现使用 live source；混淆需要时另建内部执行副本，验证、评审和打包证明绑定实际使用的那份代码。`delivery.sourcePath` 是用户下一次继续开发的位置，`executionPath` 是执行位置。`report --collect` 默认写入外部 stateDir/results，收集副本标为 `secondary-source-snapshot`；源码后来变化会标为未验证，不冒充旧产物的证明。自定义命令和规则仍需可信，复制目录不等于 OS 沙箱。

## 平台 UI 与动态技能选择

新 `init` 默认启用 `uiQuality: true`。移动端要求实际检查状态栏/刘海/底部手势安全区、键盘、大字体和不同屏幕；MyGo 桌面检查原生标题栏、窗口缩放、键盘焦点与高 DPI，不能仅把手机页面放大。动效须有明确用途，支持打断/反向与减少动态效果；不能用两张截图宣称流畅或 60fps。

有 Figma 时以实际可读取的设计为准；没有 Figma 时先复用项目现有设计，只为全新项目选择视觉方向。规划器根据任务决定是否需要产品、架构、设计等职责，再通过宿主的 `find-skills` 或等价发现能力搜索、评估并选用技能，优先复用已有适用能力。所选来源、用途和限制写入现有节点指令，执行 agent 在自己的上下文中按需加载；Impeccable 是可能的设计辅助，不内置整包文档、不固定角色映射。发现不等于安装授权，不自动新增全局工具、hooks 或付费服务，缺少必需能力时如实阻塞相关工作。见 [技能发现协议](packages/apple-app-factory/skills/apphx/resources/skill-discovery.md)。

最终批准需要六类 `uiQuality` 观察及实际捕获文件：安全区、响应式、键盘焦点、文字缩放、动效、视觉设计。证据保存在需求的 `screenshotsDir`（如 `build/screenshots`），在验证冻结前生成；路径、哈希、图片尺寸、两种几何和动效视频/trace 由 CLI 校验，子评审失败不能被汇总隐藏，打包前再次核对。审美和真实平台表现仍须独立评审，门禁不伪装成自动美学认证。具体协议见 [平台 UI 指南](packages/apple-app-factory/skills/apphx/resources/platform-ui.md)。

旧配置不隐式追加门禁；确属无 UI 的任务可由所有者在入队前显式关闭。已开始的 UI 任务不能关掉门禁规避验收。

## 复用宿主 Gmail、Slack 等能力

apphx 不再运行 SMTP，也不管理邮件/聊天凭据。所有者可在入队前配置 `notifications.targets`（每项含 `id`、`channel`、`destination`），宿主使用已授权的原生工具发送；不配置时正常在当前会话交付。

- `notify [JOB_ID|--any]` 只列出通知包，不发送。
- `notify claim JOB_ID TARGET_ID` 领取一个目的地；宿主随后调用实际连接器。
- `notify complete JOB_ID CLAIM_ID result.json` 回写 `accepted`（真实 provider/messageId）、确认未发送的 `failed`，或副作用不明的 `unknown`。
- `notify reconcile JOB_ID TARGET_ID result.json` 根据外部证据协调未知结果；已领取/未知结果不会自动重发。

`authorEmail` 只是需求数据，不是外发授权。通知失败不会把 built 改为构建失败。回执是宿主报告的接受结果，不认证收件人已收到/已读；本地路径不是下载链接，上传附件另需授权。

通知按产物摘要和创建时间绑定一次实际打包事件。历史未决回执显示其原事件身份；当它与 currentArtifact 不同或不可证明时，delivery 为 null，不会把旧回执关联到新产物路径。相同字节的新打包事件也不会继承旧发送回执。


## 动态工作流

新 `apphx init` 配置默认启用 `workflow: {}`：宿主模型先根据需求和工程生成 JSON DAG，apphx 校验、持久化并按依赖调度。研究结论、真实验证、独立评审和打包是固定安全关口，关口内的节点、角色、读写范围、依赖和验收由模型决定，不是固定团队模板。模型仍由宿主提供，不启动另一套 agent CLI，也不执行任意生成脚本。

- `drive --once` 返回 `host` 时先读 `turn.kind`：`plan` 完成严格的任务图；`node` 只执行该节点，并提交带逐项观察证据的结果。节点格式与计划 schema 随 packet 给出，完整协议见 [apphx skill](packages/apple-app-factory/skills/apphx/SKILL.md)。
- 可连续领取互不冲突的 ready 节点，受 `maxParallel`、文件读写范围和预算约束；遇到等待先收集本会话仍在运行的 worker，不能提前退出并遗留工作。
- `apphx replan JOB_ID '新事实或失败原因'` 请求模型局部重规划：保留无关的已通过节点，明确失效节点及其依赖后再执行。`apphx cancel JOB_ID '原因'` 撤销 token，宿主负责停止原生子代理；显式 `retry` 不退还预算，并要求重新取得失效证据。
- `status JOB_ID`、`events JOB_ID` 和 `report JOB_ID` 显示节点、结果、修订历史和恢复状态。真实验证合同或验证代次改变时，旧评审结果和回执全部失效，即使源码字节未变。
- 普通动态本地验证、混淆或打包失败会返回带失败证据的 build 规划；修复仍须重新经过冻结检查和评审。每个完成检查的 review 节点提供 typed verdict，任一拒绝或阻断 finding 都否决最终批准，不能被汇总节点隐藏。
- 控制器必须在 native worker 生命周期内持续存活。`next`/`drive` 支持 `--host-pid` 或 `APPHX_HOST_PID` 指定真实存活祖先进程；可识别的包管理器包装层会被跳过，无法可靠识别时拒绝领取而非把短命包装器记成 owner。持久 shell 可设置 `export APPHX_HOST_PID=$$`；一次性 tool shell 的 `$$` 不满足此条件。
- 文件互斥保守处理大小写、Unicode、realpath 和已存在硬链接；可能把大小写不同但物理独立的路径串行化，不承诺 OS 沙箱。已退休节点 ID 不能重新引入以重置 attempts；席位约束、剩余回合数和最小结果大小不可满足时，在配置/计划准入时拒绝。

`workflow` 可配置每阶段 `maxNodes`（默认 64）、同时执行的 `maxParallel`（默认 4）和 `maxReplans`（默认 4）；新配置的**全作业** `maxHostTurns` 为 64，每个 planner 和 node 都消耗一次，接纳计划时为后续必需关口保留最低回合数，不会自动加预算。JSON 需求、计划和完成结果受 1 MiB 传输限制。旧任务通过持久化迁移保留要求、原工作区、历史和预算；静态模式继续可用。新任务是否启用动态模式由 owner 配置决定，已开始任务不能通过切换模式绕过门禁。未配置的阶段角色留给模型决定，显式席位是最低约束；所有 review 节点都必须新上下文、只读。


## 注意事项

- **执行权限**：默认不开本地执行或云构建，须由所有者确认命令可信后预授权（或 init `--autopilot`）。模型不自行改权限或预算；缺少凭据、工具链、独立上下文等前提时如实延期，不通过新版本重入队绕过限制。工作区不是安全沙箱，真实运行验收不可省略。
- **工具链**：iOS 本地构建需要 macOS、完整 Xcode 与模拟器；Android 需要匹配的 JDK、Android SDK 与模拟器。模块名/scheme/产物路径/签名按实际工程校准；`doctor` 通过不代表应用已运行。
- **Expo / uni-app / MyGo**：Expo 用 EAS local（需认证与签名，不要求 prebuild）；HBuilderX uni-app 保留原构建方式，WGT/H5 不能冒充 APK/IPA；MyGo 仅 macOS 本地 ad-hoc 签名，固定 v0.3.0 + Go 1.27.1。
- **源码与产物**：明确区分 live source、执行副本和外部控制状态；可信 SDK 不能位于可写项目根。产物必须新生成，拒绝符号链接别名与旧产物。同一队列内重叠项目的活跃工作不能通过不同 job ID 并发领取。
- **渠道**：默认 `local`。商店上传、提交与审核都是人工工作，`built` 不等于上架或过审。
- **升级旧数据**：先结束活跃回合/命令并备份实际 stateDir；旧任务迁移为显式 isolated 语义，保留原 UUID 路径，不自动搬回项目根。旧 SMTP 配置需移除并按 owner 授权改为 notifications.targets；历史回执不自动绑定新连接器或重发。若更换 live/isolated 所有权，显式选择源版本，不隐式跨模式复用。
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

### 源码职责

两个包的 src 根只保留 CLI 入口，内部模块不提供旧路径转发；构建保留目录结构，公开二进制仍是 dist/cli.js。

| 包 | 目录职责 |
| --- | --- |
| apphx | `contracts/` 契约与纯校验；`configuration/` 路径和配置；`state/` SQLite 与迁移；`projects/` 源码/依赖/副本 |
| apphx | `workflow/` 计划、调度与证明；`execution/` 进程和隔离；`platforms/` 平台构建；`intake/` 需求接入 |
| apphx | `delivery/` 交付报告和宿主通知状态；`hosts/` 宿主安装、会话和 SSH 接入 |
| obfuscator | `core/` 基础类型与配置；`pipeline/` 变换编排；`transforms/code/`、`project/`、`resources/`、`content/` 按变换对象归类，Flutter 专项位于 transforms/flutter.ts |

契约层不依赖运行流程、持久化或交付服务；历史通知迁移由 state 拥有，不反向调用发送服务。混淆器 core 不依赖变换/流水线，变换不反向调用流水线或 CLI。

### Schema、平台 profile 与示例

- apphx 的 `src/contracts/schemas.ts` 定义配置、需求及结果契约；obfuscator 的配置契约独立位于 `src/core/config.ts`。两者均直接使用 `@earendil-works/pi-schema` 原生 builder 和闭包编译校验，移除 Zod。JSON Schema 原样提供给模型，不再转换；应用解析边界负责默认值、转换及跨字段业务校验，保持既有 JSON、权限、严格/开放/剥离字段语义，不启用类型强制转换或运行时代码生成。
- 校验库来自 [官方 pi 仓库的固定源码](https://github.com/earendil-works/pi/tree/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/schema)，独立构建为 `vendor/pi-schema.tgz`（`1.4.0-apphx.c9f4c7b9fcd0`），不是声称已发布的 npm 版本。两包仅以开发依赖引用并在构建时内联；安装 apphx 不依赖仓库相对路径或上游 monorepo。源码、编译器、许可证及产物哈希见 [provenance](vendor/pi-schema.provenance.json)，MIT 与 TypeBox 声明随产物分发；普通安装/构建不会下载上游或运行其 lifecycle hooks。
- `src/configuration/profiles.ts` 按 framework/platform/target 创建全新的默认命令配置，不读文件、不运行 SDK。`apphx init` 使用 profile，固定项目/控制目录、应用所有者明确授权的选项，再经 schema 校验并独占写入配置；不会读取 `examples`。
- 七个 `<framework>.factory.json` 是从 profile 生成的下游示例，部分 Android 示例选择 AAB 展示发布包，不代表 `init` 的默认目标。`factory.json` 的 isolated 场景、existing-project、MyGo Web 等定制示例继续独立维护，但必须通过既有配置/需求契约校验。角色约定和 Expo EAS 示例属于宿主/Expo 格式，不是 apphx 默认配置。

修改默认命令时改 profile，构建后生成示例；不要反向修改示例来改变运行时：

```sh
pnpm --filter apphx build
pnpm --filter apphx run examples:generate
pnpm --filter apphx run examples:check
```

`pnpm test` 在已有构建/typecheck 流程后执行同一个只读检查器，拒绝示例漂移和非法的 apphx 配置/需求组合。生成和检查都不会执行示例命令；具体 scheme、原生工程路径、签名及实际运行验收仍需按用户项目校准。

重现当前锁定源码的产物使用 `--rebuild`（会下载并校验同一固定归档）；只校验现有产物及源码/许可证/构建元数据使用 `--verify`：

```sh
node scripts/build-pi-schema.mjs --rebuild
node scripts/build-pi-schema.mjs --verify
```



## License

[MIT](LICENSE)。
