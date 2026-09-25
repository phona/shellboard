# AGENTS.md

Shellboard is not an agent platform. Do not add abstractions for agent conversations, tools, prompts, MCP, memory, orchestration, or structured views. Read `docs/ARCHITECTURE.md` (product boundaries, architecture, design decisions) and `docs/PLAN.md` (milestones, tech stack, conventions) before starting work; both are binding. If a scope question is not answered there, ask — do not invent product scope.

## Architecture Invariants

Violating any of these is a design bug, not a style issue:

- Shellboard manages shells, not agents. The native CLI is the canonical agent interface.
- Terminal bytes are opaque. Never parse ANSI, cursor state, prompts, or agent semantics; never reconstruct terminal output (no capture-pane scraping).
- Observers may report status but must never control session behavior.
- The web terminal lifecycle is not the agent session lifecycle. Closing the browser or dropping the WebSocket must never kill the tmux session or the agent process.
- Session (SQLite) is intent; SessionRuntime (tmux) is fact. tmux is the source of truth — reconcile before acting, never trust a DB flag that says a session is running.
- tmux runs on a dedicated socket (`tmux -L shellboard`). Never touch the user's default tmux server or its options.
- One server-side PTY per session. A second client takes over the PTY; it never shares or mirrors it.
- git/file access is scoped to the selected session's `cwd` (see docs/ARCHITECTURE.md D1). Sandbox every path: resolve against that cwd, verify containment including symlink targets, reject escapes.
- No generic exec endpoint. Every mutating action goes through an explicit service (SessionService, GitService, FileService) with Zod-validated arguments.
- Server binds 127.0.0.1 by default. Never log terminal input/output or file contents.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- TypeScript, strict mode. No `any` unless absolutely necessary.
- Top-level imports only. No dynamic `import()` or `import("pkg").Type`.
- Use only erasable TypeScript syntax (no `enum`, `namespace`, parameter properties, `import =`/`export =`). Use explicit fields with constructor assignments.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Shared DTOs live in `packages/contracts` (Zod). Never hand-write a second copy of a contract in an app.
- All keyboard shortcuts go through the central keybinding map; never hardcode key matching inside components.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.

## Commands

- pnpm workspace (scaffolded in M0). After code changes (not docs): `pnpm check` — typecheck + lint, full output, no tail. Fix all errors before committing. Does not run tests.
- Run a single test file with `pnpm vitest run <path>` from the owning package. Do not run the full Playwright e2e suite unless asked.
- Integration tests spawn real `tmux` (dedicated socket, temp dirs) and real `git`/fs. Never mock tmux, node-pty, or git in tests that exercise them; mocking is allowed only at service boundaries in unit tests.
- If you create or modify a test file, run it and iterate until it passes.
- Ad-hoc scripts: write them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in shell commands.
- Never commit unless the user asks.

## Git

Multiple coding-agent sessions may run in this repo at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work.

Committing:

- Only commit files you changed in this session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- Message format: `{feat,fix,docs}[(server,web,contracts)]: <message>`. Informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`. Never force push.

Rebase conflicts:

- Resolve conflicts only in files you modified. If a conflict is in a file you did not modify, abort and ask the user.

## Dependencies

- Direct dependencies are pinned to exact versions. `node-pty` and `better-sqlite3` are native modules — pin them and never bump silently.
- Install with `pnpm install --ignore-scripts` unless the user asks otherwise. A new dependency with lifecycle scripts requires explicit user approval.
- Treat lockfile changes as reviewed code; never change them incidentally.

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
