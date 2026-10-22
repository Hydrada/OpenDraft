import type { Point } from './measurements';

export type SnapKind = 'vertex' | 'orthogonal' | 'none';
export type SnapResult = { point: Point; kind: SnapKind; distance: number };
export type SnapOptions = { tolerance: number; vertices: readonly Point[]; anchor?: Point; orthogonal?: boolean };

/**
 * Snaps a screen-space pick. All inputs share one coordinate space (viewport pixels), so
 * tolerance and horizontal/vertical stay as the reviewer sees them under rotation and zoom.
 * Vertex snapping wins over orthogonal constraint; only existing measurement/draft vertices are
 * candidates. Drawing vector geometry is never inferred.
 */
export function snapPick(raw: Point, options: SnapOptions): SnapResult {
  if (!raw.every(Number.isFinite)) throw new Error('Snap input must be finite.');
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0 || options.tolerance > 100) throw new Error('Snap tolerance must be between 0 and 100 pixels.');
  let best: Point | undefined, bestDistance = Infinity;
  for (const vertex of options.vertices) {
    if (!vertex.every(Number.isFinite)) continue;
    const distance = Math.hypot(vertex[0] - raw[0], vertex[1] - raw[1]);
    if (distance <= options.tolerance && distance < bestDistance) { best = vertex; bestDistance = distance; }
  }
  if (best) return { point: [best[0], best[1]], kind: 'vertex', distance: bestDistance };
  const anchor = options.anchor;
  if (options.orthogonal && anchor && anchor.every(Number.isFinite)) {
    const dx = raw[0] - anchor[0], dy = raw[1] - anchor[1];
    const point: Point = Math.abs(dx) >= Math.abs(dy) ? [raw[0], anchor[1]] : [anchor[0], raw[1]];
    return { point, kind: 'orthogonal', distance: Math.hypot(point[0] - raw[0], point[1] - raw[1]) };
  }
  return { point: [raw[0], raw[1]], kind: 'none', distance: 0 };
}
