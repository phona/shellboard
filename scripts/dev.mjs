// Root dev orchestrator: runs the API server and the vite dev server in
// parallel and forwards CLI args to vite only, so the standard command works:
//
//   pnpm dev -- --host 0.0.0.0 --port 5199
//
// (`pnpm -r dev` cannot forward args cleanly — vite receives a literal `--`
// and treats --host as a positional.) API host/port stay env-driven:
// SHELLBOARD_HOST / SHELLBOARD_PORT.
//
// Exposing the web dev server on a non-loopback interface auto-enables token
// auth (Jupyter/code-server style): a token is generated, printed once, and
// injected into the API server's env.
//
// Two guards exist because orphaned watchers used to make `pnpm dev`
// un-runnable for days: children are spawned in their own process groups and
// shutdown kills those groups (SIGTERM, then SIGKILL), so a ^C can never
// leave a surviving `tsx watch` behind; and if a configured port is already
// held, startup fails fast naming the holder instead of racing it and dying
// in a child's EADDRINUSE.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

function argValue(name) {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const next = args[index + 1];
  if (next === undefined || next.startsWith("-")) return "0.0.0.0"; // bare --host
  return next;
}

const isLoopback = (host) => host === "localhost" || host === "::1" || host.startsWith("127.");

const webHost = argValue("--host") ?? process.env.SHELLBOARD_WEB_HOST;
if (webHost !== undefined && !isLoopback(webHost) && !process.env.SHELLBOARD_TOKEN) {
  const token = randomBytes(24).toString("base64url");
  process.env.SHELLBOARD_TOKEN = token; // inherited by the API server child
  console.log(`[shellboard] web is exposed on ${webHost} — token auth is enabled.`);
  console.log(`[shellboard] access token: ${token}`);
  console.log(`[shellboard] paste it into the login page; set SHELLBOARD_TOKEN to pin your own.`);
}

const apiPort = Number(process.env.SHELLBOARD_PORT ?? 7700);
const webPort = Number(argValue("--port") ?? process.env.SHELLBOARD_WEB_PORT ?? 5173);

/** Resolves the pid holding `port`, or null when it is free (probe bind) or
    the owner cannot be attributed (another user's process). */
function portHolder(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      try {
        const out = execFileSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf8" });
        const pid = /pid=(\d+)/.exec(out)?.[1] ?? null;
        const cmd = pid ? execFileSync("ps", ["-p", pid, "-o", "args="], { encoding: "utf8" }).trim() : "";
        resolve({ pid, cmd });
      } catch {
        resolve({ pid: null, cmd: "" });
      }
    });
    probe.once("listening", () => {
      probe.close(() => resolve(null));
    });
    probe.listen(port);
  });
}

const holders = await Promise.all([portHolder(apiPort), portHolder(webPort)]);
let blocked = false;
for (const [port, holder] of [
  [apiPort, holders[0]],
  [webPort, holders[1]],
]) {
  if (!holder) continue;
  blocked = true;
  const who = holder.pid ? `pid ${holder.pid}${holder.cmd ? ` (${holder.cmd})` : ""}` : "another process";
  console.error(`[shellboard] port ${port} is already in use by ${who}.`);
}
if (blocked) {
  console.error(`[shellboard] stop the old instance first (kill <pid>), or pick another port:
[shellboard]   SHELLBOARD_PORT=<port> pnpm dev        # API
[shellboard]   pnpm dev -- --port <port>              # web`);
  process.exit(1);
}

const children = new Set();
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Children live in their own process groups (detached), so a plain
  // SIGTERM here would not reach tsx's descendants — signal the groups,
  // and SIGKILL anything that ignores the graceful window.
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  setTimeout(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    process.exit(code);
  }, 500);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

function pipeLabeled(stream, label, out) {
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      out(`[${label}] ${buffer.slice(0, index)}`);
      buffer = buffer.slice(index + 1);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) out(`[${label}] ${buffer}`);
  });
}

function start(label, cwd, command, commandArgs) {
  const child = spawn(command, commandArgs, {
    cwd,
    env: process.env,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group: shutdown kills the whole subtree (tsx's server
    // child included) and nothing can orphan a watcher behind our back.
    detached: process.platform !== "win32",
  });
  children.add(child);
  pipeLabeled(child.stdout, label, console.log);
  pipeLabeled(child.stderr, label, console.error);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.log(`[${label}] exited (${signal ?? `code ${code}`}) — shutting down the other one`);
      shutdown(code ?? 1);
    }
  });
}

// API server (env-configured; no CLI args)
start("server", "apps/server", "./node_modules/.bin/tsx", ["watch", "src/server.ts"]);
// vite: with forwarded args use the binary directly so they arrive verbatim
if (args.length > 0) {
  start("web", "apps/web", "./node_modules/.bin/vite", args);
} else {
  start("web", "apps/web", "./node_modules/.bin/vite", []);
}
