/** Synthetic preservation fixtures only. Run with Node 24; generated output is not a source asset. */
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PDFDocument,PDFName,PDFDict,PDFHexString,StandardFonts,degrees,rgb} from 'pdf-lib';
import {assemblePdf} from '../apps/opendraft/src/organization.ts';

const output=path.resolve(process.argv[2]??'test-results/organization-validation');
await mkdir(output,{recursive:true});
const N=PDFName.of,attachment=new TextEncoder().encode('Authorized synthetic attachment\nA101 reference\n');
async function source(label,rich){
 const pdf=await PDFDocument.create({updateMetadata:false}),font=await pdf.embedFont(StandardFonts.Helvetica);
 pdf.setTitle(`${label} original – 工程`);pdf.setAuthor('Synthetic reviewer');pdf.setSubject('Preservation fixture');pdf.setKeywords(['construction','synthetic']);pdf.setCreator('Synthetic generator');pdf.setProducer('Original fixture producer');pdf.setCreationDate(new Date('2001-02-03T04:05:06Z'));pdf.setModificationDate(new Date('2002-03-04T05:06:07Z'));
 pdf.context.lookup(pdf.context.trailerInfo.Info,PDFDict).set(N('ProjectCode'),PDFHexString.fromText(`${label}-工程-42`));
 const xml=`<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${label} original XMP 工程</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
 pdf.catalog.set(N('Metadata'),pdf.context.register(pdf.context.stream(new TextEncoder().encode(xml),{Type:'Metadata',Subtype:'XML'})));
 const pages=Array.from({length:rich?3:1},(_,index)=>{const page=pdf.addPage(index===1?[300,400]:index===2?[420,300]:[400,300]);page.setRotation(degrees([90,90,180][index]));page.drawText(`${label} synthetic sheet ${index+1}`,{x:35,y:240,size:18,font});page.drawRectangle({x:30+index*20,y:35,width:60,height:45,color:rgb(index===0?0.8:0.1,index===1?0.7:0.2,index===2?0.8:0.1)});return page;});
 if(rich){
  const form=pdf.getForm(),field=form.createTextField('AssetCode');field.setText('A101 checked');field.addToPage(pages[1],{x:40,y:120,width:180,height:30,font});
  await pdf.attach(attachment,'reference.txt',{mimeType:'text/plain',description:'Synthetic authorized fixture'});await pdf.flush();
  const names=pdf.catalog.lookup(N('Names'),PDFDict);names.set(N('Dests'),pdf.context.obj({Names:[PDFHexString.fromText('target-sheet'),[pages[2].ref,'Fit']]}));
  const outlines=pdf.context.register(pdf.context.obj({Type:'Outlines',Count:2}));
  const first=pdf.context.register(pdf.context.obj({Title:PDFHexString.fromText('Explicit sheet 2'),Parent:outlines,Dest:[pages[1].ref,'Fit']}));
  const second=pdf.context.register(pdf.context.obj({Title:PDFHexString.fromText('Named sheet 3'),Parent:outlines,Dest:PDFHexString.fromText('target-sheet'),Prev:first}));
  pdf.context.lookup(first,PDFDict).set(N('Next'),second);const root=pdf.context.lookup(outlines,PDFDict);root.set(N('First'),first);root.set(N('Last'),second);pdf.catalog.set(N('Outlines'),outlines);
  pages[0].node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[30,210,230,230],Border:[0,0,0],Dest:[pages[2].ref,'Fit'],P:pages[0].ref,NM:PDFHexString.fromText('source-link')})));
  pages[2].node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Text',Rect:[5,5,15,15],Contents:PDFHexString.fromText('Foreign retained note'),NM:PDFHexString.fromText('foreign-note'),F:32,P:pages[2].ref})));
  pages[1].node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[20,70,170,90],Border:[0,0,0],A:{S:'GoTo',D:[0,'Fit']},P:pages[1].ref,NM:PDFHexString.fromText('numeric-local-link')})));
  pages[2].node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[20,70,170,90],Border:[0,0,0],A:{S:'GoToR',F:PDFHexString.fromText('other.pdf'),D:[0,'Fit']},P:pages[2].ref,NM:PDFHexString.fromText('numeric-remote-link')})));
  pdf.catalog.set(N('PageLabels'),pdf.context.obj({Nums:[0,{P:PDFHexString.fromText('A-'),S:'D',St:1},1,{P:PDFHexString.fromText('B-'),S:'D',St:10},2,{P:PDFHexString.fromText('C-'),S:'D',St:20}]}));
  const ocg=pdf.context.register(pdf.context.obj({Type:'OCG',Name:PDFHexString.fromText('Source review layer')}));pdf.catalog.set(N('OCProperties'),pdf.context.obj({OCGs:[ocg],D:{BaseState:'ON',Order:[ocg],ON:[ocg],OFF:[]}}));
  // Exercise inherited page-tree attributes, not only flat trees with local attributes.
  const tree=pdf.catalog.Pages(),treeRef=pdf.catalog.get(N('Pages'));
  const nested=pdf.context.register(pdf.context.obj({Type:'Pages',Parent:treeRef,Kids:pages.map(page=>page.ref),Count:pages.length,MediaBox:[0,0,400,300],Resources:pages[0].node.Resources(),Rotate:90}));
  tree.set(N('Kids'),pdf.context.obj([nested]));tree.set(N('Count'),pdf.context.obj(pages.length));
  for(const page of pages)page.node.set(N('Parent'),nested);
  for(const key of ['MediaBox','Resources','Rotate'])pages[0].node.delete(N(key));
  pages[0].node.set(N('CropBox'),pdf.context.obj([10,10,390,290]));
 }
 return pdf.save();
}
const a=await source('A',true),b=await source('B',false),empty=await PDFDocument.create({updateMetadata:false});empty.addPage([200,200]);const noInfo=await empty.save();
const originals=[a.slice(),b.slice()],sources=new Map([['A',a],['B',b]]),ref=(sourceId,pageIndex,rotation=0)=>({sourceId,pageIndex,rotation});
const cases=[
 {name:'permuted.pdf',pages:[ref('A',2),ref('A',0,90),ref('A',1)],primary:'source-a.pdf',full:true},
 {name:'extracted.pdf',pages:[ref('A',1)],primary:'source-a.pdf'},
 {name:'merged.pdf',pages:[ref('B',0),ref('A',2),ref('A',0)],primary:'source-a.pdf'},
 {name:'duplicated.pdf',pages:[ref('A',1),ref('A',1),ref('A',0)],primary:'source-a.pdf'},
 {name:'secondary-only.pdf',pages:[ref('B',0)],primary:'source-b.pdf'},
];
await writeFile(path.join(output,'source-a.pdf'),a);await writeFile(path.join(output,'source-b.pdf'),b);await writeFile(path.join(output,'source-no-info.pdf'),noInfo);
for(const item of cases)await writeFile(path.join(output,item.name),await assemblePdf(sources,item.pages));
await writeFile(path.join(output,'no-info-extracted.pdf'),await assemblePdf(new Map([['N',noInfo]]),[ref('N',0),ref('N',0)]));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
await writeFile(path.join(output,'manifest.json'),JSON.stringify({fixture:'synthetic-three-page-preservation',renderScale:1.25,sources:{A:'source-a.pdf',B:'source-b.pdf'},cases,attachmentText:new TextDecoder().decode(attachment),immutableSources:[digest(a)===digest(originals[0]),digest(b)===digest(originals[1])],limitations:'Synthetic page trees, metadata and catalog references only; not full PDF conformance, partial-catalog reconstruction or independent commercial-viewer acceptance.'},null,2)+'\n');
console.log(`Wrote organization validation fixtures under ${output}`);
