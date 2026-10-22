"""Independent affine/automatic-alignment checks over authorized synthetic fixtures.

node scripts/generate-alignment-validation.mjs <folder>
python scripts/independent-alignment-check.py <folder> --render
node scripts/generate-alignment-validation.mjs <folder> --run
python scripts/independent-alignment-check.py <folder> --check

Uses independent PDFium/Pillow rendering, matrix algebra and landmark ground truth.
Synthetic success is not general drawing registration or engineering certification.
"""
import hashlib
from importlib.metadata import version
import json
import math
from pathlib import Path
import sys
import tempfile
from PIL import Image, ImageDraw
import pypdfium2 as pdfium

folder = Path(sys.argv[1] if len(sys.argv) > 1 else Path(tempfile.gettempdir()) / 'opendraft-alignment-validation')
fixtures = json.loads((folder / 'fixtures.json').read_text(encoding='utf-8'))
source = folder / fixtures['document']['file']

def digest(data): return hashlib.sha256(data).hexdigest()
def point(matrix, x, y):
    a, b, c, d, e, f = matrix
    return a*x + c*y + e, b*x + d*y + f
def around_center(scale, angle, dx=0, dy=0):
    angle = math.radians(angle)
    a, b = scale * math.cos(angle), scale * math.sin(angle)
    c, d = -b, a
    return [a, b, c, d, 300-a*300-c*250+dx, 250-b*300-d*250+dy]

if '--render' in sys.argv:
    folder.mkdir(parents=True, exist_ok=True)
    document = pdfium.PdfDocument(source)
    bitmap = document[0].render(scale=1)
    image = bitmap.to_pil().convert('RGBA')
    assert image.size == (600, 500)
    rasters = {}
    def save(name, raster):
        data = raster.tobytes()
        (folder / f'{name}.rgba').write_bytes(data)
        rasters[name] = {'width': raster.width, 'height': raster.height, 'file': f'{name}.rgba', 'sha256': digest(data)}
    save('drawing', image)
    estimates = []
    for name, matrix in [('identity', [1,0,0,1,0,0]), ('translation', [1,0,0,1,-18,11]), ('rotation', around_center(1,8)), ('scale', around_center(.9,0)), ('similarity-change', around_center(1.12,-9,15,-18))]:
        a,b,c,d,e,f = matrix
        # Pillow inverse mapping is output(revision)->input(base), matching known matrix.
        revision = image.transform(image.size, Image.Transform.AFFINE, (a,c,e,b,d,f), resample=Image.Resampling.BILINEAR, fillcolor='white')
        if name == 'similarity-change':
            draw = ImageDraw.Draw(revision)
            draw.rectangle((257,209,271,226), fill='black')
        save(name, revision)
        estimates.append({'id': name, 'base': 'drawing', 'revision': name, 'matrix': matrix, 'maximumLandmarkError': 3.0})
    save('blank', Image.new('RGBA', image.size, 'white'))
    unrelated = Image.new('RGBA', image.size, 'white')
    draw = ImageDraw.Draw(unrelated)
    for x,y in [(40,40),(160,100),(220,230),(370,130),(430,340)]: draw.ellipse((x,y,x+30,y+30), fill='black')
    save('unrelated', unrelated)
    estimates.extend([{'id':'blank-reject','base':'blank','revision':'blank','expectRejection':True}, {'id':'unrelated-reject','base':'drawing','revision':'unrelated','expectRejection':True}])
    # Exact small raster cases give independent bilinear and corner geometry evidence.
    colored = Image.new('RGBA',(3,2),'white')
    colored.putdata([(255,0,0,255),(0,255,0,255),(0,0,255,255),(0,0,0,128),(255,255,0,255),(40,80,120,0)])
    save('small',colored)
    save('small-base',Image.new('RGBA',(2,3),'white'))
    transforms = [
        {'id':'identity-warp','base':'small-base','revision':'small','matrix':[1,0,0,1,0,0]},
        {'id':'positive-translation','base':'small-base','revision':'small','matrix':[1,0,0,1,2,1]},
        {'id':'negative-translation','base':'small-base','revision':'small','matrix':[1,0,0,1,-2,-1]},
        {'id':'quarter-turn','base':'small-base','revision':'small','matrix':[0,1,-1,0,2,0]},
        {'id':'fractional-translation','base':'small-base','revision':'small','matrix':[1,0,0,1,.5,-.5]},
        {'id':'double-scale','base':'small-base','revision':'small','matrix':[2,0,0,2,0,0]},
        {'id':'nonorthogonal','base':'small-base','revision':'small','matrix':[1,.2,.15,1,-.2,.3]},
    ]
    invalid_transforms=[{'id':name,'base':'small-base','revision':'small','matrix':matrix} for name,matrix in [
        ('reflection-reject',[-1,0,0,1,0,0]),('collapse-reject',[0,0,0,0,0,0]),
        ('extreme-scale-reject',[.01,0,0,.01,0,0]),('union-budget-reject',[1,0,0,1,10000,0]),
        ('ill-conditioned-reject',[1,0,1000,1,0,0]),
    ]]
    (folder/'rasters.json').write_text(json.dumps({'rasters':rasters,'transforms':transforms,'invalidTransforms':invalid_transforms,'estimates':estimates},indent=2),encoding='utf-8')
    print(f'PDFium rendered source; prepared {len(transforms)} warps, {len(invalid_transforms)} rejected matrices and {len(estimates)} estimator cases')
    sys.exit(0)

