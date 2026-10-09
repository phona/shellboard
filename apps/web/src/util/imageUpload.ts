import { formatSize } from "./format.js";

/** A JPEG at or below this size goes out untouched: everything that has
    actually landed from a phone so far is under it. */
export const RESIZE_THRESHOLD_BYTES = 1024 * 1024;
/** Longest edge of the re-encoded image, in pixels. */
export const RESIZE_MAX_EDGE = 1920;
/** First quality pass. */
export const RESIZE_QUALITY = 0.82;
/** Second pass, only when the first overshoots the budget. */
export const RESIZE_QUALITY_LOW = 0.6;
/** A re-encode larger than this is worse than useless: it spends fidelity
    without buying a transfer short enough to complete. */
export const RESIZE_BUDGET_BYTES = 1024 * 1024;

export interface ResizePlan {
  maxEdge: number;
  quality: number;
  budget: number;
}

export interface UploadPlan {
  /** The bytes to send: the original, or a re-encoded stand-in named after it. */
  file: File;
  /** Set when `file` is a stand-in, so the caller can tell the user. */
  resizedFrom: { name: string; size: number } | null;
}

/**
 * Does this file need re-encoding? JPEG only.
 *
 * The case that actually fails is a phone-camera photo: a multi-megapixel
 * JPEG that takes minutes on a phone uplink and gets cut off. PNG screenshots
 * already land (the buffer holds them at 200-800KB), so they are left alone.
 * The JPEG-only rule also keeps the two traps out of the rewrite entirely:
 * HEIC cannot be decoded into a canvas, and a transparent PNG turned into
 * JPEG gets a black background.
 */
export function planResize(input: { size: number; type: string }): ResizePlan | null {
  if (input.type !== "image/jpeg") return null;
  if (input.size <= RESIZE_THRESHOLD_BYTES) return null;
  return { maxEdge: RESIZE_MAX_EDGE, quality: RESIZE_QUALITY, budget: RESIZE_BUDGET_BYTES };
}

/** One decode/scale/encode pass. null means "this did not work" — never throws. */
async function reencode(file: File, maxEdge: number, quality: number): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    // A phone stores portrait photos rotated and records the turn in EXIF.
    // Applying it here is the difference between a readable image and one
    // lying on its side; a browser without the option simply ignores it.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) return null;
      context.drawImage(bitmap, 0, 0, width, height);
      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
      });
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/**
 * What to actually PUT: the file as it is, or a smaller one wearing its name.
 *
 * A transcode, not compression — the result is an ordinary JPEG that the
 * server stores verbatim, so there is nothing to decompress on the far side.
 * Every failure path returns the original: a compression step must never be
 * the reason an upload fails.
 */
export async function prepareUpload(file: File): Promise<UploadPlan> {
  const plan = planResize(file);
  if (plan === null) return { file, resizedFrom: null };

  for (const quality of [plan.quality, RESIZE_QUALITY_LOW]) {
    const blob = await reencode(file, plan.maxEdge, quality);
    // Both bounds matter: over budget is no better than the original, and a
    // result larger than what we started with bought nothing but lost pixels.
    if (blob !== null && blob.size < file.size && blob.size <= plan.budget) {
      return {
        file: new File([blob], file.name, {
          type: "image/jpeg",
          lastModified: file.lastModified,
        }),
        resizedFrom: { name: file.name, size: file.size },
      };
    }
  }
  return { file, resizedFrom: null };
}

/** "5.2MB → 480KB" — the honest accounting for a resized upload. */
export function resizeSummary(plan: UploadPlan): string | null {
  if (plan.resizedFrom === null) return null;
  return `${formatSize(plan.resizedFrom.size)} → ${formatSize(plan.file.size)}`;
}
