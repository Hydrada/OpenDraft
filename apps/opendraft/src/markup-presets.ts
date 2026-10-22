import { validateMarkups } from './annotations.ts';
import type { Markup, MarkupKind, StampName } from './annotations.ts';

/** A reusable tool definition. Drawing geometry and document/reviewer state are never stored here. */
export type MarkupPreset = {
  id: string;
  name: string;
  kind: MarkupKind;
  stampName?: StampName;
  color: [number, number, number];
  width: number;
  opacity: number;
  contents: string;
};

export const MAX_PRESET_LIBRARY_BYTES = 1024 * 1024;
export const MAX_MARKUP_PRESETS = 200;
const timestamp = '2026-01-01T00:00:00.000Z';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedJson(value: unknown): string {
  let text: string | undefined;
  try { text = JSON.stringify(value, null, 2); }
  catch { throw new Error('Preset library must contain serializable JSON data.'); }
  if (text === undefined || new TextEncoder().encode(text).length > MAX_PRESET_LIBRARY_BYTES)
    throw new Error('Preset library exceeds the 1 MiB JSON limit.');
  return text;
}

/** Validate the versioned import/storage envelope and return only supported fields with deep copies. */
export function validatePresetLibrary(value: unknown): MarkupPreset[] {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.presets))
    throw new Error('Unsupported or invalid preset library; expected version 1.');
  if (value.presets.length > MAX_MARKUP_PRESETS)
    throw new Error('Preset library supports at most 200 presets.');
  boundedJson(value);
  const ids = new Set<string>(), names = new Set<string>();
  return Array.from(value.presets, (entry: unknown): MarkupPreset => {
    if (!record(entry) || typeof entry.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,120}$/.test(entry.id))
      throw new Error('Invalid preset id.');
    if (typeof entry.name !== 'string') throw new Error('Invalid preset name.');
    const name = entry.name.trim().normalize('NFC');
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))
      throw new Error('Preset name must contain 1–80 characters without control characters.');
    const nameKey = name.toLowerCase();
    if (ids.has(entry.id) || names.has(nameKey)) throw new Error('Duplicate preset id or name.');
    ids.add(entry.id); names.add(nameKey);
    // Reuse annotation validation without carrying any imported document geometry/state into the model.
    const synthetic = {
      id: entry.id, pageIndex: 0, kind: entry.kind,
      ...(entry.stampName !== undefined ? { stampName: entry.stampName } : {}),
      points: [[40, 100], [200, 180]],
      ...(entry.kind === 'callout' ? { callout: [[20, 140], [40, 140]] } : {}),
      color: entry.color, width: entry.width, opacity: entry.opacity, contents: entry.contents,
      author: '', status: 'open', locked: false, createdAt: timestamp, modifiedAt: timestamp,
    } as Markup;
    // Array iteration also rejects sparse RGB arrays, unlike Array.some in the underlying schema.
    if (!Array.isArray(entry.color) || entry.color.length !== 3 ||
        Array.from(entry.color).some(component => typeof component !== 'number' || !Number.isFinite(component)))
      throw new Error('Invalid preset color.');
    const [mark] = validateMarkups([synthetic], 1);
    return { id: entry.id, name, kind: mark.kind, ...(mark.stampName ? {stampName:mark.stampName} : {}), color: [...mark.color], width: mark.width,
      opacity: mark.opacity, contents: mark.contents };
  });
}

export function parsePresetLibrary(text: string): MarkupPreset[] {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_PRESET_LIBRARY_BYTES)
    throw new Error('Preset library exceeds the 1 MiB JSON limit.');
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Preset library is not valid JSON.'); }
  return validatePresetLibrary(value);
}

export function serializePresetLibrary(presets: readonly MarkupPreset[]): string {
  const canonical = validatePresetLibrary({ version: 1, presets });
  return boundedJson({ version: 1, presets: canonical });
}

export function presetFromMarkup(mark: Pick<Markup, 'kind' | 'color' | 'width' | 'opacity' | 'contents' | 'stampName'>, name: string, id: string): MarkupPreset {
  return validatePresetLibrary({ version: 1, presets: [{ id, name, kind: mark.kind, color: mark.color,
    width: mark.width, opacity: mark.opacity, contents: mark.contents, ...(mark.stampName !== undefined ? {stampName:mark.stampName} : {}) }] })[0];
}
