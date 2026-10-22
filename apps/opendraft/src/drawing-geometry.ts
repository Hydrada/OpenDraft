import type { Point } from './measurements';

/** PDF.js 6 operator and path codes used here. Kept local so the module stays testable in Node. */
export const PathOps = { save: 10, restore: 11, transform: 12, endPath: 28, beginMarkedContent: 69, beginMarkedContentProps: 70, endMarkedContent: 71, formBegin: 74, formEnd: 75, constructPath: 91 } as const;
const Draw = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const;

export type OperatorList = { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> };
export type DrawingVertices = { points: Point[]; truncated: boolean; skippedPaths: number; derived: Point[]; derivedTruncated: boolean };
/** Intersections are computed pairwise, so they are skipped above this many straight segments. */
export const INTERSECTION_SEGMENT_LIMIT = 6000;
type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const isMatrix = (value: unknown): value is Matrix =>
  !!value && typeof value === 'object' && (value as ArrayLike<number>).length === 6 && Array.from(value as ArrayLike<number>).every(Number.isFinite);

/**
 * Collects painted path vertices (segment endpoints, curve end points) in unrotated PDF user
 * space from a page operator list. Clip-only paths are ignored. Curve control points, text,
 * images, shadings and annotation appearances are not candidates. When `isVisible` is given,
 * geometry inside optional content (PDF layers) that it reports hidden is skipped, matching what
 * the renderer shows.
 */
export function extractDrawingVertices(list: OperatorList, limit = 50_000, isVisible?: (properties: unknown) => boolean): DrawingVertices {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) throw new Error('Vertex limit must be between 1 and 1,000,000.');
  const seen = new Set<string>(), points: Point[] = [], stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0], truncated = false, skippedPaths = 0;
  const marked: boolean[] = []; let hidden = 0;
  const segments: [Point, Point][] = [], curved = new Set<number>();
  let current: Point | undefined, raw: Point | undefined;
  const apply = (x: number, y: number): Point => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  // Curves are flattened into short pieces used only for intersections (never midpoints).
  const flatten = (controls: Point[], end: Point) => {
    if (!raw || !current || segments.length > INTERSECTION_SEGMENT_LIMIT) return;
    const start = raw, steps = 8, bezier = (t: number): Point => {
      const pts = [start, ...controls, end];
      // de Casteljau: each pass blends neighbours and drops the last point.
      while (pts.length > 1) { for (let i = 0; i < pts.length - 1; i++) pts[i] = [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]; pts.pop(); }
      return pts[0];
    };
    let previous = current;
    for (let k = 1; k <= steps; k++) { const next = apply(...bezier(k / steps)); if (![next[0], next[1]].every(Number.isFinite)) return; curved.add(segments.length); segments.push([previous, next]); previous = next; }
  };
  // Records the transformed vertex, plus the straight segment from the previous point when `line` is set.
  const add = (x: number, y: number, line = false) => {
    const px = ctm[0] * x + ctm[2] * y + ctm[4], py = ctm[1] * x + ctm[3] * y + ctm[5];
    if (!Number.isFinite(px) || !Number.isFinite(py)) { current = undefined; return; }
    if (line && current && segments.length <= INTERSECTION_SEGMENT_LIMIT) segments.push([current, [px, py]]);
    current = [px, py]; raw = [x, y];
    const key = `${Math.round(px * 1000)},${Math.round(py * 1000)}`;
    if (seen.has(key)) return;
    if (points.length >= limit) { truncated = true; return; }
    seen.add(key); points.push([px, py]);
  };
  for (let index = 0; index < list.fnArray.length && !truncated; index++) {
    const fn = list.fnArray[index], args = list.argsArray[index] as unknown[] | null;
    if (fn === PathOps.save) stack.push(ctm);
    else if (fn === PathOps.restore) ctm = stack.pop() ?? ctm;
    else if (fn === PathOps.transform && args && isMatrix(args)) ctm = multiply(ctm, Array.from(args) as Matrix);
    else if (fn === PathOps.formBegin) { stack.push(ctm); if (args && isMatrix(args[0])) ctm = multiply(ctm, Array.from(args[0]) as Matrix); }
    else if (fn === PathOps.formEnd) ctm = stack.pop() ?? ctm;
    else if (fn === PathOps.beginMarkedContent) marked.push(true);
    else if (fn === PathOps.beginMarkedContentProps) {
      const visible = !isVisible || args?.[0] !== 'OC' || isVisible(args?.[1]);
      marked.push(visible); if (!visible) hidden++;
    } else if (fn === PathOps.endMarkedContent) { if (marked.pop() === false) hidden--; }
    else if (fn === PathOps.constructPath && hidden > 0) continue;
    else if (fn === PathOps.constructPath && args) {
      if (args[0] === PathOps.endPath) continue;
      const data = (args[1] as unknown[] | undefined)?.[0] as ArrayLike<number> | undefined;
      if (!data || typeof data.length !== 'number') { skippedPaths++; continue; }
      let start: Point | undefined;
      for (let i = 0; i < data.length && !truncated;) {
        const code = data[i++];
        if (code === Draw.moveTo || code === Draw.lineTo) { const x = data[i++], y = data[i++]; if (code === Draw.moveTo) start = [x, y]; add(x, y, code === Draw.lineTo); }
        else if (code === Draw.curveTo) { const c1: Point = [data[i], data[i + 1]], c2: Point = [data[i + 2], data[i + 3]]; i += 4; const end: Point = [data[i++], data[i++]]; flatten([c1, c2], end); add(end[0], end[1]); }
        else if (code === Draw.quadraticCurveTo) { const c: Point = [data[i], data[i + 1]]; i += 2; const end: Point = [data[i++], data[i++]]; flatten([c], end); add(end[0], end[1]); }
        else if (code === Draw.closePath) { if (start) add(start[0], start[1], true); }
        else { skippedPaths++; break; }
      }
    }
  }
  const derived = deriveSnapPoints(segments, seen, limit, curved);
  return { points, truncated, skippedPaths, ...derived };
}

