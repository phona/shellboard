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
自研 terminal emulator / 用 capture-pane 重建终端语义(仅 D7 历史种子的字节透传例外)
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

重连(浏览器标签存活)时客户端缓冲由 D7 种子重新播种(`seed-start` 控制帧先清空旧缓冲,避免与旧转录重复),滚动历史连续;刷新/标签被浏览器丢弃后,同样由**接入历史种子**恢复 tmux 内的历史(默认 ≈5000 行,含颜色);更早或需要完整原文时走 `tmux -L shellboard attach`(history-limit 50000)。

### D6 用户主动的路径注入(Send to terminal)

Shellboard 不解析终端状态、不自主发起任何 PTY 输入(见开头红线)。唯一 carve-out 与 History 按钮同类:**用户显式点击**触发的 `tmux send-keys -l -- <绝对路径>`——纯文本、无换行、不回车,字节与键盘输入不可区分,提交永远由用户完成。禁止任何变体:自动粘贴、定时发送、带 `Enter`、读取屏幕来决定时机。"现在能不能打字"这个问题要么读屏(禁止)要么瞎猜(会打坏 vim/半行命令),所以时机责任永远在用户:终端就在眼前,点击前可见。

### D7 缓冲区 pane 与滚动(no-alt-screen attach + 接入历史种子)

live 画面的传输是忠实的字节搬运,累积机制在 **tmux 侧**:shellboard 的 tmux 以 `terminal-overrides` 移除 `smcup`/`rmcup`/`indn`(注意用 terminfo 小写名,tmux 内部名 Smcup/Rmcup 在 overrides 中不匹配),web 客户端因此被 tmux 当作**无备用屏的普通滚动终端**:

- 无 1049 包裹,pane 渲染进客户端**主缓冲**;pane 滚动以底边距 LF 到达(带 indn 时 tmux 会发 CSI S scroll-up,其语义是丢弃——历史上 v2 客户端剥离 1049 后转录仍无法累积,根因即此)。
- 转录在本地 scrollback 天然生长;滚动/搜索/选择全部纯本地、零网络往返、零重放(缓冲从字节流锁定步进生长,不存在任何重放)。
- **滚动路由**:客户端跟踪 DECSET 1049(overrides 生效时不会出现;若出现说明 overrides 未生效)——全屏应用拥有视口时滚轮等量转为方向键作为普通输入(iTerm2 alternate-scroll 语义);普通 pane 滚本地缓冲。桌面滚轮、移动端滑动(内容跟手指+惯性)、PageUp/Down、Ctrl+End 全部本地即时;`touch-action: none` 保证真机上浏览器不抢手势。
- **鼠标报告**(1000/1002/1003/1006/1015)被吞噬:普通拖拽保持浏览器原生选择。
- **终端内粘贴的路由**(用户已批准的窄 carve-out):xterm 6.0 的 paste 处理无条件 `stopPropagation`,窗口冒泡监听永远收不到终端内粘贴;终端聚焦时的截图上传由 **capture 阶段**监听完成——仅当剪贴板**只有文件/图片、完全无文本**时才 `preventDefault`+`stopPropagation` 并转入上传缓冲区(xterm 只消费 `text/plain`,空串本就是 no-op,拦走不夺走终端任何字节);含任何文本的粘贴一律放行,文本粘贴与 IME 逐字节不变(1.3 成功标准)。
- **接入历史种子**(唯一 capture-pane carve-out,用户已批准):tmux attach 协议只发当前屏,冷启动页面将无历史可滚。桥接等客户端首帧 `init`/`resize` 生效、tmux 按本客户端尺寸重排后的首个重绘帧(屏障),执行一次 `capture-pane -p -e -T -S -4990 -E -1`(可见屏之上的历史,含 SGR 颜色,上限对齐客户端 scrollback),**字节原样**先于 live 流发给接入客户端;服务端不解析、不落盘、不进日志、无其他消费方。`-E -1` 精确止于可见屏之上,与随后的 attach 重绘无缝拼合;历史为空(`#{history_size}` 为 0)时跳过种子,避免首行与重绘重复。种子前发送 `seed-start` 控制帧:客户端先清空本地转录再接收,重连因此是重新播种而非叠加重复块。
- **已知边界**:全屏应用(vim/less)运行期间帧不污染 scrollback(经典 no-alt-screen 行为,退出后恢复原画面);tmux 对爆炸式输出会合并刷新(如 `seq 1 300` 一瞬打完),中间行不逐行到达——真实 agent 输出速度不受影响;接缝处(捕获与放行间隙)繁忙 pane 可能重复个别行。
- **重绘型 TUI 与 scrollback 复合模型**:agent CLI(StepCode/Codex/Claude Code 一类)流式输出时每次更新都全量重绘整条消息(实测一条 60 行回复的 wire ≈ 370KB,约 36 倍重绘)。tmux 把每次重绘作为屏幕变更转发,因此纯字节流累积的客户端 scrollback 会与 pane 真相漂移(重复副本、行错位后的重绘落错行)。pane 自身历史保持干净(capture-pane 每行一份)。
- **校准机制**:客户端 scrollback 是 pane 真相的缓存而非真相本身。用户向上翻入历史时(或翻到缓冲顶部请求更深历史时),客户端向服务端请求从 pane 全量重推,阅读位置恢复;慢网(种子传输 > 1s 自测)下降级为浅深度(1000 行)以控制成本。直播保真路径不受影响。
- **已知边界(本层不可修)**:TUI 的重绘带宽(~36 倍/消息)与它自己的 `+N lines (ctrl+o to expand)` 折叠标记,均在 tmux 之上,shellboard 不解析、不干预(字节不透明红线);流式演播途中向上翻,看到的可能仍是重绘残影,校准发生在用户翻入历史时。

