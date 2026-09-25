# Shellboard 架构文档

> **A vendor-neutral web cockpit for persistent coding-agent shells.**
> 管理 Shell,不抽象 Agent。

本文回答"Shellboard 是什么、不是什么、如何组成"。工程红线见根目录 `AGENTS.md`;实施顺序与技术选型见 `docs/PLAN.md`。本文的 §1.2 边界与 §4 设计决策为**约束性**内容。

## 架构哲学

> **Shellboard manages shells, not agents.**
> **The native CLI is the canonical agent interface.**
> **Terminal bytes are opaque. Agent semantics are opaque.**
> **Observers may report status, but must never control session behavior.**

Codex、Claude Code、OpenCode、Gemini CLI,以及未来任何厂商,只要能跑在终端里,就天然兼容。新 Agent 的接入成本是:

```ts
{ id: "new-agent", label: "New Agent", command: ["new-agent"] }
```

## 1. 产品目标与边界

### 1.1 只解决五个问题

```text
Session / Shell / Activity / Diff / Files
```

界面沿用三栏信息架构,三个区域的职责永远不变:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Shellboard       Project: race-platform         Search     ☀/☾    ⚙     │
├────────────────┬────────────────────────────────┬───────────────────────┤
│ SESSION VIEW   │          AGENT SHELL           │      TOOL VIEW        │
│                │                                │                       │
│ ⟳ backend      │                                │ [Diff][Files][Term]   │
│   Codex        │                                │                       │
│   main · 12s   │          xterm.js              │ M order.ts            │
│                │                                │ M refund.ts           │
│ ○ frontend     │                                │ A design.md           │
│   Claude       │                                │                       │
│   feat/ui · 8m │                                │                       │
│                │                                │                       │
│ × old-test     │                                │                       │
├────────────────┴────────────────────────────────┴───────────────────────┤
│ 3 sessions · 1 working · 2 idle · main · 12 changed files               │
└─────────────────────────────────────────────────────────────────────────┘
```

> **左边切 Agent,中间用 Agent,右边审查 Agent。**

### 1.2 Non-goals(约束性)

Shellboard 永远不做:

```text
Structured View / Conversation abstraction / Tool-call renderer
Prompt management / Agent planner / Agent orchestration / Subagent protocol
MCP manager / Memory / embeddings / vector DB
Agent-specific transcript parser
自研 terminal emulator / capture-pane 终端重建
```

也不试图理解:

```text
Codex 是不是 thinking;Claude 是不是 tool calling
Agent 是不是 planning;Agent 在调用什么 subagent
```

Shellboard 看不到这些,也不应该看到。

### 1.3 成功标准

功能不做加法,直到全部达标:

```text
打开页面 < 1s;切换 session 快;终端流畅无卡顿
Ctrl+V 与 IME 永远正常;Agent UI 新版无需 Shellboard 适配
浏览器刷新 Agent 不死;十几个 session CPU 占用低
Diff/Files 随手可看;Dark/Light 都舒服
```

## 2. 总体架构

Shellboard 是 **control plane + observation plane**;interaction plane 完全透传。

```text
                            Browser
                               │
                ┌──────────────┴──────────────┐
                │ React + Vite                │
                │                             │
                │ SessionView                 │
                │ AgentTerminal (xterm.js)    │
                │ DiffView                    │
                │ FileView                    │
                │ ToolTerminal                │
                └──────────────┬──────────────┘
                               │
                        HTTP + WebSocket
                               │
                ┌──────────────▼──────────────┐
                │ Node.js / TypeScript        │
                │ Fastify                     │
                │                             │
                │ ProjectService              │
                │ SessionService              │
                │ TerminalBridge              │
                │ ActivityObserver            │
                │ GitService                  │
                │ FileService                 │
                └───────┬────────┬────────────┘
                        │        │
              ┌─────────┘        └──────────┐
              ▼                            ▼
            tmux                          git/fs
              │
      ┌───────┼─────────┐
      ▼       ▼         ▼
    Codex   Claude    OpenCode
```

Interaction plane,即真正的输入输出链路:

```text
xterm.js
   ⇅
WebSocket
   ⇅
node-pty(tmux attach)
   ⇅
原生 Agent CLI
```

这是核心原则:**Terminal bytes are opaque**。Server 不知道 ANSI 是什么、cursor 在哪、prompt 在哪、Agent UI 长什么样——统统不知道,两个 pipe 而已:

```text
PTY output → WS → xterm.write()
xterm.onData() → WS → pty.write()
```

## 3. 领域模型

```ts
interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
}

interface Session {
  id: string;
  projectId: string;
  name: string;
  /** 工作目录,同时是 Tool View(git/files/path)sandbox 的根,见 D1 */
  cwd: string;
  agentType: "codex" | "claude" | "opencode" | "gemini" | "shell" | "custom";
  command: string[];
  tmuxName: string;   // 创建后不可变
  createdAt: string;
}

