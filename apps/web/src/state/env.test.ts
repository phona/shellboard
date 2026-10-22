import { describe, expect, it } from "vitest";
import {
  envSummary,
  firstEnvError,
  pairsToRecord,
  parseEnvText,
  recordToPairs,
  serializeEnvPairs,
  validateEnvKey,
} from "./env";

describe("env pairs", () => {
  it("round-trips a record through rows", () => {
    const pairs = recordToPairs({ B: "2", A: "1" });
    expect(pairs).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
    expect(pairsToRecord(pairs)).toEqual({ A: "1", B: "2" });
  });

  it("drops rows whose key is still empty and keeps duplicate-key order", () => {
    expect(pairsToRecord([{ key: "", value: "ignored" }, { key: "A", value: "1" }])).toEqual({
      A: "1",
    });
    expect(pairsToRecord([{ key: "A", value: "1" }, { key: " A ", value: "2" }])).toEqual({
      A: "2",
    });
  });

  it("keeps values verbatim while trimming keys", () => {
    expect(pairsToRecord([{ key: " A ", value: " padded " }])).toEqual({ A: " padded " });
  });

  it("rejects the keys the server rejects", () => {
    expect(validateEnvKey("ANTHROPIC_MODEL")).toBeNull();
    expect(validateEnvKey("")).toBeNull();
    expect(validateEnvKey("1BAD")).toBe("must be a POSIX variable name");
    expect(validateEnvKey("A-B")).toBe("must be a POSIX variable name");
    expect(validateEnvKey("TMUX")).toBe("reserved for tmux/shellboard runtime");
    expect(validateEnvKey("SHELLBOARD_TOKEN")).toBe("reserved for tmux/shellboard runtime");
  });

  it("reports the first blocking row for Save", () => {
    expect(firstEnvError([{ key: "A", value: "1" }])).toBeNull();
    expect(firstEnvError([{ key: "OK", value: "1" }, { key: "TMUX", value: "1" }])).toBe(
      "TMUX: reserved for tmux/shellboard runtime",
    );
    expect(
      firstEnvError(Array.from({ length: 25 }, () => ({ key: "A", value: "1" }))),
    ).toBe("at most 24 variables");
  });

  it("summarizes an environment for a row title", () => {
    expect(envSummary({})).toBe("");
    expect(envSummary({ A: "1", B: "x y" })).toBe("A=1, B=x y");
  });
});

describe("bulk env text", () => {
  it("parses a plain block", () => {
    const { pairs, errors } = parseEnvText("A=1\nB=two words");
    expect(pairs).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two words" },
    ]);
    expect(errors).toEqual([]);
  });

  it("accepts a real .env file: comments, blanks, export, quotes", () => {
    const { pairs, errors } = parseEnvText(
      [
        "# my config",
        "",
        "export ANTHROPIC_MODEL=sonnet",
        'ANTHROPIC_BASE_URL="https://example.invalid"',
        "NOTE='single quoted'",
        "  SPACED  =  padded  ",
      ].join("\n"),
    );
    expect(pairs).toEqual([
      { key: "ANTHROPIC_MODEL", value: "sonnet" },
      { key: "ANTHROPIC_BASE_URL", value: "https://example.invalid" },
      { key: "NOTE", value: "single quoted" },
      { key: "SPACED", value: "padded" },
    ]);
    expect(errors).toEqual([]);
  });

  it("splits on the first = so values may contain it", () => {
    expect(parseEnvText("TOKEN=a=b=c").pairs).toEqual([{ key: "TOKEN", value: "a=b=c" }]);
  });

  it("keeps an empty value instead of dropping the variable", () => {
    expect(parseEnvText("EMPTY=").pairs).toEqual([{ key: "EMPTY", value: "" }]);
  });

  it("reports the offending line for a line without =", () => {
    const { pairs, errors } = parseEnvText("A=1\nbroken line\nB=2");
    expect(errors).toEqual(['line 2: missing "="']);
    // kept as a pair so the row editor shows the broken line and Save stays off
    expect(pairs).toEqual([
      { key: "A", value: "1" },
      { key: "broken line", value: "" },
      { key: "B", value: "2" },
    ]);
    expect(firstEnvError(pairs)).toBe("broken line: must be a POSIX variable name");
  });

  it("reports a reserved key with its line number", () => {
    expect(parseEnvText("TMUX=x").errors).toEqual([
      "line 1: TMUX — reserved for tmux/shellboard runtime",
    ]);
  });

  it("round-trips through the row editor", () => {
    const original = { B: "2", A: "1", C: "a=b" };
    const text = serializeEnvPairs(recordToPairs(original));
    expect(text).toBe("A=1\nB=2\nC=a=b");
    const { pairs, errors } = parseEnvText(text);
    expect(errors).toEqual([]);
    expect(pairsToRecord(pairs)).toEqual(original);
  });

  it("cannot represent a value with a newline, and says so instead of losing it", () => {
    const text = serializeEnvPairs([{ key: "MULTI", value: "a\nb" }]);
    const { pairs, errors } = parseEnvText(text);
    expect(errors).toEqual(['line 2: missing "="']);
    // the orphaned second line survives as a pair with an empty value, which is
    // indistinguishable from a real empty variable — that is exactly why the
    // editor reports validity separately instead of deriving it from the pairs
    expect(pairsToRecord(pairs)).toEqual({ MULTI: "a", b: "" });
    expect(firstEnvError(pairs)).toBeNull();
  });

  it("handles CRLF and an empty block", () => {
    expect(parseEnvText("A=1\r\nB=2").pairs).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
    expect(parseEnvText("").pairs).toEqual([]);
    expect(parseEnvText("# only a comment\n\n").pairs).toEqual([]);
  });

  it("enforces the variable cap", () => {
    const text = Array.from({ length: 25 }, (_, i) => `K${i}=v`).join("\n");
    const { pairs, errors } = parseEnvText(text);
    expect(pairs).toHaveLength(25);
    expect(errors).toEqual(["at most 24 variables"]);
  });
});