### D8 任务完成通知:状态驱动为主,agent 声明为精

Shellboard 永远不从终端字节推断"任务完成"(bytes are opaque);D3 的 working→idle 是唯一可用的状态信号。

**状态驱动(默认路径,零接线)**:ActivityTracker 的 working→idle 跃迁接同一个 hook 扇出。工作阶段自离开 idle/exited 起算(穿过 cooling 不重置——<10s 的停顿是同一阶段),持续 ≥ `SHELLBOARD_NOTIFY_IDLE_MIN_MS`(默认 30s,0 关闭)、session 非 shell 类型(交互 shell 每条命令都是一次 working→idle)时,以 `<name> is now idle` 触发 `~/.shellboard/notify/` 的 hooks。附着状态**不**设门槛:开着的 web 标签会让 PTY 长时间保持 attached 而无人观看,"是否在看"是浏览器通知的职责(document.hidden),不是服务端的。这是启发式而非精确信号(静默思考 >阈值 会误报、等待输入也会触发),且只走 hooks 不走 WS 广播(web 端对该跃迁本就有浏览器通知)。

**agent 声明(精确路径,按需接线)**:agent CLI 自带 hook 机制(Claude Code 的 Stop、Codex 的 `notify`、shell 手动执行)调用零依赖 CLI `shellboard-notify`(读 `TMUX_PANE` 与 `~/.shellboard/notify-token`)→ `POST /api/notify`:定位 session(显式 `sessionId`,或 `TMUX_PANE` → tmux `display-message` 查 `#{session_name}` → 按不可变 tmuxName 反查;定位不到也照常通知,`session: null`),广播 `session.notify` 到 `/api/events`(web toast + 后台时浏览器 Notification),并 spawn hooks。

**hooks 执行边界(两条触发路径共用)**:`~/.shellboard/notify/` 下每个 `*.js`/`*.mjs` 在事件时 spawn(payload 与 WS 事件同形、走 stdin;子进程崩溃隔离,每次重读目录,文件名加 `.disabled.` 即停用;超时 SIGKILL;hook 的 cwd 为 session.cwd,注入 `SHELLBOARD_SESSION_ID/NAME/CWD`)。能运行的只有用户放进该目录的文件,触发源只能决定 hook 是否运行,不能决定运行什么——不是通用 exec endpoint。不做 per-project hook 目录(克隆仓库即执行其代码是供应链风险)。链路上任何失败都不影响 agent 进程与 shellboard。

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
POST   /api/sessions/:id/files/upload         # 二进制上传到 cwd 内目录 ?path=&name=(≤MAX_UPLOAD_BYTES,重名 409)
PATCH  /api/sessions/:id/files                # rename
DELETE /api/sessions/:id/files?path=&recursive=

POST   /api/sessions/:id/uploads              # 二进制上传到上传缓冲区 ?name=(≤MAX_UPLOAD_BYTES,重名自动改名)
GET    /api/sessions/:id/uploads              # 缓冲区列表(最新在前)
DELETE /api/sessions/:id/uploads?name=        # 删除缓冲区文件
POST   /api/sessions/:id/uploads/send         # 把绝对路径打进 agent pane(D6,无换行不回车)

POST   /api/notify                            # agent hook 上报通知(notify token / cookie,见 D8)

WS     /api/sessions/:id/tools/terminal       # session.cwd 下 bash,不落 tmux,随浏览器关闭结束

GET    /api/fs/directories?path=              # 只读目录浏览(项目路径选择器),仅列目录名,受统一鉴权保护

WS     /api/events                            # SessionCreated/Updated/Deleted/ActivityChanged/Notify
```

禁止任何形式的通用 exec endpoint。

## 6. 安全与日志边界

这个项目权限极高,本质是:

```text
Web Shell + 文件系统写 + Git 写
```

- 默认监听 `127.0.0.1`;远程访问推荐 Cloudflare Tunnel 或 Tailscale,不裸暴露公网。
- 应用层:token 登录 + HttpOnly cookie、WebSocket Origin 校验、CSRF 保护、全路由(含 WS upgrade)鉴权。绑定非回环地址且未设置 `SHELLBOARD_TOKEN` 时,启动自动生成随机 token 并打印(Jupyter/code-server 模式),不允许无鉴权暴露。
- `/api/notify` 用独立的 notify token:服务端启动时生成并落盘 `~/.shellboard/notify-token`(0600),`shellboard-notify` CLI 自动读取;web 端走 cookie。该路由会触发用户 hook 脚本,即使 cookie auth 关闭(本地回环)也要求 token,防浏览器 drive-by POST。
- 所有 path 经 `resolve` + 逐段 `realpath` 验证仍位于 session `cwd` 内,拒绝 `../` 与 symlink escape(见 D1)。
- 所有执行动作走显式 service(SessionService / GitService / FileService),参数经 Zod 校验;Custom session command 仅在用户主动创建时允许,不暴露成通用远程 exec。
- 日志只记录:session lifecycle、PTY connect/disconnect、tmux errors、git 操作、文件写删、auth 事件。**绝不记录终端输入输出,默认不偷偷做 transcript。**
