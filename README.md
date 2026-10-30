# apphx

给现有 AI agent 接入应用开发、验收与交付流程。支持 **Java Android、Swift、Flutter、React Native、Expo、uni-app、MyGo macOS**，可新建项目或接管已有工程；复用宿主模型和工具，不启动另一套 coding agent。

## 快速开始

需要 Node.js **22.23.4+ / 24.22.1+ / 26.12.1+（安全补丁版本）**。先安装 CLI，再在控制项目中安装宿主工作流：

```sh
npm install -g apphx
apphx install codex
apphx init --framework android-java --platform android --package-target apk
```

`init` 只创建 `factory.json`，不覆盖已有文件，也不生成应用代码。按项目校准构建、设备验收和签名配置后，重新打开 agent 会话，交给它继续：

```text
$apphx 接管我的 Java Android 项目，完成真实验收，只做本地构建，不上传。
```

无人值守（owner 预授权）：`apphx init --autopilot --framework flutter --platform ios --package-target simulator` 会在 `factory.json` 写入 `"autopilot": true` 与 `"allowLocalExecution": true`，宿主 agent 在 owner 一次性授权下自动跑完 研究→构建→验证→评审→打包，全程不再提问；这不等于可伪造证据或绕过验收，诚实降级仍强制生效。

其他宿主先用 `apphx hosts` 查看安装方式；通常为 `apphx install <host>`：

| 宿主 | 启动工作流 | 直接触发混淆 |
| --- | --- | --- |
| Codex | `$apphx <需求>` | `$apphx-obfuscator <需求>` |
| Claude Code / Cursor | `/apphx <需求>` | `/apphx-obfuscator <需求>` |
| Pi | `/skill:apphx <需求>` | `/skill:apphx-obfuscator <需求>` |
| Gemini / OpenCode / DeepSeek | 请加载 apphx skill，随后描述需求 | 请加载 apphx-obfuscator skill |
| Hermes | `apphx install hermes --global` 后使用 `/apphx <需求>` | 同上安装后使用 `/apphx-obfuscator <需求>` |

`apphx install <host>` 会同时安装 `apphx` 与 `apphx-obfuscator` 两个 skill；后者让 agent 直接运行确定性混淆器：`apphx obfuscator <project> --config <rules.json> [--framework <stack>] [--seed <text>]`，规则结构与流水线 `obfuscation` 阶段一致，覆盖 ObjC/Swift 符号改名、XOR 字符串加密、Flutter 符号/资源混淆、DFA 敏感词过滤、垃圾代码与清理、工程身份改名和图片变换。

项目本地安装 CLI 时，使用原包管理器的 `pnpm exec apphx`、`yarn exec apphx` 或 `npm exec --offline --package=apphx -- apphx`；Skill 不会替你下载 CLI。

## 选择项目与交付方式

- `--framework`：`android-java`、`swift`、`flutter`、`react-native`、`expo`、`uni-app`、`mygo`。
- `--platform`：`android`、`ios` 或 `macos`；Java Android 仅 Android，Swift 仅 iOS，MyGo 仅 macOS。
- `--package-target`：Android 用 `apk` / `aab`，iOS 用 `simulator` / `ipa`，MyGo macOS 用 `app` / `dmg`。
- 已有工程在需求中设置 `project.sourceDir`，嵌套应用再设置 `project.directory`。只修改固定快照，不重写原工程或强制迁移技术栈。

