import { describe, expect, it } from "vitest";
import { inputModeSequences } from "./inputModes";

const ALL_OFF = {
  applicationCursorKeysMode: false,
  applicationKeypadMode: false,
  bracketedPasteMode: false,
};

describe("inputModeSequences", () => {
  it("restores nothing when the app asked for none of them", () => {
    expect(inputModeSequences(ALL_OFF)).toBe("");
  });

  it("carries bracketed paste — the mode whose loss breaks multi-line paste", () => {
    // Without this the paste leaves as bare newlines: xterm only wraps a
    // paste in 200~/201~ while the mode is set, otherwise every \r the
    // conversion produced is an Enter and the shell runs the text line by
    // line. That is the reported bug, so it gets its own case.
    expect(inputModeSequences({ ...ALL_OFF, bracketedPasteMode: true })).toBe("\x1b[?2004h");
  });

  it("carries the application cursor and keypad modes", () => {
    // Same class of loss: an app that set DECCKM/DECNKM sees the wrong
    // sequences for arrows and the keypad once the mode is forgotten.
    expect(inputModeSequences({ ...ALL_OFF, applicationCursorKeysMode: true })).toBe("\x1b[?1h");
    expect(inputModeSequences({ ...ALL_OFF, applicationKeypadMode: true })).toBe("\x1b[?66h");
  });

  it("emits every set mode, in DECSET parameter order", () => {
    expect(
      inputModeSequences({
        applicationCursorKeysMode: true,
        applicationKeypadMode: true,
        bracketedPasteMode: true,
      }),
    ).toBe("\x1b[?1h\x1b[?66h\x1b[?2004h");
  });
});
