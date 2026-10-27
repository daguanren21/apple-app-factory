# apphx

给现有 AI agent 接入 Flutter / iOS 开发、验收与交付流程。复用宿主的模型、会话和工具，不启动另一套 coding agent。

## 1. 安装 CLI

需要 Node.js **22.18+**。从 **1.1.0** 起，npm 包、命令和 Skill 统一为 **`apphx`**。已有 1.0 安装时，先按第 4 节迁移，**不要先升级 CLI**。

| 包管理器 | 安装 CLI | 运行命令 | 卸载 CLI |
| --- | --- | --- | --- |
| npm | `npm install -g apphx` | `apphx` | `npm uninstall -g apphx` |
| pnpm | `pnpm add -g apphx` | `apphx` | `pnpm remove -g apphx` |
| Yarn Classic 1.x | `yarn global add apphx` | `apphx` | `yarn global remove apphx` |
| Yarn 2+ | 在目标项目中 `yarn add -D apphx` | `yarn exec apphx` | `yarn remove apphx` |

先确认目标版本已在 npm 发布；本地试用或发布前，将表格中的包名换成安装包的绝对路径，例如 `$PWD/apphx-1.1.0.tgz`。Yarn Classic 全局安装不能使用相对 tarball 路径。

pnpm 提示缺少全局 bin 目录时，先运行 `pnpm setup` 并重新打开终端。Yarn 2+ 没有 `yarn global`：后文的 `apphx ...` 全部改用 `yarn exec apphx ...`，并从安装了依赖的控制项目目录执行。

npm / pnpm 也可先在控制项目中执行 `npm install -D apphx` / `pnpm add -D apphx`，之后分别用 `npm exec --offline --package=apphx -- apphx ...` / `pnpm exec apphx ...`。Skill 只使用已安装的依赖，不会代为下载 CLI。

## 2. 接入你的 agent

在要开发应用的项目目录执行对应命令，再重新打开该目录的 agent 会话。

| Agent | 安装工作流 | 在 agent 中启动 |
| --- | --- | --- |
| Codex App / CLI | `apphx install codex` | `$apphx <需求>` |
| Claude Code | `apphx install claude` | `/apphx <需求>` |
| Cursor | `apphx install cursor` | `/apphx <需求>` |
| Pi | `apphx install pi` | `/skill:apphx <需求>` |
| Gemini CLI | `apphx install gemini` | `请启用 apphx skill，<需求>` |
| OpenCode | `apphx install opencode` | `请加载 apphx skill，<需求>` |
| DeepSeek Harness | `apphx install deepseek` | `请加载 apphx skill，<需求>` |
| Hermes | `apphx install hermes --global` | `/apphx <需求>` |

其他项目加 `--project /path/to/project`；用户级安装加 `--global`。Hermes 的全局目录跟随 `HERMES_HOME`，默认 `~/.hermes/skills`。也可在 Git 项目内使用 `apphx install hermes`，然后由你执行 `hermes skills trust` 授予项目信任；安装器不会代为授权。见 [Hermes Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)。

例如在 Codex 中输入：

```text
$apphx 开发行李配重应用：离线记录物品重量、检查超重、支持备份恢复；完成模拟器验收，只做本地构建，不上传。
```

## 3. 准备环境并确认接入

实际 iOS 验收需要 **macOS、完整 Xcode、Flutter 和模拟器**。仅在允许本机执行构建与验收命令时运行：

```sh
apphx init --allow-local-execution
```

用 `flutter devices` 查询目标并设置真实的 `IOS_DEVICE_ID`；按 `factory.json` 配置验收命令，指定 SDK 时设置 `toolchain.flutterSdk`。然后检查：

```sh
apphx doctor --build-only
apphx doctor --host codex
apphx status
```

宿主 ID、`--project` / `--global` 与安装时保持一致。宿主检查只证明安装文件完整，实际加载看宿主的技能列表；Hermes 可用 `hermes skills list`。

