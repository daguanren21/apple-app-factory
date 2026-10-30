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

## 注意事项

- **执行权限**：默认不开本地执行或云构建，确认命令可信后再开 `allowLocalExecution`（或 init `--allow-local-execution`）；autopilot 下由 agent 决策者角色拍板，不向用户提问。工作区不是安全沙箱，真实运行验收不可省略。
- **工具链**：iOS 本地构建需要 macOS、完整 Xcode 与模拟器；Android 需要匹配的 JDK、Android SDK 与模拟器。模块名/scheme/产物路径/签名按实际工程校准；`doctor` 通过不代表应用已运行。
- **Expo / uni-app / MyGo**：Expo 用 EAS local（需认证与签名，不要求 prebuild）；HBuilderX uni-app 保留原构建方式，WGT/H5 不能冒充 APK/IPA；MyGo 仅 macOS 本地 ad-hoc 签名，固定 v0.3.0 + Go 1.27.1。
- **源码与产物**：控制配置、状态目录、导入源必须分离；产物必须新生成，拒绝符号链接别名与旧产物。
- **渠道**：默认 `local`。商店上传、提交与审核都是人工工作，`built` 不等于上架或过审。
- **升级旧数据**：先结束活跃任务并备份 `.factory`；1.0 用户升级 CLI 前用原 `app-factory uninstall` 卸载旧 Skill 再装新 `apphx`。
- **宿主与调度**：更新/卸载保持原 `--project`/`--global` 作用域；多任务在 agent 内循环 `apphx next --any`（`host` 回合 `complete`，`step` 回合 `apphx step`）直到 `idle`。定时任务应唤醒宿主续跑，不要只定时执行 `next`。
- **子进程隔离**：可选 `isolation: { "mode": "macos-sandbox", "readOnlyPaths": [], "network": "deny" }` 约束 Harness 检查/打包子进程；后端不可用即阻塞，不回退降级。

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