interface SessionRuntime {
  sessionId: string;
  alive: boolean;
  attachedClients: number;   // 服务端恒为 0 或 1,见 D4
  lastActivityAt: number | null;
  activity: "working" | "cooling" | "idle" | "exited";
}
```

**Session ≠ SessionRuntime**:Session 是 SQLite 里的配置(intent),SessionRuntime 是 tmux 的当前事实(fact)。tmux 是 source of truth:启动时及每次动作前 reconcile(`SQLite × tmux list-sessions`),永远不假设 DB 说 running 就真的 running。

## 4. 设计决策(约束性)

以下决策为评审后拍板,与早期草案冲突时以本文为准。

### D1 Tool View 以 session 为作用域

git / files / tool terminal 的作用域是**当前选中 session 的 `cwd`**,不是 project root。Project 只是 session 的分组容器。

- API 一律 session 级:`/api/sessions/:id/git/...`、`/api/sessions/:id/files/...`、`/api/sessions/:id/tools/terminal`。project 级只保留 CRUD。
- path sandbox 基准 = `session.cwd`;`session.cwd` 为空时回落 `project.rootPath`。
- 理由:支持一个 project 下多 worktree 并行多个 session;消除"右侧看的是哪个分支的 diff"的歧义。

### D2 独立 tmux socket

所有 tmux 操作走 `tmux -L shellboard ...`,与用户自己的 tmux server 完全隔离(会话列表互不可见、选项互不污染、命名不冲突)。创建 session 时显式设置所需选项:

```bash
tmux -L shellboard new-session -d -s sb-xxx -c /path/to/cwd codex
tmux -L shellboard set-option -t sb-xxx monitor-activity on
```

用户仍可从真终端调试:`tmux -L shellboard attach -t sb-xxx`。测试必须验证不会触碰用户默认 server。

### D3 Activity 语义

基于 tmux 输出活动 `#{session_activity}`,`monitor-activity on` 在创建时显式设置(不赌默认值)。observer 每 1 秒一次 `tmux -L shellboard list-sessions -F ...`,状态变化才广播:

```text
session missing            → exited
activity < 3s              → working
3s ≤ activity < 10s        → cooling(仅 spinner 淡化,不显示文字)
activity ≥ 10s             → idle
```

接受不精确:Agent 静默思考 30 秒显示 idle 可以接受,这只是 UI hint,不为准确性引入 Agent 语义理解。

### D4 PTY 与多客户端

每个 session 服务端至多一个 PTY。第二个客户端 attach 时:旧 PTY 断开,新 PTY attach(Take Over)。不做协同、不做镜像、不做输出回放。

### D5 连接生命周期

WebSocket 断开 / 浏览器关闭 → 只杀 node-pty(tmux client),不碰 tmux session,Agent 继续运行。重开 → 新 PTY 重新 attach。**Web terminal lifecycle ≠ Agent session lifecycle**,必须有集成测试。

已知 UX 限制:重连后 xterm.js 只有当前屏,历史输出在 tmux copy-mode 里。M5 提供 History 按钮向 PTY 写入 prefix+`[`,并在文档写明。

## 5. API Surface(全集)

```text
GET    /api/projects
POST   /api/projects
PATCH  /api/projects/:id
DELETE /api/projects/:id

GET    /api/sessions                  # 含 runtime 合并视图
POST   /api/sessions
PATCH  /api/sessions/:id              # rename 等
DELETE /api/sessions/:id              # kill
POST   /api/sessions/:id/restart

WS     /api/sessions/:id/terminal     # 二进制帧 + JSON 控制帧(resize/ping)

GET    /api/sessions/:id/git/status           # porcelain=v2 --branch,基于 session.cwd
GET    /api/sessions/:id/git/diff?path=
POST   /api/sessions/:id/git/stage
POST   /api/sessions/:id/git/unstage
POST   /api/sessions/:id/git/discard          # 破坏性,UI 必须确认

GET    /api/sessions/:id/files?path=          # 列目录
GET    /api/sessions/:id/files/content?path=
PUT    /api/sessions/:id/files/content?path=
GET    /api/sessions/:id/files/download?path= # 原始字节下载(≤100MB)
POST   /api/sessions/:id/files                # create/upload
PATCH  /api/sessions/:id/files                # rename
DELETE /api/sessions/:id/files?path=&recursive=

WS     /api/sessions/:id/tools/terminal       # session.cwd 下 bash,不落 tmux,随浏览器关闭结束

WS     /api/events                            # SessionCreated/Updated/Deleted/ActivityChanged
```

禁止任何形式的通用 exec endpoint。

## 6. 安全与日志边界

这个项目权限极高,本质是:

```text
Web Shell + 文件系统写 + Git 写
```

- 默认监听 `127.0.0.1`;远程访问推荐 Cloudflare Tunnel 或 Tailscale,不裸暴露公网。
- 应用层:token 登录 + HttpOnly cookie、WebSocket Origin 校验、CSRF 保护、全路由(含 WS upgrade)鉴权。
- 所有 path 经 `resolve` + 逐段 `realpath` 验证仍位于 session `cwd` 内,拒绝 `../` 与 symlink escape(见 D1)。
- 所有执行动作走显式 service(SessionService / GitService / FileService),参数经 Zod 校验;Custom session command 仅在用户主动创建时允许,不暴露成通用远程 exec。
- 日志只记录:session lifecycle、PTY connect/disconnect、tmux errors、git 操作、文件写删、auth 事件。**绝不记录终端输入输出,默认不偷偷做 transcript。**
