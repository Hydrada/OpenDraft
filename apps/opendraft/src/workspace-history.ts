import { PageHistory, type PageRef } from "./organization.ts";
import { type Markup } from "./annotations.ts";
import { emptyTakeoff, validateTakeoff, type TakeoffState } from "./takeoff.ts";
import { validateMarkupLayers, validateLayerAssignments, type MarkupLayer } from "./markup-layers.ts";
import { validateRevisionJournal, type RevisionEntry } from "./revision-journal.ts";

type State = { pages: PageRef[]; markups: Markup[]; takeoff: TakeoffState; layers: MarkupLayer[]; revisions: RevisionEntry[] };
/** Bounded atomic page/markup history; callers materialize before committing. */
export class WorkspaceHistory {
  private states: State[];
  private cursor = 0;
  constructor(
    pages: readonly PageRef[],
    markups: readonly Markup[] = [],
    takeoff: TakeoffState = emptyTakeoff(),
    layers: readonly MarkupLayer[] = [],
    revisions: readonly RevisionEntry[] = [],
  ) {
    this.states = [
      {
        pages: new PageHistory(pages).pages,
        markups: validateLayerAssignments(markups, layers, pages.length),
        layers: validateMarkupLayers(layers),
        takeoff: validateTakeoff(takeoff, pages.length),
        revisions: validateRevisionJournal(revisions),
      },
    ];
  }
  get pages(): PageRef[] {
    return structuredClone(this.states[this.cursor].pages);
  }
  get markups(): Markup[] {
    return structuredClone(this.states[this.cursor].markups);
  }
  get takeoff(): TakeoffState {
    return structuredClone(this.states[this.cursor].takeoff);
  }
  get layers(): MarkupLayer[] {
    return structuredClone(this.states[this.cursor].layers);
  }
  get revisions(): RevisionEntry[] {
    return structuredClone(this.states[this.cursor].revisions);
  }
  get canUndo(): boolean {
    return this.cursor > 0;
  }
  get canRedo(): boolean {
    return this.cursor < this.states.length - 1;
  }
  commit(
    pages: readonly PageRef[],
    markups: readonly Markup[] = this.markups,
    takeoff: TakeoffState = this.takeoff,
    layers: readonly MarkupLayer[] = this.layers,
    revisions: readonly RevisionEntry[] = this.revisions,
  ): void {
    const value = {
      pages: new PageHistory(pages).pages,
      markups: validateLayerAssignments(markups, layers, pages.length),
      layers: validateMarkupLayers(layers),
      takeoff: validateTakeoff(takeoff, pages.length),
      revisions: validateRevisionJournal(revisions),
    };
    if (JSON.stringify(value) === JSON.stringify(this.states[this.cursor]))
      return;
    this.states.splice(this.cursor + 1);
    this.states.push(value);
    if (this.states.length > 101) this.states.shift();
    this.cursor = this.states.length - 1;
  }
  undo(): void {
    if (this.canUndo) this.cursor--;
  }
  redo(): void {
    if (this.canRedo) this.cursor++;
  }
}
