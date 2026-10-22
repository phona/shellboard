# SSH Remote Projects 设计提案

状态：R1 实施稿。核心决策已并入 ARCHITECTURE.md D10 和 PLAN.md M6：Project 保存直接连接参数；首期目标 shell 为 Windows PowerShell，本地 tmux 持有 SSH，不要求远端 tmux，也不自动重连 SSH。

## 1. 目标与边界

Remote Project 让 Shellboard 在目标机上启动 agent，并通过现有 Web terminal 操作它。Shellboard 仍管理 shell 和 tmux，不解析 agent 输出或推断 agent 语义。

首期采用以下链路：

```text
Browser → Shellboard WebSocket → 本地 node-pty → 本地 tmux → ssh → 远端 agent
```

本地 tmux 是连接持有者。浏览器关闭或 WebSocket 断开只结束本地 tmux attach 的 PTY；本地 tmux 中的 SSH 进程继续运行。SSH 异常断联后不自动重启；界面显示连接断开，由用户显式重新启动。

首期不提供断线后恢复同一个 agent 的能力。重启会再次执行启动命令，不代表恢复旧进程。远端 tmux、autossh 和常驻远端 helper 不属于首期。

## 2. Project 与 Session 模型

Project 增加位置类型。rootPath 继续保留，含义由位置决定：

```ts
type ProjectLocation =
  | { kind: "local" }
  | {
      kind: "ssh";
      host: string;
      port: number;
      username: string;
      auth:
        | { kind: "key"; identityFile?: string }
        | { kind: "password-prompt" };
    };

interface Project {
  id: string;
  name: string;
  location: ProjectLocation;
  rootPath: string; // 本机或目标机上的绝对路径
  createdAt: string;
}
```

- Session 继承 Project 的连接设置；不允许单独覆盖 host、port、username 或 auth。
- Session.cwd 对 local Project 是本机绝对路径，对 remote Project 是 Windows 绝对路径，例如 `C:\Users\dev\repo`。
- tmuxName 仍由本机 Shellboard 的独立 socket 管理，因此现有全局唯一约束可保留。
- 认证选项为 SSH key/agent（可选服务端本地 identity file 路径）或 password-prompt。只存 auth 类型与可选的密钥路径；密码和私钥内容不写数据库。
- 新建 Project 只做本地字段校验，不在 API 请求中连接远端；密码认证必须在 terminal 的 SSH PTY 中交互。远端目录与命令在 Session 启动时由 PowerShell 脚本检查。
- OpenSSH 用 `-F /dev/null` 加显式 host、port、username、auth 参数，避免依赖用户 alias 或 system ssh config；因此首期不支持 ProxyJump/ProxyCommand。
- 现有 projects 数据迁移为 kind=local。Project 已有关联 Session 时，不允许更改 remote connection fields；rootPath 的更新只影响以后默认创建的 Session。

Windows 目标的 rootPath 必须是 Windows 绝对路径。相对路径、`~` 和 POSIX 路径不接受。

## 3. 远程 Session 启动与终端

本地 tmux session 运行 SSH 命令，SSH 在远端 PTY 中启动 PowerShell agent：

```text
本地 tmux pane:
  ssh -F /dev/null -tt -p <port> -l <username> <host> powershell.exe -EncodedCommand <base64>
```

实现约束：