无需配置另一份模型 API key 或 builder/reviewer。agent 负责研究、开发和独立审查，CLI 执行验收与交付门禁。`status` 返回任务 ID、阶段、错误和产物路径；中断后继续同一任务 ID，不重复入队。

## 4. 更新与卸载

以下适用于已经使用 `apphx` 命令和 Skill 的安装；1.0 用户先完成下方迁移。先升级 CLI（本地试用则安装新的 tarball），再显式更新宿主工作流：

| 包管理器 | 升级 CLI |
| --- | --- |
| npm | `npm install -g apphx@latest` |
| pnpm | `pnpm add -g apphx@latest` |
| Yarn Classic 1.x | `yarn global add apphx@latest` |
| Yarn 2+ | 在控制项目中 `yarn add -D apphx@latest` |

npm / pnpm 项目本地依赖分别用 `npm install -D apphx@latest` / `pnpm add -D apphx@latest`。升级后执行：

```sh
apphx update codex
apphx update hermes --global
```

`install` 只安装；重复安装相同内容不做改动，已有不同版本会提示使用 `update`。`update` 不创建缺失的安装，也不会覆盖你修改过的文件。更新使用原来的 `--project` / `--global` 作用域。

卸载时先移除工作流，再按安装表卸载 CLI：

```sh
apphx uninstall codex
apphx uninstall hermes --global
```

不会删除应用代码、`factory.json`、`remote.json` 或 `.factory` 任务数据。

<details>
<summary>已有 1.0 安装：迁移到统一的 apphx 入口</summary>

1.0 的 npm 包已经叫 `apphx`，但可执行文件是 `app-factory`，Skill 是 `apple-app-factory`。1.1 只支持新的 `apphx` 入口；新版不会识别、接管或自动改名旧 Skill。

1. **暂停所有定时工作**，例如 `hermes cron pause CRON_ID`。保存原 `JOB_ID`、配置绝对路径、每个宿主的安装作用域与 profile；确认先前执行已结束，状态不明时停止，不抢占任务。
2. **升级 npm 包之前**，用仍已安装的 **1.0 CLI** 卸载每一个未修改的旧 Skill。下面是项目级和全局示例；将宿主、路径换成原安装值，对所有安装逐一执行，保持原 `--project` / `--global` 及 `HERMES_HOME` 等环境：

   ```sh
   app-factory uninstall codex --project /absolute/project
   app-factory uninstall hermes --global
   ```

   若旧 CLI 是控制项目的本地依赖，使用原项目的 `pnpm exec app-factory`、`yarn exec app-factory` 或 `npm exec --offline --package=apphx -- app-factory` 前缀执行同样的卸载。

   **如果 CLI 已升级**，由你明确手动调用精确的旧版本作为卸载工具（可能需要下载并确认），而不是让新版兼容或让 Skill 自动获取旧 CLI：

   ```sh
   npm exec --package=apphx@1.0.0 -- app-factory uninstall codex --project /absolute/project
   npm exec --package=apphx@1.0.0 -- app-factory uninstall hermes --global
   ```

   旧卸载器只移除归其所有且未修改的安装。若发现编辑过、添加或缺失的文件而拒绝，**停止自动迁移**：由你备份、审阅并决定如何保留；如需退出旧 Skill，由你明确将完整目录归档到宿主发现范围之外。不要覆盖、自动删除或篡改所有权标记来绕过拒绝。更早的本地预览包 `apple-app-factory` 也应先用其原 CLI 安全卸载 Skill，再用原包管理器卸载旧包。
