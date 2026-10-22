import { z } from "zod";

export const AGENT_TYPES = [
  "codex",
  "claude",
  "opencode",
  "gemini",
  "shell",
  "custom",
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AgentTypeSchema = z.enum(AGENT_TYPES);

export const AGENT_PRESETS: ReadonlyArray<{ id: AgentType; label: string }> = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
  { id: "gemini", label: "Gemini CLI" },
  { id: "shell", label: "Shell" },
  { id: "custom", label: "Custom" },
];

/**
 * Default argv per built-in agent type; `null` means the launch command is
 * decided elsewhere (shell: login shell, custom: user-provided line).
 * Codex launches inline (`tui.alternate_screen=never`): its alt-screen TUI
 * keeps no tmux pane history, which leaves the scroll channel (D7) and
 * copy-mode history nothing to work with.
 */
export const AGENT_DEFAULT_COMMAND: Record<AgentType, string[] | null> = {
  codex: ["codex", "-c", "tui.alternate_screen=never"],
  claude: ["claude"],
  opencode: ["opencode"],
  gemini: ["gemini"],
  shell: null,
  custom: null,
};

/**
 * Environment variables attached to a launch (registered command preset or a
 * one-off session). Delivered to the tmux pane via `new-session -e K=V` (D9),
 * so the agent process and every pane opened later in that session inherit
 * them.
 *
 * Keys are POSIX-safe names. A small deny-list protects the variables tmux and
 * the pane runtime own: overriding TMUX/TMUX_PANE breaks notify attribution
 * (D8) and in-pane tmux detection, TERM breaks rendering, and HOME/SHELL/TMPDIR
 * silently relocate the agent's own state. PATH stays allowed on purpose — a
 * power user pinning `PATH=/opt/claude-2/bin:$PATH` is a real use case, and a
 * wrong value only breaks that user's own pane (fixable by editing the preset).
 */
export const ENV_DENYLIST: readonly string[] = [
  "TMUX",
  "TMUX_PANE",
  "TERM",
  "HOME",
  "USER",
  "LOGNAME",
  "PWD",
  "SHELL",
  "TMPDIR",
];

/** Variables per launch, key length, and value length. Enough for a handful of
    model/endpoint overrides; small enough that the JSON column stays readable. */
export const MAX_ENV_VARS = 24;
export const MAX_ENV_KEY_CHARS = 64;
export const MAX_ENV_VALUE_CHARS = 4096;

export const EnvKeySchema = z
  .string()
  .min(1)
  .max(MAX_ENV_KEY_CHARS)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a POSIX variable name")
  .refine(
    (key) => !ENV_DENYLIST.includes(key) && !key.startsWith("SHELLBOARD_"),
    "reserved for tmux/shellboard runtime",
  );

export const EnvValueSchema = z
  .string()
  .max(MAX_ENV_VALUE_CHARS)
  .refine((value) => !value.includes("\u0000"), "must not contain NUL");

export const EnvVarMapSchema = z
  .record(EnvKeySchema, EnvValueSchema)
  .refine((map) => Object.keys(map).length <= MAX_ENV_VARS, {
    message: `at most ${MAX_ENV_VARS} variables`,
  });
export type EnvVarMap = z.infer<typeof EnvVarMapSchema>;

/**
 * A user-registered launch command (D9). Persisted server-side; the name is
 * unique, and launching a session from a preset snapshots `command` + `env`
 * onto the session row, so editing or deleting the preset later never mutates
 * a running session.
 */
export const CommandSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  env: EnvVarMapSchema,
  createdAt: z.string(),
});
export type Command = z.infer<typeof CommandSchema>;

/** `env` is optional on every input and normalized to `{}` by the services:
    zod does not apply an object-key default when the key is absent. */
export const CreateCommandInputSchema = z.object({
  name: z.string().min(1).max(64),
  command: z.string().min(1).max(2000),
  env: EnvVarMapSchema.optional(),
});
export type CreateCommandInput = z.infer<typeof CreateCommandInputSchema>;

export const UpdateCommandInputSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  command: z.string().min(1).max(2000).optional(),
  env: EnvVarMapSchema.optional(),
});
export type UpdateCommandInput = z.infer<typeof UpdateCommandInputSchema>;

export const ActivitySchema = z.enum(["working", "cooling", "idle", "exited"]);
export type Activity = z.infer<typeof ActivitySchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  cwd: z.string(),
  agentType: AgentTypeSchema,
  command: z.array(z.string()),
  /** Launch environment, snapshotted from the preset (or the request) at
      creation time and re-applied on restart (D9). */
  env: EnvVarMapSchema,
  tmuxName: z.string(),
  createdAt: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;

export const SessionRuntimeSchema = z.object({
  sessionId: z.string(),
  alive: z.boolean(),
  attachedClients: z.number().int().min(0).max(1),
  lastActivityAt: z.number().nullable(),
  activity: ActivitySchema,
});
export type SessionRuntime = z.infer<typeof SessionRuntimeSchema>;

export const SessionWithRuntimeSchema = z.object({
  session: SessionSchema,
  runtime: SessionRuntimeSchema,
});
export type SessionWithRuntime = z.infer<typeof SessionWithRuntimeSchema>;

export const GitEntrySchema = z.object({
  path: z.string(),
  origPath: z.string().nullable(),
  x: z.string(),
  y: z.string(),
});
export type GitEntry = z.infer<typeof GitEntrySchema>;

export const GitStatusSchema = z.object({
  branch: z.string().nullable(),
  entries: z.array(GitEntrySchema),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

export const GitDiffSchema = z.object({
  text: z.string(),
});
export type GitDiff = z.infer<typeof GitDiffSchema>;

export const FileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["dir", "file", "symlink", "other"]),
  size: z.number(),
  mtime: z.number(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const DirectoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
});
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;

