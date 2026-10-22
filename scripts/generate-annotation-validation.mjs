/** Synthetic fixtures only. Run from repo root with Node 24; output is ignored test-results/. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { applyMarkups, STAMP_NAMES } from '../apps/opendraft/src/annotations.ts';

const output=path.resolve(process.argv[2]??'test-results/annotation-validation');
await mkdir(output,{recursive:true});
const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
const kinds=['rectangle','ellipse','line','arrow','highlight','ink','text','cloud','callout','stamp'];
const geometries={rectangle:[[40,70],[180,150]],ellipse:[[210,60],[340,150]],line:[[30,350],[170,350]],arrow:[[230,280],[340,330]],highlight:[[40,280],[200,310]],ink:[[240,180],[280,160],[320,195]],text:[[40,190],[220,250]]};
geometries.cloud=[[230,20],[370,60]];
geometries.callout=[[220,210],[380,265]];
geometries.stamp=[[30,15],[200,60]];
const time='2026-10-21T12:00:00.000Z',marks=[];
for(let index=0;index<kinds.length+2;index++){
  const page=pdf.addPage([400,400]);
  if(index===kinds.length+1)page.setRotation(degrees(90));
  page.drawText(`Synthetic annotation validation ${index+1}`,{x:15,y:380,size:12,font});
  page.drawText('REFERENCE LINE BELOW HIGHLIGHT',{x:42,y:292,size:8,font});
  page.drawLine({start:{x:20,y:300},end:{x:370,y:300},thickness:1,color:rgb(0.3,0.3,0.3)});
  for(const kind of index<kinds.length?[kinds[index]]:kinds){
    marks.push({id:`page${index+1}-${kind}`,pageIndex:index,kind,...(index>=kinds.length?{groupId:`group-page-${index+1}`} : {}),points:geometries[kind],...(kind==='stamp'?{stampName:'Approved'}:{}),...(kind==='callout'?{callout:[[180,170],[205,235],[220,235]]}:{}),color:kind==='highlight'?[1,1,0]:kind==='text'?[0,0,0]:[0.8,0.1,0.3],width:2,opacity:kind==='highlight'?0.4:0.7,contents:kind==='text'?'Review dimension before construction.':`Review ${kind}`,author:'Synthetic tester',status:'open',locked:false,createdAt:time,modifiedAt:time});
  }
}
for (const stampName of STAMP_NAMES) {
  const index=pdf.getPageCount(),page=pdf.addPage([400,400]);
  page.drawText(`Synthetic standard stamp ${stampName}`,{x:15,y:380,size:12,font});
  if(index%2)page.setRotation(degrees(90));
  marks.push({id:`standard-${stampName}`,pageIndex:index,kind:'stamp',stampName,points:[[40,100],[340,200]],color:[0.1,0.3,0.6],width:2,opacity:0.6,contents:'',author:'Synthetic tester',status:'open',locked:false,createdAt:time,modifiedAt:time});
}
const bytes=await pdf.save();
await writeFile(path.join(output,'baseline.pdf'),bytes);
await writeFile(path.join(output,'annotated.pdf'),await applyMarkups(bytes,marks));
await writeFile(path.join(output,'flattened.pdf'),await applyMarkups(bytes,marks,{flatten:true}));
await writeFile(path.join(output,'manifest.json'),JSON.stringify({fixture:'synthetic-all-ten-annotation-kinds',pageCount:pdf.getPageCount(),pageKinds:[...kinds,'all-ten','all-ten-rotated90',...STAMP_NAMES.map(name=>`standard-stamp-${name}`)],expectedAnnotationCounts:[...kinds.map(()=>1),kinds.length,kinds.length,...STAMP_NAMES.map(()=>1)],expectedGroups:[{pageIndex:kinds.length,memberIndices:kinds.map((_,index)=>index)},{pageIndex:kinds.length+1,memberIndices:kinds.map((_,index)=>index)}],renderScale:1.5,tolerance:{meanChannelDifference:0.25,changedChannelFraction:0.01},limitations:'Synthetic normal appearance streams only; not broad compatibility or imported annotation certification.'},null,2)+'\n');
console.log(`Wrote baseline, annotated, flattened PDFs and manifest under ${output}`);
