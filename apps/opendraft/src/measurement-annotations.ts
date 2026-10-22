import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { measure, resolveScale, unitFactor } from './measurements.ts';
import type { Point } from './measurements.ts';
import { derivedQuantity, validateTakeoff, type MeasurementRecord, type TakeoffState } from './takeoff.ts';

export type MeasurementAnnotationResult = { bytes: Uint8Array; written: number; skipped: { id: string; label: string; reason: string }[] };

const subtypes: Partial<Record<MeasurementRecord['kind'], { subtype: string; intent: string; closed: boolean }>> = {
  length: { subtype: 'Line', intent: 'LineDimension', closed: false },
  polyline: { subtype: 'PolyLine', intent: 'PolyLineDimension', closed: false },
  perimeter: { subtype: 'Polygon', intent: 'PolygonDimension', closed: true },
  area: { subtype: 'Polygon', intent: 'PolygonDimension', closed: true },
  volume: { subtype: 'Polygon', intent: 'PolygonDimension', closed: true },
};
const numberText = (value: number) => Number(value.toPrecision(12)).toString();
const pdfNumber = (value: number) => Number(value.toFixed(6));

/**
 * Writes reviewed takeoff as standard ISO 32000 measurement annotations (Line/PolyLine/Polygon with
 * a rectilinear /Measure dictionary) into a copy. Angle and count have no standard dimension
 * annotation and are reported as skipped. Values in /Contents are recomputed from reviewed scales.
 */
export async function applyMeasurementAnnotations(bytes: Uint8Array, input: TakeoffState): Promise<MeasurementAnnotationResult> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const state = validateTakeoff(input, pdf.getPageCount());
  const skipped: MeasurementAnnotationResult['skipped'] = [];
  let written = 0;
  for (const record of state.records) {
    const type = subtypes[record.kind];
    if (!type) { skipped.push({ id: record.id, label: record.label, reason: `${record.kind} has no standard PDF measurement annotation` }); continue; }
    const result = measure({ ...record, scales: state.scales });
    // Units per PDF user-space unit at this record, resolved through the same (viewport) scale.
    const factor = resolveScale(state.scales, record.pageIndex, record.points).metersPerPdfUnit / unitFactor(record.unit);
    const page = pdf.getPage(record.pageIndex);
    const xs = record.points.map(point => point[0]), ys = record.points.map(point => point[1]), pad = 2;
    const rect = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad].map(pdfNumber);
    const path = (points: Point[]) => points.map((point, index) => `${pdfNumber(point[0])} ${pdfNumber(point[1])} ${index ? 'l' : 'm'}`).join('\n');
    const appearance = pdf.context.register(pdf.context.flateStream(`q 0 0.42 0.56 RG 1.5 w 1 J 1 j\n${path(record.points)}${type.closed ? ' h' : ''}\nS Q`,
      { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: rect }));
    const derived = derivedQuantity(record, result.value);
    const contents = `${record.label}: ${numberText(result.value)} ${result.unit}${derived === undefined ? '' : ` (${numberText(derived)} ${record.quantity!.unitLabel})`.replace(/ \)$/, ')')}`;
    const format = (unit: string, conversion: number) => pdf.context.obj({ Type: 'NumberFormat', U: PDFString.of(unit), C: conversion, D: 1000000, F: PDFName.of('D') });
    const measureDictionary = pdf.context.obj({
      Type: 'Measure', Subtype: 'RL', R: PDFHexString.fromText(`1 pt = ${numberText(factor)} ${record.unit}`),
      X: [format(record.unit, factor)], D: [format(record.unit, 1)], A: [format(`${record.unit}2`, factor * factor)],
    });
    const geometry = type.subtype === 'Line'
      ? { L: record.points.flat().map(pdfNumber), LE: [PDFName.of('OpenArrow'), PDFName.of('OpenArrow')], Cap: true }
      : { Vertices: record.points.flat().map(pdfNumber) };
    const annotation = pdf.context.register(pdf.context.obj({
      Type: 'Annot', Subtype: PDFName.of(type.subtype), IT: PDFName.of(type.intent), Rect: rect, P: page.ref, F: 4,
      NM: PDFHexString.fromText(`opendraft-measurement:${record.id}`), Contents: PDFHexString.fromText(contents),
      Subj: PDFHexString.fromText(`OpenDraft ${record.kind} measurement`), T: PDFHexString.fromText('OpenDraft takeoff'), C: [0, 0.42, 0.56],
      BS: { Type: 'Border', W: 1.5, S: 'S' }, Measure: measureDictionary, AP: { N: appearance }, ...geometry,
    }));
    page.node.addAnnot(annotation);
    written++;
  }
  return { bytes: await pdf.save({ useObjectStreams: false }), written, skipped };
}
