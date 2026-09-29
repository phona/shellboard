# AGENTS.md

Shellboard is not an agent platform. Do not add abstractions for agent conversations, tools, prompts, MCP, memory, orchestration, or structured views. Read `docs/ARCHITECTURE.md` (product boundaries, architecture, design decisions) and `docs/PLAN.md` (milestones, tech stack, conventions) before starting work; both are binding. If a scope question is not answered there, ask — do not invent product scope.

## Architecture Invariants

Violating any of these is a design bug, not a style issue:

- Shellboard manages shells, not agents. The native CLI is the canonical agent interface.
- Terminal bytes are opaque. Never parse ANSI, cursor state, prompts, or agent semantics; never reconstruct terminal output. The single carve-out is the connect-time history seed (terminal/bridge.ts, ARCHITECTURE.md D7): `tmux capture-pane -e` bytes forwarded verbatim to the connecting client — no parsing, no logging, no persistence, no other consumer.
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

## Design Context

Canonical copy lives in `.better-web-ui.md`; this section mirrors it so design rules travel with the engineering red lines.

### Users

Primary user: the author, a power-user developer who runs several coding agents in parallel (Codex, Claude Code, OpenCode, Gemini CLI, plain shells) inside tmux, across multiple worktrees of the same repo. Context: all-day daily driver, used next to the agents' own terminals, often with the browser open on a second monitor. Job to be done: launch, switch between, and review many persistent agent shells from one place without ever killing an agent by accident — see all sessions and their activity at a glance, drive the selected agent in its native CLI, and inspect the diff/files of that session's cwd without leaving the page. Secondary audience: teammates who may be given access later — they get the same dense power-user UI, not a simplified mode. Emotional goal: trust and calm competence. The tool should feel like a reliable instrument: nothing surprising, nothing decorative, nothing between the user and the shell. If a screen ever makes the user hesitate, the design failed.

### Brand Personality

Three words: technical, dense, trustworthy. Voice and tone follow the repo's engineering style: concise, direct, technical prose; define unavoidable jargon; no emojis, no cheerful filler. UI copy is written in English (the product's interface language), short and literal — "Rename session", "Kill session", "no sessions", "Select a session" — never chatty, never apologetic, never marketing-flavored. The interface earns trust through precision: exact counts, exact relative times, honest status, destructive actions that state exactly what will happen before they run.

### Aesthetic Direction

A utilitarian developer cockpit in the lineage of Linear, VS Code, and tmux: keyboard-driven, information-dense, dark-friendly, zero ornament. Concretely:

- Theme: light, dark, and system, all first-class. The existing GitHub-Primer-flavored tokens in `apps/web/src/theme.css` are the canonical palette (`--bg #f6f8fa` / `#0d1117`, `--accent #0969da` / `#2f81f7`, plus `--surface*`, `--border`, `--text*`, `--working`, `--idle`, `--danger`, `--warning`, `--term-*`). Extend these tokens; never fork the palette or hardcode hex values in components.
- Palette: cool neutrals with one restrained blue accent. Accent means "primary action" or "selection", never decoration.
- Density: 13px base font, 2–6px paddings, compact rows, 34–42px bars, 26px status bar. This is a cockpit, not a landing page.
- Type: system sans for chrome (`-apple-system, "Segoe UI", ...`), the monospace stack (`--mono`) for every path, branch, diff, and file listing. Code is never set in the sans font.
- Corners: gently rounded, 4–10px (6px for controls, 8–10px for floating surfaces).
- Anti-references: bloated SaaS dashboards, marketing pages, playful/consumer styling, gradient hero sections, oversized headings, card grids, illustration, and anything that competes visually with the xterm.js terminal. The agent's own TUI output is the brightest, most colorful thing on screen; the Shellboard chrome must stay quieter than it.
- Motion: minimal. The only animation is the subtle activity-dot pulse on working/cooling sessions. Respect `prefers-reduced-motion`.

### Implementation Defaults

Precedence for all future UI work: (1) the detected existing project stack below, (2) explicit user preference recorded here, (3) framework-based fallback defaults — the fallbacks are listed only for gaps and are not the baseline.

**Detected existing stack (authoritative baseline):**

