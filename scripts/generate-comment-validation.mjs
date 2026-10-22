/** Synthetic comment fixtures only. Pass a TEMP directory during concurrent browser tests. */
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {PDFDocument,PDFName,PDFHexString,StandardFonts,degrees} from 'pdf-lib';
import {applyMarkups} from '../apps/opendraft/src/annotations.ts';
import {materializeWorkspace} from '../apps/opendraft/src/workspace-export.ts';

const output=path.resolve(process.argv[2]??'test-results/comment-validation');
await mkdir(output,{recursive:true});
const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
pdf.setTitle('Synthetic threaded review — independent validation');
pdf.context.lookup(pdf.context.trailerInfo.Info).set(PDFName.of('ProjectCode'),PDFHexString.fromText('Reference 水-2026'));
const time='2026-10-21T12:00:00.000Z',marks=[];
for(let index=0;index<2;index++){
 const page=pdf.addPage([400,400]);if(index)page.setRotation(degrees(90));
 page.drawText(`Comment validation reference ${index+1}`,{x:20,y:360,size:13,font});
 const appearance=pdf.context.register(pdf.context.flateStream('0 0 1 RG 1 w 1 1 18 18 re S',{Type:'XObject',Subtype:'Form',BBox:[0,0,20,20],Resources:{}}));
 page.node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Square',Rect:[320,20,340,40],F:4,NM:PDFHexString.fromText(`foreign:${index}`),Contents:PDFHexString.fromText('Preserve foreign annotation'),AP:{N:appearance}})));
 const common={pageIndex:index,groupId:`group-${index}`,layerId:'review',color:[0.8,0.1,0.2],width:3,opacity:0.7,author:'Drawing reviewer',status:'open',locked:false,createdAt:time,modifiedAt:time};
 marks.push({...common,id:`primary-${index}`,kind:'rectangle',points:[[40,100],[170,220]],contents:'Primary box',comments:[
  {id:`root-${index}`,author:'Reviewer 1',contents:'=SUM(1,2) "quoted"\nReference dimension.',createdAt:'2026-10-21T12:00:01.000Z',modifiedAt:'2026-10-21T12:00:02.000Z'},
  {id:`reply-${index}`,parentId:`root-${index}`,author:'工程師 Zoë',contents:'尺寸 42 — confirmed ✓',createdAt:'2026-10-21T12:00:03.000Z',modifiedAt:'2026-10-21T12:00:04.000Z'},
 ]});
 marks.push({...common,id:`subordinate-${index}`,kind:'ellipse',points:[[210,100],[300,200]],contents:'Subordinate ellipse',locked:true,comments:[
  {id:`member-${index}`,author:'Reviewer 2',contents:'Reply belongs to this individual group member.',createdAt:'2026-10-21T12:00:01.000Z',modifiedAt:'2026-10-21T12:00:01.000Z'},
 ]});
}
const bytes=await pdf.save(),before=bytes.slice(),layers=[{id:'review',name:'Review layer',visible:true,locked:false}];
await writeFile(path.join(output,'baseline.pdf'),bytes);
const plain=marks.map(({comments,...mark})=>mark),sources=new Map([['source',bytes]]),pages=marks.filter(mark=>mark.kind==='rectangle').map((mark)=>({sourceId:'source',pageIndex:mark.pageIndex,rotation:0}));
const cases=[];
for(const visible of [true,false])for(const [kind,comments,flatten] of [['marks-only',false,false],['threaded',true,false],['flattened',true,true]]){
 const name=`${visible?'visible':'hidden'}-${kind}.pdf`;
 await writeFile(path.join(output,name),await applyMarkups(bytes,comments?marks:plain,{flatten,layers:[{...layers[0],visible}]}));
 cases.push({name,visible,comments,flatten});
}
// Repeated workspace exports always start from immutable originals rather than prior exported annotations.
await materializeWorkspace(sources,pages,marks,false,layers);
await writeFile(path.join(output,'threaded-repeat.pdf'),await materializeWorkspace(sources,pages,marks,false,layers));
cases.push({name:'threaded-repeat.pdf',visible:true,comments:true,flatten:false});
if(Buffer.compare(Buffer.from(bytes),Buffer.from(before))!==0)throw new Error('Fixture generation mutated source bytes.');
await writeFile(path.join(output,'manifest.json'),JSON.stringify({fixture:'synthetic-threaded-comments-groups-rotation0-90',pageCount:2,renderScale:1.5,tolerance:{meanChannelDifference:0.25,changedChannelFraction:0.01},marks,cases,limitations:'Synthetic own-authored reply metadata and appearance checks only; no interactive commercial-viewer or imported-thread certification.'},null,2)+'\n');
console.log(`Wrote comment fixtures under ${output}`);
