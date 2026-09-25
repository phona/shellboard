# Shellboard 技术规划

前置阅读:`docs/ARCHITECTURE.md` —— 其 §1.2 边界与 §4 设计决策为约束性内容,本文的实施顺序与选型不得违反。工程红线见根目录 `AGENTS.md`。

## 1. 技术栈与 Monorepo

全部 TypeScript。pnpm workspace:

```text
shellboard/
├── apps/
│   ├── web/               React + Vite 三栏 UI
│   └── server/            Fastify + ws + node-pty + tmux/git/fs
├── packages/
│   ├── contracts/         Zod schemas + 类型(唯一 DTO 来源)
│   └── config/            tsconfig / eslint 共享配置
├── pnpm-workspace.yaml
└── package.json
```

注:UI 组件先并入 `apps/web`,出现真实复用再抽 `packages/ui`,不为抽而抽。

### 1.1 选型决策

| 需求 | 选型 | 说明 |
|---|---|---|
| diff UI | `react-diff-view` | 直接吃 `git diff` 输出,不手写 diff 渲染 |
| 文件编辑器 | CodeMirror 6 | 只当 viewer/editor,不上 LSP |
| SQLite | `better-sqlite3` | 同步 API + 手写 SQL migration,不上 ORM |
| xterm | `@xterm/xterm` | addons:fit / search / web-links / unicode11;WebGL 后置 |
| contracts | Zod | 唯一 DTO 来源,同时承担运行时校验 |

## 2. 里程碑

### M0 — Skeleton

```text
monorepo 脚手架;root scripts:pnpm dev(server+vite 并行,代理)/ pnpm check(tsc -b + eslint)/ pnpm test
SQLite migrations/0001_init.sql(projects、sessions)+ 极简 migrate runner
contracts:Project / Session / SessionRuntime / WsEvent(Zod)
web:三栏布局(240px / flex-1 / 420px,左右可 collapse)、设计 token、System/Light/Dark、空状态
```

验收:`pnpm dev` 可打开;主题切换正常;`pnpm check` 全绿。此时只有 UI。

### M1 — Session + Real Terminal(第一个自用节点)

```text
ProjectService / SessionService(CRUD + presets:codex/claude/opencode/gemini/shell/custom;创建前检查二进制存在)
tmux 集成:dedicated socket(ARCHITECTURE.md D2)、new/kill/rename、启动时 reconcile
TerminalBridge:node-pty attach + WS 管道、resize、心跳、指数退避重连
Take Over(D4);断开语义(D5)
```

验收(真 tmux+bash 集成测试 + 真实 agent 手测):

```text
create 后 tmux session 真启动;关浏览器 Agent 不死;重开可重新 attach
resize 后 Codex/Claude UI 不错位;Ctrl+V、IME 中文、长输出、scrollback 正常
kill 后 tmux session 真消失;restart 恢复;双客户端触发 Take Over
```

M1 完成立刻开始自用,问题反馈驱动后续里程碑。

### M2 — Activity

```text
ActivityObserver:1s 轮询单 socket 调用,状态机 + lastActivityAt(D3)
WS /api/events 广播;sidebar 只订阅、零 HTTP 轮询
sidebar 完整形态:name/agent/branch(轻量 git 调用,缓存)/activity/相对时间
右键菜单(rename/restart/kill/copy cwd)、`/` 搜索、project 折叠
```

验收:真实 session 上 working/cooling/idle/exited 切换正确;ActivityObserver 不依赖任何浏览器连接。

### M3 — Diff(session 级)

```text
GitService 基于 session.cwd(D1):status --porcelain=v2 --branch / diff --no-ext-diff / diff --cached
git add -- / git restore --(discard 在 UI 必须二次确认)
右侧 Diff tab:文件列表(M/A/D/?)、react-diff-view、unified/split 切换、binary 文件占位
```

验收:diff 输出与 CLI 一致;staged/unstaged 分组正确;大 repo 不卡 UI。

### M4 — Files + Tool Terminal

```text
FileService:list/read/write/create/rename/delete/upload/download
path sandbox:resolve + 逐段 realpath,拒绝越界与 symlink escape(D1)——专项安全测试
CodeMirror 6 viewer/editor,保存前 mtime 冲突检查
Tool terminal:WS /:id/tools/terminal,node-pty 直连 bash,随浏览器关闭结束
```

验收:`../`、URL 编码、symlink 指向 external 等全部拒绝;读写往返一致;tool terminal 与 agent shell 互不干扰。

### M5 — Polish

```text
快捷键(中央 keybinding map)、面板宽度持久化、responsive
auth:token 登录 + HttpOnly cookie + WS Origin 校验;默认监听 127.0.0.1
activity 通知(working→idle 持续 N 秒 → browser notification,可选 webhook)
History 按钮(copy-mode,见 D5);systemd unit + 部署文档
```

验收:`ARCHITECTURE.md` §1.3 成功标准全表过一遍。不加 Agent 智能。

## 3. Coding Agent 工作流拆分

| workstream | 依赖 | 内容 |
|---|---|---|
| foundation | — | M0 全部(含 scripts/migrations/contracts) |
| session/tmux | foundation | M1 的 SessionService + tmux 集成 |
| terminal/pty | session/tmux | M1 的 TerminalBridge + WS + 重连 |
| activity | session/tmux | M2 |
| git | foundation | M3 后端 + 安全测试 |
| files | foundation | M4 后端 + sandbox 安全测试 |
| frontend | 对应后端就绪 | 各里程碑 UI |

规则:

- 接口变更先改 `packages/contracts`,前后端跟随,禁止各自手写 DTO。
- 每个 workstream 自带集成测试:真 tmux/git/fs,不 mock 被测系统。
- Agent 不得扩大 scope;`AGENTS.md` 红线优先于一切便利。
- 文档落后于实现时,以实现行为为准修文档,而不是绕过文档。

## 4. 测试矩阵

| 场景 | 必须验证 |
|---|---|
| Create session | tmux(dedicated socket)真启动,不触碰用户默认 server |
| Browser close | Agent 进程不死,tmux session 保留 |
| Browser reopen | 重新 attach,内容为当前屏 |
| Resize | Codex/Claude TUI 不错位 |
| Ctrl+V / IME 中文 | 输入正常 |
| Long output / scrollback | 不丢数据 |
| Kill / Restart | tmux session 真消失 / 恢复 |
| Take Over | 旧 PTY 断开,新 PTY 接管 |
| Activity | working/cooling/idle/exited 按阈值切换,离线也能观测 |
| Path traversal | `../`、编码变体、symlink escape 全部拒绝 |
| Git discard | 有确认,结果与 CLI 一致 |
| 主题 | Light/Dark 下终端配色跟随 |

## 5. 风险清单

- `node-pty`、`better-sqlite3` 是原生模块:锁精确版本;部署机需要编译工具链,README 写明。
- tmux ≥ 3.2 是硬依赖;dedicated socket 隔离要有测试。
- OSC 52 剪贴板:浏览器可能拦截,需要降级提示。
- IME composition 在 xterm.js 的行为,M1 必须真机手测。
- 代码量预算:核心 7k–12k LOC,含测试 ≤ 18k。显著超过 25k 时停下审查:是不是又在做平台了?
