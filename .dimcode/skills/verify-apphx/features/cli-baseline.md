# CLI 基线

## Sub-features

`apphx --version`、`apphx --help` 命令清单、`apphx doctor --host <host>` 宿主工作流体检、Node engines 约束（22.23.4+/24.22.1+/26.12.1+）。

## How to get to it (user POV)

装好 CLI 后（`npm install -g apphx` 或仓库 `node packages/apple-app-factory/dist/cli.js`），在任何目录直接执行上述命令。医生检查在控制项目目录执行 `apphx doctor --host dimagent`。

## Driving it with exec + apphx

```sh
apphx --version                          # 输出 2.3.0 及以上
apphx --help                             # 必须包含 init/enqueue/next/complete/step/report/obfuscator 与 --autopilot、--collect
apphx doctor --host dimagent             # 每个 skill 行 status 为 installed
node -v                                  # 属于 ^22.23.4 || ^24.22.1 || >=26.12.1
```

## Gotchas

- `doctor --host dimagent` 会检查 project 与 global 两个作用域；只装 global 时会报 project 作用域 missing，需在项目里补 `apphx install dimagent`（产生 `.dimcode/skills/`，本地状态，不应进版本库）。
- 非交互 shell 里 nvm 可能不在 PATH；先 `source ~/.nvm/nvm.sh`。
- Node 老版本（如 24.14.0）低于安全补丁线，engines 收紧后部分工具会拒绝；用 `nvm use 24.22.1`（或 22.23.4 / 26.12.1）。