manifest=json.loads((folder/'rasters.json').read_text(encoding='utf-8'))
results=json.loads((folder/'engine-results.json').read_text(encoding='utf-8'))
checks=[]
def check(name, passed, **details): checks.append({'name':name,'passed':bool(passed),**details})
check('source PDF unchanged',digest(source.read_bytes())==fixtures['document']['sha256'])
for name,raster in manifest['rasters'].items():
    check(f'{name}: source raster unchanged',digest((folder/raster['file']).read_bytes())==raster['sha256'])

def rounded(value): return math.floor(value+.5)
def rgba(raster): return (folder/raster['file']).read_bytes()
def opaque_at(data,width,height,x,y):
    if x<0 or y<0 or x>=width or y>=height: return (255,255,255)
    i=(y*width+x)*4;alpha=data[i+3]
    return tuple(rounded((data[i+j]*alpha+255*(255-alpha))/255) for j in range(3))

warp_results={item['id']:item for item in results['transforms']}
for case in manifest['invalidTransforms']:
    result=warp_results[case['id']]
    check(f"{case['id']}: invalid transform rejected",'error' in result,error=result.get('error'))
    check(f"{case['id']}: rejected inputs immutable",result['inputHashesBefore']==result['inputHashesAfter'])
for case in manifest['transforms']:
    result=warp_results[case['id']];name=case['id']
    check(f'{name}: warp succeeded','error' not in result,error=result.get('error'))
    if 'error' in result:continue
    base=manifest['rasters'][case['base']];revision=manifest['rasters'][case['revision']]
    matrix=case['matrix'];a,b,c,d,e,f=matrix
    corners=[point(matrix,x,y) for x,y in [(0,0),(revision['width'],0),(0,revision['height']),(revision['width'],revision['height'])]]
    left=math.floor(min([0]+[p[0] for p in corners]));top=math.floor(min([0]+[p[1] for p in corners]))
    right=math.ceil(max([base['width']]+[p[0] for p in corners]));bottom=math.ceil(max([base['height']]+[p[1] for p in corners]))
    geometry={'width':right-left,'height':bottom-top,'originX':left,'originY':top}
    check(f'{name}: independent transformed-corner union',result['geometry']==geometry,expected=geometry,actual=result['geometry'])
    determinant=a*d-b*c
    expected_base=bytearray();expected_revision=bytearray();base_bytes=rgba(base);revision_bytes=rgba(revision)
    for y in range(geometry['height']):
        for x in range(geometry['width']):
            expected_base.extend((*opaque_at(base_bytes,base['width'],base['height'],x+left,y+top),255))
            tx=x+left+.5-e;ty=y+top+.5-f
            sx=(d*tx-c*ty)/determinant-.5;sy=(-b*tx+a*ty)/determinant-.5
            ix=math.floor(sx);iy=math.floor(sy);fx=sx-ix;fy=sy-iy
            samples=[opaque_at(revision_bytes,revision['width'],revision['height'],ix,iy),opaque_at(revision_bytes,revision['width'],revision['height'],ix+1,iy),opaque_at(revision_bytes,revision['width'],revision['height'],ix,iy+1),opaque_at(revision_bytes,revision['width'],revision['height'],ix+1,iy+1)]
            weights=[(1-fx)*(1-fy),fx*(1-fy),(1-fx)*fy,fx*fy]
            expected_revision.extend((*[rounded(sum(pixel[channel]*weight for pixel,weight in zip(samples,weights))) for channel in range(3)],255))
    check(f'{name}: entire base raster matches independent placement',rgba(result['base'])==expected_base)
    actual=rgba(result['revision'])
    differences=[abs(x-y) for x,y in zip(actual,expected_revision)] if len(actual)==len(expected_revision) else [999]
    check(f'{name}: entire inverse-bilinear raster matches oracle',max(differences,default=0)<=1,maximumChannelError=max(differences,default=0))
    check(f'{name}: inputs immutable',result['inputHashesBefore']==result['inputHashesAfter']==[base['sha256'],revision['sha256']])

estimate_results={item['id']:item for item in results['estimates']}
landmarks=[(100,100),(500,100),(100,400),(500,400),(300,250)]
for case in manifest['estimates']:
    result=estimate_results[case['id']];name=case['id']
    check(f'{name}: estimator inputs immutable',result['inputHashesBefore']==result['inputHashesAfter'])
    if case.get('expectRejection'):
        check(f'{name}: ambiguous/blank input rejected','error' in result,error=result.get('error'));continue
    check(f'{name}: estimator produced candidate','result' in result,error=result.get('error'))
    if 'result' not in result:continue
    candidate=result['result'];estimated=candidate['matrix'];truth=case['matrix']
    errors=[math.dist(point(estimated,*p),point(truth,*p)) for p in landmarks]
    check(f'{name}: ground-truth landmark error within3pixels',max(errors)<=case['maximumLandmarkError'],errors=errors,estimated=estimated,expected=truth)
    check(f'{name}: evidence has finite residual and nontrivial consensus',math.isfinite(candidate['residualPixels']) and candidate['residualPixels']>=0 and candidate['inliers']>=6 and candidate['matches']>=candidate['inliers'])

report={'versions':{'pypdfium2':version('pypdfium2'),'Pillow':version('Pillow')},'passed':sum(item['passed'] for item in checks),'total':len(checks),'checks':checks,'limitations':['Synthetic fixtures do not prove arbitrary professional drawing registration.','Pixel interpolation oracle permits at most1 channel value rounding difference.','Landmark tolerance3pixels applies only to these stated synthetic cases.']}
(folder/'independent-alignment-results.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(f"Independent alignment checks: {report['passed']}/{report['total']} passed")
for item in checks:
    if not item['passed']:print(json.dumps(item))
sys.exit(0 if report['passed']==report['total'] else 1)
