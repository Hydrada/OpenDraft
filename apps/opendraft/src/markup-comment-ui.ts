import type {Markup} from './annotations';
import type {MarkupLayer} from './markup-layers';
import {addMarkupComment,updateMarkupComment,deleteMarkupComment,type MarkupComment} from './markup-comments';

type State={markups:Markup[];layers:MarkupLayer[];pageCount:number;busy:boolean;markupId:string};
type Callbacks={getState:()=>State|undefined;commit:(marks:Markup[])=>Promise<void>;error:(message:string)=>void};

/** Local comment editing uses the same validated materialize-before-commit path as annotations. */
export class MarkupCommentTools {
 private section=document.createElement('section');
 private summary=document.createElement('p');
 private list=document.createElement('div');
 private status=document.createElement('p');
 private selected=document.createElement('select');
 private author=document.createElement('input');
 private contents=document.createElement('textarea');
 private markupId='';
 private loaded='';
 constructor(container:HTMLElement,private callbacks:Callbacks){
  this.section.setAttribute('aria-label','Markup comments');this.section.className='markup-comments';
  const title=document.createElement('h4');title.textContent='Comments on selected markup';
  const help=document.createElement('p');help.textContent='Select a markup to review its thread. Add creates a top-level comment; Reply adds a child of the selected comment. Deleting a comment also deletes its replies; undo restores them. Flattened exports remove comment threads: save an editable PDF or report to keep them. Names are local display names, not verified identities.';
  this.summary.setAttribute('role','status');this.status.setAttribute('role','status');
  this.list.setAttribute('aria-label','Comment thread');
  const field=(label:string,input:HTMLElement)=>{const row=document.createElement('label');row.textContent=label;input.setAttribute('aria-label',label);row.append(input);return row;};
  this.selected.onchange=()=>{this.loaded='';this.loadFields();};
  this.author.maxLength=200;this.contents.maxLength=10000;this.contents.rows=4;
  this.section.append(title,help,this.summary,this.list,field('Selected markup comment',this.selected),field('Comment author',this.author),field('Comment text',this.contents));
  const button=(label:string,action:()=>Promise<void>)=>{const item=document.createElement('button');item.textContent=label;item.onclick=()=>void this.run(action);this.section.append(item);};
  const add=async(reply:boolean)=>{
   const state=this.state();
   if(reply&&!this.selected.value)throw new Error('Select a comment to reply to.');
   const timestamp=new Date().toISOString();
   const comment:MarkupComment={id:crypto.randomUUID(),...(reply?{parentId:this.selected.value}:{}),author:this.author.value,contents:this.contents.value,createdAt:timestamp,modifiedAt:timestamp};
   await this.callbacks.commit(addMarkupComment(state.markups,state.markupId,comment,state.pageCount,state.layers));
   this.refresh();this.selected.value=comment.id;this.loaded='';this.loadFields();
   this.status.textContent=reply?'Comment reply added.':'Comment added.';
  };
  button('Add markup comment',()=>add(false));
  button('Reply to selected comment',()=>add(true));
  button('Update selected comment',async()=>{
   const state=this.state();if(!this.selected.value)throw new Error('Select a comment first.');
   await this.callbacks.commit(updateMarkupComment(state.markups,state.markupId,this.selected.value,{author:this.author.value,contents:this.contents.value},new Date().toISOString(),state.pageCount,state.layers));
   this.status.textContent='Comment updated.';
  });
  button('Delete selected comment and replies',async()=>{
   const state=this.state();if(!this.selected.value)throw new Error('Select a comment first.');
   await this.callbacks.commit(deleteMarkupComment(state.markups,state.markupId,this.selected.value,new Date().toISOString(),state.pageCount,state.layers));
   this.selected.value='';this.loaded='';this.status.textContent='Comment and its replies deleted.';
  });
  button('Clear comment selection',async()=>{this.selected.value='';this.loaded='';this.loadFields();this.status.textContent='New comment selected.';});
  this.section.append(this.status);container.append(this.section);
 }
 private state():State {
  const state=this.callbacks.getState();
  if(!state||!state.markups.some(mark=>mark.id===state.markupId))throw new Error('Select a markup before editing its comments.');
  if(state.busy)throw new Error('Wait for the current document operation to finish.');
  return state;
 }
 private loadFields(){
  const state=this.callbacks.getState(),mark=state?.markups.find(mark=>mark.id===state.markupId);
  const comment=mark?.comments?.find(comment=>comment.id===this.selected.value);
  const signature=JSON.stringify([mark?.id??'',comment??null]);
  if(signature===this.loaded)return;
  this.loaded=signature;this.author.value=comment?.author??mark?.author??'';this.contents.value=comment?.contents??'';
 }
 refresh(){
  const state=this.callbacks.getState(),mark=state?.markups.find(mark=>mark.id===state.markupId),comments=mark?.comments??[];
  if((mark?.id??'')!==this.markupId){this.markupId=mark?.id??'';this.selected.value='';this.loaded='';this.status.textContent='';}
  const previous=this.selected.value;
  this.selected.replaceChildren(new Option('New top-level comment',''));
  for(const comment of comments)this.selected.add(new Option(`${comment.author}: ${comment.contents.slice(0,70)}`,comment.id));
  this.selected.value=comments.some(comment=>comment.id===previous)?previous:'';
  this.loadFields();this.list.replaceChildren();
  this.summary.textContent=mark?`${comments.length} comment(s) on selected ${mark.kind} · ${mark.id}`:'Select a markup to view its comments.';
  const depths=new Map<string,number>();
  for(const comment of comments){
   const depth=comment.parentId?(depths.get(comment.parentId)??0)+1:0;depths.set(comment.id,depth);
   const entry=document.createElement('article');entry.style.marginInlineStart=`${Math.min(depth,6)*10}px`;
   const metadata=document.createElement('p');metadata.textContent=`${comment.author} · ${comment.createdAt}${comment.modifiedAt!==comment.createdAt?` · edited ${comment.modifiedAt}`:''} · ${comment.parentId?`reply to ${comment.parentId}`:'top-level comment'}`;
   const body=document.createElement('p');body.className='comment-body';body.textContent=comment.contents;
   const choose=document.createElement('button');choose.textContent='Select comment';choose.setAttribute('aria-label',`Select comment ${comment.id}`);choose.setAttribute('aria-pressed',String(comment.id===this.selected.value));choose.disabled=!!state?.busy;
   choose.onclick=()=>{this.selected.value=comment.id;this.loaded='';this.loadFields();this.refresh();this.selected.focus();};
   entry.append(metadata,body,choose);this.list.append(entry);
  }
  for(const field of [this.selected,this.author,this.contents])field.disabled=!mark||!!state?.busy;
  for(const button of this.section.querySelectorAll<HTMLButtonElement>(':scope > button'))button.disabled=!mark||!!state?.busy;
 }
 private async run(action:()=>Promise<void>){try{await action();this.refresh();}catch(error){this.callbacks.error(error instanceof Error?error.message:String(error));}}
}
