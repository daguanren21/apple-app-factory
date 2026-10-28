# apphx

给现有 AI agent 接入应用开发、验收与交付流程。支持 **Java Android、Swift、Flutter、React Native、Expo、uni-app**，可新建项目或接管已有工程；复用宿主模型和工具，不启动另一套 coding agent。

## 快速开始

需要 Node.js **22.18+**。先安装 CLI，再在控制项目中安装宿主工作流：

```sh
npm install -g apphx
apphx install codex
apphx init --framework android-java --platform android --package-target apk
```

`init` 只创建 `factory.json`，不覆盖已有文件，也不生成应用代码。按项目校准构建、设备验收和签名配置后，重新打开 agent 会话，交给它继续：

```text
$apphx 接管我的 Java Android 项目，完成真实验收，只做本地构建，不上传。
```

其他宿主先用 `apphx hosts` 查看安装方式；通常为 `apphx install <host>`：

| 宿主 | 启动工作流 |
| --- | --- |
| Codex | `$apphx <需求>` |
| Claude Code / Cursor | `/apphx <需求>` |
| Pi | `/skill:apphx <需求>` |
| Gemini / OpenCode / DeepSeek | 请加载 apphx skill，随后描述需求 |
| Hermes | `apphx install hermes --global` 后使用 `/apphx <需求>` |

项目本地安装 CLI 时，使用原包管理器的 `pnpm exec apphx`、`yarn exec apphx` 或 `npm exec --offline --package=apphx -- apphx`；Skill 不会替你下载 CLI。

## 选择项目与交付方式

- `--framework`：`android-java`、`swift`、`flutter`、`react-native`、`expo`、`uni-app`。
- `--platform`：`android` 或 `ios`；Java Android 仅 Android，Swift 仅 iOS。
- `--package-target`：Android 用 `apk` / `aab`，iOS 用 `simulator` / `ipa`。
- 已有工程在需求中设置 `project.sourceDir`，嵌套应用再设置 `project.directory`。只修改固定快照，不重写原工程或强制迁移技术栈。

六种技术栈及已有工程的成对需求/配置见 [examples](https://github.com/daguanren21/apple-app-factory/tree/main/packages/apple-app-factory/examples)。复制到控制目录后按真实项目编辑，不要修改安装包资产或添加空验收脚本。

需求文件就绪后，可直接检查环境和任务状态：

```sh
apphx doctor requirement.json --build-only
apphx doctor --host codex
apphx status
```

后续由 agent 按 `next` 返回的 action 研究、开发、审查，再通过 `step` 执行验收和打包。中断后继续原 `JOB_ID`，不要重复入队。全部命令见 `apphx --help`。

## 注意事项

- **执行权限**：默认不开启本地执行、云构建、上传或发布。确认命令可信后，才加 `--allow-local-execution` 或开启 `allowLocalExecution`。`--build-only` 遇到配置或任务已有发布权限会拒绝执行，不会替你撤销权限。工作区不是安全沙箱；检查与真实运行验收都不能省略。
- **工具链**：iOS 本地构建需要 macOS、完整 Xcode 和设备/模拟器；Android 需要匹配的 JDK、Android SDK 和设备/模拟器。配置外部 Flutter SDK 隔离克隆时，文件系统须支持写时复制。模块名、scheme、产物路径与签名按实际工程校准；`doctor` 通过不代表应用已运行。
- **Expo / uni-app**：Expo 使用 EAS local 时仍需认证和签名配置，且不保证完全离线；不要求 prebuild/eject。经典 HBuilderX uni-app 不要求添加 package.json 或 npm 工程，保留原有构建与设备验收命令；WGT/H5 产物不能冒充 APK/IPA。
- **源码与产物**：控制配置、状态目录和导入源必须分离。应用目录不能放在被排除的 build/cache 路径下；产物必须新生成，拒绝符号链接别名和旧产物。Gradle `files` / `dirs` 集合只支持可证明归属的字面量路径，不接受未计入快照的外部可变依赖。
- **渠道**：默认 `channel: "local"`，不套用 Apple 上架规则。`google-play` 仅交接本地 AAB，没有自动上传器；App Store 上传须单独授权、准备真实元数据并核对回执。`built` 不等于上架或过审。
- **默认值与云构建**：不传技术栈时，`init` 默认 Flutter/iOS/simulator；`android-java` 默认 Android/APK，Expo 默认 iOS/IPA。远程云编译另需 `allowCloudBuild`；不确定的远程结果先对账，不自动重放。
- **升级旧数据**：先结束活跃任务，保留 `.factory`、配置和迁移备份。新需求显式带 `platform`，配置带 `packageTarget`；`version`、`screenshotsDir` 放在需求顶层。队列 v3 保留历史与回执、清除旧证明；重新验收或完成发布对账后再继续。1.0 用户须在升级 CLI 前用原 `app-factory uninstall` 安全卸载未修改的旧 Skill，再安装新 `apphx` Skill；不要覆盖修改过的安装。
- **宿主与调度**：更新、卸载时保持原 `--project` / `--global` 作用域。Hermes 项目级安装还需你手动授予信任；定时任务应唤醒宿主、续跑同一任务并避免重叠，不能只定时执行 `next`。详见 [Hermes 调度文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)。

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

版本变更通过 `pnpm change apphx --bump patch --summary "变更说明"` 记录，再运行 `pnpm run release:plan`。发布只走已有的手动 Release 工作流；恢复时绑定原版本提交，不改写历史、tag 或 ledger。详见 [repoctl 发布文档](https://repo.icebreaker.top/tasks/release)。

## License

[MIT](LICENSE)