- 本地 tmux 的 -c 和 node-pty 的 cwd 必须是本机存在的稳定目录，例如 Shellboard homeDir；remote cwd 只用于远端 cd。
- `-EncodedCommand` payload 是 PowerShell 脚本的 UTF-16LE Base64；脚本用 `Set-Location -LiteralPath` 设置 PowerShell location，并同步设置进程级 current directory，让 native agent 继承远端 cwd；之后设置 `$env:KEY=...` 并通过 `& agent args` 启动。PowerShell 字符串按单引号规则转义后再编码。
- Remote Shell session 保持启动用的 PowerShell 进程交互运行，不额外嵌套启动第二个 PowerShell，以保留 Project rootPath 和终端输入状态。
- PowerShell 使用 `-NoProfile` 保持启动稳定，但必须保留交互控制台；不能传 `-NonInteractive`，因为 CLI agent 需要从 PTY 读取输入。
- EncodedCommand 限制为 7600 个 Base64 字符，为 Windows OpenSSH 命令解释器的参数留出空间；超出时 Session 创建会返回错误。
- 不把远端 cwd 交给本机 `path.resolve`、fs 或 `which`。Session 启动时，PowerShell 在目标机检查目录与命令；失败信息显示在 terminal。
- `password-prompt` 不设置 BatchMode；SSH password/keyboard-interactive 和首次 host-key 提示都在 terminal 中完成。密码不经 API 或命令参数传递。
- `key` 模式使用 `ssh-agent` / 默认 identity；可选 `identityFile` 作为 `-i` 参数。SSH agent 必须对 Shellboard server 进程可用。
- 对 SSH 设置连接超时和协议层保活。建议首期默认值为 ConnectTimeout=10、ServerAliveInterval=15、ServerAliveCountMax=3、EscapeChar=none；保活负责发现半开连接，不提供断线恢复。
- 首期不使用 autossh。SSH 进程退出后自动重跑远程 agent 命令可能启动第二个 agent。
- 环境变量按 Session 创建时快照，并在 Restart 时重新应用；env 值不进入日志。PowerShell payload 在本地 ssh argv 中暂时可见；按 D9 既有的同用户进程可见性威胁模型处理。

本地 TerminalBridge 继续 attach 本机 tmux，保持一 session 一个服务端 PTY、Take Over 和浏览器断开语义。D7 历史种子仍由本机 Shellboard tmux capture-pane 生成并只发给接入客户端。Shellboard 继续把 PTY 字节当作不透明数据。

## 4. 生命周期与连接状态

本地 tmux 能证明本地 SSH wrapper 是否存在，不能证明断线后远端 agent 一定退出。Remote Session 必须区分 agent activity 与 SSH transport：

- Activity 继续作为 tmux 输出活动提示，不作为 agent 完成状态。
- 新增 transport 状态，例如 local、connecting、connected、disconnected、unknown。
- connected 表示本地 SSH 子进程仍运行；keepalive 负责在无响应后让它退出。
- disconnected 表示 SSH 已异常退出；界面显示 SSH 断开（X）。远端 agent 状态标为 unknown，不标成已退出。
- unknown 用于 tmux 查询失败或状态无法分类；查询失败不能被解释为 session 已退出。
- 可读取本地 tmux pane_dead 和 pane_dead_status 来保留退出结果。Remote Session 的 pane 需要在命令退出后保留，方便显示 X 和手动重启。
- SSH 客户端退出码 255 可作为断联信号，但远端命令本身也可能返回 255，因此它是启发式分类；无法区分时使用 unknown。
- 不自动 Restart。用户点击 Restart 时，界面说明会重新启动一条 agent 命令，无法恢复断线前的进程。

Kill 会结束本地 tmux session 和 SSH 连接。前台交互命令通常会随远端 PTY 关闭而退出；若自定义命令主动脱离终端或忽略挂断信号，Shellboard 无法保证清理远端残留进程。首期 remote command 应限于前台交互进程；若产品要求断线后精确查询或保证 kill，必须增加远端运行时（例如远端 tmux）。

## 5. 服务边界

| 能力 | Local Project | Remote Project |
|---|---|---|
| Project root 校验 | 本机 fs | 本地格式校验；Session 启动时在远端检查 |
| Session 创建 / Restart | 本机 tmux 启动 agent | 本机 tmux 启动 SSH，远端 PowerShell 启动 agent |
| Terminal attach / history seed | 本机 tmux | 同一本机 tmux；其中 pane 输出来自 SSH |
| Activity | tmux 输出活动 | 本机 tmux 对 SSH 输出的活动提示 |
| Git | 本机 git | 后续通过 SSH 执行固定 Git 操作 |
| Files | 本机 fs sandbox | 后续在目标机执行 canonical path、reparse-point containment 和文件操作 |
| Tool Terminal / Uploads / Notify | 当前本机能力 | 后续逐项设计远端路径 |

