import {
  ENV_DENYLIST,
  MAX_ENV_VARS,
  type EnvVarMap,
} from "@shellboard/contracts";

/** One editable row in an env editor. The key is an identifier, so it is
    trimmed; the value is data and is kept verbatim (trailing spaces in a value
    are rare but a value is not ours to rewrite). */
export interface EnvPair {
  key: string;
  value: string;
}

/** Sorted so the editor, the row summary, and the tmux command line all show
    the same order regardless of how the rows were typed. */
export function recordToPairs(env: EnvVarMap): EnvPair[] {
  return Object.keys(env)
    .sort()
    .map((key) => ({ key, value: env[key] ?? "" }));
}

/** Drops rows whose key is still empty (a half-filled row the user abandoned);
    duplicate keys keep the last value, matching the editor's row order. */
export function pairsToRecord(pairs: EnvPair[]): EnvVarMap {
  const env: EnvVarMap = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (key.length === 0) continue;
    env[key] = pair.value;
  }
  return env;
}

/**
 * Client-side mirror of the contract's env rules, so a bad key is reported
 * while typing instead of as a 400 after submit. The server is still the
 * authority — this only decides whether to show an inline message.
 */
export function validateEnvKey(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.length === 0) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return "must be a POSIX variable name";
  if (ENV_DENYLIST.includes(trimmed) || trimmed.startsWith("SHELLBOARD_")) {
    return "reserved for tmux/shellboard runtime";
  }
  return null;
}

/** First invalid row, for disabling Save with a reason instead of failing the
    request. */
export function firstEnvError(pairs: EnvPair[]): string | null {
  const filled = pairs.filter((pair) => pair.key.trim().length > 0);
  if (filled.length > MAX_ENV_VARS) return `at most ${MAX_ENV_VARS} variables`;
  for (const pair of filled) {
    const error = validateEnvKey(pair.key);
    if (error) return `${pair.key.trim()}: ${error}`;
  }
  return null;
}

/** Compact `K=V, K=V` rendering for a preset row; the full list lives in the
    row's title attribute. */
export function envSummary(env: EnvVarMap): string {
  const pairs = recordToPairs(env).map((pair) => `${pair.key}=${pair.value}`);
  return pairs.join(", ");
}

/**
 * Bulk text form: one `KEY=value` per line, so a `.env` file, a shell `env`
 * dump, or a teammate's snippet pastes straight in.
 *
 * Accepted (and why): blank lines and `#` comments are dropped — real `.env`
 * files are full of both; a leading `export ` is stripped — that is what
 * `env`/`set` output and shell snippets look like; the split is on the FIRST
 * `=`, so values may contain `=`; surrounding matching quotes are removed,
 * because `.env` quoting is the norm and the quotes are syntax, not data.
 *
 * Deliberately NOT handled: inline `KEY=value # comment` (a `#` inside a value
 * is data, e.g. a color or a token) and multi-line values. A value containing
 * a newline is not representable here — serializing it produces a second line
 * that fails to parse, which surfaces as an error instead of silently
 * truncating the value.
 *
 * A line without `=` is kept as a pair with an invalid key rather than
 * dropped: the row editor then shows exactly which line is broken, and the
 * parent form's Save stays disabled. Silent dropping is how config gets lost.
 */
export function parseEnvText(text: string): { pairs: EnvPair[]; errors: string[] } {
  const pairs: EnvPair[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return;
    const body = trimmed.replace(/^export\s+/, "");
    const eq = body.indexOf("=");
    if (eq < 0) {
      errors.push(`line ${line}: missing "="`);
      pairs.push({ key: body.trim(), value: "" });
      return;
    }
    const key = body.slice(0, eq).trim();
    pairs.push({ key, value: unquote(body.slice(eq + 1).trim()) });
    const keyError = validateEnvKey(key);
    if (keyError) errors.push(`line ${line}: ${key} — ${keyError}`);
  });
  if (pairs.length > MAX_ENV_VARS) errors.push(`at most ${MAX_ENV_VARS} variables`);
  return { pairs, errors };
}

/** Inverse of parseEnvText for the pairs the editor already holds: sorted by
    key, half-filled rows dropped, so switching to bulk mode and back is a
    no-op. */
export function serializeEnvPairs(pairs: EnvPair[]): string {
  return pairs
    .map((pair) => ({ key: pair.key.trim(), value: pair.value }))
    .filter((pair) => pair.key.length > 0)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((pair) => `${pair.key}=${pair.value}`)
    .join("\n");
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}
