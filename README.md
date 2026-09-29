# Shellboard

> A vendor-neutral web cockpit for persistent coding-agent shells.
> **Shellboard manages shells, not agents.**

Codex、Claude Code、OpenCode、Gemini CLI,以及任何能在终端里跑的东西,只要能跑在 tmux 里,天然兼容。新 Agent 的接入成本是一行 `{ id, label, command }`。

- 产品边界与架构:`docs/ARCHITECTURE.md`(non-goals 与设计决策为约束性文件)
- 里程碑与技术规划:`docs/PLAN.md`
- Agent 工程红线:`AGENTS.md`

## 核心架构

```text
xterm.js ⇅ WebSocket ⇅ node-pty(tmux attach)⇅ 原生 Agent CLI
```

- **Terminal bytes are opaque** —— 服务端不解析 ANSI、cursor、prompt 或任何 Agent 语义,只做字节透传。
- **tmux 独立 socket**(`tmux -L shellboard`)—— 与你自己的 tmux 完全隔离;调试:`tmux -L shellboard attach -t <session>`。
- **Web terminal lifecycle ≠ Agent lifecycle** —— 关浏览器只杀 tmux client,Agent 继续跑;重开重新 attach。
- **Tool View 以 session 为作用域** —— git / files / 副终端都落在选中 session 的 `cwd` 上,支持多 worktree 并行。

## 依赖

- Node ≥ 22,pnpm ≥ 10
- tmux ≥ 3.2,git
- 原生模块 `node-pty`、`better-sqlite3`:首次 `pnpm install` 后需构建(本仓库已通过 `pnpm.onlyBuiltDependencies` 允许),构建机需要 gcc/make/python3

## 快速开始

```bash
pnpm install          # 安装依赖(原生模块自动编译)
pnpm dev              # 并行起 server(:7700)与 vite(:5173),开发用
```

浏览器打开 <http://localhost:5173>。

开发态远程访问(从局域网其他机器打开):

```bash
pnpm dev -- --host 0.0.0.0 --port 5199
# 浏览器访问 http://<server-ip>:5199
```

参数只作用于前端(vite);API 的地址/端口用 `SHELLBOARD_HOST` / `SHELLBOARD_PORT` 调整,前端代理目标自动跟随。对外暴露时建议同时设置 `SHELLBOARD_TOKEN`。

生产部署:

```bash
pnpm build            # 构建 web → apps/web/dist
pnpm --filter @shellboard/server start   # 单进程:API + 静态资源,默认 127.0.0.1:7700
```

单元/集成测试(真实 tmux + git + fs,不 mock 被测系统):

```bash
pnpm test             # vitest,自带独立 socket 与临时目录,不碰你的 tmux
pnpm check            # typecheck(tsc)+ eslint
```

## 配置(环境变量)

| 变量 | 默认 | 说明 |
|---|---|---|
| `SHELLBOARD_PORT` | `7700` | API 监听端口(开发态 vite 代理目标跟随此值) |
| `SHELLBOARD_HOST` | `127.0.0.1` | API 监听地址;**保持回环**,远程走 Tailscale/Cloudflare Tunnel |
| `SHELLBOARD_WEB_PORT` | `5173` | 仅开发态:vite dev server 端口 |
| `SHELLBOARD_HOME` | `~/.shellboard` | 数据目录(SQLite 在 `shellboard.db`) |
| `SHELLBOARD_TMUX_SOCKET` | `shellboard` | 专用 tmux socket 名 |
| `SHELLBOARD_TOKEN` | 空 = 回环免鉴权 | 非回环绑定时自动生成并打印;显式设置可固定 |
| `SHELLBOARD_ALLOWED_ORIGINS` | vite dev 源 | 额外允许的 WebSocket Origin(完整 origin 或裸域名);开发态 vite 同时以此放行 `server.allowedHosts`。回环与局域网 IP 访问无需配置;带点的主机名(如 `board.example.com`、`mymac.local`)必须在此列出——Origin 校验对它们不接受 Host 自洽(防 DNS rebinding) |

## 安全模型

本质是 Web Shell + 文件系统写 + Git 写,权限极高:

- 默认只监听 `127.0.0.1`,回环访问免鉴权;**绑定非回环地址时自动启用 token 鉴权**——未设置 `SHELLBOARD_TOKEN` 会生成随机 token 并打印在启动日志(Jupyter/code-server 模式),建议自行设置固定值。
- 文件/路径全部经 sandbox(逐段 realpath),拒绝 `../` 与 symlink escape,有专项测试。
- 没有通用 exec 端点;一切动作走显式 service。
- 服务端不记录终端输入输出。

## 已知限制

- 终端交互是桌面式默认:普通拖拽 = 浏览器原生选区(松手自动复制,双击选词/三击选行),`Ctrl+C`/⧉ 复制,`Ctrl+V`(或 Ctrl+Shift+V/右键)粘贴;滚轮由服务端驱动 tmux copy-mode 滚动,滚回底部自动退出(手动 `q`/`Enter`/`Esc` 也可);tmux/TUI 的鼠标转发已关闭以换取原生选择——TUI 内的鼠标点击不可用。
- 重连后终端只显示当前屏,历史在 tmux copy-mode(终端工具条的 ⇲ 按钮进入)。
- Activity 是 tmux 输出活动的近似(Agent 静默思考会显示 idle),这是设计取舍而非 bug。
- Windows 不支持(通过浏览器访问 Linux 上的 Shellboard)。
