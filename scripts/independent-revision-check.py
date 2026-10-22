"""Independent raster comparison checks, using PDFium 5.14.0 and a Python oracle.

node scripts/generate-revision-validation.mjs <folder>
python scripts/independent-revision-check.py <folder> --render
node scripts/generate-revision-validation.mjs <folder> --compare
python scripts/independent-revision-check.py <folder> --check
python scripts/independent-revision-check.py <export-folder> --check-export

Only authorized synthetic data is generated. This does not certify arbitrary PDFs.
"""
import hashlib
from importlib.metadata import version
import json
import math
from pathlib import Path
import sys
import tempfile
import pypdfium2 as pdfium

folder=Path(sys.argv[1] if len(sys.argv)>1 else Path(tempfile.gettempdir())/'opendraft-revision-validation')
assert version('pypdfium2')=='5.14.0'

if '--check-export' in sys.argv:
    from pypdf import PdfReader
    from PIL import Image
    assert version('pypdf')=='6.21.1'
    checks=[]
    def check(name,passed,**details):checks.append({'name':name,'passed':bool(passed),**details})
    evidence=json.loads((folder/'revision-comparison.json').read_text(encoding='utf-8'))
    reader=PdfReader(folder/'revision-difference.pdf')
    check('PDF has one page',len(reader.pages)==1)
    page=reader.pages[0]
    dimensions=[float(page.mediabox.width),float(page.mediabox.height)]
    check('PDF physical dimensions are 200 x 160 points',dimensions==[200,160],actual=dimensions)
    check('PDF page is unrotated at default UserUnit',int(page.get('/Rotate',0))%360==0 and float(page.get('/UserUnit',1))==1)
    check('PDF title identifies raster revision difference','raster revision difference' in (reader.metadata.title or ''))
    attachments=reader.attachments.get('revision-comparison.json',[])
    check('PDF has one embedded comparison evidence JSON',len(attachments)==1)
    attached=json.loads(attachments[0].decode('utf-8')) if attachments else {}
    check('Embedded evidence identifies difference view',attached.get('exportedView')=='difference')
    check('Embedded source hashes match JSON export',all(attached.get(key,{}).get('sha256')==evidence.get(key,{}).get('sha256') for key in ['base','revision']))
    for key in ['base','revision']:
        source=folder/f'{key}.pdf'
        expected=evidence.get(key,{}).get('sha256')
        actual=hashlib.sha256(source.read_bytes()).hexdigest() if source.exists() else None
        check(f'{key}: evidence SHA256 matches original source PDF',expected==actual and actual is not None,expected=expected,actual=actual)
    check('Embedded and downloaded evidence match except exported view',
          {key:value for key,value in attached.items() if key!='exportedView'}==
          {key:value for key,value in evidence.items() if key!='exportedView'})
    expected={'width':200,'height':160,'originX':0,'originY':0,'changedPixels':800,'totalPixels':32000,'changedBounds':{'x':80,'y':40,'width':60,'height':80}}
    for source_name,source in [('embedded',attached),('downloaded',evidence)]:
        actual=source.get('comparison',{})
        check(f'{source_name}: known count, geometry and bounds',all(actual.get(key)==value for key,value in expected.items()),actual=actual)
    check('Evidence records 72 dpi and explicit zero translation',evidence.get('renderer',{}).get('dpi')==72 and evidence.get('alignment',{}).get('appliedPixels')=={'x':0,'y':0})
    with Image.open(folder/'revision-difference.png') as png:
        png_rgb=png.convert('RGB')
        check('PNG dimensions are 200 x 160 pixels',png_rgb.size==(200,160),actual=list(png_rgb.size))
        for label,point,color in [('removal',(85,45),(220,35,45)),('addition',(125,105),(25,80,220)),('common',(25,45),(224,224,224)),('background',(0,0),(255,255,255))]:
            check(f'PNG known {label} color',png_rgb.getpixel(point)==color,expected=list(color),actual=list(png_rgb.getpixel(point)))
        with pdfium.PdfDocument(folder/'revision-difference.pdf') as doc:
            pdf_page=doc[0]
            try:
                bitmap=pdf_page.render(scale=1,draw_annots=True)
                try:
                    raster=bitmap.to_pil().convert('RGB')
                    check('PDFium 72 dpi raster dimensions match PNG',raster.size==png_rgb.size,actual=list(raster.size))
                    for label,point,color in [('removal',(85,45),(220,35,45)),('addition',(125,105),(25,80,220)),('common',(25,45),(224,224,224)),('background',(0,0),(255,255,255))]:
                        check(f'PDFium known {label} color',raster.getpixel(point)==color,expected=list(color),actual=list(raster.getpixel(point)))
                    a,b=raster.tobytes(),png_rgb.tobytes()
                    changed=sum(x!=y for x,y in zip(a,b)) if len(a)==len(b) else None
                    check('Entire PDFium raster exactly matches PNG',a==b,changedChannels=changed)
                    raster.close()
                finally:bitmap.close()
            finally:pdf_page.close()
        png_rgb.close()
    report={'versions':{'pypdf':version('pypdf'),'pypdfium2':version('pypdfium2'),'Pillow':version('Pillow')},'checks':checks,'passed':sum(item['passed'] for item in checks),'total':len(checks),'limitations':['Known 200 x 160 synthetic export only; no broad export interoperability, engineering correctness or vector-content claim.']}
    (folder/'independent-revision-export-results.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(f"Independent revision export checks: {report['passed']}/{report['total']} passed")
    for item in checks:
        if not item['passed']:print(json.dumps(item))
    sys.exit(0 if report['passed']==report['total'] else 1)

fixtures=json.loads((folder/'fixtures.json').read_text(encoding='utf-8'))

if '--render' in sys.argv:
    rasters={}
    for name,source in fixtures['documents'].items():
        with pdfium.PdfDocument(folder/source['file']) as doc:
            page=doc[0]
            try:
                bitmap=page.render(scale=fixtures['renderScale'],draw_annots=True)
                try:
                    image=bitmap.to_pil().convert('RGBA')
                    data=image.tobytes()
                    rasters[name]={'width':image.width,'height':image.height,'file':f'{name}.rgba'}
                    (folder/f'{name}.rgba').write_bytes(data)
                    image.close()
                finally:bitmap.close()
            finally:page.close()
    # This case isolates alpha and exact threshold boundaries without relying on PDF compositing.
    for name,data in {'alpha-base':[0,0,0,0,0,0,0,128,20,50,90,255],
                      'alpha-revision':[255,255,255,255,127,127,127,255,40,50,90,255]}.items():
        (folder/f'{name}.rgba').write_bytes(bytes(data))
        rasters[name]={'width':3,'height':1,'file':f'{name}.rgba'}
    for name,data in {'white':[255,255,255,255],'black':[0,0,0,255],
                      'red':[255,0,0,255],'same-gray-green':[0,130,0,255]}.items():
        (folder/f'{name}.rgba').write_bytes(bytes(data))
        rasters[name]={'width':1,'height':1,'file':f'{name}.rgba'}
    cases=fixtures['cases']+[
        {'id':'alpha-threshold-equal','base':'alpha-base','revision':'alpha-revision','options':{'offsetX':0,'offsetY':0,'threshold':20},'expectedChanged':0,'expectedBounds':None},
        {'id':'alpha-threshold-exceeded','base':'alpha-base','revision':'alpha-revision','options':{'offsetX':0,'offsetY':0,'threshold':19},'expectedChanged':1,'expectedBounds':{'x':2,'y':0,'width':1,'height':1}},
        {'id':'positive-offset','base':'white','revision':'black','options':{'offsetX':3,'offsetY':2,'threshold':0},'expectedChanged':1,'expectedBounds':{'x':3,'y':2,'width':1,'height':1}},
        {'id':'equal-gray-color-change','base':'red','revision':'same-gray-green','options':{'offsetX':0,'offsetY':0,'threshold':0},'expectedChanged':1,'expectedBounds':{'x':0,'y':0,'width':1,'height':1}},
    ]
    (folder/'rasters.json').write_text(json.dumps({'rasters':rasters,'cases':cases},indent=2),encoding='utf-8')
    print(f'Rendered {len(rasters)} independent rasters for {len(cases)} comparisons')
    sys.exit(0)

assert '--check' in sys.argv, 'Specify --render or --check'
manifest=json.loads((folder/'rasters.json').read_text(encoding='utf-8'))
results={item['id']:item for item in json.loads((folder/'engine-results.json').read_text(encoding='utf-8'))}
checks=[]
def check(name,passed,**details):checks.append({'name':name,'passed':bool(passed),**details})
def rgba(name):
    item=manifest['rasters'][name]
    return item, (folder/item['file']).read_bytes()
def pixel(source,data,x,y):
    if not (0<=x<source['width'] and 0<=y<source['height']):return (255,255,255)
    i=(y*source['width']+x)*4
    # A separate scalar reference, including round-half-up white alpha composition.
    return tuple(math.floor((data[i+c]*data[i+3]+255*(255-data[i+3]))/255+0.5) for c in range(3))

for name,source in fixtures['documents'].items():
    check(f'{name}: original PDF hash unchanged',hashlib.sha256((folder/source['file']).read_bytes()).hexdigest()==source['sha256'])
for case in manifest['cases']:
    base,base_data=rgba(case['base']);revision,revision_data=rgba(case['revision'])
    dx,dy,threshold=(case['options'][key] for key in ['offsetX','offsetY','threshold'])
    left,top=min(0,dx),min(0,dy)
    right,bottom=max(base['width'],dx+revision['width']),max(base['height'],dy+revision['height'])
    width,height=right-left,bottom-top
    changed=[]
    for y in range(top,bottom):
        for x in range(left,right):
            a=pixel(base,base_data,x,y);b=pixel(revision,revision_data,x-dx,y-dy)
            if any(abs(a[c]-b[c])>threshold for c in range(3)):changed.append((x-left,y-top))
    bounds=None
    if changed:
        xs,ys=zip(*changed)
        bounds={'x':min(xs),'y':min(ys),'width':max(xs)-min(xs)+1,'height':max(ys)-min(ys)+1}
    result=results[case['id']];prefix=case['id']
    check(f'{prefix}: independent geometry',all(result[key]==value for key,value in [('width',width),('height',height),('originX',left),('originY',top),('totalPixels',width*height)]))
    check(f'{prefix}: independent changed count and bounds',result['changedPixels']==len(changed) and result['changedBounds']==bounds,expectedCount=len(changed),actualCount=result['changedPixels'],expectedBounds=bounds,actualBounds=result['changedBounds'])
    check(f'{prefix}: known synthetic expected count/bounds',len(changed)==case['expectedChanged'] and bounds==case['expectedBounds'],count=len(changed),bounds=bounds)
    check(f'{prefix}: raster inputs unchanged',result['inputHashesBefore']==result['inputHashesAfter']==[hashlib.sha256(base_data).hexdigest(),hashlib.sha256(revision_data).hexdigest()])
    for kind in ['overlay','difference']:
        data=(folder/result[f'{kind}File']).read_bytes()
        check(f'{prefix}: {kind} output dimensions and opaque alpha',len(data)==width*height*4 and all(alpha==255 for alpha in data[3::4]))
    # Fixed known swatches assert documented meaning, rather than deriving palette from engine code.
    swatches={
        'identical':(25,65,[0,0,0,255],[224,224,224,255]),
        'addition':(75,35,[0,0,255,255],[25,80,220,255]),
        'removal':(25,65,[255,0,0,255],[220,35,45,255]),
        'registered':(33,70,[0,0,0,255],[224,224,224,255]),
        'positive-offset':(3,2,[0,0,255,255],[25,80,220,255]),
        'equal-gray-color-change':(0,0,[76,23,76,255],[180,40,180,255]),
    }
    if prefix in swatches:
        x,y,overlay_expected,difference_expected=swatches[prefix]
        for kind,expected in [('overlay',overlay_expected),('difference',difference_expected)]:
            data=(folder/result[f'{kind}File']).read_bytes();i=(y*width+x)*4
            check(f'{prefix}: {kind} known palette',list(data[i:i+4])==expected,expected=expected,actual=list(data[i:i+4]))

report={'versions':{'pypdfium2':version('pypdfium2')},'checks':checks,'passed':sum(item['passed'] for item in checks),'total':len(checks),'limitations':['Synthetic raster cases do not certify semantic revision detection, automatic registration, engineering correctness or arbitrary document interoperability.','PDFium fixtures validate engine raster behavior; PDF.js browser rendering requires separate end-to-end coverage.']}
(folder/'independent-revision-results.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(f"Independent revision checks: {report['passed']}/{report['total']} passed")
for item in checks:
    if not item['passed']:print(json.dumps(item))
sys.exit(0 if report['passed']==report['total'] else 1)
