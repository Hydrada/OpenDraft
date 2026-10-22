"""Independent structural grouping check using developer-only pypdf 6.21.1.
Generate synthetic files with generate-annotation-validation.mjs first.
"""
import json
import sys
from pathlib import Path
from importlib.metadata import version
from pypdf import PdfReader
assert version('pypdf') == '6.21.1'
folder = Path(sys.argv[1] if len(sys.argv) > 1 else 'test-results/annotation-validation')
manifest = json.loads((folder / 'manifest.json').read_text())
reader = PdfReader(folder / 'annotated.pdf')
expected = {group['pageIndex']: group['memberIndices'] for group in manifest['expectedGroups']}
results = []
for page_index, page in enumerate(reader.pages):
    annotations = page.get('/Annots', [])
    members = expected.get(page_index, [])
    for index, ref in enumerate(annotations):
        annotation = ref.get_object()
        if index in members[1:]:
            assert annotation['/RT'] == '/Group'
            primary = annotation.raw_get('/IRT')
            target = annotations[members[0]]
            assert primary.idnum == target.idnum and primary.generation == target.generation
            assert primary.get_object()['/P'] == annotation['/P']
            assert '/IRT' not in primary.get_object()
        else:
            assert '/IRT' not in annotation and '/RT' not in annotation
    if members:
        assert len(members) >= 2
        results.append({'page': page_index + 1, 'members': len(members), 'primaryAnnotationIndex': members[0]})
assert results, 'Fixture contains no group relations'
report = {'reader': 'pypdf 6.21.1', 'passed': True, 'groups': results, 'limitations': 'Synthetic primary/subordinate links only; no interactive viewer grouping certification.'}
(folder / 'group-parser-results.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