export const DirectoryListingSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(DirectoryEntrySchema),
});
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;

export const FileListSchema = z.object({
  path: z.string(),
  entries: z.array(FileEntrySchema),
});
export type FileList = z.infer<typeof FileListSchema>;

/** One file in the session's upload buffer (~/.shellboard/uploads/<sid>/). */
export const UploadEntrySchema = z.object({
  name: z.string(),
  /** Absolute server-side path — what "Send to terminal" types into the shell. */
  path: z.string(),
  size: z.number(),
  mtime: z.number(),
});
export type UploadEntry = z.infer<typeof UploadEntrySchema>;

export const UploadListSchema = z.object({
  entries: z.array(UploadEntrySchema),
});
export type UploadList = z.infer<typeof UploadListSchema>;

/**
 * Hard ceiling for a single binary upload, in bytes.
 *
 * The server enforces it as Fastify's per-route bodyLimit on both upload
 * lanes; the web client reads the same constant to refuse an oversized file
 * before any bytes leave the device. Behind a Cloudflare front the edge caps
 * a request body at the same size and answers with an HTML 413 that a
 * JSON-parsing client cannot read, so the number has to be known on both
 * sides of the wire and stay in one place.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export const NotifyLevelSchema = z.enum(["info", "success", "warning", "error"]);
export type NotifyLevel = z.infer<typeof NotifyLevelSchema>;

/** Session identity resolved server-side for a notify event. */
export const NotifySessionInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  agentType: AgentTypeSchema,
  cwd: z.string(),
});
export type NotifySessionInfo = z.infer<typeof NotifySessionInfoSchema>;

/**
 * Inbound notify event (D8): the completion signal is declared by the agent
 * CLI's own hook mechanism via the shellboard-notify CLI — never inferred
 * from terminal bytes. `sessionId` names the session explicitly; `pane` is
 * the TMUX_PANE value read inside the pane that ran the hook.
 */
export const NotifyInputSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(4000).optional(),
  level: NotifyLevelSchema.default("info"),
  sessionId: z.string().min(1).optional(),
  pane: z.string().min(1).max(100).optional(),
});
export type NotifyInput = z.infer<typeof NotifyInputSchema>;

export const FileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  binary: z.boolean(),
  size: z.number(),
  mtime: z.number(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

export const WsEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.created"), session: SessionSchema }),
  z.object({ type: z.literal("session.updated"), session: SessionSchema }),
  z.object({ type: z.literal("session.deleted"), sessionId: z.string() }),
  z.object({
    type: z.literal("session.activity"),
    runtime: SessionRuntimeSchema,
  }),
  z.object({ type: z.literal("git.status_changed"), projectId: z.string() }),
  z.object({
    type: z.literal("session.notify"),
    title: z.string(),
    body: z.string().nullable(),
    level: NotifyLevelSchema,
    at: z.number(),
    /** Null when the event could not be attributed to a session. */
    session: NotifySessionInfoSchema.nullable(),
  }),
]);
export type WsEvent = z.infer<typeof WsEventSchema>;

export const CreateProjectInputSchema = z.object({
  name: z.string().min(1),
  rootPath: z.string().min(1),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const UpdateProjectInputSchema = z.object({
  name: z.string().min(1).optional(),
  rootPath: z.string().min(1).optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

export const CreateSessionInputSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1),
  cwd: z.string().optional(),
  agentType: AgentTypeSchema,
  command: z.string().optional(),
  /** Applied to the pane for any agentType, not just custom (D9). */
  env: EnvVarMapSchema.optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

export const UpdateSessionInputSchema = z.object({
  name: z.string().min(1).optional(),
});
export type UpdateSessionInput = z.infer<typeof UpdateSessionInputSchema>;

export const GitActionInputSchema = z.object({
  path: z.string().min(1),
});
export type GitActionInput = z.infer<typeof GitActionInputSchema>;

export const GitDiffQuerySchema = z.object({
  path: z.string().optional(),
  staged: z
    .enum(["0", "1"])
    .optional()
    .transform((v) => v === "1"),
});

export const SaveFileInputSchema = z.object({
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  mtime: z.number().optional(),
});
export type SaveFileInput = z.infer<typeof SaveFileInputSchema>;

export const CreateFileInputSchema = z.object({
  path: z.string().min(1),
  type: z.enum(["file", "dir"]),
  content: z.string().optional(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});
export type CreateFileInput = z.infer<typeof CreateFileInputSchema>;

export const RenameFileInputSchema = z.object({
  path: z.string().min(1),
  newName: z.string().min(1),
});

/** Control characters never belong in a file name. The hard case is the
 *  newline: "Send to terminal" (D6) types the buffer path literally with
 *  `send-keys -l`, and a newline byte in that path is a line submit — the
 *  pane would execute the path's first line. Rejected at the contract so
 *  no route can forget. */
const noControlChars = (value: string): boolean => !/[\u0000-\u001f\u007f]/.test(value);

export const SendUploadInputSchema = z.object({
  name: z.string().min(1).refine(noControlChars, "invalid file name"),
});
export type SendUploadInput = z.infer<typeof SendUploadInputSchema>;

/** Binary upload into the session's upload buffer: ?name=<filename> */
export const UploadQuerySchema = z.object({
  name: z.string().min(1).refine(noControlChars, "invalid file name"),
});

/** Binary upload into a directory inside the session cwd: ?path=<dir>&name= */
export const UploadToDirQuerySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).refine(noControlChars, "invalid file name"),
});

export const AuthLoginInputSchema = z.object({
  token: z.string().min(1),
});
