import { PDFDocument, PDFName, PDFObject, PDFRawStream, PDFRef } from 'pdf-lib';

/**
 * Incremental PDF updates: changes are appended after the original bytes, which stay untouched.
 * This is how a signature is added without invalidating earlier ones. Usage: `snapshot` right
 * after loading, make changes, then `appendIncrementalUpdate`.
 */
export type Snapshot = { largest: number; digests: Map<string, string> };

const serialize = (object: PDFObject) => { const bytes = new Uint8Array(object.sizeInBytes()); object.copyBytesInto(bytes, 0); return bytes; };
const key = (ref: PDFRef) => `${ref.objectNumber} ${ref.generationNumber}`;
const latin1 = (bytes: Uint8Array) => { let out = ''; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return out; };

export function snapshot(pdf: PDFDocument, original: Uint8Array): Snapshot {
  // pdf-lib drops cross-reference/object-stream containers on load and would reuse their numbers.
  // Reserve every object number that appears in the original so new objects never clobber one.
  let highest = pdf.context.largestObjectNumber;
  for (const match of latin1(original).matchAll(/(?:^|[\s>\]])(\d{1,9})\s+\d{1,5}\s+obj/g)) highest = Math.max(highest, Number(match[1]));
  const size = /\/Size\s+(\d{1,9})/g;
  for (const match of latin1(original).matchAll(size)) highest = Math.max(highest, Number(match[1]) - 1);
  pdf.context.largestObjectNumber = highest;
  const digests = new Map<string, string>();
  for (const [ref, object] of pdf.context.enumerateIndirectObjects()) digests.set(key(ref), latin1(serialize(object)));
  return { largest: pdf.context.largestObjectNumber, digests };
}

/** Offset in the original file of its last cross-reference section and whether it is a stream. */
function lastXref(original: Uint8Array): { offset: number; stream: boolean } {
  const tail = latin1(original.subarray(Math.max(0, original.length - 2048)));
  const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail) ?? [...tail.matchAll(/startxref\s+(\d+)/g)].at(-1);
  if (!match) throw new Error('The PDF has no readable cross-reference section, so it cannot be updated incrementally.');
  const offset = Number(match[1]);
  if (!Number.isInteger(offset) || offset <= 0 || offset >= original.length) throw new Error('The PDF cross-reference offset is invalid.');
  return { offset, stream: latin1(original.subarray(offset, offset + 4)) !== 'xref' };
}

export async function appendIncrementalUpdate(original: Uint8Array, pdf: PDFDocument, before: Snapshot): Promise<Uint8Array> {
  await pdf.flush(); // embed fonts/images/pages created during the change
  const previous = lastXref(original);
  const changed: [PDFRef, PDFObject][] = [];
  for (const [ref, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && ['/XRef', '/ObjStm'].includes(String(object.dict.lookup(PDFName.of('Type'))))) continue;
    const old = before.digests.get(key(ref));
    if (old === undefined || old !== latin1(serialize(object))) changed.push([ref, object]);
  }
  changed.sort((a, b) => a[0].objectNumber - b[0].objectNumber);
  const encoder = new TextEncoder(), parts: Uint8Array[] = [original];
  let position = original.length;
  const push = (bytes: Uint8Array) => { parts.push(bytes); position += bytes.length; };
  if (original[original.length - 1] !== 0x0a) push(encoder.encode('\n'));
  const offsets = new Map<number, { offset: number; generation: number }>();
  for (const [ref, object] of changed) {
    offsets.set(ref.objectNumber, { offset: position, generation: ref.generationNumber });
    push(encoder.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`)); push(serialize(object)); push(encoder.encode('\nendobj\n'));
  }
  const info = pdf.context.trailerInfo;
  const trailerEntries = (size: number) => [`/Size ${size}`, info.Root ? `/Root ${info.Root.toString()}` : '', info.Info ? `/Info ${info.Info.toString()}` : '', info.ID ? `/ID ${info.ID.toString()}` : '', `/Prev ${previous.offset}`].filter(Boolean).join(' ');
  const runs = (numbers: number[]) => numbers.reduce<number[][]>((out, n) => { const last = out.at(-1); if (last && last.at(-1)! + 1 === n) last.push(n); else out.push([n]); return out; }, []);
  if (!previous.stream) {
    const size = Math.max(pdf.context.largestObjectNumber + 1, ...[...offsets.keys()].map(n => n + 1));
    let table = 'xref\n';
    for (const run of runs([...offsets.keys()])) {
      table += `${run[0]} ${run.length}\n`;
      for (const n of run) { const entry = offsets.get(n)!; table += `${String(entry.offset).padStart(10, '0')} ${String(entry.generation).padStart(5, '0')} n\r\n`; }
    }
    const xrefOffset = position;
    push(encoder.encode(`${table}trailer\n<< ${trailerEntries(size)} >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  } else {
    // The original uses a cross-reference stream; the update must use one too.
    const own = pdf.context.largestObjectNumber + 1, size = own + 1, xrefOffset = position;
    offsets.set(own, { offset: xrefOffset, generation: 0 });
    const numbers = [...offsets.keys()].sort((a, b) => a - b), index = runs(numbers).flatMap(run => [run[0], run.length]);
    const data = new Uint8Array(numbers.length * 7);
    numbers.forEach((n, i) => { const { offset, generation } = offsets.get(n)!; data[i * 7] = 1; for (let b = 0; b < 4; b++) data[i * 7 + 1 + b] = (offset >>> (8 * (3 - b))) & 0xff; data[i * 7 + 5] = (generation >>> 8) & 0xff; data[i * 7 + 6] = generation & 0xff; });
    push(encoder.encode(`${own} 0 obj\n<< /Type /XRef ${trailerEntries(size)} /W [1 4 2] /Index [${index.join(' ')}] /Length ${data.length} >>\nstream\n`)); push(data);
    push(encoder.encode(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`));
  }
  const out = new Uint8Array(position); let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
