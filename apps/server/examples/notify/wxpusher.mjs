#!/usr/bin/env node
// Shellboard notify hook: pushes `session.notify` events to WxPusher.
// Ported from the Kimi Code variant (~/.kimi-code/hooks/wxpusher.sh).
//
// Install: place next to a .env holding WXPUSHER_APP_TOKEN / WXPUSHER_UID
// (see .env.example):
//
//   ~/.shellboard/notify/wxpusher.mjs
//   ~/.shellboard/notify/.env
//
// The server spawns this file on every notify event and writes the payload
// (a `session.notify` event, same shape as the web UI receives) to stdin.
// Like the original: notification failure must never break anything.
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(here, ".env"));

function loadEnvFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const appToken = process.env.WXPUSHER_APP_TOKEN;
const uid = process.env.WXPUSHER_UID;
if (!appToken || !uid) {
  console.error("wxpusher: WXPUSHER_APP_TOKEN or WXPUSHER_UID is empty");
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(await readStdin());
} catch {
  console.error("wxpusher: unreadable payload on stdin");
  process.exit(0);
}

// Dedup: the same session firing the same title within 5s pushes once.
const dedupKey = crypto
  .createHash("sha256")
  .update(`${payload.session?.id ?? "none"}|${payload.title}`)
  .digest("hex")
  .slice(0, 24);
const stampFile = path.join(os.tmpdir(), `shellboard-wxpusher-${dedupKey}`);
const now = Math.floor(Date.now() / 1000);
try {
  const last = Number(readFileSync(stampFile, "utf8"));
  if (Number.isFinite(last) && now - last < 5) process.exit(0);
} catch {
  // first fire for this key
}
try {
  writeFileSync(stampFile, String(now));
} catch {
  // dedup is best-effort
}

const session = payload.session;
const levelSuffix = payload.level === "info" ? "" : ` (${payload.level})`;
const summary = `Shellboard: ${session ? session.name : payload.title}${levelSuffix}`.slice(0, 99);

const lines = [`**${payload.title}**${levelSuffix}`];
if (payload.body) lines.push("", payload.body);
if (session) {
  lines.push("", `会话: ${session.name} (${session.agentType})`);
  lines.push(`目录: \`${session.cwd}\``);
}
const baseUrl = (process.env.SHELLBOARD_WEB_BASE ?? "").replace(/\/$/, "");
if (baseUrl) lines.push("", `[打开 Shellboard](${baseUrl})`);

try {
  const response = await fetch("https://wxpusher.zjiecode.com/api/send/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      appToken,
      content: lines.join("\n"),
      summary,
      contentType: 3,
      uids: [uid],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) console.error(`wxpusher: HTTP ${response.status}`);
} catch (err) {
  console.error(`wxpusher: ${err?.message ?? err}`);
}
process.exit(0);
