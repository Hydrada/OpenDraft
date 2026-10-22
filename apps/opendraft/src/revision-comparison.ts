/** Read-only, deterministic raster comparison. All coordinates are rendered pixels. */
export type RasterPage = { width: number; height: number; data: Uint8ClampedArray };
export type ComparisonOptions = { offsetX: number; offsetY: number; threshold: number };
export type ComparisonGeometry = { width: number; height: number; originX: number; originY: number };
export type RasterComparison = ComparisonGeometry & {
  overlay: Uint8ClampedArray;
  difference: Uint8ClampedArray;
  changedPixels: number;
  totalPixels: number;
  /** Zero-based output-canvas coordinates, not base-page coordinates. */
  changedBounds: null | { x: number; y: number; width: number; height: number };
};

export const COMPARISON_LIMITS = Object.freeze({ maxPixels: 4_000_000, maxSide: 8192 });
export const COMPARISON_COLORS = Object.freeze({
  removal: Object.freeze([220, 35, 45] as const),
  addition: Object.freeze([25, 80, 220] as const),
  colorChange: Object.freeze([180, 40, 180] as const),
});

function dimensions(value: { width: number; height: number }, name: string): void {
  if (!value || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) ||
      value.width < 1 || value.height < 1 || value.width > COMPARISON_LIMITS.maxSide ||
      value.height > COMPARISON_LIMITS.maxSide || value.width * value.height > COMPARISON_LIMITS.maxPixels) {
    throw new Error(`${name} dimensions exceed the comparison budget (4,000,000 pixels, 8192 per side) or are invalid.`);
  }
}

/** The entire translated revision remains inside the union canvas, including negative offsets. */
export function comparisonGeometry(
  base: { width: number; height: number },
  revision: { width: number; height: number },
  offsetX: number,
  offsetY: number,
): ComparisonGeometry {
  dimensions(base, 'Base page');
  dimensions(revision, 'Revision page');
  if (!Number.isSafeInteger(offsetX) || !Number.isSafeInteger(offsetY)) {
    throw new Error('Comparison offsets must be safe integer pixels.');
  }
  const originX = Math.min(0, offsetX), originY = Math.min(0, offsetY);
  const width = Math.max(base.width, offsetX + revision.width) - originX;
  const height = Math.max(base.height, offsetY + revision.height) - originY;
  dimensions({ width, height }, 'Aligned comparison');
  return { width, height, originX, originY };
}

function raster(value: RasterPage, name: string): void {
  if (!(value.data instanceof Uint8ClampedArray) || value.data.length !== value.width * value.height * 4) {
    throw new Error(`${name} must contain exactly width × height × 4 RGBA bytes.`);
  }
}

const gray = (r: number, g: number, b: number) => Math.round((299 * r + 587 * g + 114 * b) / 1000);
const overWhite = (channel: number, alpha: number) => Math.round((channel * alpha + 255 * (255 - alpha)) / 255);

/**
 * Compare alpha-composited RGB over white, including white outside either page.
 * A change is max(abs(RGB difference)) > threshold (0..255 inclusive).
 * Overlay: [revisionGray, round(baseGray*revisionGray/255), baseGray], alpha 255.
 * Base-only black is red; revision-only black is blue; shared black is black.
 * Difference colors indicate relative darkness, not semantic engineering changes.
 * Unchanged pixels are light grayscale: round(224 + min(grayA,grayB)*31/255).
 * Validation and the union budget are checked before output allocations.
 */
export function compareRasters(base: RasterPage, revision: RasterPage, options: ComparisonOptions): RasterComparison {
  if (!options || !Number.isInteger(options.threshold) || options.threshold < 0 || options.threshold > 255) {
    throw new Error('Comparison threshold must be an integer from 0 to 255.');
  }
  const geometry = comparisonGeometry(base, revision, options.offsetX, options.offsetY);
  raster(base, 'Base page');
  raster(revision, 'Revision page');
  const { width, height, originX, originY } = geometry;
  const totalPixels = width * height;
  const overlay = new Uint8ClampedArray(totalPixels * 4);
  const difference = new Uint8ClampedArray(totalPixels * 4);
  let changedPixels = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const ay = y + originY, by = ay - options.offsetY;
    for (let x = 0; x < width; x++) {
      const ax = x + originX, bx = ax - options.offsetX;
      const a = ax >= 0 && ax < base.width && ay >= 0 && ay < base.height ? (ay * base.width + ax) * 4 : -1;
      const b = bx >= 0 && bx < revision.width && by >= 0 && by < revision.height ? (by * revision.width + bx) * 4 : -1;
      const ar = a < 0 ? 255 : overWhite(base.data[a], base.data[a + 3]);
      const ag = a < 0 ? 255 : overWhite(base.data[a + 1], base.data[a + 3]);
      const ab = a < 0 ? 255 : overWhite(base.data[a + 2], base.data[a + 3]);
      const br = b < 0 ? 255 : overWhite(revision.data[b], revision.data[b + 3]);
      const bg = b < 0 ? 255 : overWhite(revision.data[b + 1], revision.data[b + 3]);
      const bb = b < 0 ? 255 : overWhite(revision.data[b + 2], revision.data[b + 3]);
      const ga = gray(ar, ag, ab), gb = gray(br, bg, bb);
      const i = (y * width + x) * 4;
      overlay[i] = gb;
      overlay[i + 1] = Math.round(ga * gb / 255);
      overlay[i + 2] = ga;
      overlay[i + 3] = 255;
      if (Math.max(Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab - bb)) > options.threshold) {
        const color = ga < gb ? COMPARISON_COLORS.removal : ga > gb ? COMPARISON_COLORS.addition : COMPARISON_COLORS.colorChange;
        difference[i] = color[0]; difference[i + 1] = color[1]; difference[i + 2] = color[2];
        changedPixels++;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      } else {
        const lightGray = Math.round(224 + Math.min(ga, gb) * 31 / 255);
        difference[i] = lightGray; difference[i + 1] = lightGray; difference[i + 2] = lightGray;
      }
      difference[i + 3] = 255;
    }
  }
  return {
    ...geometry, overlay, difference, changedPixels, totalPixels,
    changedBounds: changedPixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}
