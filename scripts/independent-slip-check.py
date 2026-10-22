"""Independent synthetic slip-sheet preservation/appearance acceptance.

node scripts/generate-slip-validation.mjs DIRECTORY
python scripts/independent-slip-check.py --check DIRECTORY

Reads the fixture PDFs and expected.json; writes independent-slip-results.json.
Uses pypdf for structural checks and PDFium for independent content rendering.
Annotation rendering is disabled for exact content comparisons; retained target
annotations are independently verified as PDF objects and live page references.
"""
import argparse
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import sys
from pypdf import PdfReader
from pypdf.generic import IndirectObject, StreamObject
import pypdfium2 as pdfium


def sha(data):
    return hashlib.sha256(data).hexdigest()


def refid(ref):
    return [ref.idnum, ref.generation]


def canonical(value):
    """Preserve reference identities rather than recursively following cycles."""
    if isinstance(value, IndirectObject):
        return {'ref': refid(value)}
    if isinstance(value, dict):
        result = {str(key): canonical(item) for key, item in value.items()}
        if isinstance(value, StreamObject):
            result['decodedStreamSha256'] = sha(value.get_data())
        return result
    if isinstance(value, (list, tuple)):
        return [canonical(item) for item in value]
    if isinstance(value, bytes):
        return {'bytes': value.hex()}
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def annotations(page):
    return [ref.get_object() for ref in page.get('/Annots', [])]


