export type Point = [number, number];
export type Rect = [number, number, number, number];
export type LinearUnit = 'mm' | 'cm' | 'm' | 'km' | 'in' | 'ft' | 'yd';
export type CalibrationReference = { points: [Point, Point]; distance: number; unit: LinearUnit };
export type Scale = { id: string; pageIndex: number; viewport?: Rect; metersPerPdfUnit: number; reference: CalibrationReference };
export type MeasureKind = 'length' | 'polyline' | 'perimeter' | 'area' | 'angle' | 'count' | 'volume' | 'radius' | 'diameter' | 'arc' | 'space';
export type MeasurementRequest = { kind: MeasureKind; points: readonly Point[]; pageIndex: number; scales: readonly Scale[]; unit?: LinearUnit; depth?: { value: number; unit: LinearUnit }; cutouts?: readonly (readonly Point[])[] };
export type MeasurementResult = { kind: MeasureKind; value: number; unit: string; scaleId: string | null };
// International inch/foot/yard, not legacy US survey-foot units. NIST HB44 Appendix C.
const meters: Record<LinearUnit, number> = { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144 };
const maxQuantity = 1e18;
export function unitFactor(unit: LinearUnit): number { if (!Object.hasOwn(meters, unit)) throw new Error('Unsupported measurement unit.'); return meters[unit]; }
function bounded(value: number): number { if (!Number.isFinite(value) || value < 0 || value > maxQuantity) throw new Error('Measurement quantity exceeds the supported numeric range.'); return value; }
function checkPoints(points: readonly Point[], min = 1): Point[] {
  if (!Array.isArray(points) || points.length < min || points.length > 10000 || points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || Math.abs(v) > 1e9))) throw new Error('Measurement requires bounded finite PDF page coordinates.');
  return points.map(([x, y]) => [x, y]);
}
function validPage(page: number): void { if (!Number.isSafeInteger(page) || page < 0) throw new Error('Invalid measurement page index.'); }
function rectangle(viewport: Rect): Rect {
  if (!Array.isArray(viewport) || viewport.length !== 4 || viewport.some(v => !Number.isFinite(v) || Math.abs(v) > 1e9) || viewport[0] >= viewport[2] || viewport[1] >= viewport[3]) throw new Error('Viewport must be a positive rectangular PDF region.');
  return [...viewport];
}
const inside = ([x, y]: Point, r: Rect) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function reference(value: CalibrationReference): CalibrationReference {
  if (!value || !Number.isFinite(value.distance) || value.distance <= 0 || value.distance > 1e12) throw new Error('Known calibration distance must be positive and bounded.');
  const points = checkPoints(value.points, 2);
  if (points.length !== 2 || distance(points[0], points[1]) < 1e-7) throw new Error('Calibration requires two separated reference points.');
  unitFactor(value.unit);
  return { points: [points[0], points[1]], distance: value.distance, unit: value.unit };
}
export function calibrateScale(input: { id: string; pageIndex: number; viewport?: Rect; points: [Point, Point]; distance: number; unit: LinearUnit }): Scale {
  validPage(input.pageIndex);
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(input.id)) throw new Error('Invalid scale identity.');
  const known = reference(input), viewport = input.viewport === undefined ? undefined : rectangle(input.viewport);
  if (viewport && known.points.some(p => !inside(p, viewport))) throw new Error('Calibration reference points must lie inside their viewport.');
  const ratio = known.distance * unitFactor(known.unit) / distance(...known.points);
  if (!Number.isFinite(ratio) || ratio < 1e-12 || ratio > 1e12) throw new Error('Calibration ratio exceeds the supported numeric range.');
  return { id: input.id, pageIndex: input.pageIndex, ...(viewport ? { viewport } : {}), metersPerPdfUnit: ratio, reference: known };
}
/** Recovered ratios must agree with their stored calibration evidence. No unchecked ratios. */
export function validateScales(scales: readonly Scale[], pageCount = Number.MAX_SAFE_INTEGER): Scale[] {
  if (!Array.isArray(scales) || scales.length > 1000 || !Number.isInteger(pageCount) || pageCount < 1) throw new Error('Invalid calibration collection or page count.');
  const ids = new Set<string>(), pageScales = new Set<number>();
  return scales.map((scale: Scale) => {
    if (!scale || !scale.reference || !Number.isFinite(scale.metersPerPdfUnit)) throw new Error('Calibration evidence is required.');
    const known = reference(scale.reference);
    const result = calibrateScale({ id: scale.id, pageIndex: scale.pageIndex, viewport: scale.viewport, points: known.points, distance: known.distance, unit: known.unit });
    if (result.pageIndex >= pageCount || ids.has(result.id)) throw new Error('Duplicate calibration id or invalid page.');
    ids.add(result.id);
    if (!result.viewport) { if (pageScales.has(result.pageIndex)) throw new Error('A page can have only one page-wide calibration.'); pageScales.add(result.pageIndex); }
    if (Math.abs(scale.metersPerPdfUnit - result.metersPerPdfUnit) / result.metersPerPdfUnit > 1e-12) throw new Error('Calibration ratio does not match reference evidence.');
    return result;
  });
}
function segmentTouchesRect(a: Point, b: Point, r: Rect): boolean {
  let low = 0, high = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - r[0]], [dx, r[2] - a[0]], [-dy, a[1] - r[1]], [dy, r[3] - a[1]]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) low = Math.max(low, t); else high = Math.min(high, t);
    if (low > high) return false;
  }
  return true;
}
/** Closed viewport boundaries belong to the viewport. Any overlap/crossing is explicit error. */
export function resolveScale(scales: readonly Scale[], pageIndex: number, points: readonly Point[]): Scale {
  validPage(pageIndex); const pts = checkPoints(points);
  const candidates = validateScales(scales).filter(scale => scale.pageIndex === pageIndex);
  const touching = candidates.filter(scale => scale.viewport && (pts.some(p => inside(p, scale.viewport!)) || pts.slice(1).some((p, i) => segmentTouchesRect(pts[i], p, scale.viewport!))));
  if (touching.length) {
    if (touching.length !== 1 || !pts.every(p => inside(p, touching[0].viewport!))) throw new Error('Ambiguous calibration: measurement crosses or overlaps viewport scales. Split the measurement.');
    return touching[0];
  }
  const pageScale = candidates.find(scale => !scale.viewport);
  if (!pageScale) throw new Error('No calibration applies to this measurement.');
  return pageScale;
}
function sum(values: number[]): number { let total = 0, correction = 0; for (const value of values) { const adjusted = value - correction, next = total + adjusted; correction = (next - total) - adjusted; total = next; } return total; }
function cross(a: Point, b: Point, c: Point): number { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let insidePolygon = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) insidePolygon = !insidePolygon;
  }
  return insidePolygon;
}
function polygon(input: readonly Point[]): { points: Point[]; area: number } {
  const points = checkPoints(input, 3);
  if (points.length > 2001) throw new Error('Polygon exceeds the 2000 vertex limit.');
  if (distance(points[0], points.at(-1)!) === 0) points.pop();
  if (points.length < 3 || points.length > 2000) throw new Error('Polygon requires at least three distinct vertices.');
  const extent = Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]));
  const yExtent = Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1]));
  const eps = Math.max(1, extent, yExtent) ** 2 * 1e-12;
  const onSegment = (a: Point, b: Point, c: Point) => Math.abs(cross(a, b, c)) <= eps && c[0] >= Math.min(a[0], b[0]) && c[0] <= Math.max(a[0], b[0]) && c[1] >= Math.min(a[1], b[1]) && c[1] <= Math.max(a[1], b[1]);
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (distance(a, b) < 1e-7) throw new Error('Polygon has duplicate or degenerate edges.');
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      const c = points[j], d = points[(j + 1) % points.length];
      const c1 = cross(a, b, c), c2 = cross(a, b, d), c3 = cross(c, d, a), c4 = cross(c, d, b);
      if ((c1 > eps && c2 < -eps || c1 < -eps && c2 > eps) && (c3 > eps && c4 < -eps || c3 < -eps && c4 > eps) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)) throw new Error('Polygon is self-intersecting or touches itself.');
    }
  }
  // Translate before shoelace sum to avoid cancellation for small shapes at large origins.
  const origin = points[0];
  const area = Math.abs(sum(points.map((a, i) => cross(origin, a, points[(i + 1) % points.length]))) / 2);
  if (area <= eps) throw new Error('Polygon area is degenerate or below numerical precision.');
  return { points, area };
}
export function measure(request: MeasurementRequest): MeasurementResult {
  validPage(request.pageIndex); const points = checkPoints(request.points);
  const kind = request.kind, unit = request.unit ?? 'm'; unitFactor(unit);
  if (kind === 'count') return { kind, value: points.length, unit: 'count', scaleId: null };
  if (kind === 'angle') {
    if (points.length !== 3) throw new Error('Angle requires three points with the vertex in the middle.');
    const a = [points[0][0] - points[1][0], points[0][1] - points[1][1]], b = [points[2][0] - points[1][0], points[2][1] - points[1][1]];
    if (Math.hypot(...a) < 1e-7 || Math.hypot(...b) < 1e-7) throw new Error('Angle has a degenerate arm.');
    return { kind, value: Math.atan2(Math.abs(a[0] * b[1] - a[1] * b[0]), a[0] * b[0] + a[1] * b[1]) * 180 / Math.PI, unit: 'deg', scaleId: null };
  }
  if (kind === 'radius' || kind === 'diameter') {
    // Centre point, then any point on the circle.
    if (points.length !== 2) throw new Error('Radius and diameter require the centre point and one point on the circle.');
    const radius = distance(points[0], points[1]);
    if (radius < 1e-7) throw new Error('Radius is degenerate.');
    const scale = resolveScale(request.scales, request.pageIndex, points), factor = scale.metersPerPdfUnit / unitFactor(unit);
    return { kind, value: bounded(radius * factor * (kind === 'diameter' ? 2 : 1)), unit, scaleId: scale.id };
  }
  if (kind === 'arc') {
    // Start, any point along the arc, end: the arc through all three on their circumcircle.
    if (points.length !== 3) throw new Error('Arc requires start, a point on the arc, and end.');
    const [a, b, c] = points, d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-9) throw new Error('Arc points are collinear; use length instead.');
    const sq = (p: Point) => p[0] ** 2 + p[1] ** 2;
    const centre: Point = [(sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d, (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d];
    const radius = distance(centre, a), angle = (p: Point) => Math.atan2(p[1] - centre[1], p[0] - centre[0]), turn = 2 * Math.PI;
    const ccw = (from: number, to: number) => ((to - from) % turn + turn) % turn;
    const sweep = ccw(angle(a), angle(b)) <= ccw(angle(a), angle(c)) ? ccw(angle(a), angle(c)) : turn - ccw(angle(a), angle(c));
    const scale = resolveScale(request.scales, request.pageIndex, points), factor = scale.metersPerPdfUnit / unitFactor(unit);
    return { kind, value: bounded(radius * sweep * factor), unit, scaleId: scale.id };
  }
  if (!['length', 'polyline', 'perimeter', 'area', 'volume', 'space'].includes(kind)) throw new Error('Unsupported measurement kind.');
  if (kind === 'length' && points.length !== 2 || kind === 'polyline' && points.length < 2) throw new Error('Length requires two points; polyline requires at least two.');
  const closed = ['perimeter', 'area', 'volume', 'space'].includes(kind) ? polygon(points) : null;
  const path = closed ? [...closed.points, closed.points[0]] : points;
  const scale = resolveScale(request.scales, request.pageIndex, path), factor = scale.metersPerPdfUnit / unitFactor(unit);
  if (kind === 'area' || kind === 'volume' || kind === 'space') {
    // A different-scale inset can be entirely inside a polygon without any boundary crossing.
    for (const other of validateScales(request.scales).filter(s => s.pageIndex === request.pageIndex && s.id !== scale.id && s.viewport)) {
      const [x1, y1, x2, y2] = other.viewport!;
      if ([[x1, y1], [x2, y1], [x2, y2], [x1, y2]].some(p => pointInPolygon(p as Point, closed!.points))) throw new Error('Ambiguous calibration: area encloses another viewport scale. Split the measurement.');
    }
  }
  let value: number;
  if (request.cutouts?.length && kind !== 'area' && kind !== 'volume' && kind !== 'space') throw new Error('Cutouts apply only to area and volume measurements.');
  if (kind === 'area' || kind === 'volume' || kind === 'space') {
    // Cutouts (openings, shafts) are deducted. Each must lie wholly inside the outline and apart from the others.
    const holes = (request.cutouts ?? []).map(hole => polygon(hole));
    if (holes.length > 50) throw new Error('At most 50 cutouts per measurement.');
    for (const [index, hole] of holes.entries()) {
      if (!hole.points.every(p => pointInPolygon(p, closed!.points))) throw new Error(`Cutout ${index + 1} must lie inside the measured outline.`);
      for (const other of holes.slice(0, index)) if (hole.points.some(p => pointInPolygon(p, other.points)) || other.points.some(p => pointInPolygon(p, hole.points))) throw new Error(`Cutout ${index + 1} overlaps another cutout.`);
    }
    const net = closed!.area - holes.reduce((total, hole) => total + hole.area, 0);
    if (!(net > 0)) throw new Error('Cutouts remove the whole area.');
    value = net * factor ** 2;
    if (kind === 'volume') {
      if (!request.depth || !Number.isFinite(request.depth.value) || request.depth.value <= 0) throw new Error('Volume requires a positive known depth and unit.');
      value *= request.depth.value * unitFactor(request.depth.unit) / unitFactor(unit);
    }
  } else {
    const lengths = path.slice(1).map((p, i) => distance(path[i], p));
    if (lengths.some(length => length < 1e-7)) throw new Error('Measurement contains a degenerate segment.');
    value = sum(lengths) * factor;
  }
  return { kind, value: bounded(value), unit: kind === 'area' || kind === 'space' ? `${unit}²` : kind === 'volume' ? `${unit}³` : unit, scaleId: scale.id };
}
/**
 * Space (named room/zone) that contains a measurement: the first space on the same page whose
 * outline contains the measurement's centroid. Spaces themselves belong to no space.
 */
export function spaceOf<T extends { kind: string; pageIndex: number; points: readonly Point[]; label: string }>(record: T, records: readonly T[]): T | undefined {
  if (record.kind === 'space' || !record.points.length) return undefined;
  const centre: Point = [record.points.reduce((s, p) => s + p[0], 0) / record.points.length, record.points.reduce((s, p) => s + p[1], 0) / record.points.length];
  return records.find(space => space.kind === 'space' && space.pageIndex === record.pageIndex && space.points.length >= 3 && pointInPolygon(centre, space.points));
}
/**
 * Sketch to scale: the end point of a line that starts at `start` and is exactly `length` long in
 * real units at the page's calibration, drawn at `degrees` (counter-clockwise from +x in PDF space).
 */
export function sketchEndpoint(scales: readonly Scale[], pageIndex: number, start: Point, length: number, unit: LinearUnit, degrees: number): Point {
  if (!Number.isFinite(length) || length <= 0 || length > 1e6) throw new Error('Sketch length must be a positive number.');
  if (!Number.isFinite(degrees)) throw new Error('Sketch angle must be a number of degrees.');
  const scale = resolveScale(scales, pageIndex, [start]);
  const units = length * unitFactor(unit) / scale.metersPerPdfUnit, radians = degrees * Math.PI / 180;
  return [start[0] + units * Math.cos(radians), start[1] + units * Math.sin(radians)];
}
export function verifyCalibration(scale: Scale, check: CalibrationReference & { tolerance?: number }): { measured: number; expected: number; relativeError: number; passed: boolean } {
  const validated = validateScales([scale])[0], known = reference(check), tolerance = check.tolerance ?? 0.001;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.01) throw new Error('Verification tolerance must be between zero and one percent.');
  const samePoint = (a: Point, b: Point) => distance(a,b) <= 1e-7;
  const original = validated.reference.points;
  if ((samePoint(known.points[0],original[0]) && samePoint(known.points[1],original[1])) ||
      (samePoint(known.points[0],original[1]) && samePoint(known.points[1],original[0])))
    throw new Error('Independent verification requires a different known reference, not the original calibration points.');
  if (validated.viewport && known.points.some(p => !inside(p, validated.viewport!))) throw new Error('Verification points lie outside the calibrated viewport.');
  const measured = distance(...known.points) * validated.metersPerPdfUnit / unitFactor(known.unit), relativeError = Math.abs(measured - known.distance) / known.distance;
  return { measured, expected: known.distance, relativeError, passed: relativeError <= tolerance };
}
/** Bounded linear quantity factor and waste allowance; never executes arbitrary formula text. */
export function calculateQuantity({ measurement, multiplier = 1, wastePercent = 0 }: { measurement: number; multiplier?: number; wastePercent?: number }): number {
  bounded(measurement); bounded(multiplier);
  if (!Number.isFinite(wastePercent) || wastePercent < 0 || wastePercent > 1000) throw new Error('Waste allowance must be between zero and 1000 percent.');
  return bounded(measurement * multiplier * (1 + wastePercent / 100));
}
