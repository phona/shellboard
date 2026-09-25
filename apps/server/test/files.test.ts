import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { FileService } from "../src/files/fileService";
import { realpathInside, resolveInside } from "../src/files/sandbox";
import { makeTempDir } from "./helpers";

const files = new FileService();

function fixture(): { root: string; sub: string } {
  const root = makeTempDir();
  const sub = path.join(root, "sub");
  fs.mkdirSync(sub);
  return { root, sub };
}

function expectPathEscape(fn: () => unknown, status: number): void {
  try {
    fn();
    throw new Error("expected the call to be rejected");
  } catch (err) {
    expect((err as { statusCode?: number }).statusCode).toBe(status);
  }
}

it("rejects lexical path traversal (D1 sandbox)", () => {
  const { root } = fixture();
  expectPathEscape(() => resolveInside(root, "../outside"), 400);
  expectPathEscape(() => resolveInside(root, "sub/../../outside"), 400);
  expectPathEscape(() => resolveInside(root, "/etc/passwd"), 400);
  expectPathEscape(() => resolveInside(root, "a\0b"), 400);
  // inside stays allowed
  expect(resolveInside(root, "sub/../ok.txt")).toBe(path.join(root, "ok.txt"));
});

it("rejects symlink escapes but allows internal symlinks", () => {
  const { root, sub } = fixture();
  fs.symlinkSync("/etc", path.join(root, "evil"));
  expectPathEscape(() => realpathInside(root, "evil/passwd"), 400);
  // lexical resolution does not follow symlinks; opening does (realpath) and is rejected:
  expectPathEscape(() => files.content(root, "evil/passwd"), 400);

  fs.symlinkSync(sub, path.join(root, "link"));
  expect(realpathInside(root, "link")).toBe(sub);
});

it("save and content round trip, detects on-disk conflicts", () => {
  const { root } = fixture();
  const { mtime } = files.save(root, "notes/a.md", { content: "# hi", encoding: "utf8" });
  const readBack = files.content(root, "notes/a.md");
  expect(readBack.content).toBe("# hi");
  expect(readBack.binary).toBe(false);

  expectPathEscape(
    () => files.save(root, "notes/a.md", { content: "x", encoding: "utf8", mtime: mtime - 9999 }),
    409,
  );
});

it("round trips binary content as base64", () => {
  const { root } = fixture();
  const raw = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]);
  files.save(root, "blob.bin", {
    content: raw.toString("base64"),
    encoding: "base64",
  });
  const readBack = files.content(root, "blob.bin");
  expect(readBack.binary).toBe(true);
  expect(readBack.encoding).toBe("base64");
  expect(Buffer.from(readBack.content, "base64").equals(raw)).toBe(true);
});

it("create, rename, remove with containment checks", () => {
  const { root } = fixture();
  files.create(root, { path: "d1/d2", type: "dir", encoding: "utf8" });
  files.create(root, { path: "d1/d2/f.txt", type: "file", encoding: "utf8" });

  expectPathEscape(
    () => files.rename(root, "d1/d2/f.txt", "../../escape"),
    400,
  );
  files.rename(root, "d1/d2/f.txt", "g.txt");
  expect(fs.existsSync(path.join(root, "d1/d2/g.txt"))).toBe(true);

  expectPathEscape(() => files.remove(root, ".", true), 400);
  files.remove(root, "d1", true);
  expect(fs.existsSync(path.join(root, "d1"))).toBe(false);
});

it("lists directories with types and dirs first", () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, "z.txt"), "zz");
  fs.mkdirSync(path.join(root, "adir"));
  const list = files.list(root, ".");
  expect(list.path).toBe(".");
  expect(list.entries[0]?.type).toBe("dir");
  expect(list.entries.map((entry) => entry.name)).toContain("z.txt");
});

it("refuses to open oversized files", () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 1));
  expectPathEscape(() => files.content(root, "big.bin"), 413);
});
