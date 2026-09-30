import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  basenamePosix,
  dirnamePosix,
  isTypingTarget,
  joinPosix,
  KEYBINDINGS,
  matchesBinding,
  parentPosix,
  rowActivator,
} from "./dom";

/** A KeyboardEvent stand-in: matchesBinding reads exactly these five fields. */
function key(
  k: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  return {
    key: k,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  } as KeyboardEvent;
}

describe("matchesBinding", () => {
  it("matches a plain key with no modifiers", () => {
    expect(matchesBinding(key("/"), KEYBINDINGS.search)).toBe(true);
    expect(matchesBinding(key("a"), KEYBINDINGS.search)).toBe(false);
  });

  it("requires the modifier to be held", () => {
    expect(matchesBinding(key("b", { ctrl: true }), KEYBINDINGS.toggleLeft)).toBe(true);
    expect(matchesBinding(key("b"), KEYBINDINGS.toggleLeft)).toBe(false);
  });

  it("treats a binding's modifier as required, not optional", () => {
    // Ctrl+b must not fire on a bare b, and a bare-key binding must not fire
    // when Ctrl happens to be down.
    expect(matchesBinding(key("b", { ctrl: true, shift: true }), KEYBINDINGS.toggleLeft)).toBe(
      false,
    );
    expect(matchesBinding(key("/", { ctrl: true }), KEYBINDINGS.search)).toBe(false);
  });

  it("separates Ctrl and Ctrl+Shift", () => {
    expect(matchesBinding(key("b", { ctrl: true, shift: true }), KEYBINDINGS.toggleRight)).toBe(
      true,
    );
    expect(matchesBinding(key("b", { ctrl: true }), KEYBINDINGS.toggleRight)).toBe(false);
  });

  it("matches the key case-insensitively but still distinguishes symbols", () => {
    expect(matchesBinding(key("B", { ctrl: true }), KEYBINDINGS.toggleLeft)).toBe(true);
    expect(matchesBinding(key("End", { ctrl: true }), KEYBINDINGS.terminalBottom)).toBe(true);
  });

  it("matches Escape and PageUp/PageDown as written", () => {
    expect(matchesBinding(key("Escape"), KEYBINDINGS.exitMaximize)).toBe(true);
    expect(matchesBinding(key("PageUp", { shift: true }), KEYBINDINGS.terminalPageUp)).toBe(true);
    expect(matchesBinding(key("PageDown", { shift: true }), KEYBINDINGS.terminalPageDown)).toBe(
      true,
    );
  });

  it("never matches a modifier key on its own", () => {
    // "ctrl+b" must not fire when the user presses only Ctrl.
    expect(matchesBinding(key("Control", { ctrl: true }), KEYBINDINGS.toggleLeft)).toBe(false);
    expect(matchesBinding(key("Shift", { shift: true }), KEYBINDINGS.terminalCopyShift)).toBe(
      false,
    );
  });
});

describe("posix path helpers", () => {
  it("joins a name onto a directory", () => {
    expect(joinPosix("src", "util")).toBe("src/util");
    expect(joinPosix("a/b", "c")).toBe("a/b/c");
  });

  it("treats the current directory as empty rather than './'", () => {
    expect(joinPosix(".", "file.ts")).toBe("file.ts");
  });

  it("walks up to the parent, stopping at the root", () => {
    expect(parentPosix("a/b/c")).toBe("a/b");
    expect(parentPosix("a")).toBe(".");
    expect(parentPosix(".")).toBe(".");
    expect(parentPosix("/")).toBe(".");
  });

  it("takes the last segment", () => {
    expect(basenamePosix("a/b/c.ts")).toBe("c.ts");
    expect(basenamePosix("c.ts")).toBe("c.ts");
    expect(basenamePosix("a/b/")).toBe("");
  });

  it("takes everything before the last segment", () => {
    expect(dirnamePosix("a/b/c.ts")).toBe("a/b");
    expect(dirnamePosix("c.ts")).toBe("");
    expect(dirnamePosix("/c.ts")).toBe("");
  });

  it("round-trips join with parent", () => {
    const path = "apps/web/src/util/dom.ts";
    expect(joinPosix(parentPosix(path), basenamePosix(path))).toBe(path);
  });
});