不要将远端 cwd 传给本机 FileService 或 GitService。远程 Git/File 的路径解析和 symlink containment 必须在目标机完成。mutating 操作继续走显式 service 和 Zod contracts；不新增接收任意命令的 HTTP endpoint。

远端文件能力有额外的数据位置要求：当前 upload buffer 存在本机，远端 agent 无法读取本机绝对路径。远程上传必须先传到目标机，再把目标机路径送入 agent。远端 notify hook 同样不能假设能读取本机 token 或本机文件。

## 6. UI 与错误反馈

- 新建 Project 表单提供 Local / SSH 选择。SSH 模式显示 Host/IP、Port、Username、Auth method、可选 identity file 和 Windows rootPath。
- Session 继承 Project 的连接配置；列表中显示 `username@host:port`，避免同名项目看不出所在机器。
- 连接状态与 working/idle 活动状态分别展示。断联显示 X / SSH disconnected。
- 断联 Session 可显式 Restart；确认文案说明会启动新命令，不会恢复原会话。
- 首期未实现的远程 Git、Files、Upload 等入口应明确禁用或隐藏，避免对远端路径执行本机操作。

## 7. 分期与验收

### R1：远程 Session 与终端

- Project 支持 local / SSH 位置，并迁移既有 Project 为 local。SSH 字段为 host/IP、port、username、auth method、可选 identity file。
- Windows remote rootPath / cwd 使用 Windows 绝对路径；shell 命令用 PowerShell UTF-16LE EncodedCommand 构造。
- Project 创建不发起 SSH 预检；密码 auth 在 terminal 交互，key auth 在连接时使用 agent/default key/identity file。远端 agent 命令必须在 Windows PATH 中可用；PowerShell 不加载用户 profile。
- 本地 tmux 启动 SSH + PowerShell agent，设置 keepalive；使用 `-F /dev/null` 和显式连接字段，不安装远端 tmux。
- 观察本地 pane/SSH 退出状态并通过现有事件流更新界面。
- 浏览器关闭后 SSH 与 agent 继续运行；SSH 断开后显示 X，不自动启动新 agent。
- 手动 Restart 启动新命令；UI 不称其为 Reconnect。
- 在真实 Windows OpenSSH 主机和 tmux 上验证 PowerShell launch、resize、Take Over、浏览器断开、keepalive、两种认证方式与退出状态。
- 做 PowerShell payload、环境变量和 Windows path 输入的安全检查；终端输入输出不进日志。

### R2：远程 Git 与 Files

- Git 操作限定为现有服务支持的 status、diff、stage、unstage、discard。
- File sandbox 在目标机做 canonical path、realpath 与 symlink containment；写入与校验尽可能在同一次远程操作中完成。
- cwd 内上传、下载和远端 upload buffer 一并设计，确保 agent 收到的是目标机路径。
- 远端目录选择器只浏览已登记 Project 对应的 host 与目录权限范围。

### R3：Tool Terminal 与通知

- Tool Terminal 在目标机 cwd 启动临时 shell，浏览器断开只结束该 SSH PTY。
- Notify/hooks 需要单独设计远端认证和事件回传，不复用本机 token 文件路径的假设。

## 8. 首期明确的限制

1. R1 只交付远程 Project、Session、Activity 和 Terminal；远程 Git/Files、上传在 R2。
2. Remote Kill 结束本地 tmux 与 SSH 前台 PTY。若要在 SSH 已断时保证远端进程终止或重新 attach 同一 agent，需另加远端运行时。
3. 首期不支持 ProxyJump/ProxyCommand；需要跳板机时再增加显式配置字段。host key 仍由 OpenSSH known_hosts 校验，不关闭校验。

## 9. 文档同步

Project location、SSH 生命周期和状态语义已补入 ARCHITECTURE.md D10；远程分期已加入 PLAN.md M6。本文记录 R1 设计与 R2/R3 的后续边界。
