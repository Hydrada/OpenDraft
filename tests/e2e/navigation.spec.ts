import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {PDFDocument,PDFName,PDFHexString,PDFString,StandardFonts} from 'pdf-lib';

async function navigationFixture(){
  const pdf=await PDFDocument.create();
  const first=pdf.addPage([400,500]),second=pdf.addPage([400,500]);
  const font=await pdf.embedFont(StandardFonts.Helvetica);
  first.drawText('Sheet A101',{x:40,y:450,size:20,font});second.drawText('Sheet B202',{x:40,y:450,size:20,font});
  await pdf.attach(new TextEncoder().encode('Synthetic authorized attachment'),'notes.txt');
  const outline=pdf.context.obj({Type:'Outlines',Count:1}),outlineRef=pdf.context.register(outline);
  const item=pdf.context.register(pdf.context.obj({Title:PDFHexString.fromText('Go to B202'),Parent:outlineRef,Dest:[second.ref,PDFName.of('Fit')]}));
  outline.set(PDFName.of('First'),item);outline.set(PDFName.of('Last'),item);pdf.catalog.set(PDFName.of('Outlines'),outlineRef);
  const group=pdf.context.register(pdf.context.obj({Type:'OCG',Name:PDFString.of('Red revision')}));
  pdf.catalog.set(PDFName.of('OCProperties'),pdf.context.obj({OCGs:[group],D:{Order:[group],ON:[group]}}));
  first.node.Resources()!.set(PDFName.of('Properties'),pdf.context.obj({Revision:group}));
  first.node.addContentStream(pdf.context.register(pdf.context.flateStream('q /OC /Revision BDC 1 0 0 rg 40 40 100 100 re f EMC Q')));
  return pdf.save();
}

test('bookmarks navigate, attachments download exact bytes and layer toggles change rendered pixels',async({page})=>{
  await page.goto('/');
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'navigation.pdf',mimeType:'application/pdf',buffer:Buffer.from(await navigationFixture())});
  await page.getByText('Bookmarks (1)',{exact:true}).click();
  await page.getByRole('button',{name:'Go to B202',exact:true}).click();
  await expect(page.locator('#page-label')).toHaveText('2 / 2');
  await expect(page.locator('#text')).toContainText('B202');
  await page.getByText('Attachments (1)',{exact:true}).click();
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download attachment notes.txt',exact:true}).click()]);
  expect((await readFile((await download.path())!)).toString()).toBe('Synthetic authorized attachment');
  await page.getByRole('button',{name:'Previous page',exact:true}).click();
  const redPixels=()=>page.getByTestId('pdf-canvas').evaluate((canvas:HTMLCanvasElement)=>{
    const data=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
    let red=0;for(let i=0;i<data.length;i+=4)if(data[i]>180&&data[i+1]<80&&data[i+2]<80)red++;return red;
  });
  await expect.poll(redPixels).toBeGreaterThan(1000);
  await page.getByText('Layers (1)',{exact:true}).click();
  await page.getByLabel('Show layer Red revision',{exact:true}).uncheck();
  await expect.poll(redPixels).toBe(0);
  await page.getByText('Layers (1)',{exact:true}).click();
  await page.getByLabel('Show layer Red revision',{exact:true}).check();
  await expect.poll(redPixels).toBeGreaterThan(1000);
});
