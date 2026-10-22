"""Independent structural/pixel checks for synthetic page organization.

Generate fixtures first; isolate pypdf 6.21.1 and pypdfium2 5.14.0.
Failure is reported as a failing exit code, not waived as a viewer difference.
"""
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import sys
from pypdf import PdfReader
import pypdfium2 as pdfium

folder=Path(sys.argv[1] if len(sys.argv)>1 else 'test-results/organization-validation')
manifest=json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
assert version('pypdf')=='6.21.1' and version('pypdfium2')=='5.14.0'
checks=[]
def check(name,passed,**details):checks.append(dict(name=name,passed=bool(passed),**details))
def refid(ref):return (ref.idnum,ref.generation)
def info(reader):return {str(key):str(value) for key,value in (reader.metadata or {}).items()}
def xmp(reader):
    value=reader.trailer['/Root'].get('/Metadata')
    return value.get_object().get_data() if value else None
def render(filename,index,rotation=0):
    with pdfium.PdfDocument(folder/filename) as doc:
        page=doc[index]
        try:
            bitmap=page.render(scale=manifest['renderScale'],rotation=rotation,draw_annots=True)
            try:return bitmap.width,bitmap.height,bytes(bitmap.buffer)
            finally:bitmap.close()
        finally:page.close()
def compare(a,b):
    if a[:2]!=b[:2] or len(a[2])!=len(b[2]):return dict(equal=False,dimensions=[a[:2],b[:2]])
    changed=sum(left!=right for left,right in zip(a[2],b[2]))
    return dict(equal=changed==0,changedChannels=changed,dimensions=a[:2])
def annotations(page):return [ref.get_object() for ref in page.get('/Annots',[])]
def annotation(page,name):return next(item for item in annotations(page) if item.get('/NM')==name)

sources={key:PdfReader(folder/name) for key,name in manifest['sources'].items()}
check('source-inputs-remain-byte-identical',all(manifest['immutableSources']))
for case in manifest['cases']:
    reader=PdfReader(folder/case['name']);primary=PdfReader(folder/case['primary'])
    check(case['name']+':page-count',len(reader.pages)==len(case['pages']))
    check(case['name']+':source-Info',info(reader)==info(primary),actual=info(reader))
    check(case['name']+':source-XMP',xmp(reader)==xmp(primary))
    for index,spec in enumerate(case['pages']):
        source=sources[spec['sourceId']];original=source.pages[spec['pageIndex']];page=reader.pages[index]
        expected_rotation=(int(original.get('/Rotate',0))+spec['rotation'])%360
        check(f"{case['name']}:page{index+1}:geometry",list(page.mediabox)==list(original.mediabox) and list(page.cropbox)==list(original.cropbox) and int(page.get('/Rotate',0))%360==expected_rotation)
        check(f"{case['name']}:page{index+1}:searchable-text",page.extract_text()==original.extract_text())
        pixels=compare(render(case['name'],index),render(manifest['sources'][spec['sourceId']],spec['pageIndex'],spec['rotation']))
        check(f"{case['name']}:page{index+1}:independent-pixels",pixels['equal'],**pixels)
    if not case.get('full'):continue
    root=reader.trailer['/Root'];source=sources['A'];source_root=source.trailer['/Root']
    page_refs=[refid(page.indirect_reference) for page in reader.pages]
    check('permutation:original-page-reference-identities',page_refs==[refid(source.pages[item['pageIndex']].indirect_reference) for item in case['pages']])
    expected_labels=[source.page_labels[item['pageIndex']] for item in case['pages']]
    check('permutation:page-label-semantics',reader.page_labels==expected_labels,actual=reader.page_labels,expected=expected_labels)
    check('permutation:outline-page-targets',[reader.get_destination_page_number(item) for item in reader.outline]==[2,0])
    check('permutation:named-destination-target',reader.get_destination_page_number(reader.named_destinations['target-sheet'])==0)
    check('permutation:internal-reference-link',refid(annotation(reader.pages[1],'source-link')['/Dest'][0])==page_refs[0])
    check('permutation:numeric-local-link-remapped',int(annotation(reader.pages[2],'numeric-local-link')['/A']['/D'][0])==1)
    remote=annotation(reader.pages[0],'numeric-remote-link')['/A']
    check('permutation:remote-numeric-link-unchanged',remote['/S']=='/GoToR' and int(remote['/D'][0])==0 and remote['/F']=='other.pdf')
    check('permutation:source-foreign-annotation',annotation(reader.pages[0],'foreign-note')['/Contents']=='Foreign retained note')
    check('permutation:attachment-bytes',list(reader.attachments['reference.txt'])==[manifest['attachmentText'].encode('utf-8')])
    check('permutation:form-value',reader.get_fields()['AssetCode']['/V']=='A101 checked')
    fields=root['/AcroForm']['/Fields'];field=fields[0].get_object();widgets=field.get('/Kids',[fields[0]])
    check('permutation:widget-target-live-page',all(refid(widget.get_object().raw_get('/P'))==page_refs[2] for widget in widgets))
    group=root['/OCProperties']['/OCGs'][0].get_object();source_group=source_root['/OCProperties']['/OCGs'][0].get_object()
    check('permutation:source-layer-name',group['/Name']==source_group['/Name']=='Source review layer')
    check('permutation:source-layer-defaults',[refid(item) for item in root['/OCProperties']['/D']['/ON']]==[refid(item) for item in source_root['/OCProperties']['/D']['/ON']])

absent=PdfReader(folder/'no-info-extracted.pdf')
check('absent-metadata:no-invented-Info-or-XMP','/Info' not in absent.trailer and '/Metadata' not in absent.trailer['/Root'])
report=dict(passed=all(item['passed'] for item in checks),fixture=manifest['fixture'],packages={'pypdf':version('pypdf'),'pypdfium2':version('pypdfium2')},checks=checks,sha256={item.name:hashlib.sha256(item.read_bytes()).hexdigest() for item in folder.glob('*.pdf')},limitations=[manifest['limitations'],'Partial assemblies verify Info/XMP and page appearance only; they do not claim preserved catalog graphs.'])
(folder/'independent-organization-results.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,indent=2))
sys.exit(0 if report['passed'] else 1)
