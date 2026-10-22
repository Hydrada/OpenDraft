"""Check layer metadata with pypdf 6.21.1 and rendering with pypdfium2 5.14.0.

Run generate-layer-validation.mjs first, then pass the same fixture directory.
Visibility mismatches are reported as failures, never waived as viewer differences.
"""
import hashlib
import json
from importlib.metadata import version
from pathlib import Path
import sys
from pypdf import PdfReader
import pypdfium2 as pdfium
import pypdfium2.raw as raw

folder = Path(sys.argv[1] if len(sys.argv) > 1 else 'test-results/layer-validation')
manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
assert version('pypdf') == '6.21.1'
assert version('pypdfium2') == '5.14.0'
checks, limitations = [], []


def check(name, passed, **details):
    checks.append(dict(name=name, passed=bool(passed), **details))


def rendered(page, annotations=True):
    bitmap = page.render(scale=manifest['renderScale'], draw_annots=annotations)
    try:
        return bitmap.width, bitmap.height, bytes(bitmap.buffer)
    finally:
        bitmap.close()


def difference(left, right):
    assert left[:2] == right[:2] and len(left[2]) == len(right[2])
    values = [abs(a - b) for a, b in zip(left[2], right[2])]
    return dict(meanChannelDifference=sum(values) / len(values), changedChannelFraction=sum(v != 0 for v in values) / len(values), changedChannels=sum(v != 0 for v in values))


def close_enough(metrics):
    return all(metrics[key] <= limit for key, limit in manifest['tolerance'].items())


images = {}
with pdfium.PdfDocument(folder / 'baseline.pdf') as document:
    assert len(document) == manifest['pageCount']
    images['baseline.pdf'] = []
    for index in range(len(document)):
        page = document[index]
        try:
            images['baseline.pdf'].append(rendered(page))
        finally:
            page.close()

for case in manifest['cases']:
    name = case['name']
    reader = PdfReader(folder / name)
    assert len(reader.pages) == manifest['pageCount']
    oc = reader.trailer['/Root']['/OCProperties']
    assert len(oc['/OCGs']) == 1
    layer_ref = oc['/OCGs'][0]
    layer = layer_ref.get_object()
    assert layer['/Type'] == '/OCG' and layer['/Name'] == 'Review comments'
    defaults = oc['/D']
    assert layer_ref in defaults['/ON' if case['visible'] else '/OFF']
    assert layer_ref not in defaults['/OFF' if case['visible'] else '/ON']
    for page in reader.pages:
        annotations = page.get('/Annots', [])
        assert len(annotations) == case['expectedAnnotationCount']
        if case['flatten']:
            properties = page['/Resources']['/Properties']
            assert any(properties.raw_get(key) == layer_ref for key in properties)
            content = page.get_contents().get_data()
            assert b'/OC /OpenDraftLayer' in content and b' BDC' in content and b'EMC' in content
        else:
            annotation = annotations[0].get_object()
            assert annotation.raw_get('/OC') == layer_ref
            assert annotation['/Contents']
    check(f'{name}:metadata', True)
    images[name] = []
    with pdfium.PdfDocument(folder / name) as document:
        for index in range(len(document)):
            page = document[index]
            try:
                assert raw.FPDFPage_GetAnnotCount(page) == case['expectedAnnotationCount']
                image = rendered(page)
                images[name].append(image)
                baseline_metrics = difference(image, images['baseline.pdf'][index])
                if not case['flatten']:
                    assert difference(rendered(page, False), images['baseline.pdf'][index])['changedChannels'] == 0
                if case['visible']:
                    check(f'{name}:page{index + 1}:appearance-present', baseline_metrics['changedChannels'] > 20, **baseline_metrics)
                else:
                    passed = baseline_metrics['changedChannels'] == 0
                    check(f'{name}:page{index + 1}:hidden-equals-baseline', passed, **baseline_metrics)
                    if not passed:
                        limitations.append(f'PDFium renders hidden optional-content {"page content" if case["flatten"] else "annotation"} on page {index + 1} despite /OFF metadata.')
            finally:
                page.close()

for index in range(manifest['pageCount']):
    metrics = difference(images['visible-annotated.pdf'][index], images['visible-flattened.pdf'][index])
    check(f'page{index + 1}:visible-annotation-vs-flatten', close_enough(metrics), **metrics)

report = dict(passed=all(item['passed'] for item in checks), fixture=manifest['fixture'], packages={'pypdf': version('pypdf'), 'pypdfium2': version('pypdfium2')}, sha256={name: hashlib.sha256((folder / name).read_bytes()).hexdigest() for name in images}, checks=checks, limitations=limitations + ['Synthetic rectangles at rotations 0 and 90 only; not broad viewer or imported-layer certification.'])
(folder / 'independent-layer-results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, indent=2))
sys.exit(0 if report['passed'] else 1)
