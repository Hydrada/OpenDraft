"""Validate synthetic authored comment graphs with pypdf and pixels with PDFium.

Generate fixtures first. Run using isolated pypdf 6.21.1 and pypdfium2 5.14.0.
No failed assertions or pixel mismatches are waived as viewer differences.
"""
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import sys
from pypdf import PdfReader
import pypdfium2 as pdfium

folder=Path(sys.argv[1] if len(sys.argv)>1 else 'test-results/comment-validation')
manifest=json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
assert version('pypdf')=='6.21.1' and version('pypdfium2')=='5.14.0'
checks=[]

def check(name,passed,**details):
    checks.append(dict(name=name,passed=bool(passed),**details))

def identity(ref):
    return ref.idnum,ref.generation

def date(value):
    return 'D:'+value[:19].replace('-','').replace(':','').replace('T','')+'Z'

def render(name):
    images=[]
    with pdfium.PdfDocument(folder/name) as document:
        assert len(document)==manifest['pageCount']
        for index in range(len(document)):
            page=document[index]
            try:
                bitmap=page.render(scale=manifest['renderScale'],draw_annots=True)
                try:
                    images.append((bitmap.width,bitmap.height,bytes(bitmap.buffer)))
                finally:
                    bitmap.close()
            finally:
                page.close()
    return images

def difference(a,b):
    assert a[:2]==b[:2] and len(a[2])==len(b[2])
    total=changed=0
    for x,y in zip(a[2],b[2]):
        delta=abs(x-y);total+=delta;changed+=delta!=0
    return dict(changedChannels=changed,meanChannelDifference=total/len(a[2]),changedChannelFraction=changed/len(a[2]))

baseline=PdfReader(folder/'baseline.pdf')
original_info={key:str(value) for key,value in baseline.trailer['/Info'].items()}
images={'baseline.pdf':render('baseline.pdf')}
for case in manifest['cases']:
    name=case['name'];reader=PdfReader(folder/name)
    assert len(reader.pages)==manifest['pageCount']
    assert {key:str(value) for key,value in reader.trailer['/Info'].items()}==original_info
    for index,page in enumerate(reader.pages):
        assert int(page.get('/Rotate',0))==(90 if index else 0)
        refs=page.get('/Annots',[])
        annotations={str(ref.get_object()['/NM']):(ref,ref.get_object()) for ref in refs}
        assert len(annotations)==len(refs),'Duplicate annotation identity'
        assert f'foreign:{index}' in annotations
        assert annotations[f'foreign:{index}'][1]['/Contents']=='Preserve foreign annotation'
        marks=[mark for mark in manifest['marks'] if mark['pageIndex']==index]
        expected_count=1 if case['flatten'] else 1+len(marks)+(sum(len(mark.get('comments',[])) for mark in marks) if case['comments'] else 0)
        assert len(refs)==expected_count
        if case['flatten']:
            assert all(not key.startswith('opendraft:') for key in annotations)
            continue
        layer=reader.trailer['/Root']['/OCProperties']['/OCGs'][0]
        defaults=reader.trailer['/Root']['/OCProperties']['/D']
        assert layer in defaults['/ON' if case['visible'] else '/OFF']
        primary_ref=annotations[f'opendraft:primary-{index}'][0]
        primary=annotations[f'opendraft:primary-{index}'][1]
        assert '/IRT' not in primary and '/RT' not in primary
        subordinate=annotations[f'opendraft:subordinate-{index}'][1]
        assert subordinate['/RT']=='/Group' and identity(subordinate.raw_get('/IRT'))==identity(primary_ref)
        for mark in marks:
            owner_ref=annotations['opendraft:'+mark['id']][0]
            if not case['comments']:
                continue
            for comment in mark.get('comments',[]):
                reply_ref,reply=annotations['opendraft:comment:'+comment['id']]
                target=annotations['opendraft:comment:'+comment['parentId']][0] if 'parentId' in comment else owner_ref
                assert reply['/Subtype']=='/Text' and reply['/RT']=='/R'
                assert identity(reply.raw_get('/IRT'))==identity(target)
                assert reply['/T']==comment['author'] and reply['/Contents']==comment['contents']
                assert reply['/CreationDate']==date(comment['createdAt']) and reply['/M']==date(comment['modifiedAt'])
                assert identity(reply.raw_get('/P'))==identity(page.indirect_reference)
                assert identity(reply.raw_get('/OC'))==identity(layer)
                flags=int(reply['/F']);assert flags&32 and not flags&4 and not flags&2
                assert bool(flags&128)==mark['locked'] and bool(flags&512)==mark['locked']
                assert reply['/Open'].value is False
                # Walk every reply to its individual owning annotation: no cycle, dangling ref or group-primary substitution.
                seen=set();cursor=reply_ref
                while True:
                    key=identity(cursor);assert key not in seen;seen.add(key)
                    node=cursor.get_object()
                    if str(node.get('/NM',''))=='opendraft:'+mark['id']:
                        break
                    assert node.get('/RT')=='/R';cursor=node.raw_get('/IRT')
    check(name+':independent-metadata-and-thread-graph',True)
    images[name]=render(name)

for index in range(manifest['pageCount']):
    for visibility in ['visible','hidden']:
        metrics=difference(images[f'{visibility}-threaded.pdf'][index],images[f'{visibility}-marks-only.pdf'][index])
        check(f'{visibility}:page{index+1}:comments-add-no-icons',metrics['changedChannels']==0,**metrics)
        metrics=difference(images[f'{visibility}-threaded.pdf'][index],images[f'{visibility}-flattened.pdf'][index])
        check(f'{visibility}:page{index+1}:flatten-appearance',all(metrics[key]<=limit for key,limit in manifest['tolerance'].items()),**metrics)
    metrics=difference(images['hidden-threaded.pdf'][index],images['baseline.pdf'][index])
    check(f'page{index+1}:hidden-threaded-equals-source',metrics['changedChannels']==0,**metrics)
    metrics=difference(images['threaded-repeat.pdf'][index],images['visible-threaded.pdf'][index])
    check(f'page{index+1}:repeated-workspace-export-same-pixels',metrics['changedChannels']==0,**metrics)

report=dict(passed=all(item['passed'] for item in checks),fixture=manifest['fixture'],packages={'pypdf':version('pypdf'),'pypdfium2':version('pypdfium2')},checks=checks,sha256={name:hashlib.sha256((folder/name).read_bytes()).hexdigest() for name in images},limitations=[manifest['limitations']])
(folder/'independent-comment-results.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print(json.dumps({'passed':report['passed'],'checks':len(checks),'failures':[item for item in checks if not item['passed']],'report':str(folder/'independent-comment-results.json')},indent=2))
sys.exit(0 if report['passed'] else 1)