3. 确认 1.1.0 可获取后，按上表升级 `apphx`（或安装已验证的 1.1.0 tarball），运行 `apphx --version` 确认版本，再用 **`install`，不是 `update`** 安装新 Skill：

   ```sh
   apphx install codex --project /absolute/project
   apphx install hermes --global
   apphx status JOB_ID --config /absolute/project/factory.json
   ```

   保留原 `factory.json`、`remote.json`、`.factory` 及其任务数据，不重新 `init` 或 `enqueue`。使用 SSH 时，也在 Mac 主机升级 CLI，并将 `remote.json` 的 `executable` 改为该主机 `apphx` 的绝对路径，其他字段保持不变。重新打开宿主，确认加载的是 `apphx`；按第 2 节的新名称调用，继续同一个 `JOB_ID`。
4. 在恢复调度前，编辑**原定时任务**的命令、Skill 和名称为 `apphx` / `apphx` / `apphx-continue`，保留原任务 ID、配置、工作目录和防重叠设置，不另建并行调度。Hermes 可先替换所附 Skill（保留其他 Skill）：

   ```sh
   hermes cron edit CRON_ID --remove-skill apple-app-factory --add-skill apphx
   hermes cron list
   ```

   同时按第 5 节修改原任务提示词与名称；核对配置和任务状态后，才执行 `hermes cron resume CRON_ID` 或恢复原调度器。不要用恢复调度替代人工授权。

</details>


## 5. Hermes 与定时任务

先在 Hermes 中完成一次正常接入，取得 `apphx status` 中的任务 ID。定时任务**唤醒 Hermes 并续跑这个任务**，不是重复 `enqueue`，也不是只运行 `apphx next`。

将 `JOB_ID`、`/absolute/project` 换成真实值，使用相同的 Hermes profile：

```sh
hermes cron create "every 30m" \
  "继续 apphx 任务 JOB_ID，配置 /absolute/project/factory.json。先检查 status；若 running 且原执行是否结束不明，则报告并停止。否则读取 next，只处理一个返回 action；wait/done 或需要人工授权时停止。所有 apphx 操作使用 --build-only，不重复 enqueue，不上传。" \
  --skill apphx \
  --workdir /absolute/project \
  --name apphx-continue \
  --paused
hermes cron list
```

核对后，将 `CRON_ID` 换成 Hermes 返回的定时任务 ID，再启用：

```sh
hermes cron resume CRON_ID
hermes cron status
```

- **Hermes gateway 必须运行**：可前台运行 `hermes gateway`，或按官方方式安装服务。`hermes cron tick` 不会替你启动 gateway。
- gateway 的执行环境必须能访问 CLI、同一配置/工作目录和 Mac 工具链；使用本地 Yarn 依赖时还需在控制项目中使用 `yarn exec apphx`。
- 同一 apphx 任务只交给一个调度入口；不要同时手工编辑。Hermes 的定时任务去重不是 apphx 跨宿主的文件编辑锁。需要人工处理时先 `hermes cron pause CRON_ID`。
- 系统 cron / launchd / CI 也遵循相同边界：只查询状态可直接运行 CLI；需要模型工作时必须唤醒已有 agent 宿主，保留任务 ID、工作目录、环境和防重叠设置。

创建为暂停状态不会自动执行。具体调度、恢复和服务安装见 [Hermes 定时任务文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)。

默认只构建、不上传；`built` 不代表 App Store 批准。Skill 不接管宿主所有工具权限，CLI 只对本项目的任务推进和交付执行门禁。

<details>
<summary>开发、打包与版本发布（Turborepo + tsdown + repoctl）</summary>

维护者使用 `.nvmrc` 指定的 **Node.js 24.22.1** 和 **pnpm 12.15.0**。根目录是私有工具 workspace，唯一发布包为 `apphx`；内部源码目录保留 `packages/apple-app-factory`，以兼容 repoctl 对已发布版本的历史路径校验。Turbo 编排构建、类型检查和测试，tsdown 生成发布产物，repoctl 管理版本和发布。

```sh
pnpm install
pnpm exec repoctl config validate --json
pnpm test
pnpm run package:check
pnpm run package:pack
```

构建缓存包含 `dist`、README 与两份 MIT 许可证，并将根目录 README/LICENSE 纳入缓存输入；测试不缓存结果。只使用本地 Turbo 缓存，没有启用远程缓存。安装包输出到仓库根目录。

