import {PDFDocument, PDFNumber, PDFName, type PDFPage} from 'pdf-lib';
import {zipSync, strToU8} from 'fflate';
import type {BatchSource} from './batch-comparison.ts';
import {batchCsvCell} from './batch-comparison.ts';
import {validateRevisionPlan, assertRevisionPlanSources, type SavedRevisionPlan} from './revision-plan.ts';
import {assertEditablePdf} from './document-safety.ts';
import {assemblePdf, type PageRef} from './organization.ts';
import {applyMarkups, type Markup} from './annotations.ts';
import {buildRevisionInsertion} from './revision-insert.ts';
import {validateRevisionJournal, type RevisionEntry} from './revision-journal.ts';

export const REVISION_SET_LIMITS = Object.freeze({maxJobs:20,maxSourceBytes:64*1024*1024,maxPages:200,maxPairs:100,maxInputBytes:256*1024*1024,maxOutputBytes:128*1024*1024});
export type RevisionSetJob = {id:string;base:BatchSource;revision:BatchSource;plan:SavedRevisionPlan};
type SourceEvidence = Omit<BatchSource,'bytes'>;
export type RevisionSetResult = {id:string;status:'succeeded'|'failed';base:SourceEvidence;revision:SourceEvidence;plan:SavedRevisionPlan;unmatchedBase:number[];unmatchedRevision:number[];journal:RevisionEntry;outputPath?:string;outputSha256?:string;outputPageCount?:number;outputBytes?:number;error?:string};
export type RevisionSetManifest = {schema:'opendraft.revision-set';version:1;createdAt:string;reviewedAt:string;limits:typeof REVISION_SET_LIMITS;results:RevisionSetResult[];[key:string]:unknown};
const issue=(error:unknown)=>error instanceof Error?error.message:String(error);
function live(signal?:AbortSignal){if(signal?.aborted)throw new DOMException('Revision set cancelled.','AbortError');}
async function hash(bytes:Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer)),value=>value.toString(16).padStart(2,'0')).join('');}
function timestamp(value:string){if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new Error('Revision set requires a canonical ISO review timestamp.');return value;}
function validateSource(source:BatchSource){
 if(!source||typeof source.name!=='string'||source.name.length>1024||!(source.bytes instanceof Uint8Array)||!source.bytes.length||source.bytes.length>REVISION_SET_LIMITS.maxSourceBytes)throw new Error('Revision set sources require named PDF bytes within the 64 MiB limit.');
 if(typeof source.sha256!=='string'||!/^[0-9a-f]{64}$/u.test(source.sha256)||!Number.isInteger(source.pageCount)||source.pageCount<1||source.pageCount>REVISION_SET_LIMITS.maxPages||!Array.isArray(source.labels)||source.labels.length!==source.pageCount||Array.from(source.labels).some(label=>label!==null&&(typeof label!=='string'||label.length>4096)))throw new Error('Revision set source metadata is invalid.');
}
function evidence(source:BatchSource):SourceEvidence{return{name:source.name,sha256:source.sha256,pageCount:source.pageCount,labels:[...source.labels]};}
function geometry(page:PDFPage){
 const media=page.getMediaBox(),crop=page.getCropBox();
 for(const box of[media,crop])if(![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.width<=0||box.height<=0)throw new Error('Page geometry is invalid.');
 const left=Math.max(media.x,crop.x),bottom=Math.max(media.y,crop.y),right=Math.min(media.x+media.width,crop.x+crop.width),top=Math.min(media.y+media.height,crop.y+crop.height);
 const view=right>left&&top>bottom?[left,bottom,right,top]:[media.x,media.y,media.x+media.width,media.y+media.height];
 const rotate=page.getRotation().angle,unit=page.node.lookupMaybe(PDFName.of('UserUnit'),PDFNumber)?.asNumber()??1;
 if(!Number.isFinite(rotate)||rotate%90!==0||!Number.isFinite(unit)||unit<=0)throw new Error('Page rotation or UserUnit is unsupported.');
 return{view,rotation:((rotate%360)+360)%360,userUnit:unit};
}
function stamp(page:PDFPage,index:number,now:string,id:string):Markup{
 const [left,bottom,right,top]=geometry(page).view,w=right-left,h=top-bottom;
 const width=Math.min(240,w*0.8),height=Math.min(60,h*0.25);
 if(width<90||height<28)throw new Error(`Page ${index+1} is too small for a readable superseded stamp.`);
 return{id,pageIndex:index,kind:'stamp',stampName:'Draft',points:[[left+(w-width)/2,bottom+(h-height)/2],[left+(w+width)/2,bottom+(h+height)/2]],color:[0.85,0,0],width:2,opacity:0.8,contents:'SUPERSEDED',author:'OpenDraft',status:'open',locked:false,createdAt:now,modifiedAt:now};
}
function csv(manifest:RevisionSetManifest){
 const rows:unknown[][]=[['Job','Base','Revision','Operation','Status','Pairs','Output','Output SHA-256','Output pages','Error']];
 for(const result of manifest.results)rows.push([result.id,result.base.name,result.revision.name,result.plan.operation,result.status,result.plan.pairs.length,result.outputPath,result.outputSha256,result.outputPageCount,result.error]);
 return rows.map(row=>row.map(batchCsvCell).join(',')).join('\r\n')+'\r\n';
}
/** Processes independent PDF copies; approvals and source files are never imported from saved plans. */
export async function runRevisionSet(jobs:readonly RevisionSetJob[],reviewedAt:string,signal?:AbortSignal,onProgress?:(done:number,total:number)=>void):Promise<{zip:Uint8Array;manifest:RevisionSetManifest}>{
 live(signal);timestamp(reviewedAt);
 if(!Array.isArray(jobs)||jobs.length<1||jobs.length>REVISION_SET_LIMITS.maxJobs)throw new Error('A revision set requires 1–20 jobs.');
 const ids=new Set<string>();let inputBytes=0;
 for(const job of jobs){
  if(!job||typeof job.id!=='string'||!job.id.trim()||job.id.length>200||ids.has(job.id))throw new Error('Revision set job IDs must be unique, nonempty and at most 200 characters.');
  ids.add(job.id);validateSource(job.base);validateSource(job.revision);inputBytes+=job.base.bytes.length+job.revision.bytes.length;
  if(inputBytes>REVISION_SET_LIMITS.maxInputBytes)throw new Error('Revision set input copies exceed the 256 MiB limit.');
 }
 // All bytes, labels and canonical instructions are copied before the first await.
 const snapshots=jobs.map(job=>({id:job.id,base:{...evidence(job.base),bytes:job.base.bytes.slice()},revision:{...evidence(job.revision),bytes:job.revision.bytes.slice()},plan:validateRevisionPlan(job.plan)}));
 for(const job of snapshots)assertRevisionPlanSources(job.plan,job.base,job.revision);
 // One stale source rejects the entire reviewed request before any PDF parsing/output.
 for(const job of snapshots)for(const source of[job.base,job.revision]){if(await hash(source.bytes)!==source.sha256)throw new Error('Revision set source snapshot changed after review. Prepare and review the entire set again.');live(signal);}
 const manifest:RevisionSetManifest={schema:'opendraft.revision-set',version:1,createdAt:new Date().toISOString(),reviewedAt,limits:REVISION_SET_LIMITS,results:[],inputBytes,
  reviewScope:'Reviewed instructions for independent local PDF copies; not engineering acceptance or a cryptographic audit.',journalScope:'Journal fields describe requested operation evidence; only results with status succeeded produced an output. Failed jobs did not commit a revision.',
  annotations:'Base PDF annotations remain at original coordinates. Replacement requires identical effective CropBox, UserUnit and rotation. Donor annotations/actions/forms are excluded. Markup policy affects only authored workspace markups, of which this workflow imports none.',
  limitations:['No current workspace edits, takeoff, journal or external project data are imported. Cleared measurement/scale counts are zero.','Inserted revisions require independent calibration; navigation continues to old superseded sheets.','Source labels are reviewed metadata; source identity is bound to exact bytes and actual page counts.','PDF parsing/copying/ZIP are synchronous or bounded asynchronous library operations; cancellation is checked between stages and sheets are processed sequentially.'],};
 const entries:Record<string,Uint8Array>={};let outputBytes=0;
 for(let index=0;index<snapshots.length;index++){
  live(signal);const job=snapshots[index],selectedBase=new Set(job.plan.pairs.map(pair=>pair.basePage)),selectedRevision=new Set(job.plan.pairs.map(pair=>pair.revisionPage));
  const journal=validateRevisionJournal([{id:`revision-set-${index+1}`,createdAt:new Date().toISOString(),reason:job.plan.reason,baseSha256:job.base.sha256,revisionSha256:job.revision.sha256,replacements:job.plan.pairs.map(pair=>({targetPage:pair.basePage,revisionPage:pair.revisionPage})),operation:job.plan.operation,markupPolicy:job.plan.markupPolicy,clearedMeasurements:0,clearedScales:0}])[0];
  const result:RevisionSetResult={id:job.id,status:'failed',base:evidence(job.base),revision:evidence(job.revision),plan:job.plan,journal,unmatchedBase:Array.from({length:job.base.pageCount},(_,i)=>i+1).filter(page=>!selectedBase.has(page)),unmatchedRevision:Array.from({length:job.revision.pageCount},(_,i)=>i+1).filter(page=>!selectedRevision.has(page))};
  try{
   await assertEditablePdf(job.base.bytes);live(signal);await assertEditablePdf(job.revision.bytes);live(signal);
   const base=await PDFDocument.load(job.base.bytes,{updateMetadata:false});live(signal);const revision=await PDFDocument.load(job.revision.bytes,{updateMetadata:false});live(signal);
   if(base.getPageCount()!==job.base.pageCount||revision.getPageCount()!==job.revision.pageCount)throw new Error('Actual PDF page counts do not match the reviewed revision plan.');
   const originals:PageRef[]=Array.from({length:base.getPageCount()},(_,pageIndex)=>({sourceId:'base',pageIndex,rotation:0}));
   let pages=originals,stamps:Markup[]=[];
   if(job.plan.operation==='replace'){
    for(const pair of job.plan.pairs){
     if(JSON.stringify(geometry(base.getPage(pair.basePage-1)))!==JSON.stringify(geometry(revision.getPage(pair.revisionPage-1))))throw new Error(`Page ${pair.basePage} geometry differs; retained PDF annotations require matching CropBox, UserUnit and rotation.`);
     pages[pair.basePage-1].replacement={sourceId:'revision',pageIndex:pair.revisionPage-1};
    }
   }else{
    const oldStamps=job.plan.pairs.map(pair=>stamp(base.getPage(pair.basePage-1),pair.basePage-1,journal.createdAt,`revision-set-${index+1}-sheet-${pair.basePage}`));
    const insertion=buildRevisionInsertion({pages:originals,markups:[],takeoff:{scales:[],records:[]}},job.plan.pairs,'revision',job.revision.labels,oldStamps);pages=insertion.pages;stamps=insertion.markups;
   }
   live(signal);
   let bytes=await assemblePdf(new Map([['base',job.base.bytes],['revision',job.revision.bytes]]),pages);live(signal);
   if(stamps.length){bytes=await applyMarkups(bytes,stamps);live(signal);}
   if(outputBytes+bytes.length>REVISION_SET_LIMITS.maxOutputBytes)throw new Error('Revision set PDF outputs exceed the 128 MiB output limit.');
   const outputSha256=await hash(bytes);live(signal);const outputPath=`PDFs/${String(index+1).padStart(4,'0')}.pdf`;
   entries[outputPath]=bytes;outputBytes+=bytes.length;Object.assign(result,{status:'succeeded',outputPath,outputSha256,outputPageCount:pages.length,outputBytes:bytes.length});
  }catch(error){live(signal);result.error=issue(error);}
  manifest.results.push(result);onProgress?.(index+1,snapshots.length);live(signal);await new Promise(resolve=>setTimeout(resolve,0));live(signal);
 }
 manifest.outputPdfBytes=outputBytes;manifest.succeeded=manifest.results.filter(result=>result.status==='succeeded').length;manifest.failed=manifest.results.length-Number(manifest.succeeded);
 entries['manifest.json']=strToU8(JSON.stringify(manifest,null,2));entries['summary.csv']=strToU8(csv(manifest));
 const archiveBytes=Object.entries(entries).reduce((total,[name,bytes])=>total+bytes.length+128+2*strToU8(name).length,22);
 if(archiveBytes>REVISION_SET_LIMITS.maxOutputBytes)throw new Error('Revision set archive exceeds the 128 MiB output limit.');
 live(signal);const zip=zipSync(entries,{level:0});live(signal);if(zip.length>REVISION_SET_LIMITS.maxOutputBytes)throw new Error('Revision set archive exceeds the 128 MiB output limit.');
 return{zip,manifest};
}
