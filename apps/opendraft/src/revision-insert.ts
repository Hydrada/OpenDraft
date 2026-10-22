import {validatePages, type PageRef} from './organization.ts';
import {validateMarkups, type Markup} from './annotations.ts';
import {validateTakeoff, type TakeoffState} from './takeoff.ts';

/** Insert reviewed donor sheets before old sheets; retain old annotations and invalidate selected takeoff. */
export function buildRevisionInsertion(
  current: {pages: readonly PageRef[]; markups: readonly Markup[]; takeoff: TakeoffState},
  pairs: readonly {basePage: number; revisionPage: number}[],
  sourceId: string,
  labels: readonly (string | null)[],
  stamps: readonly Markup[],
): {pages: PageRef[]; markups: Markup[]; takeoff: TakeoffState} {
  const oldPages = validatePages(current.pages), oldMarkups = validateMarkups(current.markups,oldPages.length);
  const oldTakeoff = validateTakeoff(current.takeoff,oldPages.length);
  if (typeof sourceId !== 'string' || !sourceId.trim()) throw new Error('Revision insertion requires a donor source.');
  if (!Array.isArray(labels) || !labels.length || Array.from(labels).some(label => label !== null && (typeof label !== 'string' || label.length > 1000))) throw new Error('Revision labels must be text or null, at most 1000 characters each.');
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > 100 || oldPages.length + pairs.length > 20000) throw new Error('Insert 1–100 reviewed sheet pairs within the 20000-page workspace limit.');
  const selected = new Map<number,number>(), donorPages = new Set<number>();
  for (const pair of Array.from(pairs)) {
    if (!pair || !Number.isSafeInteger(pair.basePage) || pair.basePage < 1 || pair.basePage > oldPages.length || selected.has(pair.basePage - 1) || !Number.isSafeInteger(pair.revisionPage) || pair.revisionPage < 1 || pair.revisionPage > labels.length || donorPages.has(pair.revisionPage)) throw new Error('Revision insertion requires unique one-to-one pages within both sources.');
    selected.set(pair.basePage - 1,pair.revisionPage); donorPages.add(pair.revisionPage);
  }
  const oldStamps = validateMarkups(stamps,oldPages.length), stamped = new Set<number>();
  for (const stamp of oldStamps) {
    if (stamp.kind !== 'stamp' || !selected.has(stamp.pageIndex) || stamped.has(stamp.pageIndex)) throw new Error('Provide exactly one superseded stamp per selected old page.');
    stamped.add(stamp.pageIndex);
  }
  if (stamped.size !== selected.size) throw new Error('Provide exactly one superseded stamp per selected old page.');
  const pages: PageRef[] = [], positions = new Map<number,number>();
  oldPages.forEach((page,index) => {
    const revisionPage = selected.get(index);
    if (revisionPage !== undefined) {
      const label = labels[revisionPage - 1];
      pages.push({sourceId,pageIndex:revisionPage - 1,rotation:0,inserted:true,label:label?.trim() ? label : `Revision page ${revisionPage}`});
    }
    positions.set(index,pages.length); pages.push(page);
  });
  const remap = <T extends {pageIndex:number}>(item:T): T => ({...item,pageIndex:positions.get(item.pageIndex)!});
  return {
    pages: validatePages(pages),
    markups: validateMarkups([...oldMarkups.map(remap),...oldStamps.map(remap)],pages.length),
    takeoff: validateTakeoff({
      scales:oldTakeoff.scales.filter(scale => !selected.has(scale.pageIndex)).map(remap),
      records:oldTakeoff.records.filter(record => !selected.has(record.pageIndex)).map(remap),
    },pages.length),
  };
}
