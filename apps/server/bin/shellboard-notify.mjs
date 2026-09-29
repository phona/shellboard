#!/usr/bin/env node
// shellboard-notify — called by agent CLI hooks (Claude Code Stop, Codex
// notify, a manual line in a shell) to push a completion notification into
// Shellboard. Zero-dependency: run with plain `node` (>= 22, global fetch).
//
//   shellboard-notify --title "task done" [--body "..."] [--level success]
//
// Session attribution is automatic inside a shellboard pane: tmux sets
// TMUX_PANE and the server resolves it to the owning session. Outside a
// pane, pass --session <id> explicitly.
//
// The notify token is read from <home>/.shellboard/notify-token (server
// persists it on first start). Failures exit non-zero; agent hooks treat
// that as non-blocking, so a dead server never disturbs the agent.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const USAGE = `usage: shellboard-notify --title <text> [options]

options:
  --title,  -t <text>   notification title (required)
  --body,   -b <text>   optional longer text
  --level,  -l <level>  info | success | warning | error (default: info)
  --session,-s <id>     shellboard session id (default: auto via TMUX_PANE)
  --pane,   -p <id>     tmux pane id override (default: $TMUX_PANE)
  --url,    -u <url>    shellboard base url
                        (default: $SHELLBOARD_URL or http://127.0.0.1:\${port})
  --home,   -h <dir>    shellboard home (default: $SHELLBOARD_HOME or ~/.shellboard)
  --help                show this help`;

function fail(message) {
  process.stderr.write(`shellboard-notify: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    title: undefined,
    body: undefined,
    level: process.env.SHELLBOARD_NOTIFY_LEVEL ?? "info",
    session: undefined,
    pane: process.env.TMUX_PANE,
    url: process.env.SHELLBOARD_URL,
    home: process.env.SHELLBOARD_HOME ?? path.join(homedir(), ".shellboard"),
  };
  for (let i = 0; i < argv.length; i++) {
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) fail(`missing value for ${argv[i]}`);
      i += 1;
      return v;
    };
    switch (argv[i]) {
      case "--title":
      case "-t":
        args.title = value();
        break;
      case "--body":
      case "-b":
        args.body = value();
        break;
      case "--level":
      case "-l":
        args.level = value();
        break;
      case "--session":
      case "-s":
        args.session = value();
        break;
      case "--pane":
      case "-p":
        args.pane = value();
        break;
      case "--url":
      case "-u":
        args.url = value();
        break;
      case "--home":
      case "-h":
        args.home = value();
        break;
      case "--help":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      default:
        // Agent harnesses append their own payload as a positional argument
        // (e.g. Codex `notify` passes its JSON event as $1) — ignore it.
        if (!argv[i].startsWith("-")) break;
        fail(`unknown flag: ${argv[i]}\n\n${USAGE}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.title) fail(`--title is required\n\n${USAGE}`);

const baseUrl =
  args.url ?? `http://127.0.0.1:${process.env.SHELLBOARD_PORT ?? "7700"}`;
let token;
try {
  token = readFileSync(path.join(args.home, "notify-token"), "utf8").trim();
} catch {
  fail(
    `notify token not found at ${path.join(args.home, "notify-token")} — start the shellboard server once to generate it`,
  );
}

const payload = {
  title: args.title,
  ...(args.body !== undefined && { body: args.body }),
  ...(args.level !== "info" && { level: args.level }),
  ...(args.session !== undefined && { sessionId: args.session }),
  ...(args.pane !== undefined && { pane: args.pane }),
};

try {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/notify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    fail(`HTTP ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  }
} catch (err) {
  fail(`${err?.cause?.message ?? err?.message ?? err}`);
}
