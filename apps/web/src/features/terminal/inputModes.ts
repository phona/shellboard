import type { IModes } from "@xterm/xterm";

/** The private modes that decide what the client SENDS to the pane, in
    DECSET parameter order. These are the ones a buffer wipe must not lose:
    the others either affect rendering (origin, wraparound, insert) or are
    output the pane asks for (synchronized output), which a repaint restores
    on its own. */
type InputModeState = Pick<
  IModes,
  "applicationCursorKeysMode" | "applicationKeypadMode" | "bracketedPasteMode"
>;

const INPUT_MODES: ReadonlyArray<{ key: keyof InputModeState; param: number }> = [
  { key: "applicationCursorKeysMode", param: 1 },
  { key: "applicationKeypadMode", param: 66 },
  { key: "bracketedPasteMode", param: 2004 },
];

/** DECSET bytes that put `modes` back after a wipe, empty when nothing needs
    restoring.

    xterm's `reset()` — the only way to drop a whole buffer — also clears
    every tracked private mode, and nothing re-asserts them afterwards: the
    pane app set them once at startup, tmux broadcasts mode state only on
    attach, and a history seed is `capture-pane -e` text, which carries no
    DECSET sequences. So after the buffer is wiped for a re-seed the client
    silently forgets what the app asked for, and the next input goes out in
    the wrong encoding: without bracketed paste a multi-line paste leaves as
    bare newlines and the shell executes it line by line instead of taking
    one paste, and without the application cursor/keypad modes an app like
    vim receives the wrong sequences for arrows and the keypad.

    Writing the sequences back through the parser is the supported way to
    set them — `Terminal.modes` is a read-only snapshot, not a setter. */
export function inputModeSequences(modes: InputModeState): string {
  let sequences = "";
  for (const mode of INPUT_MODES) {
    if (modes[mode.key]) sequences += `\x1b[?${mode.param}h`;
  }
  return sequences;
}
