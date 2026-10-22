import { calculateQuantity, measure, validateScales } from './measurements.ts';
import type { LinearUnit, Point, Scale } from './measurements.ts';

export type MeasurementRecord = {
  id: string;
  label: string;
  pageIndex: number;
  kind: Parameters<typeof measure>[0]['kind'];
  points: Point[];
  unit: LinearUnit;
  depth?: { value: number; unit: LinearUnit };
  /** Deducted openings for area/volume, each a polygon inside the outline. */
  cutouts?: Point[][];
  /** Derived quantity = measured value × multiplier × (1 + waste%). Never an evaluated expression. */
  quantity?: QuantityFormula;
};
export type QuantityFormula = { multiplier: number; wastePercent: number; unitLabel: string };
export type TakeoffState = { scales: Scale[]; records: MeasurementRecord[] };
export const emptyTakeoff = (): TakeoffState => ({scales:[],records:[]});

const units: readonly string[] = ['mm','cm','m','km','in','ft','yd'];
const kinds: readonly string[] = ['length','polyline','perimeter','area','angle','count','volume','radius','diameter','arc','space'];
export function validateQuantityFormula(value: unknown): QuantityFormula {
  const input = value as Partial<QuantityFormula> | null;
  if (!input || typeof input !== 'object' || typeof input.multiplier !== 'number' || typeof input.wastePercent !== 'number' ||
      typeof input.unitLabel !== 'string' || input.unitLabel.length > 50 || /[\x00-\x1f\x7f]/u.test(input.unitLabel)) throw new Error('Invalid derived quantity formula.');
  if (!Number.isFinite(input.multiplier) || input.multiplier === 0 || Math.abs(input.multiplier) > 1e9) throw new Error('Quantity multiplier must be a nonzero number up to 1,000,000,000.');
  calculateQuantity({measurement:1,multiplier:input.multiplier,wastePercent:input.wastePercent});
  return {multiplier:input.multiplier,wastePercent:input.wastePercent,unitLabel:input.unitLabel};
}

export function derivedQuantity(record: MeasurementRecord, value: number): number | undefined {
  return record.quantity ? calculateQuantity({measurement:value,multiplier:record.quantity.multiplier,wastePercent:record.quantity.wastePercent}) : undefined;
}

const unit = (value: unknown): value is LinearUnit => typeof value === 'string' && units.includes(value);

/** Canonical persisted model; results are always recomputed from reviewed scale evidence. */
export function validateTakeoff(value: unknown, pageCount: number): TakeoffState {
  if (!Number.isInteger(pageCount) || pageCount < 0) throw new Error('Invalid takeoff page count.');
  if (!value || typeof value !== 'object') throw new Error('Invalid takeoff workspace.');
  const input = value as Partial<TakeoffState>;
  if (!Array.isArray(input.scales) || !Array.isArray(input.records) || input.records.length > 10_000) throw new Error('Takeoff requires scales and at most 10,000 measurement records.');
  const scales = pageCount === 0 && input.scales.length === 0 ? [] : validateScales(input.scales,pageCount);
  const ids = new Set<string>();
  let pointCount = 0;
  const records = input.records.map((record): MeasurementRecord => {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id.trim() || record.id.length > 200 || ids.has(record.id) ||
        typeof record.label !== 'string' || record.label.length > 500 || !Number.isInteger(record.pageIndex) || record.pageIndex < 0 || record.pageIndex >= pageCount ||
        !kinds.includes(record.kind) || !unit(record.unit) || !Array.isArray(record.points)) throw new Error('Invalid or duplicate takeoff measurement record.');
    ids.add(record.id);
    pointCount += record.points.length;
    if (record.points.length > 10_000 || pointCount > 100_000) throw new Error('Takeoff exceeds the 100,000-point workspace limit or 10,000 points per measurement.');
    const points: Point[] = record.points.map(point => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))) throw new Error('Invalid takeoff coordinate.');
      return [point[0],point[1]];
    });
    const canonical: MeasurementRecord = {id:record.id,label:record.label,pageIndex:record.pageIndex,kind:record.kind,points,unit:record.unit};
    if (record.depth !== undefined) {
      if (!record.depth || typeof record.depth.value !== 'number' || !Number.isFinite(record.depth.value) || record.depth.value <= 0 || !unit(record.depth.unit)) throw new Error('Invalid takeoff depth.');
      canonical.depth = {value:record.depth.value,unit:record.depth.unit};
    }
    if (record.cutouts !== undefined) {
      if (!Array.isArray(record.cutouts) || record.cutouts.length > 50) throw new Error('Invalid takeoff cutouts.');
      canonical.cutouts = record.cutouts.map(hole => {
        if (!Array.isArray(hole) || hole.length < 3 || hole.length > 2000) throw new Error('Invalid takeoff cutout polygon.');
        pointCount += hole.length;
        return hole.map(point => {
          if (!Array.isArray(point) || point.length !== 2 || !point.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))) throw new Error('Invalid takeoff coordinate.');
          return [point[0], point[1]] as Point;
        });
      });
      if (pointCount > 100_000) throw new Error('Takeoff exceeds the 100,000-point workspace limit or 10,000 points per measurement.');
    }
    if (record.quantity !== undefined) canonical.quantity = validateQuantityFormula(record.quantity);
    const result = measure({...canonical,scales});
    derivedQuantity(canonical,result.value);
    return canonical;
  });
  return {scales,records};
}
