import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { sanitizedHttpUrl } from './metadata';

type PageViewport = ReturnType<PDFPageProxy['getViewport']>;

/** Read-only link hit targets. No document actions or unsafeUrl values are executed. */
export async function mountPageLinks(
  container: HTMLElement, pdf: PDFDocumentProxy, page: PDFPageProxy, viewport: PageViewport,
  navigate: (pageNumber: number) => void, isCurrent: () => boolean,
): Promise<void> {
  const annotations = await page.getAnnotations({intent:'display'}).catch(()=>[]);
  if (!isCurrent()) return;
  container.replaceChildren();
  Object.assign(container.style,{position:'absolute',inset:'0',pointerEvents:'none'});
  container.dataset.testid='pdf-links';
  for(const annotation of annotations){
    try{
    if(annotation.subtype!=='Link' || !Array.isArray(annotation.rect) || annotation.rect.length!==4 || !annotation.rect.every(Number.isFinite))continue;
    // Named, launch, remote-go-to and JavaScript actions intentionally have no target.
    const url=sanitizedHttpUrl(annotation.url);
    let target:number|null=null;
    if(!url && annotation.dest){
      try{
        const destination=typeof annotation.dest==='string'?await pdf.getDestination(annotation.dest):annotation.dest;
        if(Array.isArray(destination)&&destination.length){
          const index=Number.isInteger(destination[0])?destination[0]:await pdf.getPageIndex(destination[0]);
          if(Number.isInteger(index)&&index>=0&&index<pdf.numPages)target=index+1;
        }
      }catch{/* Broken internal links remain inert. */}
    }
    if(!isCurrent())return;
    if(!url && target===null)continue;
    const [x1,y1]=viewport.convertToViewportPoint(annotation.rect[0],annotation.rect[1]);
    const [x2,y2]=viewport.convertToViewportPoint(annotation.rect[2],annotation.rect[3]);
    const left=Math.max(0,Math.min(x1,x2)),top=Math.max(0,Math.min(y1,y2));
    const right=Math.min(viewport.width,Math.max(x1,x2)),bottom=Math.min(viewport.height,Math.max(y1,y2));
    if(![left,top,right,bottom].every(Number.isFinite)||right<=left||bottom<=top)continue;
    const link=document.createElement('a');
    Object.assign(link.style,{position:'absolute',left:`${left}px`,top:`${top}px`,width:`${right-left}px`,height:`${bottom-top}px`,pointerEvents:'auto',background:'transparent',zIndex:'2'});
    const label=url?`Open link ${url}`:`Go to linked page ${target}`;
    link.setAttribute('aria-label',label);link.title=label;
    if(url){link.href=url;link.target='_blank';link.rel='noopener noreferrer';}
    else{link.href='#';link.onclick=event=>{event.preventDefault();if(isCurrent())navigate(target!);};}
    link.onfocus=()=>{link.style.outline='3px solid #1895ec';link.style.outlineOffset='2px';};
    link.onblur=()=>{link.style.outline='';link.style.outlineOffset='';};
    container.append(link);
    }catch{/* An invalid link never prevents navigation or executes fallback actions. */}
  }
}
