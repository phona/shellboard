import { describe, expect, it, vi } from "vitest";
import { codename } from "./codename";

describe("codename", () => {
  it("builds an adjective-noun pair", () => {
    const name = codename(new Set());
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("never returns a name that is already taken", () => {
    // Deterministic by construction: take the name it would otherwise give.
    const first = codename(new Set());
    expect(codename(new Set([first]))).not.toBe(first);
  });

  it("falls back to a numeric suffix when the pool is exhausted", () => {
    // With every adjective-noun pair taken, the only escape is a suffix — the
    // loop retries a bounded number of times and then numbers instead of
    // spinning forever.
    const all = new Set<string>();
    for (let i = 0; i < 5000; i += 1) all.add(codename(all));
    const late = codename(all);
    expect(late).toMatch(/^[a-z]+-[a-z]+-\d+$/);
    expect(all.has(late)).toBe(false);
  });

  it("picks the lowest free suffix", () => {
    const taken = new Set(["amber-atlas", "amber-atlas-2", "amber-atlas-3"]);
    vi.spyOn(Math, "random").mockReturnValue(0); // amber + atlas, deterministically
    try {
      expect(codename(taken)).toBe("amber-atlas-4");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("returns the bare pair when it is free, without consulting the suffix path", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(codename(new Set())).toBe("amber-atlas");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