/**
 * Midpoints of painted straight segments and crossings between them (room corners where walls
 * cross are rarely path endpoints). Points already present as vertices are not repeated.
 */
function deriveSnapPoints(segments: readonly [Point, Point][], seen: Set<string>, limit: number, curved: ReadonlySet<number> = new Set()): { derived: Point[]; derivedTruncated: boolean } {
  const derived: Point[] = [], keys = new Set(seen);
  let derivedTruncated = segments.length > INTERSECTION_SEGMENT_LIMIT;
  const push = (x: number, y: number) => {
    const key = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
    if (keys.has(key)) return;
    if (derived.length >= limit) { derivedTruncated = true; return; }
    keys.add(key); derived.push([x, y]);
  };
  const kept = segments.slice(0, INTERSECTION_SEGMENT_LIMIT).map((segment, index) => ({ segment, curve: curved.has(index) })).filter(({ segment: [a, b] }) => Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9);
  const usable = kept.map(item => item.segment);
  for (const { segment: [a, b], curve } of kept) if (!curve) push((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  const box = usable.map(([a, b]) => [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
  for (let i = 0; i < usable.length && !derivedTruncated; i++) {
    const [p, p2] = usable[i], r = [p2[0] - p[0], p2[1] - p[1]], bi = box[i];
    for (let j = i + 1; j < usable.length; j++) {
      // Consecutive pieces of one flattened curve only touch at their shared joint: not a crossing.
      if (j === i + 1 && kept[i].curve && kept[j].curve) continue;
      const bj = box[j];
      if (bj[0] > bi[1] || bj[1] < bi[0] || bj[2] > bi[3] || bj[3] < bi[2]) continue;
      const [q, q2] = usable[j], s = [q2[0] - q[0], q2[1] - q[1]], denominator = r[0] * s[1] - r[1] * s[0];
      if (Math.abs(denominator) < 1e-9) continue; // parallel or collinear: no single crossing
      const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / denominator, u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / denominator;
      if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) push(p[0] + t * r[0], p[1] + t * r[1]);
    }
  }
  return { derived, derivedTruncated };
}