def render(filename, index, scale, user_unit):
    with pdfium.PdfDocument(filename) as doc:
        page = doc[index]
        try:
            # PDFium's public API uses raw canvas units, without UserUnit.
            # Apply independently parsed pypdf UserUnit to compare physical DPI.
            # https://pypdfium2.readthedocs.io/en/stable/_modules/pypdfium2/_helpers/page.html
            bitmap = page.render(scale=scale * user_unit, draw_annots=False)
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', required=True, type=Path, metavar='DIRECTORY')
    folder = parser.parse_args().check
    expected = json.loads((folder / 'expected.json').read_text(encoding='utf-8'))
    paths = {name: folder / item['file'] for name, item in expected['sources'].items()}
    paths['output'] = folder / expected['output']
    before = {name: sha(path.read_bytes()) for name, path in paths.items()}
    readers = {name: PdfReader(path) for name, path in paths.items()}
    base, revision, result = (readers[key] for key in ('base', 'revision', 'output'))
    checks = []

    def check(name, passed, **details):
        checks.append({'name': name, 'passed': bool(passed), **details})

    versions = {name: version(name) for name in ('pypdf', 'pypdfium2', 'Pillow')}
    check('Independent pypdf version is pinned', versions['pypdf'] == '6.21.1', actual=versions['pypdf'])
    check('Independent PDFium version is pinned', versions['pypdfium2'] == '5.14.0', actual=versions['pypdfium2'])
    check('Generator retained exact in-memory source byte hashes', expected['immutableSources'] == [True, True])
    for name, source in expected['sources'].items():
        check(f'{name}: original file SHA256 matches captured source', before[name] == source['sha256'])
    check('Output and both input PDFs have expected two pages', all(len(reader.pages) == 2 for reader in readers.values()))
    check('Base Info metadata preserved exactly', canonical(result.metadata) == canonical(base.metadata))
    check('Base XMP metadata preserved byte for byte',
          result.trailer['/Root']['/Metadata'].get_data() == base.trailer['/Root']['/Metadata'].get_data())
    check('Base entire catalog keys, values and reference identities preserved',
          canonical(result.trailer['/Root']) == canonical(base.trailer['/Root']))
    check('Base stable original page object identities preserved',
          [refid(page.indirect_reference) for page in result.pages] ==
          [refid(page.indirect_reference) for page in base.pages])
    replaced = expected['replaced']
    target = result.pages[replaced['outputPage']]
    source_target = base.pages[replaced['outputPage']]
    donor = revision.pages[replaced['donorPage']]
    check('Replaced content contains independently expected donor text', replaced['text'] in (target.extract_text() or ''))
    check('Original target text removed from replacement content', replaced['absentText'] not in (target.extract_text() or ''))
    check('Replacement searchable text equals donor searchable text', target.extract_text() == donor.extract_text())
    check('Replacement MediaBox adopted from donor', list(target.mediabox) == replaced['mediaBox'] == list(donor.mediabox))
    check('Replacement CropBox adopted from donor', list(target.cropbox) == replaced['cropBox'] == list(donor.cropbox))
    check('Replacement rotation adopted from donor', int(target.get('/Rotate', 0)) == replaced['rotation'] == int(donor.get('/Rotate', 0)))
    check('Replacement UserUnit adopted from donor', float(target.get('/UserUnit', 1)) == replaced['userUnit'] == float(donor.get('/UserUnit', 1)))
    visual_keys = {'/Contents', '/Resources', '/MediaBox', '/CropBox', '/BleedBox', '/TrimBox', '/ArtBox', '/Rotate', '/UserUnit'}
    check('Target non-content/geometry page dictionary entries preserved',
          canonical({key: value for key, value in target.items() if key not in visual_keys}) ==
          canonical({key: value for key, value in source_target.items() if key not in visual_keys}))
    check('Target custom page metadata retained', target.get('/OpenDraftSynthetic') == 'Stable target page dictionary')
    target_annots, source_annots = annotations(target), annotations(source_target)
    check('Target annotation reference identities retained',
          canonical(target.get('/Annots', [])) == canonical(source_target.get('/Annots', [])))
    check('All retained target annotation dictionaries unchanged', canonical(target_annots) == canonical(source_annots))
    check('Donor foreign annotation is not copied', all(item.get('/NM') != 'donor-note' for page in result.pages for item in annotations(page)))
    check('Base retained foreign note still present',
          any(item.get('/NM') == 'base-note' and item.get('/Contents') == 'Retained target foreign note' for item in target_annots))
    link = next(item for item in target_annots if item.get('/NM') == 'base-link')
    check('Retained link targets stable second base page', refid(link['/Dest'][0]) == refid(result.pages[1].indirect_reference))
    check('Retained annotations still point to stable target page',
          all(refid(item.raw_get('/P')) == refid(target.indirect_reference) for item in target_annots))
    check('Base form field value retained', result.get_fields()['AssetCode']['/V'] == base.get_fields()['AssetCode']['/V'] == 'BASE-A101')
    check('Base form fields retain same catalog graph',
          canonical(result.trailer['/Root']['/AcroForm']) == canonical(base.trailer['/Root']['/AcroForm']))
    check('Base page labels retained', result.page_labels == base.page_labels == ['A101', 'B202'])
    check('Base outline still targets stable replaced page', result.get_destination_page_number(result.outline[0]) == 0)
    check('Base named destination still targets stable replaced page', result.get_destination_page_number(result.named_destinations['stable-sheet']) == 0)
    attachment = expected['attachment']
    check('Base attachment retained exactly', list(result.attachments[attachment['name']]) == [attachment['text'].encode('utf-8')])
    check('Base optional-content group retained',
          result.trailer['/Root']['/OCProperties']['/OCGs'][0].get_object()['/Name'] == 'Base review layer')
    check('Unreplaced page searchable text unchanged', result.pages[1].extract_text() == base.pages[1].extract_text())
    def page_with_explicit_default_rotation(page):
        values = dict(page.items())
        values['/Rotate'] = int(page.get('/Rotate', 0)) % 360
        return canonical(values)
    check('Unreplaced page dictionary/references unchanged except equivalent default rotation materialization',
          page_with_explicit_default_rotation(result.pages[1]) == page_with_explicit_default_rotation(base.pages[1]))
    for name, output_index, input_name, input_index in [('replaced', 0, 'revision', 1), ('unreplaced', 1, 'base', 1)]:
        a = render(paths['output'], output_index, expected['renderScale'], float(result.pages[output_index].get('/UserUnit', 1)))
        b = render(paths[input_name], input_index, expected['renderScale'], float(readers[input_name].pages[input_index].get('/UserUnit', 1)))
        check(f'{name}: independent PDFium pixel geometry matches source', a[0] == b[0], actual=list(a[0]), expected=list(b[0]))
        changed = sum(x != y for x, y in zip(a[1], b[1])) if len(a[1]) == len(b[1]) else None
        check(f'{name}: entire independent PDFium raster exactly matches source content',
              a == b, changedChannels=changed)
        if name == 'replaced':
            check('Replaced PDFium dimensions match known CropBox/rotation/UserUnit geometry', list(a[0]) == replaced['pdfiumSize'], actual=list(a[0]), expected=replaced['pdfiumSize'])
            for swatch in replaced['swatches']:
                x, y = swatch['point']
                i = (y * a[0][0] + x) * 3
                color = list(a[1][i:i + 3]) if 0 <= x < a[0][0] and 0 <= y < a[0][1] else None
                check(f"Replaced known {swatch['name']} pixel", color == swatch['rgb'], expected=swatch['rgb'], actual=color)
    for name, path in paths.items():
        check(f'{name}: checker left supplied PDF bytes unchanged', sha(path.read_bytes()) == before[name])
    report = {'fixture': expected['fixture'], 'versions': versions, 'checks': checks,
              'passed': sum(item['passed'] for item in checks), 'total': len(checks),
              'sha256': before, 'limitations': expected['limitations'] + [
                  'PDFium public rendering ignores UserUnit; checker applies pypdf-parsed UserUnit explicitly to render scale.',
                  'Unreplaced page default /Rotate omission and explicit zero are equivalent for dictionary comparison.'
              ], 'rendererUnitReference': 'https://pypdfium2.readthedocs.io/en/stable/_modules/pypdfium2/_helpers/page.html'}
    (folder / 'independent-slip-results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f"Independent slip-sheet checks: {report['passed']}/{report['total']} passed")
    for item in checks:
        if not item['passed']:
            print(json.dumps(item))
    return 0 if report['passed'] == report['total'] else 1


if __name__ == '__main__':
    sys.exit(main())
