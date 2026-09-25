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
