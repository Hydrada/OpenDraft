import { measure, spaceOf } from './measurements.ts';
import { derivedQuantity, validateTakeoff, type TakeoffState } from './takeoff.ts';

// Numeric values remain numbers; only untrusted text needs formula protection.
function cell(value: string | number): string {
  const raw = String(value);
  const safe = typeof value === 'string' && /^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** One row per quantity, with sufficient scale evidence to independently recompute it. */
export function takeoffRows(document: string, pageCount: number, input: TakeoffState): (string | number)[][] {
  if (typeof document !== 'string' || !document.length || document.length > 1000) throw new Error('Invalid takeoff document name.');
  const state = validateTakeoff(input, pageCount);
  const rows: (string | number)[][] = [[
    'Document', 'Page', 'Measurement ID', 'Label', 'Type', 'Value', 'Unit',
    'Coordinate space', 'Points JSON', 'Depth', 'Depth unit', 'Scale ID',
    'Meters per PDF unit', 'Reference points JSON', 'Reference distance',
    'Reference unit', 'Viewport bounds JSON', 'Quantity multiplier',
    'Waste percent', 'Derived quantity', 'Derived unit', 'Cutouts JSON', 'Space',
  ]];
  for (const record of state.records) {
    const result = measure({...record, scales:state.scales});
    const scale = result.scaleId === null ? undefined : state.scales.find(item => item.id === result.scaleId);
    rows.push([
      document, record.pageIndex + 1, record.id, record.label, record.kind,
      result.value, result.unit, 'unrotated-pdf-user-space', JSON.stringify(record.points),
      record.depth?.value ?? '', record.depth?.unit ?? '', result.scaleId ?? '',
      scale?.metersPerPdfUnit ?? '', scale ? JSON.stringify(scale.reference.points) : '',
      scale?.reference.distance ?? '', scale?.reference.unit ?? '',
      scale?.viewport ? JSON.stringify(scale.viewport) : '',
      record.quantity?.multiplier ?? '', record.quantity?.wastePercent ?? '',
      derivedQuantity(record,result.value) ?? '', record.quantity?.unitLabel ?? '',
      record.cutouts?.length ? JSON.stringify(record.cutouts) : '',
      spaceOf(record, state.records)?.label ?? '',
    ]);
  }
  return rows;
}

export function takeoffCsv(document: string, pageCount: number, input: TakeoffState): string {
  return takeoffRows(document,pageCount,input).map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Typed strings cannot become formulas; quantities remain numeric, never formatted text. */
export async function takeoffXlsx(document: string, pageCount: number, input: TakeoffState): Promise<Uint8Array> {
  const rows = takeoffRows(document,pageCount,input);
  // Excel limits cell strings to 32,767 characters. Reject rather than truncate evidence.
  for (const row of rows) for (const value of row) {
    if (typeof value === 'string' && (value.length > 32767 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)))
      throw new Error('XLSX cell text exceeds Excel limits or contains unsupported XML characters. Use JSON export for this model.');
  }
  const {default:writeXlsxFile} = await import('write-excel-file/universal');
  const data = rows.map((row,index) => row.map(value => typeof value === 'number'
    ? {type:Number,value}
    : {type:String,value,wrap:true,...(index === 0 ? {fontWeight:'bold' as const} : {})}));
  const widths = [26,8,44,32,16,26,12,32,50,16,16,44,28,50,24,18,50,18,14,26,16];
  const blob = await writeXlsxFile(data,{sheet:'Takeoff',stickyRowsCount:1,columns:widths.map(width=>({width}))}).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}
