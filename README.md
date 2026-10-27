# Apple App Factory

给现有 AI agent 接入 Flutter / iOS 开发、验收与交付流程。复用宿主的模型、会话和工具，不启动另一套 coding agent。

## 1. 安装 CLI

需要 Node.js **22.18+**。npm 包名为 **`apphx`**，命令仍是 `app-factory`，Skill 名仍是 `apple-app-factory`。

| 包管理器 | 安装或升级 CLI | 运行命令 | 卸载 CLI |
| --- | --- | --- | --- |
| npm | `npm install -g apphx` | `app-factory` | `npm uninstall -g apphx` |
| pnpm | `pnpm add -g apphx` | `app-factory` | `pnpm remove -g apphx` |
| Yarn Classic 1.x | `yarn global add apphx` | `app-factory` | `yarn global remove apphx` |
| Yarn 2+ | 在目标项目中 `yarn add -D apphx` | `yarn exec app-factory` | `yarn remove apphx` |

本地试用时将表格中的包名换成安装包的绝对路径，例如 `$PWD/apphx-1.0.0.tgz`；Yarn Classic 全局安装不能使用相对 tarball 路径。

pnpm 提示缺少全局 bin 目录时，先运行 `pnpm setup` 并重新打开终端。Yarn 2+ 没有 `yarn global`：后文的 `app-factory ...` 全部改用 `yarn exec app-factory ...`，并从安装了依赖的控制项目目录执行；宿主 Skill 也支持这个本地入口。

安装过旧的本地预览包 `apple-app-factory` 时，先用原包管理器卸载那个 CLI 包，再安装 `apphx`，避免同名命令冲突。不要删除已有 Skill 或 `.factory`；随后用 `app-factory update <host>` 更新原安装。

## 2. 接入你的 agent

在要开发应用的项目目录执行对应命令，再重新打开该目录的 agent 会话。

| Agent | 安装工作流 | 在 agent 中启动 |
| --- | --- | --- |
| Codex App / CLI | `app-factory install codex` | `$apple-app-factory <需求>` |
| Claude Code | `app-factory install claude` | `/apple-app-factory <需求>` |
| Cursor | `app-factory install cursor` | `/apple-app-factory <需求>` |
| Pi | `app-factory install pi` | `/skill:apple-app-factory <需求>` |
| Gemini CLI | `app-factory install gemini` | `请启用 apple-app-factory skill，<需求>` |
| OpenCode | `app-factory install opencode` | `请加载 apple-app-factory skill，<需求>` |
| DeepSeek Harness | `app-factory install deepseek` | `请加载 apple-app-factory skill，<需求>` |
| Hermes | `app-factory install hermes --global` | `/apple-app-factory <需求>` |

其他项目加 `--project /path/to/project`；用户级安装加 `--global`。Hermes 的全局目录跟随 `HERMES_HOME`，默认 `~/.hermes/skills`。也可在 Git 项目内使用 `app-factory install hermes`，然后由你执行 `hermes skills trust` 授予项目信任；安装器不会代为授权。见 [Hermes Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)。

例如在 Codex 中输入：

```text
$apple-app-factory 开发行李配重应用：离线记录物品重量、检查超重、支持备份恢复；完成模拟器验收，只做本地构建，不上传。
```

## 3. 准备环境并确认接入

实际 iOS 验收需要 **macOS、完整 Xcode、Flutter 和模拟器**。仅在允许本机执行构建与验收命令时运行：

```sh
app-factory init --allow-local-execution
```

用 `flutter devices` 查询目标并设置真实的 `IOS_DEVICE_ID`；按 `factory.json` 配置验收命令，指定 SDK 时设置 `toolchain.flutterSdk`。然后检查：

```sh
app-factory doctor --build-only
app-factory doctor --host codex
app-factory status
```

宿主 ID、`--project` / `--global` 与安装时保持一致。宿主检查只证明安装文件完整，实际加载看宿主的技能列表；Hermes 可用 `hermes skills list`。

