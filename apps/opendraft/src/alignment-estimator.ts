// jsfeat 0.0.8 ships CommonJS without TypeScript declarations; its bundled LICENSE is MIT.
// @ts-expect-error Upstream package has no declaration file.
import jsfeat from 'jsfeat';
import type { RasterPage } from './revision-comparison';

export type AlignmentEstimate = {
  /** Canvas convention: x'=a*x+c*y+e; y'=b*x+d*y+f, revision -> base. */
  matrix: [number, number, number, number, number, number];
  scale: number;
  rotationDegrees: number;
  matches: number;
  inliers: number;
  residualPixels: number;
  coverage: number;
  method: string;
};
type Point = {x: number; y: number};
type Feature = Point & {descriptor: Uint32Array};
type Match = {base: Point; revision: Point; distance: number};
type Matrix = AlignmentEstimate['matrix'];
export const ALIGNMENT_LIMITS = Object.freeze({maxPixels: 4_000_000, maxSide: 8192, previewSide: 640, maxFeatures: 600, minInliers: 8, minInlierRatio: 0.45, minCoverage: 0.08});

function validate(page: RasterPage) {
  if (!page || !Number.isSafeInteger(page.width) || !Number.isSafeInteger(page.height) || page.width < 1 || page.height < 1 || page.width > ALIGNMENT_LIMITS.maxSide || page.height > ALIGNMENT_LIMITS.maxSide || page.width * page.height > ALIGNMENT_LIMITS.maxPixels) throw new Error('Alignment input exceeds the 4,000,000-pixel/8192-side budget or has invalid dimensions.');
  if (!(page.data instanceof Uint8ClampedArray) || page.data.length !== page.width * page.height * 4) throw new Error('Alignment requires exactly width × height × 4 RGBA bytes.');
}
function gray(page: RasterPage) {
  const image = new jsfeat.matrix_t(page.width, page.height, jsfeat.U8_t | jsfeat.C1_t);
  for (let p = 0, i = 0; p < page.width * page.height; p++, i += 4) {
    const alpha = page.data[i + 3] / 255;
    image.data[p] = Math.round((0.299 * page.data[i] + 0.587 * page.data[i + 1] + 0.114 * page.data[i + 2]) * alpha + 255 * (1 - alpha));
  }
  return image;
}
function orientation(image: {cols: number; data: Uint8Array}, x: number, y: number) {
  let mx = 0, my = 0;
  // Intensity-centroid orientation over a circular 31-pixel descriptor patch.
  for (let dy = -15; dy <= 15; dy++) {
    const radius = Math.floor(Math.sqrt(225 - dy * dy));
    for (let dx = -radius; dx <= radius; dx++) {
      const value = image.data[(y + dy) * image.cols + x + dx]; mx += dx * value; my += dy * value;
    }
  }
  return Math.atan2(my, mx);
}
function features(page: RasterPage, commonScale: number): Feature[] {
  const source = gray(page), found: Feature[] = [];
  const width = Math.max(1, Math.floor(page.width * commonScale)), height = Math.max(1, Math.floor(page.height * commonScale));
  // YAPE06 skips the next x after every accepted maximum, so half the pixels is a safe storage bound.
  const scratch = Array.from({length: Math.ceil(width * height / 2) + 1}, () => new jsfeat.keypoint_t(0, 0, 0, 0, 0));
  for (let level = 0; level < 6; level++) {
    const factor = 0.8 ** level, w = Math.floor(width * factor), h = Math.floor(height * factor);
    if (w < 64 || h < 64) break;
    const image = new jsfeat.matrix_t(w, h, jsfeat.U8_t | jsfeat.C1_t);
    if (w === page.width && h === page.height) image.data.set(source.data.subarray(0, w * h));
    else jsfeat.imgproc.resample(source, image, w, h);
    const count = jsfeat.yape06.detect(image, scratch, 24);
    const bins: {x: number; y: number; score: number; angle: number}[][] = Array.from({length: 16}, () => []);
    for (let i = 0; i < count; i++) {
      const p = scratch[i];
      bins[Math.min(3, Math.floor(p.y * 4 / h)) * 4 + Math.min(3, Math.floor(p.x * 4 / w))].push({x: p.x, y: p.y, score: p.score, angle: 0});
    }
    for (const bin of bins) bin.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
    const selected: {x: number; y: number; score: number; angle: number}[] = [];
    for (let rank = 0; selected.length < 100 && rank < count; rank++) {
      let any = false;
      for (const bin of bins) if (bin[rank] && selected.length < 100) {selected.push(bin[rank]); any = true;}
      if (!any) break;
    }
    if (!selected.length) continue;
    const blurred = new jsfeat.matrix_t(w, h, jsfeat.U8_t | jsfeat.C1_t);
    jsfeat.imgproc.gaussian_blur(image, blurred, 3, 1);
    for (const p of selected) p.angle = orientation(blurred, p.x, p.y);
    const descriptors = new jsfeat.matrix_t(32, selected.length, jsfeat.U8_t | jsfeat.C1_t);
    jsfeat.orb.describe(blurred, selected, selected.length, descriptors);
    for (let i = 0; i < selected.length; i++) {
      // Coordinates are physical raster edges, hence +0.5 for a pixel center before rescaling.
      found.push({x: (selected[i].x + 0.5) * page.width / w, y: (selected[i].y + 0.5) * page.height / h, descriptor: new Uint32Array(descriptors.data.subarray(i * 32, i * 32 + 32).slice().buffer)});
    }
  }
  return found;
}
function bits(value: number) {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
function correspondences(base: Feature[], revision: Feature[]): Match[] {
  const bestB = new Int32Array(base.length).fill(-1), bestR = new Int32Array(revision.length).fill(-1);
  const distB = new Int32Array(base.length).fill(257), nextB = new Int32Array(base.length).fill(257);
  const distR = new Int32Array(revision.length).fill(257), nextR = new Int32Array(revision.length).fill(257);
  for (let b = 0; b < base.length; b++) for (let r = 0; r < revision.length; r++) {
    let distance = 0;
    for (let k = 0; k < 8; k++) distance += bits(base[b].descriptor[k] ^ revision[r].descriptor[k]);
    if (distance < distB[b]) {nextB[b] = distB[b]; distB[b] = distance; bestB[b] = r;} else if (distance < nextB[b]) nextB[b] = distance;
    if (distance < distR[r]) {nextR[r] = distR[r]; distR[r] = distance; bestR[r] = b;} else if (distance < nextR[r]) nextR[r] = distance;
  }
  const matches: Match[] = [];
  for (let b = 0; b < base.length; b++) {
    const r = bestB[b];
    if (r >= 0 && bestR[r] === b && distB[b] < 72 && distB[b] < 0.8 * nextB[b] && distR[r] < 0.8 * nextR[r]) {
      const match = {base: base[b], revision: revision[r], distance: distB[b]};
      // Multiple pyramid levels at the same location do not count as independent support.
      if (!matches.some(other => Math.hypot(other.base.x - match.base.x, other.base.y - match.base.y) < 4 && Math.hypot(other.revision.x - match.revision.x, other.revision.y - match.revision.y) < 4)) matches.push(match);
    }
  }
  return matches.sort((a, b) => a.distance - b.distance || a.base.y - b.base.y || a.base.x - b.base.x);
}
function fit(matches: Match[]): Matrix | undefined {
  let bx = 0, by = 0, rx = 0, ry = 0;
  for (const p of matches) {bx += p.base.x; by += p.base.y; rx += p.revision.x; ry += p.revision.y;}
  bx /= matches.length; by /= matches.length; rx /= matches.length; ry /= matches.length;
  let dot = 0, cross = 0, denominator = 0;
  for (const p of matches) {
    const x = p.revision.x - rx, y = p.revision.y - ry, u = p.base.x - bx, v = p.base.y - by;
    dot += x * u + y * v; cross += x * v - y * u; denominator += x * x + y * y;
  }
  if (denominator < 1e-6) return;
  const a = dot / denominator, b = cross / denominator, scale = Math.hypot(a, b);
  if (scale < 0.25 || scale > 4) return;
  return [a, b, -b, a, bx - a * rx + b * ry, by - b * rx - a * ry];
}
const error = (m: Matrix, p: Match) => Math.hypot(m[0] * p.revision.x + m[2] * p.revision.y + m[4] - p.base.x, m[1] * p.revision.x + m[3] * p.revision.y + m[5] - p.base.y);
function support(matrix: Matrix, matches: Match[], tolerance: number) {return matches.filter(p => error(matrix, p) <= tolerance);}
function coverage(points: Point[], page: RasterPage) {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) / (page.width * page.height);
}
/** Deterministic feature-based suggestion; a caller must ask the reviewer before applying it. */
export async function estimateAlignment(base: RasterPage, revision: RasterPage): Promise<AlignmentEstimate> {
  validate(base); validate(revision);
  const previewScale = Math.min(1, ALIGNMENT_LIMITS.previewSide / Math.max(base.width, base.height, revision.width, revision.height));
  const matches = correspondences(features(base, previewScale), features(revision, previewScale));
  if (matches.length < ALIGNMENT_LIMITS.minInliers) throw new Error('Not enough distinctive shared drawing features to suggest alignment. Use manual alignment.');
  const tolerance = 3 / previewScale;
  let best: Match[] = [], bestMatrix: Matrix | undefined, bestError = Infinity, seed = 0x1a17c0de;
  const random = () => {seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296;};
  const iterations = Math.min(1500, matches.length * (matches.length - 1) / 2);
  for (let i = 0; i < iterations; i++) {
    const p = matches[Math.floor(random() * matches.length)], q = matches[Math.floor(random() * matches.length)];
    if (p === q || Math.hypot(p.revision.x - q.revision.x, p.revision.y - q.revision.y) < 20 / previewScale) continue;
    const matrix = fit([p, q]); if (!matrix) continue;
    const inliers = support(matrix, matches, tolerance), sum = inliers.reduce((total, item) => total + error(matrix, item) ** 2, 0);
    if (inliers.length > best.length || (inliers.length === best.length && sum < bestError)) {best = inliers; bestMatrix = matrix; bestError = sum;}
  }
  if (!bestMatrix || best.length < ALIGNMENT_LIMITS.minInliers || best.length / matches.length < ALIGNMENT_LIMITS.minInlierRatio) throw new Error('Shared features do not support a reliable alignment. Use manual alignment.');
  for (let i = 0; i < 3; i++) {
    const candidate = fit(best); if (!candidate) throw new Error('Alignment geometry is degenerate.');
    bestMatrix = candidate; best = support(candidate, matches, tolerance);
  }
  const cov = Math.min(coverage(best.map(p => p.base), base), coverage(best.map(p => p.revision), revision));
  const grid = new Set(best.map(p => `${Math.min(2, Math.floor(p.base.x * 3 / base.width))},${Math.min(2, Math.floor(p.base.y * 3 / base.height))}`));
  const residual = Math.sqrt(best.reduce((sum, p) => sum + error(bestMatrix!, p) ** 2, 0) / best.length);
  if (best.length < ALIGNMENT_LIMITS.minInliers || best.length / matches.length < ALIGNMENT_LIMITS.minInlierRatio || cov < ALIGNMENT_LIMITS.minCoverage || grid.size < 4 || residual > 2.5 / previewScale) throw new Error('Alignment support is too local, sparse or inconsistent. Use manual alignment.');
  return {matrix: bestMatrix, scale: Math.hypot(bestMatrix[0], bestMatrix[1]), rotationDegrees: Math.atan2(bestMatrix[1], bestMatrix[0]) * 180 / Math.PI, matches: matches.length, inliers: best.length, residualPixels: residual, coverage: cov, method: 'jsfeat 0.0.8 ORB; mutual ratio matches; deterministic similarity RANSAC; reviewer approval required'};
}
