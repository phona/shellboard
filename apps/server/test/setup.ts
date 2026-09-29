import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Must run before any src module is imported: config is env-driven.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "shellboard-home-"));
process.env.SHELLBOARD_HOME = home;
process.env.SHELLBOARD_DB = path.join(home, "shellboard.db");
process.env.SHELLBOARD_TMUX_SOCKET = `sb-test-${process.pid}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;
process.env.SHELLBOARD_WEB_DIST = path.join(home, "no-dist");
process.env.SHELLBOARD_PORT = "0";
// Neutralize ambient auth config: a developer shell (or CI) with
// SHELLBOARD_TOKEN set would silently enable token auth in every test
// file and fail a dozen of them with 401s; a non-loopback SHELLBOARD_HOST
// would do the same via auto-token. Tests that exercise token auth set it
// explicitly per test.
delete process.env.SHELLBOARD_TOKEN;
delete process.env.SHELLBOARD_HOST;
delete process.env.SHELLBOARD_NOTIFY_TOKEN;