describe("isTypingTarget", () => {
  // The suite runs in node with no DOM, and isTypingTarget guards on
  // `instanceof HTMLElement`. Stub the minimum surface it touches — the check
  // reads the global at call time, so setting it here is early enough. This
  // asserts the tag/mode/`.xterm` logic, not the browser's element model.
  class StubElement {
    tagName: string;
    isContentEditable: boolean;
    closest: (selector: string) => unknown;
    constructor(tag: string, extra: Partial<StubElement> = {}) {
      this.tagName = tag;
      this.isContentEditable = false;
      this.closest = () => null;
      Object.assign(this, extra);
    }
  }
  (globalThis as { HTMLElement?: unknown }).HTMLElement = StubElement;

  const el = (tag: string, extra: Record<string, unknown> = {}): HTMLElement =>
    new StubElement(tag, extra) as unknown as HTMLElement;

  it("recognises the form controls", () => {
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("SELECT"))).toBe(true);
  });

  it("recognises a content-editable region", () => {
    expect(isTypingTarget(el("DIV", { isContentEditable: true }))).toBe(true);
  });

  it("recognises anything inside the terminal", () => {
    // Keystrokes aimed at xterm must not be stolen by the global keymap.
    const inside = el("SPAN", { closest: (sel: string) => (sel === ".xterm" ? {} : null) });
    expect(isTypingTarget(inside)).toBe(true);
    const outside = el("SPAN", { closest: (sel: string) => (sel === ".other" ? {} : null) });
    expect(isTypingTarget(outside)).toBe(false);
  });

  it("does not claim a plain element", () => {
    expect(isTypingTarget(el("DIV"))).toBe(false);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
  });

  it("does not claim a non-element target", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({} as EventTarget)).toBe(false);
  });
});

describe("rowActivator", () => {
  const activate = vi.fn();
  const props = rowActivator(activate);
  /** Only `key`, `target`, `currentTarget` and `preventDefault` are read. */
  type Probe = {
    key: string;
    target: EventTarget;
    currentTarget: EventTarget;
    preventDefault: ReturnType<typeof vi.fn>;
  };
  const event = (over: Partial<Probe> = {}): Probe => ({
    key: "Enter",
    target: null as unknown as EventTarget,
    currentTarget: null as unknown as EventTarget,
    preventDefault: vi.fn(),
    ...over,
  });

  it("exposes button semantics for a screen reader", () => {
    expect(props.role).toBe("button");
    expect(props.tabIndex).toBe(0);
  });

  it("activates on Enter and Space", () => {
    activate.mockClear();
    const e = event();
    e.target = e.currentTarget;
    props.onKeyDown(e as unknown as ReactKeyboardEvent<HTMLDivElement>);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();

    activate.mockClear();
    const space = event({ key: " " });
    space.target = space.currentTarget;
    props.onKeyDown(space as unknown as ReactKeyboardEvent<HTMLDivElement>);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("ignores every other key", () => {
    activate.mockClear();
    const e = event({ key: "a" });
    e.target = e.currentTarget;
    props.onKeyDown(e as unknown as ReactKeyboardEvent<HTMLDivElement>);
    expect(activate).not.toHaveBeenCalled();
  });

  it("ignores a key that came from a nested action", () => {
    // Enter on a row's inner delete button must not also activate the row:
    // target and currentTarget differ, and only the row's own key counts.
    activate.mockClear();
    const e = event();
    e.target = { tagName: "BUTTON" } as unknown as EventTarget;
    e.currentTarget = { tagName: "DIV" } as unknown as EventTarget;
    props.onKeyDown(e as unknown as ReactKeyboardEvent<HTMLDivElement>);
    expect(activate).not.toHaveBeenCalled();
  });
});
