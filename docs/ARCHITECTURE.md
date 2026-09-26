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

> **左边切 Agent,中间用 Agent(或点开变更文件看 Diff),右边审查与导航。**

主工作区在 agent terminal 与 DiffView 之间切换:点击 TOOL VIEW 里的变更文件,该文件的 diff 以全宽在中间打开。切换只是显示层的——agent terminal 保持挂载隐藏、WS 不断、尺寸不变,‹ Back to terminal / Esc 返回时 tmux 零 reflow。TOOL VIEW 另支持临时最大化(⛶,fixed 覆盖层,Esc 或 "Back to shell" 返回),右侧 Diff tab 提供扁平分组与目录树两种文件列表。

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
- **唯一的例外是上传缓冲区(attachments lane)**:`~/.shellboard/uploads/<sessionId>/` 是显式建模的第二根(UploadService,自带 sandbox)。它存在的意义是让"丢给 agent 看的附件"完全不写进业务仓库;agent 通过绝对路径读取它。cwd 内的 `files/upload`(用户显式导航到某目录再传)仍走 D1 sandbox,两者是不同的契约:缓冲区重名自动改名,cwd 内重名 409。

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

### D6 用户主动的路径注入(Send to terminal)

Shellboard 不解析终端状态、不自主发起任何 PTY 输入(见开头红线)。唯一 carve-out 与 History 按钮同类:**用户显式点击**触发的 `tmux send-keys -l -- <绝对路径>`——纯文本、无换行、不回车,字节与键盘输入不可区分,提交永远由用户完成。禁止任何变体:自动粘贴、定时发送、带 `Enter`、读取屏幕来决定时机。"现在能不能打字"这个问题要么读屏(禁止)要么瞎猜(会打坏 vim/半行命令),所以时机责任永远在用户:终端就在眼前,点击前可见。

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
POST   /api/sessions/:id/files                # create(JSON)
POST   /api/sessions/:id/files/upload         # 二进制上传到 cwd 内目录 ?path=&name=(≤100MB,重名 409)
PATCH  /api/sessions/:id/files                # rename
DELETE /api/sessions/:id/files?path=&recursive=

POST   /api/sessions/:id/uploads              # 二进制上传到上传缓冲区 ?name=(≤100MB,重名自动改名)
GET    /api/sessions/:id/uploads              # 缓冲区列表(最新在前)
DELETE /api/sessions/:id/uploads?name=        # 删除缓冲区文件
POST   /api/sessions/:id/uploads/send         # 把绝对路径打进 agent pane(D6,无换行不回车)

WS     /api/sessions/:id/tools/terminal       # session.cwd 下 bash,不落 tmux,随浏览器关闭结束

GET    /api/fs/directories?path=              # 只读目录浏览(项目路径选择器),仅列目录名,受统一鉴权保护

WS     /api/events                            # SessionCreated/Updated/Deleted/ActivityChanged
```

禁止任何形式的通用 exec endpoint。

## 6. 安全与日志边界

这个项目权限极高,本质是:

```text
Web Shell + 文件系统写 + Git 写
```

- 默认监听 `127.0.0.1`;远程访问推荐 Cloudflare Tunnel 或 Tailscale,不裸暴露公网。
- 应用层:token 登录 + HttpOnly cookie、WebSocket Origin 校验、CSRF 保护、全路由(含 WS upgrade)鉴权。绑定非回环地址且未设置 `SHELLBOARD_TOKEN` 时,启动自动生成随机 token 并打印(Jupyter/code-server 模式),不允许无鉴权暴露。
- 所有 path 经 `resolve` + 逐段 `realpath` 验证仍位于 session `cwd` 内,拒绝 `../` 与 symlink escape(见 D1)。
- 所有执行动作走显式 service(SessionService / GitService / FileService),参数经 Zod 校验;Custom session command 仅在用户主动创建时允许,不暴露成通用远程 exec。
- 日志只记录:session lifecycle、PTY connect/disconnect、tmux errors、git 操作、文件写删、auth 事件。**绝不记录终端输入输出,默认不偷偷做 transcript。**
