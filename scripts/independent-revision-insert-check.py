"""Independent revision insertion and visible superseded-stamp checks.

node scripts/generate-revision-insert-validation.mjs DIRECTORY
python scripts/independent-revision-insert-check.py --check DIRECTORY

Uses independent pypdf structures and PDFium raster rendering. Supplied PDFs are
read only. Writes independent-revision-insert-results.json in the fixture folder.
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


def digest(data):
    return hashlib.sha256(data).hexdigest()


def refid(ref):
    return [ref.idnum, ref.generation]


def canonical(value):
    if isinstance(value, IndirectObject):
        return {'ref': refid(value)}
    if isinstance(value, dict):
        result = {str(key): canonical(item) for key, item in value.items()}
        if isinstance(value, StreamObject):
            result['streamSha256'] = digest(value.get_data())
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


def render(path, index, draw_annots=False):
    with pdfium.PdfDocument(path) as doc:
        page = doc[index]
        try:
            bitmap = page.render(scale=1, draw_annots=draw_annots)
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
    paths = {key: folder / item['file'] for key, item in expected['sources'].items()}
    paths.update({item['file']: folder / item['file'] for item in expected['cases']})
    before = {name: digest(path.read_bytes()) for name, path in paths.items()}
    base, donor = PdfReader(paths['base']), PdfReader(paths['revision'])
    checks = []

    def check(name, passed, **details):
        checks.append({'name': name, 'passed': bool(passed), **details})

    versions = {name: version(name) for name in ('pypdf', 'pypdfium2', 'Pillow')}
    check('Independent reader versions are pinned', versions['pypdf'] == '6.21.1' and versions['pypdfium2'] == '5.14.0', actual=versions)
    check('Generator source hashes remain unchanged in memory', expected['immutableSources'] == [True, True])
    for key, item in expected['sources'].items():
        check(f'{key}: exact original PDF hash matches captured source', before[key] == item['sha256'])
    original_refs = [refid(page.indirect_reference) for page in base.pages]
    base_root = base.trailer['/Root']
    base_rasters = [render(paths['base'], index) for index in range(2)]
    donor_raster = render(paths['revision'], 0)
    stamp = expected['stamp']
    stamp_rasters = []
    for case in expected['cases']:
        name = case['file']
        reader = PdfReader(paths[name])
        root = reader.trailer['/Root']
        original_index = case['originalIndex']
        check(f'{name}: expected history page count', len(reader.pages) == len(case['labels']))
        check(f'{name}: primary page labels retained and insertion label explicit', reader.page_labels == case['labels'], actual=reader.page_labels)
        check(f'{name}: original base page references retained',
              [refid(reader.pages[index].indirect_reference) for index in case['baseIndices']] == original_refs)
        check(f'{name}: inserted page references are new and unique',
              len({tuple(refid(page.indirect_reference)) for page in reader.pages}) == len(reader.pages) and
              all(refid(reader.pages[index].indirect_reference) not in original_refs for index in case['donorIndices']))
        check(f'{name}: primary Info metadata retained exactly', canonical(reader.metadata) == canonical(base.metadata))
        check(f'{name}: primary XMP retained byte for byte', root['/Metadata'].get_data() == base_root['/Metadata'].get_data())
        check(f'{name}: base catalog keys and references retained except remapped labels',
              canonical({key: value for key, value in root.items() if key != '/PageLabels'}) ==
              canonical({key: value for key, value in base_root.items() if key != '/PageLabels'}))
        check(f'{name}: outline still reaches original A101', reader.get_destination_page_number(reader.outline[0]) == original_index)
        check(f'{name}: named destination still reaches original A101', reader.get_destination_page_number(reader.named_destinations['original-a101']) == original_index)
        check(f'{name}: original form value retained', reader.get_fields()['AssetCode']['/V'] == 'BASE-A101')
        check(f'{name}: original AcroForm graph retained', canonical(root['/AcroForm']) == canonical(base_root['/AcroForm']))
        attachment = expected['attachment']
        check(f'{name}: primary attachment bytes retained', list(reader.attachments[attachment['name']]) == [attachment['text'].encode('utf-8')])
        check(f'{name}: primary optional-content name retained', root['/OCProperties']['/OCGs'][0].get_object()['/Name'] == 'Base review layer')
        check(f'{name}: donor annotations excluded from every output page',
              all(item.get('/NM') != 'donor-note' for page in reader.pages for item in annotations(page)))
        for source_index, output_index in enumerate(case['baseIndices']):
            page = reader.pages[output_index]
            source_page = base.pages[source_index]
            check(f'{name}: original page {source_index + 1} searchable content retained', page.extract_text() == source_page.extract_text())
            check(f'{name}: original page {source_index + 1} physical geometry retained',
                  list(page.mediabox) == list(source_page.mediabox) and list(page.cropbox) == list(source_page.cropbox) and
                  int(page.get('/Rotate', 0)) == int(source_page.get('/Rotate', 0)) and float(page.get('/UserUnit', 1)) == float(source_page.get('/UserUnit', 1)))
            actual = render(paths[name], output_index)
            wanted = base_rasters[source_index]
            changed = sum(x != y for x, y in zip(actual[1], wanted[1])) if len(actual[1]) == len(wanted[1]) else None
            check(f'{name}: original page {source_index + 1} full PDFium content raster exact', actual == wanted, changedChannels=changed)
            original_annots = source_page.get('/Annots', [])
            actual_annots = page.get('/Annots', [])
            check(f'{name}: original page {source_index + 1} annotation reference prefix retained',
                  canonical(actual_annots[:len(original_annots)]) == canonical(original_annots))
        for output_index in case['donorIndices']:
            page = reader.pages[output_index]
            check(f'{name}: inserted page {output_index + 1} donor text retained', page.extract_text() == donor.pages[0].extract_text())
            check(f'{name}: inserted page {output_index + 1} excludes donor annotations', len(page.get('/Annots', [])) == 0)
            actual = render(paths[name], output_index)
            changed = sum(x != y for x, y in zip(actual[1], donor_raster[1])) if len(actual[1]) == len(donor_raster[1]) else None
            check(f'{name}: inserted page {output_index + 1} full PDFium donor raster exact', actual == donor_raster, changedChannels=changed)
        old_page = reader.pages[original_index]
        retained = annotations(old_page)
        note = next(item for item in retained if item.get('/NM') == 'base-note')
        check(f'{name}: foreign original note retained on historical sheet', note['/Contents'] == 'Retained base foreign annotation')
        link = next(item for item in retained if item.get('/NM') == 'base-reference-link')
        check(f'{name}: reference link points to retained second base sheet', refid(link['/Dest'][0]) == refid(reader.pages[case['baseIndices'][1]].indirect_reference))
        second_annots = annotations(reader.pages[case['baseIndices'][1]])
        numeric = next(item for item in second_annots if item.get('/NM') == 'base-numeric-link')
        check(f'{name}: numeric GoTo remaps old page zero beyond inserted donor index zero', int(numeric['/A']['/D'][0]) == original_index, expected=original_index, actual=int(numeric['/A']['/D'][0]))
        remote = next(item for item in second_annots if item.get('/NM') == 'base-remote-link')
        check(f'{name}: remote numeric destination is unchanged', remote['/A']['/S'] == '/GoToR' and int(remote['/A']['/D'][0]) == 0 and remote['/A']['/F'] == 'remote.pdf')
        check(f'{name}: retained annotations point to original page object', all(refid(item.raw_get('/P')) == refid(old_page.indirect_reference) for item in retained))
        stamps = [item for page in reader.pages for item in annotations(page) if item.get('/NM') == stamp['name']]
        check(f'{name}: superseded stamp count exact', len(stamps) == int(case['stamped']))
        if case['stamped']:
            mark = stamps[0]
            check(f'{name}: superseded is a red standard Draft stamp',
                  mark['/Subtype'] == '/Stamp' and mark['/Name'] == stamp['standardName'] and
                  mark['/Contents'] == stamp['contents'] and list(mark['/C']) == stamp['color'] and list(mark['/Rect']) == stamp['bounds'])
            appearance = mark['/AP']['/N'].get_object()
            check(f'{name}: superseded appearance has embedded text drawing commands',
                  b'Tj' in appearance.get_data() and stamp['contents'].encode().hex().upper().encode() in appearance.get_data().upper() and bool(appearance['/Resources']['/Font']))
            check(f'{name}: superseded stamp remains attached to old base page', refid(mark.raw_get('/P')) == original_refs[0])
            visible = render(paths[name], original_index, True)
            baseline = render(paths['base'], 0, True)
            left, top, right, bottom = stamp['pixelRegion']
            red, baseline_red, changed = 0, 0, 0
            for y in range(top, bottom):
                for x in range(left, right):
                    i = (y * visible[0][0] + x) * 3
                    a, b = visible[1][i:i + 3], baseline[1][i:i + 3]
                    red += a[0] > 180 and a[1] < 80 and a[2] < 80
                    baseline_red += b[0] > 180 and b[1] < 80 and b[2] < 80
                    changed += a != b
            check(f'{name}: PDFium displays new red superseded border/lettering in known blank region',
                  baseline_red == 0 and red > 200 and changed > 200,
                  redPixels=red, baselineRedPixels=baseline_red, changedPixels=changed)
            stamp_rasters.append(visible)
    check('Repeated insertion retains exact visible superseded appearance and original annotations',
          len(stamp_rasters) == 2 and stamp_rasters[0] == stamp_rasters[1])
    for name, path in paths.items():
        check(f'{name}: checker left supplied PDF bytes unchanged', digest(path.read_bytes()) == before[name])
    report = {'fixture': expected['fixture'], 'versions': versions, 'checks': checks,
              'passed': sum(item['passed'] for item in checks), 'total': len(checks),
              'sha256': before, 'limitations': expected['limitations']}
    (folder / 'independent-revision-insert-results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f"Independent revision insertion checks: {report['passed']}/{report['total']} passed")
    for item in checks:
        if not item['passed']:
            print(json.dumps(item))
    return 0 if report['passed'] == report['total'] else 1


if __name__ == '__main__':
    sys.exit(main())
