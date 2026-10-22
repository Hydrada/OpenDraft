import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {PDFDocument,PDFName,PDFDict,PDFString,PDFHexString,StandardFonts} from 'pdf-lib';
const name=PDFName.of;
async function fixture(title='Primary source'){
 const pdf=await PDFDocument.create({updateMetadata:false});pdf.setTitle(title);pdf.setAuthor('Original reviewer');pdf.setProducer('Original application');pdf.setCreationDate(new Date('2021-02-03T04:05:06Z'));pdf.setModificationDate(new Date('2022-03-04T05:06:07Z'));
 pdf.context.lookup(pdf.context.trailerInfo.Info,PDFDict).set(name('ProjectCode'),PDFHexString.fromText('Projet Ω'));
 const a=pdf.addPage([400,500]),b=pdf.addPage([400,500]),font=await pdf.embedFont(StandardFonts.Helvetica);
 a.drawText('Source sheet A101',{x:40,y:450,size:18,font});b.drawText('Source sheet B202',{x:40,y:450,size:18,font});
 const field=pdf.getForm().createTextField('reviewer');field.setText('Retained form value');field.addToPage(a,{x:40,y:180,width:200,height:25});
 await pdf.attach(new TextEncoder().encode('Authorized schedule evidence'),'schedule.txt');
 const names=pdf.context.obj({Dests:{Names:[PDFString.of('sheet-B'),[b.ref,name('Fit')]]}});pdf.catalog.set(name('Names'),names);
 const outlines=pdf.context.obj({Type:'Outlines',Count:1}),outlineRef=pdf.context.register(outlines),item=pdf.context.register(pdf.context.obj({Title:PDFHexString.fromText('Go to source B202'),Parent:outlineRef,Dest:PDFString.of('sheet-B')}));
 outlines.set(name('First'),item);outlines.set(name('Last'),item);pdf.catalog.set(name('Outlines'),outlineRef);
 a.node.addAnnot(pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[40,350,220,390],Dest:[b.ref,name('Fit')],Border:[0,0,0]})));
 const group=pdf.context.register(pdf.context.obj({Type:'OCG',Name:PDFString.of('Source revision')}));pdf.catalog.set(name('OCProperties'),pdf.context.obj({OCGs:[group],D:{Order:[group],ON:[group]}}));
 a.node.Resources()!.set(name('Properties'),pdf.context.obj({Revision:group}));a.node.addContentStream(pdf.context.register(pdf.context.flateStream('q /OC /Revision BDC 1 0 0 rg 40 40 100 100 re f EMC Q')));
 pdf.catalog.set(name('PageLabels'),pdf.context.obj({Nums:[0,{P:PDFString.of('Sheet-'),S:'D',St:10}]}));
 pdf.catalog.set(name('Metadata'),pdf.context.register(pdf.context.stream(new TextEncoder().encode('<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Original XMP</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>'),{Type:'Metadata',Subtype:'XML'})));
 return pdf.save();
}
async function open(page:Page,bytes:Uint8Array){await page.goto('/');await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'preservation.pdf',mimeType:'application/pdf',buffer:Buffer.from(bytes)});await expect(page.locator('#text')).toContainText('A101');}
async function download(page:Page,label:string){const [file]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:label,exact:true}).click()]);return PDFDocument.load(await readFile((await file.path())!),{updateMetadata:false});}
function info(pdf:PDFDocument){return pdf.context.lookup(pdf.context.trailerInfo.Info,PDFDict).entries().map(([key,value])=>[key.toString(),value.toString()]).sort();}

test('full source reorder keeps bookmark/link targets, attachments, form, layer and metadata through undo',async({page})=>{
 const bytes=await fixture(),source=await PDFDocument.load(bytes,{updateMetadata:false});await open(page,bytes);
 await page.getByRole('button',{name:'Move page later',exact:true}).click();await expect(page.locator('#page-label')).toHaveText('2 / 2');await expect(page.locator('#text')).toContainText('A101');
 await expect(page.getByRole('link',{name:'Go to linked page 1',exact:true})).toBeVisible();
 await page.getByText('Bookmarks (1)',{exact:true}).click();await page.getByRole('button',{name:'Go to source B202',exact:true}).click();await expect(page.locator('#page-label')).toHaveText('1 / 2');await expect(page.locator('#text')).toContainText('B202');
 await page.getByText('Attachments (1)',{exact:true}).click();const [attachment]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download attachment schedule.txt',exact:true}).click()]);expect(await readFile((await attachment.path())!,'utf8')).toBe('Authorized schedule evidence');
 await page.getByText('Layers (1)',{exact:true}).click();await expect(page.getByLabel('Show layer Source revision',{exact:true})).toBeChecked();
 let saved=await download(page,'Save PDF');expect(info(saved)).toEqual(info(source));expect(saved.getForm().getTextField('reviewer').getText()).toBe('Retained form value');
 expect(saved.getPages().map(p=>p.ref.toString())).toEqual([source.getPage(1).ref.toString(),source.getPage(0).ref.toString()]);expect(saved.catalog.get(name('Metadata'))?.toString()).toBe(source.catalog.get(name('Metadata'))?.toString());
 await page.getByRole('button',{name:'Undo edit',exact:true}).click();await expect(page.locator('#text')).toContainText('A101');
 await page.getByRole('button',{name:'Redo edit',exact:true}).click();await expect(page.locator('#text')).toContainText('B202');saved=await download(page,'Save PDF');expect(info(saved)).toEqual(info(source));
});

test('extraction and insertion retain primary source Info/XMP without claiming other catalog structures',async({page})=>{
 const bytes=await fixture(),source=await PDFDocument.load(bytes,{updateMetadata:false});await open(page,bytes);
 await page.getByRole('button',{name:'Next page',exact:true}).click();let output=await download(page,'Extract page');expect(output.getPageCount()).toBe(1);expect(info(output)).toEqual(info(source));expect(output.catalog.has(name('Metadata'))).toBe(true);
 await page.getByRole('button',{name:'Delete page',exact:true}).click();await expect(page.locator('#page-label')).toHaveText('1 / 1');output=await download(page,'Save PDF');expect(info(output)).toEqual(info(source));
 await page.getByLabel('Insert PDF files',{exact:true}).setInputFiles({name:'secondary.pdf',mimeType:'application/pdf',buffer:Buffer.from(await fixture('Secondary source'))});await expect(page.locator('#page-label')).toContainText('/ 3');
 output=await download(page,'Save PDF');expect(output.getPageCount()).toBe(3);expect(info(output)).toEqual(info(source));expect(output.getTitle()).toBe('Primary source');expect(output.catalog.has(name('Metadata'))).toBe(true);
});
