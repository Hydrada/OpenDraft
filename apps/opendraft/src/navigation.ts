import type {PDFDocumentProxy} from 'pdfjs-dist';
import {readDocumentNavigation} from './metadata';

type Navigation = Awaited<ReturnType<typeof readDocumentNavigation>>;
const cache=new WeakMap<PDFDocumentProxy,Promise<Navigation>>();

/** Navigation never executes document actions; external links require an explicit click. */
export async function mountNavigation(
  container:HTMLElement,
  pdf:PDFDocumentProxy,
  callbacks:{navigate:(page:number)=>void;layersChanged:(config:Navigation['optionalContentConfig'])=>void;isCurrent:()=>boolean},
):Promise<void>{
  container.textContent='Loading document navigation…';
  try{
    let pending=cache.get(pdf);
    if(!pending){pending=readDocumentNavigation(pdf);cache.set(pdf,pending);}
    const data=await pending;
    if(!callbacks.isCurrent())return;
    container.replaceChildren();
    const section=(title:string)=>{
      const details=document.createElement('details');
      const summary=document.createElement('summary');summary.textContent=title;details.append(summary);container.append(details);return details;
    };
    const bookmarks=section(`Bookmarks (${data.bookmarks.length})`);
    function bookmarkList(items:Navigation['bookmarks']):HTMLUListElement{
      const list=document.createElement('ul');
      for(const item of items){
        const row=document.createElement('li');
        if(item.pageNumber){const button=document.createElement('button');button.textContent=item.title||'Untitled bookmark';button.onclick=()=>callbacks.navigate(item.pageNumber!);row.append(button);}
        else if(item.url){const link=document.createElement('a');link.textContent=item.title||item.url;link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';row.append(link);}
        else{const label=document.createElement('span');label.textContent=item.title||'Untitled bookmark';row.append(label);}
        if(item.children.length)row.append(bookmarkList(item.children));list.append(row);
      }
      return list;
    }
    bookmarks.append(data.bookmarks.length?bookmarkList(data.bookmarks):document.createTextNode('No bookmarks.'));
    const attachments=section(`Attachments (${data.attachments.length})`);
    if(!data.attachments.length)attachments.append('No attachments.');
    else attachments.append('Download only attachments you trust. Files are not opened automatically.');
    for(const attachment of data.attachments){
      const row=document.createElement('div');
      const button=document.createElement('button');button.textContent=attachment.filename;
      button.setAttribute('aria-label',`Download attachment ${attachment.filename}`);button.disabled=!attachment.bytes;
      button.onclick=()=>{
        if(!attachment.bytes)return;
        const url=URL.createObjectURL(new Blob([new Uint8Array(attachment.bytes)],{type:'application/octet-stream'}));
        const link=document.createElement('a');link.href=url;link.download=attachment.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),30_000);
      };
      row.append(button);if(attachment.error)row.append(attachment.error);attachments.append(row);
    }
    const layers=section(`Layers (${data.layers.length})`);
    if(!data.layers.length)layers.append('No optional content layers.');
    for(const layer of data.layers){
      const label=document.createElement('label');label.style.display='block';
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=layer.visible;
      checkbox.setAttribute('aria-label',`Show layer ${layer.name}`);
      checkbox.onchange=()=>{data.optionalContentConfig.setVisibility(layer.id,checkbox.checked);layer.visible=checkbox.checked;callbacks.layersChanged(data.optionalContentConfig);};
      label.append(checkbox,document.createTextNode(layer.name));layers.append(label);
    }
    layers.append(' Layer visibility changes affect this view only.');
  }catch(e){if(callbacks.isCurrent())container.textContent=`Document navigation unavailable: ${e instanceof Error?e.message:String(e)}`;}
}
