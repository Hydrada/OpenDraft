"""Independent batch archive/export validation over authorized synthetic fixtures.

python scripts/independent-batch-check.py --check DIRECTORY

DIRECTORY contains batch.zip, base.pdf, revision.pdf and expected.json. Expected
contains pairs [{basePage,revisionPage,status,changedPixels?,changedBounds?}],
unmatchedBase and unmatchedRevision. This script reads the supplied artifacts;
it writes only independent-batch-results.json. It never extracts archive paths.
PDFium and pypdf are independent of the browser PDF.js/pdf-lib implementation.
Synthetic export checks do not establish broad PDF interoperability or accuracy
of engineering changes, source preservation across the application's lifetime,
or safety of arbitrary external archives.
"""
import argparse
import csv
import hashlib
from importlib.metadata import version
import io
import json
import math
from pathlib import Path, PurePosixPath
import re
import sys
import zipfile

from PIL import Image
from pypdf import PdfReader
import pypdfium2 as pdfium


def digest(data):
    return hashlib.sha256(data).hexdigest()


def csv_cell(value):
    """Independent CSV formula guard, including leading whitespace/control bytes."""
    value = '' if value is None else str(value)
    return "'" + value if re.match(r'^[\s\x00-\x1f\x7f]*[=+\-@]', value) else value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', required=True, type=Path, metavar='DIRECTORY')
    folder = parser.parse_args().check
    checks = []

    def check(name, passed, **details):
        checks.append({'name': name, 'passed': bool(passed), **details})

    inputs = {name: (folder / name).read_bytes() for name in
              ('batch.zip', 'base.pdf', 'revision.pdf', 'expected.json')}
    before = {name: digest(data) for name, data in inputs.items()}
    expected = json.loads(inputs['expected.json'])
    versions = {name: version(name) for name in ('pypdf', 'pypdfium2', 'Pillow')}
    check('Independent pypdf version is pinned', versions['pypdf'] == '6.21.1', actual=versions['pypdf'])
    check('Independent PDFium version is pinned', versions['pypdfium2'] == '5.14.0', actual=versions['pypdfium2'])
    with zipfile.ZipFile(io.BytesIO(inputs['batch.zip'])) as archive:
        entries = archive.infolist()
        names = [item.filename for item in entries]
        check('ZIP entry names are unique', len(names) == len(set(names)), names=names)
        safe = all(not PurePosixPath(name).is_absolute() and '\\' not in name and
                   '..' not in PurePosixPath(name).parts and ':' not in name and
                   not name.endswith('/') for name in names)
        check('ZIP names contain no absolute or traversal paths', safe)
        check('ZIP contains required manifest and CSV', {'manifest.json', 'summary.csv'} <= set(names))
        total_size = sum(item.file_size for item in entries)
        safe_budget = total_size <= 128 * 1024 * 1024 and len(entries) <= 103
        check('ZIP bounded before reading member data', safe_budget, uncompressedBytes=total_size, entries=len(entries))
        if not safe or not safe_budget:
            raise ValueError('Refusing unsafe or oversized validation archive')
        members = {name: archive.read(name) for name in names}
    manifest = json.loads(members['manifest.json'])
    check('Manifest identifies the versioned batch evidence schema',
          manifest.get('schema') == 'opendraft.batch-revision-comparison' and manifest.get('version') == 1)
    results = manifest['results']
    options = manifest['options']
    dpi = options['dpi']
    check('DPI is one of the supported discrete resolutions', dpi in (36, 72, 108, 144))
    check('Difference threshold is an integer in range',
          isinstance(options['threshold'], int) and 0 <= options['threshold'] <= 255)
    check('Export view is explicit', options['view'] in ('overlay', 'difference'))
    for key in ('base', 'revision'):
        source = manifest[key]
        check(f'{key}: source SHA256 matches actual fixture PDF',
              source['sha256'] == before[f'{key}.pdf'], actual=source['sha256'])
        reader = PdfReader(io.BytesIO(inputs[f'{key}.pdf']))
        check(f'{key}: source page count independently verified', source['pageCount'] == len(reader.pages))
        if 'sourceHashes' in expected:
            check(f'{key}: fixture SHA256 matches separately stored expectation',
                  before[f'{key}.pdf'] == expected['sourceHashes'][key])
    actual_pairs = [{key: result[key] for key in ('basePage', 'revisionPage', 'status')} for result in results]
    expected_pairs = [{key: pair[key] for key in ('basePage', 'revisionPage', 'status')} for pair in expected['pairs']]
    check('Every selected sheet result matches expected pairing/order/status', actual_pairs == expected_pairs,
          expected=expected_pairs, actual=actual_pairs)
    check('Every base page appears at most once', len({item['basePage'] for item in results}) == len(results))
    check('Every revision page appears at most once', len({item['revisionPage'] for item in results}) == len(results))
    for key in ('unmatchedBase', 'unmatchedRevision'):
        check(f'{key}: unmatched sheets match known expectation', manifest[key] == expected[key], actual=manifest[key])
    expected_map = {(item['basePage'], item['revisionPage']): item for item in expected['pairs']}
    successful = [item for item in results if item['status'] == 'compared']
    check('Selected pair definitions correspond exactly to result identities',
          [(item['id'], item['basePage'], item['revisionPage']) for item in manifest['pairs']] ==
          [(item['id'], item['basePage'], item['revisionPage']) for item in results])
    for result in results:
        prefix = f"pair {result['basePage']}:{result['revisionPage']}"
        known = expected_map.get((result['basePage'], result['revisionPage']), {})
        if result['status'] == 'failed':
            check(f'{prefix}: failure is explicit and has no output artifacts',
                  isinstance(result.get('error'), str) and bool(result['error']) and
                  not result.get('pngPath') and not result.get('pdfPage'))
            continue
        check(f'{prefix}: status is compared', result['status'] == 'compared')
        for key in ('changedPixels', 'changedBounds'):
            if key in known:
                check(f'{prefix}: known synthetic {key}', result[key] == known[key], expected=known[key], actual=result[key])
        path = result['pngPath']
        check(f'{prefix}: generated PNG has a fixed safe path', bool(re.fullmatch(r'images/pair-\d{3}\.png', path)))
        data = members[path]
        check(f'{prefix}: PNG SHA256 matches encoded bytes', digest(data) == result['pngSha256'])
        with Image.open(io.BytesIO(data)) as image:
            geometry = result['geometry']
            check(f'{prefix}: PNG dimensions match evidence', image.size == (geometry['width'], geometry['height']), actual=list(image.size))
            check(f'{prefix}: PNG byte size matches evidence', result['pngBytes'] == len(data))
            check(f'{prefix}: total pixels equal canvas area', result['totalPixels'] == image.width * image.height)
            check(f'{prefix}: changed count lies within exact canvas', 0 <= result['changedPixels'] <= image.width * image.height)
            if result['changedPixels'] == 0:
                check(f'{prefix}: zero changes have null bounds', result['changedBounds'] is None)
            else:
                bounds = result['changedBounds']
                check(f'{prefix}: changed bounds are within canvas',
                      isinstance(bounds, dict) and bounds['x'] >= 0 and bounds['y'] >= 0 and
                      bounds['width'] > 0 and bounds['height'] > 0 and
                      bounds['x'] + bounds['width'] <= image.width and
                      bounds['y'] + bounds['height'] <= image.height)
    expected_entries = {'manifest.json', 'summary.csv'} | {item['pngPath'] for item in successful}
    if successful:
        expected_entries.add('comparisons.pdf')
    check('Archive contains exactly declared artifacts', set(names) == expected_entries,
          expected=sorted(expected_entries), actual=sorted(names))
    if successful:
        document_bytes = members['comparisons.pdf']
        reader = PdfReader(io.BytesIO(document_bytes))
        check('PDF page count equals successfully compared sheets', len(reader.pages) == len(successful))
        attachments = reader.attachments.get('manifest.json', [])
        check('PDF has exactly one embedded batch manifest', len(attachments) == 1)
        attached = json.loads(attachments[0].decode('utf-8')) if attachments else None
        check('Embedded manifest equals standalone archive manifest', attached == manifest)
        check('Embedded manifest bytes exactly match archive manifest',
              bool(attachments) and attachments[0] == members['manifest.json'])
        with pdfium.PdfDocument(document_bytes) as doc:
            for index, result in enumerate(successful):
                prefix = f"pair {result['basePage']}:{result['revisionPage']}"
                check(f'{prefix}: evidence PDF page has sequential 1-based index', result['pdfPage'] == index + 1)
                page = reader.pages[index]
                geometry = result['geometry']
                actual_size = [float(page.mediabox.width), float(page.mediabox.height)]
                wanted_size = [geometry['width'] * 72 / dpi, geometry['height'] * 72 / dpi]
                check(f'{prefix}: PDF physical geometry preserves raster scale',
                      all(math.isclose(a, b, abs_tol=1e-6) for a, b in zip(actual_size, wanted_size)),
                      expected=wanted_size, actual=actual_size)
                check(f'{prefix}: output PDF is unrotated with default UserUnit',
                      int(page.get('/Rotate', 0)) % 360 == 0 and float(page.get('/UserUnit', 1)) == 1)
                pdf_page = doc[index]
                try:
                    bitmap = pdf_page.render(scale=dpi / 72, draw_annots=True)
                    try:
                        rendered = bitmap.to_pil().convert('RGB')
                        with Image.open(io.BytesIO(members[result['pngPath']])) as png:
                            reference = png.convert('RGB')
                            check(f'{prefix}: independent PDFium raster dimensions match PNG', rendered.size == reference.size,
                                  actual=list(rendered.size), expected=list(reference.size))
                            if rendered.size == reference.size:
                                a, b = rendered.tobytes(), reference.tobytes()
                                maximum = max((abs(x - y) for x, y in zip(a, b)), default=0)
                                changed = sum(x != y for x, y in zip(a, b))
                                check(f'{prefix}: entire PDFium raster matches PNG within one channel value',
                                      maximum <= 1, maximumChannelError=maximum, changedChannels=changed)
                            reference.close()
                        rendered.close()
                    finally:
                        bitmap.close()
                finally:
                    pdf_page.close()
    else:
        check('All-failed batch does not claim to contain a comparison PDF', 'comparisons.pdf' not in members)
    csv_text = members['summary.csv'].decode('utf-8-sig')
    csv_reader = csv.DictReader(io.StringIO(csv_text, newline=''))
    csv_rows = list(csv_reader)
    header = ['Pair', 'Base page', 'Base label', 'Revision page', 'Revision label',
              'Status', 'Changed pixels', 'PNG', 'PDF page', 'Error']
    check('CSV column names/order match documented report', csv_reader.fieldnames == header)
    check('CSV contains one result row per selected pair', len(csv_rows) == len(results))
    keys = ['id', 'basePage', 'baseLabel', 'revisionPage', 'revisionLabel', 'status',
            'changedPixels', 'pngPath', 'pdfPage', 'error']
    for index, (row, result) in enumerate(zip(csv_rows, results)):
        wanted = {label: csv_cell(result.get(key)) for label, key in zip(header, keys)}
        check(f'CSV row {index + 1}: identities, labels, status and output references match manifest',
              row == wanted, expected=wanted, actual=row)
        dangerous = any(re.match(r'^[\s\x00-\x1f\x7f]*[=+\-@]', cell or '') for cell in row.values())
        check(f'CSV row {index + 1}: no active spreadsheet formula prefix', not dangerous)
    check('Manifest encoded PNG byte total equals archive members',
          manifest['encodedPngBytes'] == sum(len(members[item['pngPath']]) for item in successful))
    for name in inputs:
        check(f'{name}: checker left supplied artifact unchanged', digest((folder / name).read_bytes()) == before[name])
    report = {'versions': versions, 'checks': checks, 'passed': sum(item['passed'] for item in checks),
              'total': len(checks), 'limitations': [
                  'Authorized synthetic fixtures only; no arbitrary-PDF or engineering acceptance claim.',
                  'PDFium checks raster PDF export interoperability; this does not independently validate all source raster comparisons.',
                  'Checker source hashes establish artifact identity, not application-lifetime source preservation.'
              ]}
    (folder / 'independent-batch-results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(f"Independent batch checks: {report['passed']}/{report['total']} passed")
    for item in checks:
        if not item['passed']:
            print(json.dumps(item))
    return 0 if report['passed'] == report['total'] else 1


if __name__ == '__main__':
    sys.exit(main())