- Monorepo: pnpm workspace — `apps/web` (React 18.3 + Vite + TypeScript strict), `apps/server` (Fastify + ws + node-pty + better-sqlite3), `packages/contracts` (Zod schemas, the single DTO source), `packages/config` (shared tsconfig/eslint).
- Styling system: hand-written vanilla CSS in a single `apps/web/src/theme.css`, driven by CSS custom properties and a `data-theme` attribute on `<html>`. Semantic class names (`.session-item`, `.tool-tab`, `.modal`). **Explicit user preference: stay on this vanilla-CSS token system; do not migrate to Tailwind, CSS-in-JS, or shadcn/ui.** New styles extend `theme.css` tokens and follow its existing naming and density conventions.
- Component library: none. Components are hand-rolled locally (`Modal`, `ToastStack`, `DirectoryPickerModal`, `SettingsPopover`), using semantic HTML + ARIA where needed (`role="dialog"`, `aria-label`s on icon buttons, `:focus-visible` outline pattern). Per `docs/PLAN.md`, do not extract `packages/ui` until real reuse exists — don't factor for its own sake.
- Server state: TanStack Query (queries + mutations) plus a WebSocket event stream (`/api/events`) that invalidates queries. Client/UI state: Zustand with `persist` middleware (`apps/web/src/state/store.ts`) for selection, panel widths, tab, font size, scrollback, notifications.
- Forms: no form library. Hand-rolled `<form>` + local `useState` + TanStack Query mutations, with server-side Zod validation via `packages/contracts` and inline `.form-error` display. **Preserve this**; do not introduce React Hook Form/Formik.
- Tables / data grids: none in use; session lists, file lists, and diff file lists are hand-rolled semantic lists. **Preserve**; no AG Grid or similar.
- Virtualization / windowing: none. Scrollback lives in tmux/xterm.js; file and diff lists are plain scrolling lists. **Preserve**; no react-window.
- Headless-primitive ecosystem: N/A — no Radix, no Base UI, no shadcn. All primitives are plain DOM elements with direct event handlers. Record this so future sessions do not assume a Radix-flavored or Base UI-flavored ecosystem.
- shadcn configuration: none. There is no `components.json` and no `shadcn create` / `shadcn apply` baseline in this repo — later sessions must not apply generic shadcn defaults.
- Terminal theming: xterm.js colors are read from the same CSS tokens (`readTerminalTheme()` in `state/theme.ts`), so the terminal automatically follows the light/dark theme. Any new terminal color must go through those tokens.
- Keybindings: all shortcuts go through the central `KEYBINDINGS` map in `apps/web/src/util/dom.ts`; never hardcode key matching in components, and never intercept keys when the target is a typing target or inside `.xterm`.

**Framework fallback defaults (only if a real, approved need arises):**

- If a form library ever becomes necessary in this React project, the framework default is TanStack Form.
- If a data-grid/table library ever becomes necessary, the framework default is TanStack Table.
- If long-list virtualization ever becomes necessary, the framework default is TanStack Virtual.
- Each of these requires a new dependency, which per the Dependencies rule above needs explicit user approval — treat them as last resorts, not defaults to reach for.

**Accessibility target (explicit user preference): WCAG 2.1 AA.** Color contrast for text and UI components, visible focus (`:focus-visible` outline pattern already in `theme.css`), full keyboard operability, and `prefers-reduced-motion` support for any animation beyond the activity-dot pulse. IME composition and clipboard (Ctrl+V) must keep working in the terminal — these are functional requirements, verified in the M1 acceptance list.

### Design Principles

1. **The terminal is the product; the chrome recedes.** Do keep every non-terminal surface quiet — neutral surfaces, 13px type, one blue accent, no shadows beyond the existing elevation token, no illustration — so xterm.js remains the visual anchor. Do not add color, cards, or decoration that competes with the agent's own TUI output, which is intentionally the loudest thing on screen.

2. **Density over decoration.** Do keep compact rows, small type, and tight vertical rhythm; every pixel of chrome is a pixel stolen from the terminal or the diff. Do not introduce marketing-style whitespace, oversized headings, hero sections, or card grids — this is a cockpit modeled on VS Code and tmux, not a landing page.

3. **One obvious primary action per surface.** Do make the single most likely action visually dominant via `.btn.primary` (accent background) and place it at the end of the action row. Do not balance competing primary buttons, and do not use accent color on anything that is not the primary action, a selection, or a link.

4. **Both themes are first-class, and every color is a token.** Do define every color as a `--*` variable in `theme.css`, used by both `[data-theme="light"]` (default) and `[data-theme="dark"]`, and verify new surfaces in both. Do not hardcode hex values in components or ship a surface that only works in one theme. The terminal palette is derived from the same tokens, so theme changes propagate automatically.

5. **Never break the input path.** Do treat IME composition, Ctrl+V/OSC 52 clipboard, the central keybinding map, and focus management as functional requirements with the same weight as features. Do not intercept keystrokes when focus is in an input, a textarea, or the xterm surface, and do not let a modal, toast, or panel steal focus from the terminal unexpectedly.
