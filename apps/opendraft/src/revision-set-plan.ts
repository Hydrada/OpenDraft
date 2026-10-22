import {validateRevisionPlan, type SavedRevisionPlan, type RevisionPlanSource} from './revision-plan.ts';

export const REVISION_SET_PLAN_MAX_BYTES = 1024 * 1024;
export type SavedRevisionSetPlan = {schema:'opendraft.revision-set-plan';version:1;createdAt:string;jobs:SavedRevisionPlan[]};

/** Portable instructions only: no bytes, names, approval, execution state or results. */
export function validateRevisionSetPlan(value:unknown):SavedRevisionSetPlan {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Invalid drawing set plan.');
  const input=value as Record<string,unknown>;
  if(['schema','version','createdAt','jobs'].some(key=>!Object.hasOwn(input,key)) || input.schema!=='opendraft.revision-set-plan' || input.version!==1)throw new Error('Unsupported drawing set plan schema or version.');
  const {createdAt,jobs}=input;
  if(typeof createdAt!=='string' || createdAt.length>27 || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString()!==createdAt)throw new Error('Drawing set plan requires a canonical ISO timestamp.');
  if(!Array.isArray(jobs) || jobs.length<1 || jobs.length>20)throw new Error('Drawing set plan requires 1–20 jobs.');
  const copied=Array.from(jobs,validateRevisionPlan), bases=new Set<string>(), revisions=new Set<string>();
  for(const job of copied){
    if(job.markupPolicy!=='retain')throw new Error('Standalone drawing sets must retain source PDF annotations.');
    if(job.operation!==copied[0].operation || job.reason!==copied[0].reason)throw new Error('Drawing set jobs must share an operation and reason.');
    if(bases.has(job.base.sha256) || revisions.has(job.revision.sha256))throw new Error('Drawing set plans require unique PDF snapshots on each side.');
    bases.add(job.base.sha256);revisions.add(job.revision.sha256);
  }
  return {schema:'opendraft.revision-set-plan',version:1,createdAt,jobs:copied};
}

export function parseRevisionSetPlan(text:string):SavedRevisionSetPlan {
  if(typeof text!=='string' || text.length>REVISION_SET_PLAN_MAX_BYTES || new TextEncoder().encode(text).byteLength>REVISION_SET_PLAN_MAX_BYTES)throw new Error('Drawing set plan exceeds the 1 MiB UTF-8 limit.');
  let value:unknown;try{value=JSON.parse(text);}catch{throw new Error('Drawing set plan is not valid JSON.');}
  return validateRevisionSetPlan(value);
}

export function serializeRevisionSetPlan(value:unknown):string {
  const text=JSON.stringify(validateRevisionSetPlan(value),null,2)+'\n';
  if(new TextEncoder().encode(text).byteLength>REVISION_SET_PLAN_MAX_BYTES)throw new Error('Drawing set plan exceeds the 1 MiB UTF-8 limit.');
  return text;
}

/** Resolve the whole plan before changing review state. Filenames and selection order do not establish identity. */
export function resolveRevisionSetPlan(value:unknown,bases:readonly RevisionPlanSource[],revisions:readonly RevisionPlanSource[]) {
  const plan=validateRevisionSetPlan(value);
  const index=(expected:RevisionPlanSource,sources:readonly RevisionPlanSource[])=>{
    const matches=sources.flatMap((source,i)=>source.sha256===expected.sha256 && source.pageCount===expected.pageCount?[i]:[]);
    if(matches.length!==1)throw new Error('Drawing set plan requires exactly one matching inspected PDF snapshot and page count on each side. Reselect and prepare the original sources.');
    return matches[0];
  };
  return {plan,matches:plan.jobs.map(job=>({baseIndex:index(job.base,bases),revisionIndex:index(job.revision,revisions),pairs:job.pairs}))};
}