无需配置另一份模型 API key 或 builder/reviewer。agent 负责研究、开发和独立审查，CLI 执行验收与交付门禁。`status` 返回任务 ID、阶段、错误和产物路径；中断后继续同一任务 ID，不重复入队。

## 4. 更新与卸载

先按安装表升级 `apphx`（本地试用则安装新的 tarball），再显式更新宿主工作流：

```sh
app-factory update codex
app-factory update hermes --global
```

`install` 只安装；重复安装相同内容不做改动，已有不同版本会提示使用 `update`。`update` 不创建缺失的安装，也不会覆盖你修改过的文件。更新使用原来的 `--project` / `--global` 作用域。

卸载时先移除工作流，再按安装表卸载 CLI：

```sh
app-factory uninstall codex
app-factory uninstall hermes --global
```

不会删除应用代码或 `.factory` 任务数据。

## 5. Hermes 与定时任务

先在 Hermes 中完成一次正常接入，取得 `app-factory status` 中的任务 ID。定时任务**唤醒 Hermes 并续跑这个任务**，不是重复 `enqueue`，也不是只运行 `app-factory next`。

将 `JOB_ID`、`/absolute/project` 换成真实值，使用相同的 Hermes profile：

```sh
hermes cron create "every 30m" \
  "继续 Factory 任务 JOB_ID，配置 /absolute/project/factory.json。先检查 status；若 running 且原执行是否结束不明，则报告并停止。否则读取 next，只处理一个返回 action；wait/done 或需要人工授权时停止。所有 Factory 操作使用 --build-only，不重复 enqueue，不上传。" \
  --skill apple-app-factory \
  --workdir /absolute/project \
  --name app-factory-continue \
  --paused
hermes cron list
```

核对后，将 `CRON_ID` 换成 Hermes 返回的定时任务 ID，再启用：

```sh
hermes cron resume CRON_ID
hermes cron status
```

- **Hermes gateway 必须运行**：可前台运行 `hermes gateway`，或按官方方式安装服务。`hermes cron tick` 不会替你启动 gateway。
- gateway 的执行环境必须能访问 CLI、同一配置/工作目录和 Mac 工具链；使用本地 Yarn 依赖时还需在控制项目中使用 `yarn exec app-factory`。
- 同一 Factory 任务只交给一个调度入口；不要同时手工编辑。Hermes 的定时任务去重不是 Factory 跨宿主的文件编辑锁。需要人工处理时先 `hermes cron pause CRON_ID`。
- 系统 cron / launchd / CI 也遵循相同边界：只查询状态可直接运行 CLI；需要模型工作时必须唤醒已有 agent 宿主，保留任务 ID、工作目录、环境和防重叠设置。

创建为暂停状态不会自动执行。具体调度、恢复和服务安装见 [Hermes 定时任务文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)。

默认只构建、不上传；`built` 不代表 App Store 批准。Skill 不接管宿主所有工具权限，CLI 只对本项目的任务推进和交付执行门禁。

<details>
<summary>开发、打包与版本发布（Turborepo + tsdown + repoctl）</summary>

维护者使用 `.nvmrc` 指定的 **Node.js 24.22.1** 和 **pnpm 12.15.0**。根目录是私有工具 workspace，唯一发布包为 `packages/apple-app-factory` 中的 `apphx`。Turbo 编排构建、类型检查和测试，tsdown 生成发布产物，repoctl 管理版本和后续发布。

```sh
pnpm install
pnpm exec repoctl config validate --json
pnpm test
pnpm run package:check
pnpm run package:pack
```

构建缓存包含 `dist`、README 与两份 MIT 许可证，并将根目录 README/LICENSE 纳入缓存输入；测试不缓存结果。只使用本地 Turbo 缓存，没有启用远程缓存。安装包输出到仓库根目录。

### 首次发布 1.0.0

