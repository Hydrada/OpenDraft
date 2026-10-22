import type { LinearUnit } from './measurements.ts';
import { validateQuantityFormula, type MeasurementRecord, type QuantityFormula } from './takeoff.ts';

export type MeasurementPreset = {
  name: string; kind: MeasurementRecord['kind']; label: string; unit: LinearUnit;
  depth?: { value: number; unit: LinearUnit }; quantity?: QuantityFormula;
};
export const measurementPresetKey = 'opendraft.measurement-presets.v1';
const units: readonly string[] = ['mm','cm','m','km','in','ft','yd'];
const kinds: readonly string[] = ['length','polyline','perimeter','area','angle','count','volume','radius','diameter','arc','space'];
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

/** Presets carry settings only, never geometry or calibration; applying one is not a measurement. */
export function validateMeasurementPresets(value: unknown): MeasurementPreset[] {
  const input = value as { schema?: unknown; version?: unknown; presets?: unknown } | null;
  if (!input || input.schema !== 'opendraft.measurement-presets' || input.version !== 1 || !Array.isArray(input.presets) || input.presets.length > 200)
    throw new Error('Measurement presets require schema opendraft.measurement-presets version 1 with at most 200 presets.');
  const names = new Set<string>();
  return input.presets.map((raw): MeasurementPreset => {
    const preset = raw as Partial<MeasurementPreset> | null;
    if (!preset || typeof preset !== 'object' || !text(preset.name, 100) || !preset.name!.trim() || names.has(preset.name!.trim().toLowerCase()) ||
        !kinds.includes(preset.kind as string) || !text(preset.label, 500) || !units.includes(preset.unit as string)) throw new Error('Invalid or duplicate measurement preset.');
    names.add(preset.name!.trim().toLowerCase());
    const result: MeasurementPreset = {name:preset.name!.trim(),kind:preset.kind!,label:preset.label!,unit:preset.unit!};
    if (preset.depth !== undefined) {
      if (preset.kind !== 'volume' || !preset.depth || typeof preset.depth.value !== 'number' || !Number.isFinite(preset.depth.value) || preset.depth.value <= 0 || !units.includes(preset.depth.unit))
        throw new Error('Measurement preset depth requires a volume preset and a positive depth.');
      result.depth = {value:preset.depth.value,unit:preset.depth.unit};
    }
    if (preset.quantity !== undefined) result.quantity = validateQuantityFormula(preset.quantity);
    return result;
  });
}

export const serializeMeasurementPresets = (presets: readonly MeasurementPreset[]) =>
  JSON.stringify({schema:'opendraft.measurement-presets',version:1,presets:validateMeasurementPresets({schema:'opendraft.measurement-presets',version:1,presets})});

export function loadMeasurementPresets(storage: Pick<Storage,'getItem'>): {presets: MeasurementPreset[]; error?: string} {
  try { const raw = storage.getItem(measurementPresetKey); return {presets: raw ? validateMeasurementPresets(JSON.parse(raw)) : []}; }
  catch (error) { return {presets: [], error: `Saved measurement presets were ignored: ${error instanceof Error ? error.message : String(error)}`}; }
}