### Trusted Publisher 与原始源码恢复

1.0.0 的手动首发及原生元数据补齐已完成；后续使用 repoctl，不重复手动 `npm publish`。npm Trusted Publisher 保持以下身份：

| npm 字段 | 值 |
| --- | --- |
| Organization or user | `daguanren21` |
| Repository | `apple-app-factory` |
| Workflow filename | `release.yml`（只填文件名） |
| Environment name | `npm` |
| Allowed actions | 必须允许 `npm publish`；只有默认的 `npm stage publish` 不够 |

GitHub 的 `npm` environment 应受保护，发布 job 保留 `id-token: write`；源码仓库必须公开以生成 provenance。CI 使用 OIDC，不保存长期 npm token。`npm dist-tag` 是独立权限，不能替代 `npm publish`。可在 **Release** 工作流运行 `oidc-audit` 核对身份。

新建 Trusted Publisher 后，须在 **2 天内**通过它完成首次成功发布，否则配置过期，必须删除重建；审计或已发布版本的元数据恢复不算首次发布。首次成功发布后，该初始 2 天限制不再适用。见 [npm Trusted Publisher 配置规则](https://docs.npmjs.com/trusted-publishers/)。

发布中断时，从 `main` 手动分发 **Release**，选择 `publish`，`source-sha` 填引入该版本 changelog/ledger 的完整版本提交 SHA，先勾选 `dry-run`。它不能是任意后续文档提交。核对目标版本、源码与已发布包后，以同一输入取消 dry-run；repoctl 补齐缺失步骤，已存在的 npm 版本不重复上传。

不要拿后续 `main` 冒充原始源码、重写历史 manifest/changelog/ledger，或覆盖 `GITHUB_SHA`。repoctl 会隔离所选版本提交；来源不明、内容冲突或完整性不符时停止调查，不移动已有 tag，也不绕过校验。保留 `repoctl-release-state` 和发布诊断产物。

### 原生版本发布

按实际变更选择 `patch`、`minor` 或 `major`；每项变更只记录一次意图，再检查原生计划：

```sh
pnpm change apphx --bump patch --summary "描述本次用户可见改动"
pnpm run release:plan
```

确认目标版本，审查并提交实现及意图，推送到 `main`；不能在脏工作树上跳过门禁。随后在 GitHub Actions 的 **Release** 中依次运行 `plan`、`prepare`，审查原生版本 PR 和 changelog/ledger，检查通过后合并，再运行 `publish`（先勾选 `dry-run`）。`prepare` 会创建并推送版本 PR；repoctl 负责质量门禁、版本、npm 上传、tag、GitHub Release 与检查点。

使用默认 `GITHUB_TOKEN` 准备 PR 时，需要允许 Actions 创建 PR，并在生成的版本分支手动运行 **Check**；该 token 创建的 PR 不会自动触发普通 PR 工作流。已有 GitHub App 时，可配置 `REPOCTL_APP_CLIENT_ID` 变量和 `REPOCTL_APP_PRIVATE_KEY` secret。

Release 仅手动触发，不会因普通 push 自动上传。保留 `repoctl-release-state` 检查点；恢复细节见 [repoctl 发布文档](https://repo.icebreaker.top/tasks/release)。不要对私有根包直接执行 `npm publish`。

本项目不安装本地提交钩子，Release 是自有的手动工作流；`repo doctor` 对这两项的提示会保留，不应为清除提示而自动覆盖发布流程。

配置与需求示例见 [factory.json](https://github.com/daguanren21/apple-app-factory/blob/main/packages/apple-app-factory/examples/factory.json) 和 [luggage.json](https://github.com/daguanren21/apple-app-factory/blob/main/packages/apple-app-factory/examples/luggage.json)。全部命令见 `apphx --help`；不要删除 `.factory`。

</details>

## License

[MIT](LICENSE)
