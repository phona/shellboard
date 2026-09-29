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
