import { describe, expect, it } from "vitest";
import { sendPathConfirmation } from "./sendConfirm";

// The dialog's whole job is to name the exact path the server is about to type,
// so the payload is the feature: a dialog that showed anything else would be a
// rubber stamp over a different action than the one it describes.
describe("sendPathConfirmation", () => {
  const input = {
    path: "/home/tao/.shellboard/uploads/sb-1234/IMG_0001.JPG",
    name: "IMG_0001.JPG",
    size: 480 * 1024,
  };

  it("shows the path itself as the payload", () => {
    expect(sendPathConfirmation(input).payload).toBe(input.path);
  });

  it("names the file and its size beside the path", () => {
    expect(sendPathConfirmation(input).meta).toBe("IMG_0001.JPG · 480.0 KB");
  });

  it("drops the size when the caller does not know it", () => {
    expect(sendPathConfirmation({ ...input, size: null }).meta).toBe("IMG_0001.JPG");
  });

  it("says the path is typed without a submit", () => {
    // The D6 carve-out's whole safety argument: the keystrokes land in the
    // input line and nothing runs, so the copy must say so rather than imply
    // the file is being sent to the agent.
    const details = sendPathConfirmation(input);
    expect(details.risk).toContain("without Enter");
    expect(details.risk).toContain("nothing runs until you submit");
  });

  it("asks the same question the paste gate asks", () => {
    expect(sendPathConfirmation(input).title).toBe("Send this path to the shell?");
  });
});