首发使用维护者本机的 npm 登录，不依赖尚未配置的 Trusted Publisher。先完成上方检查，审查并提交实现和发布意图；原生版本准备要求干净工作树，不能在未提交改动上跳过检查：

```sh
pnpm run release:plan
pnpm version -r --json
pnpm test
pnpm run package:check
pnpm run package:pack
```

确认原生版本结果为 `apphx@1.0.0`，再提交生成的 changelog、`.changeset/ledger.yaml` 等版本元数据，并将两次提交推送到 `main`。记录这个首发源码提交，再发布已验证的包：

```sh
git rev-parse HEAD
npm login --registry=https://registry.npmjs.org
npm publish ./apphx-1.0.0.tgz --access public --registry=https://registry.npmjs.org
npm view apphx@1.0.0 version dist.integrity --json
```

保留首发提交 SHA 与 npm 返回的 `dist.integrity`。tarball 发布不能假定会自动附带当前仓库的 `gitHead`；后续恢复必须显式使用这个已推送的源码 SHA。

首发后再在 npm 的 `apphx` 包设置中配置 Trusted Publisher：仓库 `daguanren21/apple-app-factory`、工作流 `release.yml`、environment `npm`；**Allowed actions 勾选 `npm publish`**，不能只保留默认的 `npm stage publish`。同时配置并保护 GitHub 的 `npm` environment。repoctl 原生上传要求公开源码仓库，以生成 provenance；CI 使用 OIDC，不保存长期 npm token。

用 `oidc-audit` 检查可信发布身份。**下一次 `prepare` 前必须完成首发元数据恢复**：在 Release 工作流选择 `publish`，将 `source-sha` 设为上述首发提交，先 dry-run，再补齐 GitHub tag、Release 和 repoctl 检查点。已有 `apphx@1.0.0` 只核对、不重复上传；否则 repoctl 会因上一版尚未完整交付而拒绝准备下一版。

新建 Trusted Publisher 后，须在 **2 天内**通过它完成一次新版本发布验证，否则配置过期；`oidc-audit` 或已发布版本的元数据恢复不算。临近下一次实际发布时再创建，过期则删除重建。见 [npm Trusted Publisher 配置规则](https://docs.npmjs.com/trusted-publishers/)。

### 后续版本

```sh
pnpm change apphx --bump patch --summary "描述本次用户可见改动"
pnpm run release:plan
```

提交改动后，在 GitHub Actions 的 **Release** 中运行 `plan`、`prepare`，审查并合并版本 PR，然后运行 `publish`（先勾选 `dry-run` 预览）。`prepare` 会创建并推送版本 PR，不是本地-only 命令。

使用默认 `GITHUB_TOKEN` 准备 PR 时，需要允许 Actions 创建 PR，并在生成的版本分支手动运行 **Check**；该 token 创建的 PR 不会自动触发普通 PR 工作流。已有 GitHub App 时，可配置 `REPOCTL_APP_CLIENT_ID` 变量和 `REPOCTL_APP_PRIVATE_KEY` secret。

Release 仅手动触发，不会因普通 push 自动上传。保留 `repoctl-release-state` 检查点；恢复细节见 [repoctl 发布文档](https://repo.icebreaker.top/tasks/release)。不要对私有根包直接执行 `npm publish`。

本项目不安装本地提交钩子，Release 是自有的手动工作流；`repo doctor` 对这两项的提示会保留，不应为清除提示而自动覆盖发布流程。

0.1 的 provider 配置与后台 `run` / `service` 入口不再使用；配置按 [factory.json](https://github.com/daguanren21/apple-app-factory/blob/main/packages/apple-app-factory/examples/factory.json) 更新，不要删除 `.factory`。全部命令见 `app-factory --help`；需求示例见 [luggage.json](https://github.com/daguanren21/apple-app-factory/blob/main/packages/apple-app-factory/examples/luggage.json)。

</details>

## License

[MIT](LICENSE)
