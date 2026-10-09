import { afterEach, describe, expect, it, vi } from "vitest";
import {
  planResize,
  prepareUpload,
  RESIZE_BUDGET_BYTES,
  RESIZE_MAX_EDGE,
  RESIZE_THRESHOLD_BYTES,
  resizeSummary,
} from "./imageUpload";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A JPEG over the threshold. Only `size` and `type` drive the decision, so
    the size is pinned with defineProperty rather than by allocating bytes. */
function bigJpeg(size = 5 * 1024 * 1024): File {
  const file = new File(["x"], "IMG_0001.JPG", { type: "image/jpeg" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function smallJpeg(): File {
  const file = new File(["x"], "small.JPG", { type: "image/jpeg" });
  Object.defineProperty(file, "size", { value: 400 * 1024 });
  return file;
}

describe("planResize", () => {
  it("leaves a JPEG at or below the threshold alone", () => {
    expect(planResize({ size: 0, type: "image/jpeg" })).toBeNull();
    expect(planResize({ size: RESIZE_THRESHOLD_BYTES, type: "image/jpeg" })).toBeNull();
  });

  it("plans a re-encode for a JPEG over the threshold", () => {
    expect(planResize({ size: RESIZE_THRESHOLD_BYTES + 1, type: "image/jpeg" })).toEqual({
      maxEdge: RESIZE_MAX_EDGE,
      quality: 0.82,
      budget: RESIZE_BUDGET_BYTES,
    });
  });

  it("touches nothing but JPEG, whatever the size", () => {
    const types = ["image/png", "video/mp4", "text/plain", "", "image/heic", "application/pdf"];
    for (const type of types) {
      expect(planResize({ size: 50 * 1024 * 1024, type })).toBeNull();
    }
  });
});

interface Encoded {
  width: number;
  height: number;
  quality: number;
}

/** Decoder + canvas doubles. `sizes` is what each toBlob reports, in call
    order; the last entry repeats. */
function stubCanvas(options: {
  sizes: number[];
  pixels?: { width: number; height: number };
  decode?: "throw";
}): Encoded[] {
  const encoded: Encoded[] = [];
  const bitmap = {
    width: options.pixels?.width ?? 4000,
    height: options.pixels?.height ?? 3000,
    close: () => {},
  };
  vi.stubGlobal("createImageBitmap", async () => {
    if (options.decode === "throw") throw new Error("cannot decode");
    return bitmap;
  });
  vi.stubGlobal("document", {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (done: (blob: Blob | null) => void, _type: string, quality: number) => {
          const size = options.sizes[Math.min(encoded.length, options.sizes.length - 1)] ?? 0;
          encoded.push({ width: canvas.width, height: canvas.height, quality });
          done(new Blob([new Uint8Array(size)]));
        },
      };
      return canvas;
    },
  });
  return encoded;
}

describe("prepareUpload", () => {
  it("sends the original when there is no image decoder", async () => {
    // node, or a browser too old to have it — never a reason to fail.
    vi.stubGlobal("createImageBitmap", undefined);
    const file = bigJpeg();
    const plan = await prepareUpload(file);
    expect(plan.resizedFrom).toBeNull();
    expect(plan.file).toBe(file);
  });

  it("sends the original when the decode fails", async () => {
    const file = bigJpeg();
    stubCanvas({ sizes: [1024], decode: "throw" });
    const plan = await prepareUpload(file);
    expect(plan.resizedFrom).toBeNull();
    expect(plan.file).toBe(file);
  });

  it("re-encodes a big JPEG to a smaller file under its own name", async () => {
    const file = bigJpeg();
    stubCanvas({ sizes: [480 * 1024] });
    const plan = await prepareUpload(file);
    expect(plan.resizedFrom).toEqual({ name: "IMG_0001.JPG", size: 5 * 1024 * 1024 });
    expect(plan.file.name).toBe("IMG_0001.JPG");
    expect(plan.file.type).toBe("image/jpeg");
    expect(plan.file.size).toBe(480 * 1024);
    expect(resizeSummary(plan)).toBe("5.0 MB → 480.0 KB");
  });

  it("scales the longest edge to the plan's cap and never up", async () => {
    const encoded = stubCanvas({
      sizes: [1024],
      pixels: { width: 4000, height: 3000 },
    });
    await prepareUpload(bigJpeg());
    expect(encoded).toEqual([{ width: 1920, height: 1440, quality: 0.82 }]);

    const small = stubCanvas({ sizes: [1024], pixels: { width: 800, height: 600 } });
    await prepareUpload(bigJpeg());
    // Already under the cap: no upscaling, the canvas keeps the source size.
    expect(small).toEqual([{ width: 800, height: 600, quality: 0.82 }]);
  });

  it("drops the quality and tries again when the first pass is over budget", async () => {
    stubCanvas({ sizes: [2 * 1024 * 1024, 300 * 1024] });
    const plan = await prepareUpload(bigJpeg());
    expect(plan.file.size).toBe(300 * 1024);
    expect(plan.resizedFrom?.size).toBe(5 * 1024 * 1024);
  });

  it("keeps the original when no pass beats it", async () => {
    // Over budget, then still larger than the source: fidelity was spent for
    // nothing, so the original goes out untouched.
    const file = bigJpeg();
    stubCanvas({ sizes: [2 * 1024 * 1024, 6 * 1024 * 1024] });
    const plan = await prepareUpload(file);
    expect(plan.resizedFrom).toBeNull();
    expect(plan.file).toBe(file);
  });

  it("leaves a small JPEG alone", async () => {
    const file = smallJpeg();
    const plan = await prepareUpload(file);
    expect(plan.resizedFrom).toBeNull();
    expect(plan.file).toBe(file);
    expect(resizeSummary(plan)).toBeNull();
  });
});