各技术栈及已有工程的成对需求/配置见 [examples](https://github.com/daguanren21/apple-app-factory/tree/main/packages/apple-app-factory/examples)（含 MyGo 原生 UI / Web）。复制到控制目录后按真实项目编辑，不要修改安装包资产或添加空验收脚本。

需求文件就绪后，可直接检查环境和任务状态：

```sh
apphx doctor requirement.json --build-only
apphx doctor --host codex
apphx status
```

后续由 agent 按 `next` 返回的 action 研究、开发、审查，再通过 `step` 执行验收和打包。中断后继续原 `JOB_ID`，不要重复入队。全部命令见 `apphx --help`。

### 商店提交由人工完成

apphx 只负责在本地产出并验证 iOS/Android/macOS 包；App Store / Google Play 的上传、提交与审核都是工具之外的人工工作。内部关卡是真实验证证明 + 新鲜独立复核；研究与复核返回结构化结论及验收证据，生成的提示词不再附加内部 QA 清单。诚实差异与质量检查指引见安装的 apphx Skill。`apple` 元数据块是可选的所有者文档。

## 注意事项

- **执行权限**：默认不开启本地执行或云构建。确认命令可信后，才加 `--allow-local-execution` 或开启 `allowLocalExecution`。工作区不是安全沙箱；检查与真实运行验收都不能省略。
- **子进程隔离**：可显式配置 `isolation: { "mode": "macos-sandbox", "readOnlyPaths": [], "network": "deny" }`。macOS 检查/打包子进程默认只能访问自己的工作区、临时目录和批准的工具；后端不可用会阻塞，不回退。它不隔离宿主 agent，不提供 VM/资源配额，也不保证 GUI/设备工具兼容；未配置时仍是可信执行。详见 Skill。
- **工具链**：iOS 本地构建需要 macOS、完整 Xcode 和设备/模拟器；Android 需要匹配的 JDK、Android SDK 和设备/模拟器。配置外部 Flutter SDK 隔离克隆时，文件系统须支持写时复制。模块名、scheme、产物路径与签名按实际工程校准；`doctor` 通过不代表应用已运行。
- **Expo / uni-app**：Expo 使用 EAS local 时仍需认证和签名配置，且不保证完全离线；不要求 prebuild/eject。经典 HBuilderX uni-app 不要求添加 package.json 或 npm 工程，保留原有构建与设备验收命令；WGT/H5 产物不能冒充 APK/IPA。
- **MyGo macOS**：`apphx init --framework mygo` 默认 macOS/app；固定 MyGo v0.3.0 需 Go 1.27.1。仅本地 ad-hoc 签名、不公证/上传；原生 UI 不要求 Bun。`doctor` 在导入源的应用目录检查项目工具；新项目尚无源码时明确报告无法检查，不借用控制目录模块。真实桌面验收、名称/版本/架构和输出路径须按 Skill 与示例校准。
- **源码与产物**：控制配置、状态目录和导入源必须分离。应用目录不能放在被排除的 build/cache 路径下；产物必须新生成，拒绝符号链接别名和旧产物。Gradle `files` / `dirs` 集合只支持可证明归属的字面量路径，不接受未计入快照的外部可变依赖。
- **渠道**：默认 `channel: "local"`。`app-store` / `google-play` 只标记交付去向，产出仍是本地包；商店上传、提交与审核都是工具之外的人工工作。`built` 不等于上架或过审。
- **IPA 导出**：内置 Flutter 导出及配置中可识别的 `xcodebuild -exportArchive` 使用检查后的本地导出配置快照，拒绝 `destination=upload`。任意自定义脚本仍须信任审查；这不是脚本沙箱。
- **默认值与云构建**：不传技术栈时，`init` 默认 Flutter/iOS/simulator；`android-java` 默认 Android/APK，Expo 默认 iOS/IPA。远程云编译另需 `allowCloudBuild`；不确定的远程结果先对账，不自动重放。
- **升级旧数据**：先结束活跃任务，保留 `.factory`、配置和迁移备份。新需求显式带 `platform`，配置带 `packageTarget`；`version`、`screenshotsDir` 放在需求顶层。队列 v3 保留历史与回执、清除旧证明；重新验收后再继续。1.0 用户须在升级 CLI 前用原 `app-factory uninstall` 安全卸载未修改的旧 Skill，再安装新 `apphx` Skill；不要覆盖修改过的安装。
- **宿主与调度**：更新、卸载时保持原 `--project` / `--global` 作用域。Hermes 项目级安装还需你手动授予信任；定时任务应唤醒宿主、续跑同一任务并避免重叠，不能只定时执行 `next`。多任务（单任务同理）在 agent 内循环用 `apphx next --any` 取最早到期的可推进任务：`host` 回合做完即 `complete`，`step` 执行一次 `apphx step JOB_ID`，重复直到 `idle`（附最早下次唤醒时间）。详见 [Hermes 调度文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)。

已安装的工作流需显式更新或卸载；这些操作不会删除应用代码、配置或任务数据：

```sh
apphx update codex
apphx uninstall codex
```

## 开发与发布

维护者使用 `.nvmrc` 指定的 Node.js 和仓库声明的 pnpm 版本：

```sh
pnpm install
pnpm test
pnpm run package:check
pnpm run package:pack
```

未发布的源码改动请使用本地打包产物验证，不要假定 npm 上的旧版本已经包含它们。Yarn 2+ 使用项目依赖；pnpm 全局安装缺少 bin 目录时先运行 `pnpm setup`。

维护入口：`pnpm smoke:apps --help` 驱动真实 Android Java / MyGo 应用与重启持久化；`pnpm eval:prepare /absolute/fresh-run` 生成原生 agent 审核案例，再用 `pnpm eval:score /absolute/fresh-run --manifest-sha256 PREPARE_HASH` 检查实际结果；未运行不能算通过。`pnpm bench:peers` 提供固定十应用比较基准。工具链须已安装；评估案例不是 iOS 真机或商店过审证明，详情见各命令帮助。

版本变更通过 `pnpm change apphx --bump patch --summary "变更说明"` 记录，再运行 `pnpm run release:plan`。发布只走已有的手动 Release 工作流；恢复时绑定原版本提交，不改写历史、tag 或 ledger。详见 [repoctl 发布文档](https://repo.icebreaker.top/tasks/release)。

## License

[MIT](LICENSE)
