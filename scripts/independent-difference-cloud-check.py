"""Verify browser-produced synthetic cloud outputs with pypdf and PDFium.

Run with --check DIRECTORY containing base/revision/clouds/flattened.pdf and expected.json.
Writes only independent-difference-cloud-results.json in that directory.
"""
import argparse
import hashlib
import json
from importlib.metadata import version
from pathlib import Path

import pypdfium2 as pdfium
from pypdf import PdfReader


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', type=Path, required=True)
    folder = parser.parse_args().check
    names = ['base.pdf', 'revision.pdf', 'clouds.pdf', 'flattened.pdf']
    original = {name: (folder / name).read_bytes() for name in names}
    digest = lambda data: hashlib.sha256(data).hexdigest()
    expected = json.loads((folder / 'expected.json').read_text())
    readers = {name: PdfReader(folder / name) for name in names}
    checks = []

    def check(name, condition, **evidence):
        checks.append({'name': name, 'passed': bool(condition), **evidence})

    clouds, base, flat = [readers[name] for name in ['clouds.pdf', 'base.pdf', 'flattened.pdf']]
    check('page counts preserved', len(clouds.pages) == len(base.pages) == len(flat.pages) == 1)
    def geometry(page):
        return {'media': list(page.mediabox), 'crop': list(page.cropbox), 'rotation': int(page.get('/Rotate', 0)) % 360, 'userUnit': float(page.get('/UserUnit', 1))}

    # Missing Rotate means 0, CropBox means MediaBox, and UserUnit means 1.
    check('media crop rotation and UserUnit preserved', geometry(clouds.pages[0]) == geometry(base.pages[0]), base=geometry(base.pages[0]), output=geometry(clouds.pages[0]))
    annotations = [ref.get_object() for ref in clouds.pages[0].get('/Annots', [])]
    check('exact selected cloud count', len(annotations) == expected['count'])
    check('flatten removes authored annotation objects', not flat.pages[0].get('/Annots'))
    for index, (annotation, bounds) in enumerate(zip(annotations, expected['bounds'])):
        prefix = f'cloud {index + 1}'
        evidence = json.loads(annotation['/Contents'])
        check(prefix + ' standard cloudy Square with appearance', annotation['/Subtype'] == '/Square' and annotation['/BE']['/S'] == '/C' and annotation['/BE']['/I'] == 1 and len(annotation['/AP']['/N'].get_data()) > 100)
        check(prefix + ' reviewed geometry matches independent expectation', evidence['region']['pdfBounds'] == bounds)
        inset = float(annotation['/RD'][0])
        actual = [float(v) for v in annotation['/Rect']]
        check(prefix + ' PDF rectangle and inset encode the reviewed bounds', actual == [bounds[0] - inset, bounds[1] - inset, bounds[2] + inset, bounds[3] + inset] and all(float(v) == inset for v in annotation['/RD']))
        check(prefix + ' source provenance matches independent hashes', evidence['schema'] == 'opendraft.difference-cloud' and evidence['base']['sha256'] == digest(original['base.pdf']) and evidence['revision']['sha256'] == digest(original['revision.pdf']) and evidence['base']['page'] == evidence['revision']['page'] == 1 and evidence['threshold'] == 16)

    def raster(name, annotations=True):
        doc = pdfium.PdfDocument(original[name])
        page = doc[0]
        bitmap = page.render(scale=1, draw_annots=annotations)
        try:
            image = bitmap.to_pil().convert('RGB')
            return image.size, image.tobytes()
        finally:
            bitmap.close()
            page.close()
            doc.close()

    base_image, content_only, annotated, flattened = [raster(name, annotations) for name, annotations in [('base.pdf', False), ('clouds.pdf', False), ('clouds.pdf', True), ('flattened.pdf', True)]]
    check('full source drawing raster unchanged when annotation display is disabled', base_image == content_only)
    changed = sum(a != b for a, b in zip(base_image[1], annotated[1]))
    check('cloud appearances are visibly rendered', base_image[0] == annotated[0] and changed > 500, changedChannels=changed)
    check('authored flatten is pixel identical to displayed clouds', annotated == flattened)
    check('all supplied files remain byte identical', all((folder / name).read_bytes() == data for name, data in original.items()))
    report = {'versions': {name: version(name) for name in ['pypdf', 'pypdfium2', 'Pillow']}, 'checks': checks, 'passed': sum(item['passed'] for item in checks), 'total': len(checks), 'limitations': ['Synthetic fixture only; no universal viewer, semantic or engineering acceptance.', 'PDFium raster checks are at 72 dpi; source preservation is scoped to the supplied fixtures.']}
    (folder / 'independent-difference-cloud-results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f"Independent difference-cloud checks: {report['passed']}/{report['total']} passed")
    for item in checks:
        if not item['passed']:
            print(json.dumps(item))
    return 0 if report['passed'] == report['total'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
