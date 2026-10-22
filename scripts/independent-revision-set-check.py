"""Read-only pypdf/PDFium checks of browser-produced revision-set fixtures.

python scripts/independent-revision-set-check.py --check DIRECTORY
DIRECTORY contains replace/partial/insert fixtures, or one expected.json/set.zip.
Writes only independent-revision-set-results.json. Synthetic interoperability
evidence is limited to these exact fixtures and these independent library versions.
"""
import argparse
import csv
import hashlib
import io
import json
import re
from importlib.metadata import version
from pathlib import Path
import sys
import zipfile
from pypdf import PdfReader
from pypdf.generic import IndirectObject, StreamObject
import pypdfium2 as pdfium


def digest(data):
    return hashlib.sha256(data).hexdigest()


def refid(value):
    return [value.idnum, value.generation]


def canonical(value):
    if isinstance(value, IndirectObject):
        return {'ref': refid(value)}
    if isinstance(value, dict):
        result = {str(k): canonical(v) for k, v in value.items()}
        if isinstance(value, StreamObject):
            result['stream'] = digest(value.get_data())
        return result
    if isinstance(value, (list, tuple)):
        return [canonical(v) for v in value]
    if isinstance(value, bytes):
        return value.hex()
    return value if value is None or isinstance(value, (str, int, float, bool)) else str(value)


def annots(page):
    return [item.get_object() for item in page.get('/Annots', [])]


def render(data, index, annotations=False):
    with pdfium.PdfDocument(data) as document:
        page = document[index]
        try:
            bitmap = page.render(scale=1, draw_annots=annotations)
            try:
                image = bitmap.to_pil().convert('RGB')
                try:
                    return image.size, image.tobytes()
                finally:
                    image.close()
            finally:
                bitmap.close()
        finally:
            page.close()


