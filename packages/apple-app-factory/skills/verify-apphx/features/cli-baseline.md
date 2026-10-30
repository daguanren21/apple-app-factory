# CLI 基线

## Sub-features

`apphx --version`、`apphx --help` 命令清单、`apphx doctor --host <host>` 宿主工作流体检、Node engines 约束（22.23.4+/24.22.1+/26.12.1+）。

## How to get to it (user POV)

装好 CLI 后（`npm install -g apphx` 或仓库 `node packages/apple-app-factory/dist/cli.js`），在任何目录直接执行上述命令。医生检查在控制项目目录执行 `apphx doctor --host <your-host>`（宿主名用 `apphx hosts` 查询）。

## Driving it with exec + apphx

```sh
apphx --version                          # 输出 2.3.0 及以上
apphx --help                             # 必须包含 init/enqueue/next/complete/step/report/obfuscator 与 --autopilot（注意：--collect/--out 是 report 旗标，目前不出现在 --help 文本里，以 `apphx report` 实际行为为准）
apphx doctor --host <your-host>         # 输出 apphx 与 apphx-obfuscator 两行；单次只查一个作用域（默认 project，加 --global 查全局），以每行 status 为准
node -v                                  # 属于 ^22.23.4 || ^24.22.1 || >=26.12.1（24.x 不含 25.x）
```

## Gotchas

- `doctor --host <host>` 单次只查一个作用域（默认 project；`--global` 查全局）。只装 global 时默认作用域会报 project missing，需在项目里补 `apphx install <host>`（产生宿主专属 skills 目录：Cursor 为 `.cursor/skills/`、Claude Code 为 `.claude/skills/`、DimCode 为 `.dimcode/skills/`；本地状态，不应进版本库）；退出码只由第一个 skill（apphx）的 installed 决定。
- 非交互 shell 里 nvm 可能不在 PATH；先 `source ~/.nvm/nvm.sh`。
- Node 老版本（如 24.14.0）低于安全补丁线，engines 收紧后部分工具会拒绝；用 `nvm use 24.22.1`（或 22.23.4 / 26.12.1）。
