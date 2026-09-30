import { describe, expect, it } from "vitest";
import { formatSize, relativeTime } from "./format";

describe("relativeTime", () => {
  const now = Date.now();
  const ago = (ms: number): string => relativeTime(now - ms);

  it("renders a dash for no timestamp", () => {
    expect(relativeTime(null)).toBe("—");
  });

  it("counts seconds below a minute", () => {
    expect(ago(0)).toBe("0s");
    expect(ago(1_000)).toBe("1s");
    expect(ago(59_000)).toBe("59s");
  });

  it("switches to minutes, then hours, then days", () => {
    expect(ago(60_000)).toBe("1m");
    expect(ago(59 * 60_000)).toBe("59m");
    expect(ago(60 * 60_000)).toBe("1h");
    expect(ago(23 * 60 * 60_000)).toBe("23h");
    expect(ago(24 * 60 * 60_000)).toBe("1d");
    expect(ago(10 * 24 * 60 * 60_000)).toBe("10d");
  });

  it("truncates rather than rounds up at each boundary", () => {
    // 90 seconds is 1m, not 2m: the unit is floored so a clock never claims
    // more time has passed than has.
    expect(ago(90_000)).toBe("1m");
    expect(ago(90 * 60_000)).toBe("1h");
  });

  it("never reports a negative age for a clock in the future", () => {
    expect(relativeTime(now + 60_000)).toBe("0s");
  });
});

describe("formatSize", () => {
  it("uses bytes below 1 KiB", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("uses KiB from 1 KiB", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
  });

  it("uses MiB from 1 MiB", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1024 * 1024 * 1.5)).toBe("1.5 MB");
  });

  it("keeps one decimal, so a value never grows a unit silently", () => {
    expect(formatSize(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
  });
});
