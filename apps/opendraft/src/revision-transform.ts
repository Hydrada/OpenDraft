import {COMPARISON_LIMITS, type ComparisonGeometry, type RasterPage} from './revision-comparison.ts';

/** Revision outer-rectangle coordinates to base: x'=a*x+c*y+e, y'=b*x+d*y+f. */
export type AffineTransform = readonly [number, number, number, number, number, number];
type Size = {width: number; height: number};
export type TransformedComparison = {base: RasterPage; revision: RasterPage; geometry: ComparisonGeometry};

function dimensions(value: Size, name: string) {
  if (!value || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) ||
      value.width < 1 || value.height < 1 || value.width > COMPARISON_LIMITS.maxSide ||
      value.height > COMPARISON_LIMITS.maxSide || value.width * value.height > COMPARISON_LIMITS.maxPixels) {
    throw new Error(`${name} dimensions exceed the comparison budget (4,000,000 pixels, 8192 per side) or are invalid.`);
  }
}

/** Reject reflection, collapse and extreme magnification before reading raster storage. */
export function validateAffineTransform(matrix: AffineTransform): AffineTransform {
  if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('Alignment transform must contain exactly six finite numbers.');
  }
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant <= 1e-8) {
    throw new Error('Alignment transform must preserve orientation and be nondegenerate.');
  }
  // Eigenvalues of A^T A; det/sigmaMax avoids cancellation for sigmaMin.
  const trace = a * a + b * b + c * c + d * d;
  const discriminant = Math.max(0, trace * trace - 4 * determinant * determinant);
  const sigmaMax = Math.sqrt((trace + Math.sqrt(discriminant)) / 2);
  const sigmaMin = determinant / sigmaMax;
  if (!Number.isFinite(sigmaMax) || !Number.isFinite(sigmaMin) || sigmaMin < 0.1 - 1e-10 || sigmaMax > 10 + 1e-10) {
    throw new Error('Alignment transform principal scales must be between 0.1 and 10.');
  }
  if (Math.abs(e) > 100000 || Math.abs(f) > 100000) {
    throw new Error('Alignment transform offsets must be within 100000 pixels.');
  }
  return [a, b, c, d, e, f];
}

/** Uniform scale and clockwise rotation about the displayed revision's top-left origin. */
export function similarityTransform(options: {scale: number; rotationDegrees: number; offsetX: number; offsetY: number}): AffineTransform {
  if (!options || !Number.isFinite(options.scale) || options.scale < 0.1 || options.scale > 10 ||
      !Number.isFinite(options.rotationDegrees) || Math.abs(options.rotationDegrees) > 3600 ||
      !Number.isFinite(options.offsetX) || !Number.isFinite(options.offsetY)) {
    throw new Error('Similarity alignment needs scale 0.1–10, finite offsets and rotation within ±3600 degrees.');
  }
  const angle = ((options.rotationDegrees % 360) + 360) % 360 * Math.PI / 180;
  const exactTrig = (value: number) => Math.abs(value) < 1e-12 ? 0 : Math.abs(Math.abs(value) - 1) < 1e-12 ? Math.sign(value) : value;
  const cosine = exactTrig(Math.cos(angle)) * options.scale, sine = exactTrig(Math.sin(angle)) * options.scale;
  return validateAffineTransform([cosine, sine, -sine || 0, cosine, options.offsetX, options.offsetY]);
}

/** Whole base and transformed revision extents; integer output origin is in base coordinates. */
export function affineGeometry(base: Size, revision: Size, matrix: AffineTransform): ComparisonGeometry {
  dimensions(base, 'Base page'); dimensions(revision, 'Revision page');
  const [a, b, c, d, e, f] = validateAffineTransform(matrix);
  const corners = [[0, 0], [revision.width, 0], [0, revision.height], [revision.width, revision.height]];
  const xs = corners.map(([x, y]) => a * x + c * y + e);
  const ys = corners.map(([x, y]) => b * x + d * y + f);
  const originX = Math.floor(Math.min(0, ...xs)), originY = Math.floor(Math.min(0, ...ys));
  const width = Math.ceil(Math.max(base.width, ...xs)) - originX;
  const height = Math.ceil(Math.max(base.height, ...ys)) - originY;
  dimensions({width, height}, 'Aligned comparison');
  return {width, height, originX, originY};
}

function storage(value: RasterPage, name: string) {
  if (!(value.data instanceof Uint8ClampedArray) || value.data.length !== value.width * value.height * 4) {
    throw new Error(`${name} must contain exactly width × height × 4 RGBA bytes.`);
  }
}
const overWhite = (channel: number, alpha: number) => Math.round((channel * alpha + 255 * (255 - alpha)) / 255);

/**
 * White-composite before interpolation. Inverse mapping samples pixel centers with
 * bilinear interpolation; taps outside the revision are white, never edge-clamped.
 * Identity and integer translation therefore retain exact composited pixels.
 * Returns fresh opaque union rasters; neither source nor matrix is mutated.
 */
export function transformForComparison(base: RasterPage, revision: RasterPage, matrix: AffineTransform): TransformedComparison {
  const geometry = affineGeometry(base, revision, matrix);
  storage(base, 'Base page'); storage(revision, 'Revision page');
  const {width, height, originX, originY} = geometry;
  const baseData = new Uint8ClampedArray(width * height * 4); baseData.fill(255);
  const revisionData = new Uint8ClampedArray(width * height * 4); revisionData.fill(255);
  for (let y = 0; y < base.height; y++) for (let x = 0; x < base.width; x++) {
    const source = (y * base.width + x) * 4, target = ((y - originY) * width + x - originX) * 4;
    for (let channel = 0; channel < 3; channel++) baseData[target + channel] = overWhite(base.data[source + channel], base.data[source + 3]);
  }
  const [a, b, c, d, e, f] = matrix, determinant = a * d - b * c;
  const ia = d / determinant, ib = -b / determinant, ic = -c / determinant, id = a / determinant;
  const tap = (x: number, y: number, channel: number) => {
    if (x < 0 || y < 0 || x >= revision.width || y >= revision.height) return 255;
    const source = (y * revision.width + x) * 4;
    return overWhite(revision.data[source + channel], revision.data[source + 3]);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const bx = x + originX + 0.5 - e, by = y + originY + 0.5 - f;
    const rx = ia * bx + ic * by - 0.5, ry = ib * bx + id * by - 0.5;
    const x0 = Math.floor(rx), y0 = Math.floor(ry), fx = rx - x0, fy = ry - y0;
    if (x0 < -1 || y0 < -1 || x0 >= revision.width || y0 >= revision.height) continue;
    const target = (y * width + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      const top = tap(x0, y0, channel) * (1 - fx) + tap(x0 + 1, y0, channel) * fx;
      const bottom = tap(x0, y0 + 1, channel) * (1 - fx) + tap(x0 + 1, y0 + 1, channel) * fx;
      revisionData[target + channel] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return {base: {width, height, data: baseData}, revision: {width, height, data: revisionData}, geometry};
}