def cell(value):
    text = '' if value is None else str(value)
    return "'" + text if re.match(r'^[\s\x00-\x1f\x7f]*[=+@-]', text) else text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', required=True, type=Path)
    folder = parser.parse_args().check
    cases = [folder] if (folder / 'expected.json').exists() else sorted(p.parent for p in folder.glob('*/expected.json'))
    checks = []

    def check(name, passed, **details):
        checks.append({'name': name, 'passed': bool(passed), **details})

    versions = {name: version(name) for name in ('pypdf', 'pypdfium2', 'Pillow')}
    check('Pinned independent libraries', versions == {'pypdf': '6.21.1', 'pypdfium2': '5.14.0', 'Pillow': '12.3.0'}, actual=versions)
    check('Browser fixtures found', bool(cases))
    for case in cases:
        expected = json.loads((case / 'expected.json').read_text(encoding='utf-8'))
        source_paths = [case / job[key] for job in expected['jobs'] for key in ('baseFile', 'revisionFile')]
        before = {str(path): digest(path.read_bytes()) for path in source_paths}
        with zipfile.ZipFile(case / 'set.zip') as archive:
            names = archive.namelist()
            check(f'{case.name}: safe unique ZIP paths', len(set(names)) == len(names) and all(name in ('manifest.json', 'summary.csv') or re.fullmatch(r'PDFs/[0-9]{4}\.pdf', name) for name in names))
            check(f'{case.name}: bounded ZIP', len(names) <= 22 and sum(x.file_size for x in archive.infolist()) <= 128 * 1024 * 1024)
            manifest = json.loads(archive.read('manifest.json'))
            results = manifest['results']
            check(f'{case.name}: schema and result count', manifest['schema'] == 'opendraft.revision-set' and manifest['version'] == 1 and len(results) == len(expected['jobs']))
            wanted_names = {'manifest.json', 'summary.csv'} | {job['outputPath'] for job in expected['jobs'] if job['outputPath']}
            check(f'{case.name}: exact successful output set; no failed PDF', set(names) == wanted_names)
            rows = list(csv.reader(io.StringIO(archive.read('summary.csv').decode('utf-8'))))
            wanted_rows = [['Job', 'Base', 'Revision', 'Operation', 'Status', 'Pairs', 'Output', 'Output SHA-256', 'Output pages', 'Error']]
            output_bytes = 0
            for index, job in enumerate(expected['jobs']):
                result = results[index]
                prefix = f'{case.name}/{index + 1}'
                base_bytes, revision_bytes = [(case / job[key]).read_bytes() for key in ('baseFile', 'revisionFile')]
                base, revision = PdfReader(io.BytesIO(base_bytes)), PdfReader(io.BytesIO(revision_bytes))
                check(f'{prefix}: expected status', result['status'] == job['status'])
                for key, data, reader in [('base', base_bytes, base), ('revision', revision_bytes, revision)]:
                    check(f'{prefix}: {key} identity and labels independently verified', result[key] == {'name': job[key + 'Name'], 'sha256': digest(data), 'pageCount': len(reader.pages), 'labels': reader.page_labels})
                plan, journal = result['plan'], result['journal']
                pairs = [{'basePage': 1, 'revisionPage': 1}, {'basePage': 2, 'revisionPage': 2}]
                check(f'{prefix}: reviewed plan and journal source bindings', plan['pairs'] == pairs and plan['operation'] == expected['operation'] and plan['base'] == {'sha256': digest(base_bytes), 'pageCount': 2} and plan['revision'] == {'sha256': digest(revision_bytes), 'pageCount': 2} and journal['baseSha256'] == digest(base_bytes) and journal['revisionSha256'] == digest(revision_bytes) and journal['reason'] == plan['reason'] and journal['operation'] == plan['operation'] and journal['markupPolicy'] == plan['markupPolicy'] and journal['replacements'] == [{'targetPage': 1, 'revisionPage': 1}, {'targetPage': 2, 'revisionPage': 2}] and journal['clearedMeasurements'] == journal['clearedScales'] == 0)
                check(f'{prefix}: matched pages accounted for', result['unmatchedBase'] == result['unmatchedRevision'] == [])
                wanted_rows.append([cell(v) for v in [result['id'], result['base']['name'], result['revision']['name'], plan['operation'], result['status'], len(plan['pairs']), result.get('outputPath'), result.get('outputSha256'), result.get('outputPageCount'), result.get('error')]])
                if job['status'] == 'failed':
                    check(f'{prefix}: explicit geometry failure has no output metadata', 'geometry' in result['error'].lower() and not any(key in result for key in ('outputPath', 'outputSha256', 'outputBytes', 'outputPageCount')))
                    continue
                data = archive.read(job['outputPath'])
                output_bytes += len(data)
                output = PdfReader(io.BytesIO(data))
                inserted = expected['operation'] == 'insert-before'
                old_indices = [1, 3] if inserted else [0, 1]
                check(f'{prefix}: output bytes, hash and page count', result['outputPath'] == job['outputPath'] and result['outputBytes'] == len(data) and result['outputSha256'] == digest(data) and result['outputPageCount'] == len(output.pages) == (4 if inserted else 2))
                check(f'{prefix}: base metadata and catalog references retained', canonical(output.metadata) == canonical(base.metadata) and canonical({k: v for k, v in output.trailer['/Root'].items() if k != '/PageLabels'}) == canonical({k: v for k, v in base.trailer['/Root'].items() if k != '/PageLabels'}))
                check(f'{prefix}: original page objects retained', [refid(output.pages[i].indirect_reference) for i in old_indices] == [refid(p.indirect_reference) for p in base.pages])
                check(f'{prefix}: labels retain original sheets and inserted donor labels', output.page_labels == ([job['code'] + '1'] * 2 + [job['code'] + '2'] * 2 if inserted else base.page_labels))
                check(f'{prefix}: outline and named destination reach retained original', output.get_destination_page_number(output.outline[0]) == old_indices[0] and output.get_destination_page_number(output.named_destinations['original-sheet']) == old_indices[0])
                check(f'{prefix}: form and attachment retained', output.get_fields()['AssetCode']['/V'] == job['code'] + '-checked' and list(output.attachments['reference.txt']) == [(job['code'] + ' authorized attachment\n').encode()])
                check(f'{prefix}: donor annotations excluded', all(not str(a.get('/NM', '')).startswith('donor-') for p in output.pages for a in annots(p)))
                for source_index, old_index in enumerate(old_indices):
                    page, original = output.pages[old_index], base.pages[source_index]
                    check(f'{prefix}: sheet {source_index + 1} original annotation references retained', canonical(page.get('/Annots', [])[:len(original.get('/Annots', []))]) == canonical(original.get('/Annots', [])))
                    note = next(a for a in annots(page) if a.get('/NM') == f'base-note-{source_index + 1}')
                    check(f'{prefix}: sheet {source_index + 1} original note retained at original page', note['/Contents'] == f'{job["code"]} base note {source_index + 1}' and refid(note.raw_get('/P')) == refid(page.indirect_reference))
                    pairs_to_render = [(old_index, base_bytes, source_index)] if inserted else []
                    pairs_to_render.append((source_index * 2 if inserted else source_index, revision_bytes, source_index))
                    for output_index, wanted_data, wanted_index in pairs_to_render:
                        actual, wanted = render(data, output_index), render(wanted_data, wanted_index)
                        changed = sum(a != b for a, b in zip(actual[1], wanted[1])) if len(actual[1]) == len(wanted[1]) else None
                        check(f'{prefix}: output page {output_index + 1} independent full content raster exact', actual == wanted, changedChannels=changed)
                        wanted_page = (base if wanted_data is base_bytes else revision).pages[wanted_index]
                        check(f'{prefix}: output page {output_index + 1} text and geometry', output.pages[output_index].extract_text() == wanted_page.extract_text() and list(output.pages[output_index].mediabox) == list(wanted_page.mediabox) and list(output.pages[output_index].cropbox) == list(wanted_page.cropbox))
                    if inserted:
                        check(f'{prefix}: inserted sheet {source_index + 1} has no donor annotations', not output.pages[source_index * 2].get('/Annots'))
                        stamps = [a for a in annots(page) if a.get('/Subtype') == '/Stamp']
                        check(f'{prefix}: historical sheet {source_index + 1} contains a real red Draft superseded stamp', len(stamps) == 1 and stamps[0]['/Contents'] == 'SUPERSEDED' and stamps[0]['/Name'] == '/Draft' and float(stamps[0]['/C'][0]) > .8 and refid(stamps[0].raw_get('/P')) == refid(page.indirect_reference) and b'53555045525345444544' in stamps[0]['/AP']['/N'].get_data().upper())
                        visible, baseline = render(data, old_index, True), render(base_bytes, source_index, True)
                        pixels = [(y * 400 + x) * 3 for y in range(120, 180) for x in range(80, 320)]
                        red = sum(visible[1][i] > 180 and visible[1][i + 1] < 80 and visible[1][i + 2] < 80 for i in pixels)
                        before_red = sum(baseline[1][i] > 180 and baseline[1][i + 1] < 80 and baseline[1][i + 2] < 80 for i in pixels)
                        check(f'{prefix}: PDFium visibly renders superseded red stamp in known blank region', red > 200 and before_red == 0, redPixels=red, baselineRedPixels=before_red)
                link = next(a for a in annots(output.pages[old_indices[0]]) if a.get('/NM') == 'base-reference-link')
                numeric = next(a for a in annots(output.pages[old_indices[1]]) if a.get('/NM') == 'base-numeric-link')
                check(f'{prefix}: reference and numeric navigation target retained originals', refid(link['/Dest'][0]) == refid(output.pages[old_indices[1]].indirect_reference) and numeric['/A']['/D'][0] == old_indices[0])
            check(f'{case.name}: CSV exactly reconciles manifest', rows == wanted_rows)
            check(f'{case.name}: aggregate successes failures and bytes reconcile', manifest['succeeded'] == sum(j['status'] == 'succeeded' for j in expected['jobs']) and manifest['failed'] == sum(j['status'] == 'failed' for j in expected['jobs']) and manifest['outputPdfBytes'] == output_bytes)
        check(f'{case.name}: supplied source bytes unchanged after independent checks', all(digest(Path(path).read_bytes()) == value for path, value in before.items()))
    report = {'versions': versions, 'checks': checks, 'passed': sum(c['passed'] for c in checks), 'total': len(checks), 'limitations': ['Authorized synthetic fixtures only; no broad PDF interoperability or engineering acceptance claim.', 'Raster comparisons use PDFium at 72 dpi with annotations suppressed; stamp visibility is separately tested with annotations enabled.', 'Sources are opened read only; hashes are independently reconciled with the downloaded manifest.']}
    (folder / 'independent-revision-set-results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f"Independent revision-set checks: {report['passed']}/{report['total']} passed")
    for c in checks:
        if not c['passed']:
            print(json.dumps(c))
    return 0 if report['passed'] == report['total'] else 1


if __name__ == '__main__':
    sys.exit(main())
