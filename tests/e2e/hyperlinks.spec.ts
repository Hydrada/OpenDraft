import {test,expect} from '@playwright/test';
import {PDFDocument,PDFName,PDFString,StandardFonts} from 'pdf-lib';

async function linkedFixture(){
  const pdf=await PDFDocument.create();
  const first=pdf.addPage([400,500]),second=pdf.addPage([400,500]);
  const font=await pdf.embedFont(StandardFonts.Helvetica);
  first.drawText('Linked sheet A101',{x:40,y:470,size:18,font});
  first.drawText('Internal link to B202',{x:40,y:430,size:16,font});
  first.drawText('External reference',{x:40,y:360,size:16,font});
  first.drawText('Unsafe link is inert',{x:40,y:290,size:16,font});
  second.drawText('Linked sheet B202',{x:40,y:470,size:18,font});
  const internal=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[40,410,230,450],Border:[0,0,0],Dest:[second.ref,PDFName.of('Fit')]}));
  const external=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[40,340,230,380],Border:[0,0,0],A:{S:'URI',URI:PDFString.of('https://example.com/reference')}}));
  const malicious=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[40,270,230,310],Border:[0,0,0],A:{S:'URI',URI:PDFString.of('javascript:globalThis.OPENDRAFT_UNSAFE=true')}}));
  const script=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[40,200,230,240],Border:[0,0,0],A:{S:'JavaScript',JS:PDFString.of('globalThis.OPENDRAFT_UNSAFE=true')}}));
  first.node.set(PDFName.of('Annots'),pdf.context.obj([internal,external,malicious,script]));
  return pdf.save();
}

test('safe PDF links are keyboard accessible and unsafe PDF actions remain inert',async({page})=>{
  const externalRequests:string[]=[];
  page.on('request',request=>{if(request.url().startsWith('https://example.com'))externalRequests.push(request.url());});
  await page.goto('/');
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'linked.pdf',mimeType:'application/pdf',buffer:Buffer.from(await linkedFixture())});
  const internal=page.getByRole('link',{name:'Go to linked page 2',exact:true});
  await expect(internal).toBeVisible();
  const position=await internal.evaluate(link=>{const r=link.getBoundingClientRect();const canvas=link.parentElement!.parentElement!.querySelector('canvas')!.getBoundingClientRect();return {x:r.left-canvas.left,y:r.top-canvas.top,width:r.width,height:r.height};});
  expect(position).toEqual({x:40,y:50,width:190,height:40});
  const external=page.getByRole('link',{name:'Open link https://example.com/reference',exact:true});
  await expect(external).toHaveAttribute('href','https://example.com/reference');
  await expect(external).toHaveAttribute('target','_blank');
  await expect(external).toHaveAttribute('rel','noopener noreferrer');
  await expect(page.getByTestId('pdf-links').locator('a')).toHaveCount(2);
  expect(await page.evaluate(()=>('OPENDRAFT_UNSAFE' in globalThis))).toBe(false);
  expect(externalRequests).toEqual([]);
  await internal.focus();
  await expect(internal).toBeFocused();
  expect(await internal.evaluate(link=>getComputedStyle(link).outlineWidth)).toBe('3px');
  await page.keyboard.press('Enter');
  await expect(page.locator('#page-label')).toHaveText('2 / 2');
  await expect(page.locator('#text')).toContainText('B202');
  expect(externalRequests).toEqual([]);
});
