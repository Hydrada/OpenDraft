import { resolveStampText } from "./dynamic-stamps";
import type { PDFPageProxy } from "pdfjs-dist";
import type { Markup, MarkupKind } from "./annotations";
import { STAMP_NAMES, type StampName, StampImage } from "./annotations";
import { presetFromMarkup } from "./markup-presets";
import { PresetPalette } from "./preset-palette";
import { groupMarkups, ungroupMarkups, updateMarkupSelection, lockMarkupSelection, translateMarkupSelection, deleteMarkupSelection } from "./markup-groups";
import type { MarkupLayer } from "./markup-layers";
import { MarkupLayerTools } from "./markup-layer-ui";
import { queryMarkups, type MarkupQuery } from "./markup-query";
import { MarkupCommentTools } from "./markup-comment-ui";

type State = { pageIndex: number; pageCount: number; markups: Markup[]; layers: MarkupLayer[]; busy: boolean };
type Callbacks = {
  getState: () => State | undefined;
  commit: (marks: Markup[], layers?: MarkupLayer[]) => Promise<void>;
  error: (message: string) => void;
};
const kinds: MarkupKind[] = [
  "rectangle",
  "ellipse",
  "line",
  "arrow",
  "highlight",
  "ink",
  "text",
  "cloud",
  "callout",
  "stamp",
];

/** Accessible coordinate entry complements pointer drawing; coordinates are unrotated PDF user space. */
export class MarkupTools {
  private selectedId = "";
  palette!: PresetPalette;
  private stampImage: StampImage | undefined;
  private batchIds = new Set<string>();
  private groupControls: HTMLElement;
  private selectionSummary: HTMLElement;
  private layerTools: MarkupLayerTools;
  private commentTools: MarkupCommentTools;
  private reviewLayers = "";
  private readonly fields: Record<
    string,
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  > = {};
  private list: HTMLDivElement;
  private summary: HTMLElement;
  constructor(
    private container: HTMLElement,
    private callbacks: Callbacks,
  ) {
    container.innerHTML =
      "<h3>Markups</h3><p>Coordinates use PDF page units. Choose a tool and drag on the sheet, or enter coordinates. Text is an annotation, not source-text editing.</p>";
    const form = document.createElement("div");
    form.className = "markup-form";
    const addField = (
      name: string,
      label: string,
      type = "text",
      value = "",
    ) => {
      const row = document.createElement("label");
      row.textContent = label;
      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (type === "tool" || type === "status" || type === "stamp") {
        const select = document.createElement("select");
        for (const choice of type === "tool"
          ? ["select", ...kinds]
          : type === "stamp" ? STAMP_NAMES : ["open", "accepted", "rejected"]) {
          const option = document.createElement("option");
          option.value = choice;
          option.textContent = choice;
          select.append(option);
        }
        input = select;
      } else if (type === "textarea") {
        input = document.createElement("textarea");
      } else {
        const field = document.createElement("input");
        field.type = type;
        input = field;
      }
      input.setAttribute("aria-label", label);
      input.value = value;
      row.append(input);
      form.append(row);
      this.fields[name] = input;
      return input;
    };
    addField("kind", "Markup tool", "tool", "select");
    for (const [name, label, value] of [
      ["x1", "Markup x1", "40"],
      ["y1", "Markup y1", "100"],
      ["x2", "Markup x2", "200"],
      ["y2", "Markup y2", "180"],
    ])
      addField(name, label, "number", value);
    addField("contents", "Markup contents", "textarea", "");
    addField("stampName", "Stamp appearance", "stamp", "Draft");
    const imageLabel = document.createElement("label");
    imageLabel.textContent = "Stamp artwork (PNG, JPEG or page 1 of a PDF, optional)";
    const imagePicker = document.createElement("input");
    imagePicker.type = "file"; imagePicker.accept = "image/png,image/jpeg,application/pdf,.pdf"; imagePicker.setAttribute("aria-label", "Stamp image");
    const imageStatus = document.createElement("span"); imageStatus.textContent = " No image";
    imagePicker.onchange = async () => {
      const file = imagePicker.files?.[0]; imagePicker.value = "";
      if (!file) return;
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error("Stamp images are limited to 2 MB.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const format = bytes[0] === 0x89 && bytes[1] === 0x50 ? "png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpeg" : bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 ? "pdf" : undefined;
        if (!format) throw new Error("Stamp artwork must be a PNG, JPEG or PDF file.");
        let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        this.stampImage = { format, data: btoa(binary) };
        imageStatus.textContent = ` ${file.name}`;
      } catch (e) { this.callbacks.error(e instanceof Error ? e.message : String(e)); }
    };
    const clearImage = document.createElement("button"); clearImage.type = "button"; clearImage.textContent = "Clear stamp image";
    clearImage.onclick = () => { this.stampImage = undefined; imageStatus.textContent = " No image"; };
    imageLabel.append(imagePicker, imageStatus); form.append(imageLabel, clearImage);
    const stampHelp = document.createElement("p");
    stampHelp.textContent = "Stamps show custom contents, or their standard label when contents is blank. Dynamic text: {date}, {time}, {datetime}, {author} and {page} are filled in when the stamp is placed. A visual stamp does not verify identity or create a digital signature.";
    form.append(stampHelp);
    addField("callout", "Callout leader points", "text", "20,80;30,140;40,140");
    const leaderHelp = document.createElement("p");
    leaderHelp.textContent = "Callout leader: tip; optional knee; box-boundary anchor, as x,y pairs. Dragging draws the text box and connects the entered tip directly to its nearest edge.";
    form.append(leaderHelp);
    addField("color", "Markup color", "color", "#d62e2e");
    const width = addField(
      "width",
      "Markup line width",
      "number",
      "2",
    ) as HTMLInputElement;
    width.min = "0.1";
    width.max = "50";
    width.step = "0.5";
    const opacity = addField(
      "opacity",
      "Markup opacity",
      "number",
      "1",
    ) as HTMLInputElement;
    opacity.min = "0";
    opacity.max = "1";
    opacity.step = "0.1";
    addField("author", "Markup author", "text", "");
    addField("status", "Markup status", "status", "open");
    addField("locked", "Markup locked", "checkbox", "");
    container.append(form);
    this.palette = new PresetPalette(container, {
      read: (name, id) => {
        const color = this.value("color");
        return presetFromMarkup({
          kind: this.value("kind") as MarkupKind,
          color: [parseInt(color.slice(1, 3), 16) / 255, parseInt(color.slice(3, 5), 16) / 255, parseInt(color.slice(5, 7), 16) / 255],
          width: Number(this.value("width")), opacity: Number(this.value("opacity")), contents: this.value("contents"),
          ...(this.value("kind") === "stamp" ? { stampName: this.value("stampName") as StampName } : {}),
        }, name, id);
      },
      apply: preset => {
        if (this.callbacks.getState()?.busy) throw new Error("Wait for the current document operation to finish.");
        this.fields.kind.value = preset.kind;
        this.fields.contents.value = preset.contents;
        if (preset.stampName) this.fields.stampName.value = preset.stampName;
        this.fields.width.value = String(preset.width);
        this.fields.opacity.value = String(preset.opacity);
        this.fields.color.value = "#" + preset.color.map(c => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
        // Applying a tool must not turn Update into an accidental edit of an existing markup.
        this.selectedId = "";
        this.batchIds.clear();
        this.refresh();
      },
      error: message => this.callbacks.error(message),
    });
    const button = (label: string, handler: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = handler;
      container.append(b);
      return b;
    };
    button("Add markup", () => void this.addFromFields());
    button("Update selected markup", () => void this.updateSelected());
    button("Delete selected markup", () => void this.deleteSelected());
    button("Unlock selected markup", () => void this.unlockSelected());
    this.layerTools = new MarkupLayerTools(container, {
      getState: () => this.callbacks.getState(),
      selection: () => [...this.batchIds],
      commit: (marks, layers) => this.callbacks.commit(marks, layers),
      error: message => this.callbacks.error(message),
    });
    this.commentTools = new MarkupCommentTools(container, {
      getState: () => {const state=this.callbacks.getState();return state?{...state,markupId:this.selectedId}:undefined;},
      commit: marks => this.callbacks.commit(marks),
      error: message => this.callbacks.error(message),
    });
    this.groupControls = document.createElement("section");
    this.groupControls.setAttribute("aria-label", "Markup grouping");
    const groupTitle = document.createElement("h4"); groupTitle.textContent = "Markup groups and selection";
    const groupHelp = document.createElement("p"); groupHelp.textContent = "Use the list checkboxes to select annotations. Selecting a group member includes the whole group. Group actions preserve individual contents and authors. Ungroup before editing an individual member.";
    this.selectionSummary = document.createElement("p"); this.selectionSummary.setAttribute("role", "status");
    this.groupControls.append(groupTitle, groupHelp, this.selectionSummary);
    const groupButton = (label: string, action: (state: State, ids: string[], timestamp: string) => Markup[]) => {
      const b = document.createElement("button"); b.textContent = label;
      b.onclick = () => void this.change(async () => {
        const state = this.callbacks.getState(); if (!state || state.busy) return;
        const next = action(state, [...this.batchIds], new Date().toISOString());
        await this.callbacks.commit(next);
      });
      this.groupControls.append(b);
    };
    groupButton("Group selected markups", (s, ids, t) => groupMarkups(s.markups, ids, crypto.randomUUID(), s.pageCount, t, s.layers));
    groupButton("Ungroup selected markups", (s, ids, t) => ungroupMarkups(s.markups, ids, s.pageCount, t, s.layers));
    groupButton("Apply selection properties", (s, ids, t) => {
      const color = this.value("color");
      return updateMarkupSelection(s.markups, ids, {color: [parseInt(color.slice(1,3),16)/255,parseInt(color.slice(3,5),16)/255,parseInt(color.slice(5,7),16)/255], width:Number(this.value("width")),opacity:Number(this.value("opacity")),status:this.value("status") as Markup["status"]}, s.pageCount, t, s.layers);
    });
    groupButton("Lock markup selection", (s, ids, t) => lockMarkupSelection(s.markups, ids, true, s.pageCount, t, s.layers));
    groupButton("Unlock markup selection", (s, ids, t) => lockMarkupSelection(s.markups, ids, false, s.pageCount, t, s.layers));
    for (const [key, label] of [["moveX", "Group move x"], ["moveY", "Group move y"]]) {
      const field = addField(key, label, "number", "0");
      this.groupControls.append(field.parentElement!);
    }
    groupButton("Move markup selection", (s, ids, t) => {
      if (!this.value("moveX").trim() || !this.value("moveY").trim()) throw new Error("Enter both movement offsets in PDF page units.");
      return translateMarkupSelection(s.markups, ids, Number(this.value("moveX")), Number(this.value("moveY")), s.pageCount, t, s.layers);
    });
    groupButton("Delete markup selection", (s, ids) => deleteMarkupSelection(s.markups, ids, s.pageCount, s.layers));
    const clearSelection = document.createElement("button"); clearSelection.textContent = "Clear markup selection";
    clearSelection.onclick = () => {this.batchIds.clear(); this.selectedId=""; this.refresh();};
    this.groupControls.append(clearSelection); container.append(this.groupControls);
    const review = document.createElement("section");
    review.className = "markup-review";
    review.setAttribute("aria-label", "Markup list controls");
    const reviewTitle = document.createElement("h4"); reviewTitle.textContent = "Review markup list";
    const reviewHelp = document.createElement("p");
    reviewHelp.textContent = "Filters combine. Group actions include every selected member, including selections outside the filtered list. Reports include all annotations in document order.";
    review.append(reviewTitle, reviewHelp); container.append(review);
    const filter = addField("filter", "Filter markups", "text", "") as HTMLInputElement;
    filter.maxLength = 10000;
    review.append(filter.parentElement!);
    filter.addEventListener("input", () => this.refresh());
    const reviewSelect = (key: string, label: string, choices: [string,string][]) => {
      const row = document.createElement("label"); row.textContent = label;
      const select = document.createElement("select"); select.setAttribute("aria-label",label);
      for (const [value,text] of choices) select.add(new Option(text,value));
      select.onchange = () => this.refresh();
      row.append(select); review.append(row); this.fields[key] = select;
    };
    reviewSelect("reviewPage", "Markup page filter", [["all","All pages"],["current","Current page"]]);
    reviewSelect("reviewKind", "Markup tool filter", [["all","All tools"],...kinds.map(kind => [kind,kind] as [string,string])]);
    reviewSelect("reviewStatus", "Markup status filter", [["all","All statuses"],["open","Open"],["accepted","Accepted"],["rejected","Rejected"]]);
    reviewSelect("reviewLayer", "Markup layer filter", [["all","All layers"],["unlayered","Unlayered annotations"]]);
    reviewSelect("reviewLock", "Markup lock filter", [["all","All lock states"],["locked","Edit locked"],["unlocked","Editable"]]);
    reviewSelect("reviewSort", "Sort markup list by", [["source","Document order"],["page","Page"],["author","Author"],["status","Status"],["kind","Tool"],["created","Created time"],["modified","Modified time"],["layer","Layer"]]);
    reviewSelect("reviewDirection", "Markup sort direction", [["asc","Ascending"],["desc","Descending"]]);
    const reset = document.createElement("button"); reset.textContent = "Reset markup list controls";
    reset.onclick = () => {
      for (const key of ["filter","reviewPage","reviewKind","reviewStatus","reviewLayer","reviewLock","reviewSort","reviewDirection"])
        this.fields[key].value = key === "filter" ? "" : key === "reviewSort" ? "source" : key === "reviewDirection" ? "asc" : "all";
      this.refresh();
    };
    review.append(reset);
    this.summary = document.createElement("p");
    this.summary.setAttribute("role", "status");
    this.summary.dataset.testid = "markup-list-summary";
    container.append(this.summary);
    this.list = document.createElement("div");
    this.list.className = "markup-list";
    container.append(this.list);
    this.refresh();
  }
  private value(name: string) {
    return this.fields[name].value;
  }
  private current(): Markup | undefined {
    return this.callbacks
      .getState()
      ?.markups.find((mark) => mark.id === this.selectedId);
  }
  private fromFields(
    id: string = crypto.randomUUID(),
    createdAt = new Date().toISOString(),
  ): Markup {
    const kind = this.value("kind") as MarkupKind;
    if (!kinds.includes(kind))
      throw new Error("Choose a markup tool before adding a markup.");
    const points: [number, number][] = [
      [Number(this.value("x1")), Number(this.value("y1"))],
      [Number(this.value("x2")), Number(this.value("y2"))],
    ];
    if (!points.flat().every(Number.isFinite))
      throw new Error("Markup coordinates must be finite numbers.");
    const color = this.value("color");
    const state = this.callbacks.getState();
    if (!state) throw new Error("Open a PDF first.");
    const layerId = this.layerTools.layerId;
    if (state.layers.some(layer => layer.id === layerId && layer.locked)) throw new Error("Unlock the annotation layer before changing its annotations.");
    return {
      id,
      pageIndex: state.pageIndex,
      kind,
      points,
      ...(layerId ? {layerId} : {}),
      ...(kind === "stamp" ? { stampName: this.value("stampName") as StampName } : {}),
      ...(kind === "stamp" && this.stampImage ? { image: { ...this.stampImage } } : {}),
      ...(kind === "callout" ? { callout: this.value("callout").split(";").map(pair => {
        const values = pair.split(",").map(value => Number(value.trim()));
        if (values.length !== 2 || pair.split(",").some(value => !value.trim()) || !values.every(Number.isFinite))
          throw new Error("Callout leader requires x,y pairs separated by semicolons.");
        return values as [number, number];
      }) } : {}),
      color: [
        parseInt(color.slice(1, 3), 16) / 255,
        parseInt(color.slice(3, 5), 16) / 255,
        parseInt(color.slice(5, 7), 16) / 255,
      ],
      width: Number(this.value("width")),
      opacity: Number(this.value("opacity")),
      // Dynamic stamp placeholders resolve once, at placement.
      contents: kind === "stamp" ? resolveStampText(this.value("contents"), { author: this.value("author"), page: state.pageIndex + 1 }) : this.value("contents"),
      author: this.value("author"),
      status: this.value("status") as Markup["status"],
      locked: (this.fields.locked as HTMLInputElement).checked,
      createdAt,
      modifiedAt: new Date().toISOString(),
    };
  }
  private async change(action: () => Promise<void>) {
    try {
      await action();
      this.refresh();
    } catch (error) {
      this.callbacks.error(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  private async addFromFields() {
    await this.change(async () => {
      const state = this.callbacks.getState();
      if (!state || state.busy) return;
      const mark = this.fromFields();
      await this.callbacks.commit([...state.markups, mark]);
      this.selectedId = mark.id;
      this.batchIds = new Set([mark.id]);
    });
  }
  private async updateSelected() {
    await this.change(async () => {
      const state = this.callbacks.getState(),
        selected = this.current();
      if (!state || state.busy || !selected)
        throw new Error("Select a markup first.");
      if (selected.locked)
        throw new Error("Unlock this markup before editing.");
      if (state.layers.some(layer => layer.id === selected.layerId && layer.locked)) throw new Error("Unlock the annotation layer before editing its annotations.");
      if (selected.groupId) throw new Error("Ungroup this annotation before editing an individual member; use selection properties for group changes.");
      const replacement = this.fromFields(selected.id, selected.createdAt);
      replacement.pageIndex = selected.pageIndex;
      if (selected.comments) replacement.comments = selected.comments;
      await this.callbacks.commit(
        state.markups.map((mark) =>
          mark.id === selected.id ? replacement : mark,
        ),
      );
    });
  }
  private async deleteSelected() {
    await this.change(async () => {
      const state = this.callbacks.getState(),
        selected = this.current();
      if (!state || state.busy || !selected)
        throw new Error("Select a markup first.");
      await this.callbacks.commit(
        deleteMarkupSelection(state.markups, [selected.id], state.pageCount, state.layers),
      );
      this.selectedId = "";
    });
  }
  private async unlockSelected() {
    await this.change(async () => {
      const state = this.callbacks.getState(),
        selected = this.current();
      if (!state || state.busy || !selected)
        throw new Error("Select a markup first.");
      await this.callbacks.commit(
        lockMarkupSelection(state.markups, [selected.id], false, state.pageCount, new Date().toISOString(), state.layers),
      );
    });
  }
  private select(mark: Markup) {
    this.selectedId = mark.id;
    this.layerTools.choose(mark.layerId);
    this.batchIds = new Set((mark.groupId ? this.callbacks.getState()?.markups.filter(value => value.groupId === mark.groupId) ?? [] : [mark]).map(value => value.id));
    this.fields.kind.value = mark.kind;
    this.fields.contents.value = mark.contents;
    if (mark.stampName) this.fields.stampName.value = mark.stampName;
    this.stampImage = mark.image ? { ...mark.image } : undefined;
    if (mark.callout) this.fields.callout.value = mark.callout.map(point => point.join(",")).join(";");
    this.fields.width.value = String(mark.width);
    this.fields.opacity.value = String(mark.opacity);
    this.fields.author.value = mark.author;
    this.fields.status.value = mark.status;
    (this.fields.locked as HTMLInputElement).checked = mark.locked;
    this.fields.color.value =
      "#" +
      mark.color
        .map((c) =>
          Math.round(c * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
    const [a, b] = [mark.points[0], mark.points.at(-1)!];
    for (const [name, value] of [
      ["x1", a[0]],
      ["y1", a[1]],
      ["x2", b[0]],
      ["y2", b[1]],
    ] as const)
      this.fields[name].value = String(value);
    this.refresh();
  }
  refresh() {
    const state = this.callbacks.getState();
    this.layerTools.refresh();
    this.commentTools.refresh();
    this.list.replaceChildren();
    const marks = state?.markups ?? [];
    const layers = state?.layers ?? [];
    const layerNames = new Map(layers.map(layer => [layer.id,layer.name]));
    const layerSignature = JSON.stringify(layers.map(layer => [layer.id,layer.name]));
    const layerFilter = this.fields.reviewLayer as HTMLSelectElement;
    if (layerSignature !== this.reviewLayers) {
      const previous = layerFilter.value;
      layerFilter.replaceChildren(new Option("All layers","all"), new Option("Unlayered annotations","unlayered"));
      for (const layer of layers) layerFilter.add(new Option(layer.name,`layer:${layer.id}`));
      layerFilter.value = [...layerFilter.options].some(option => option.value === previous) ? previous : "all";
      this.reviewLayers = layerSignature;
    }
    const visible = queryMarkups(marks,layers,{
      text:this.value("filter"),
      status:this.value("reviewStatus") as MarkupQuery["status"],
      kind:this.value("reviewKind") as MarkupQuery["kind"],
      ...(this.value("reviewPage") === "current" ? {pageIndex:state?.pageIndex ?? 0} : {}),
      ...(layerFilter.value === "unlayered" ? {layerId:""} : layerFilter.value.startsWith("layer:") ? {layerId:layerFilter.value.slice(6)} : {}),
      lock:this.value("reviewLock") as MarkupQuery["lock"],
      sort:this.value("reviewSort") as MarkupQuery["sort"],
      direction:this.value("reviewDirection") as MarkupQuery["direction"],
    });
    const existingIds = new Set(marks.map(mark => mark.id));
    this.batchIds = new Set([...this.batchIds].filter(id => existingIds.has(id)));
    const selectedGroups = new Set(marks.filter(mark => this.batchIds.has(mark.id) && mark.groupId).map(mark => mark.groupId));
    for (const mark of marks) if (mark.groupId && selectedGroups.has(mark.groupId)) this.batchIds.add(mark.id);
    const visibleIds = new Set(visible.map(mark => mark.id));
    const excluded = [...this.batchIds].filter(id => !visibleIds.has(id)).length;
    this.selectionSummary.textContent = `${this.batchIds.size} markup(s) selected for group actions${excluded ? ` · ${excluded} selected outside the filtered list; actions include them` : ""}`;
    for (const button of this.groupControls.querySelectorAll("button")) button.disabled = !state || state.busy;
    this.summary.textContent = `${visible.length} of ${marks.length} markup(s) · current page ${(state?.pageIndex ?? 0) + 1}`;
    for (const mark of visible) {
      const button = document.createElement("button");
      const effectiveLock = mark.locked || !!layers.find(layer => layer.id === mark.layerId)?.locked;
      button.textContent = `Page ${mark.pageIndex + 1} · ${mark.kind}${mark.stampName ? ` (${mark.stampName})` : ""} · ${mark.contents || mark.status}${mark.contents ? ` · ${mark.status}` : ""}${mark.author ? ` · ${mark.author}` : ""}${mark.groupId ? ` · group ${mark.groupId.slice(0,8)}` : ""}${mark.layerId ? ` · layer ${layerNames.get(mark.layerId) ?? mark.layerId}` : ""}${mark.comments?.length ? ` · ${mark.comments.length} comment(s)` : ""}${effectiveLock ? " · locked" : ""}`;
      button.setAttribute("aria-label", `Select markup ${mark.id}`);
      button.setAttribute("aria-pressed", String(mark.id === this.selectedId));
      button.onclick = () => this.select(mark);
      const include = document.createElement("input"); include.type="checkbox";
      include.setAttribute("aria-label", `Include markup ${mark.id}`);
      include.dataset.markupId = mark.id;
      include.checked = this.batchIds.has(mark.id); include.disabled = !!state?.busy;
      include.onchange = () => {
        const members = mark.groupId ? marks.filter(member => member.groupId === mark.groupId) : [mark];
        for (const member of members) if (include.checked) this.batchIds.add(member.id); else this.batchIds.delete(member.id);
        this.refresh();
        this.list.querySelector<HTMLInputElement>(`input[data-markup-id="${mark.id}"]`)?.focus();
      };
      const row = document.createElement("div"); row.append(include,button); this.list.append(row);
    }
    for (const button of this.container.querySelectorAll<HTMLButtonElement>(
      ":scope > button",
    ))
      button.disabled = !state || state.busy;
  }
  mountPage(
    frame: HTMLElement,
    viewport: ReturnType<PDFPageProxy["getViewport"]>,
    pageIndex: number,
  ) {
    let start: [number, number] | null = null;
    let points: [number, number][] = [];
    const coordinates = (event: PointerEvent): [number, number] => {
      const rect = frame.getBoundingClientRect();
      const point = viewport.convertToPdfPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      return [point[0], point[1]];
    };
    frame.addEventListener(
      "pointerdown",
      (event) => {
        const state = this.callbacks.getState();
        if (
          event.button !== 0 ||
          !state ||
          state.busy ||
          this.value("kind") === "select"
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        start = coordinates(event);
        points = [start];
        frame.setPointerCapture(event.pointerId);
      },
      true,
    );
    frame.addEventListener("pointermove", (event) => {
      if (start && this.value("kind") === "ink")
        points.push(coordinates(event));
    });
    frame.addEventListener("pointercancel", () => {
      start = null;
      points = [];
    });
    frame.addEventListener(
      "pointerup",
      (event) => {
        if (!start) return;
        event.preventDefault();
        event.stopPropagation();
        const end = coordinates(event),
          first = start;
        start = null;
        void this.change(async () => {
          const state = this.callbacks.getState();
          if (!state || state.busy || state.pageIndex !== pageIndex) return;
          const mark = this.fromFields();
          mark.points = mark.kind === "ink" ? [...points, end] : [first, end];
          if (mark.kind === "callout") {
            const tip = mark.callout![0];
            const left = Math.min(first[0], end[0]), right = Math.max(first[0], end[0]);
            const bottom = Math.min(first[1], end[1]), top = Math.max(first[1], end[1]);
            const candidates: [number, number][] = [
              [left, Math.max(bottom, Math.min(top, tip[1]))],
              [right, Math.max(bottom, Math.min(top, tip[1]))],
              [Math.max(left, Math.min(right, tip[0])), bottom],
              [Math.max(left, Math.min(right, tip[0])), top],
            ];
            candidates.sort((a, b) => Math.hypot(a[0]-tip[0], a[1]-tip[1]) - Math.hypot(b[0]-tip[0], b[1]-tip[1]));
            mark.callout = [tip, candidates[0]];
          }
          mark.pageIndex = pageIndex;
          await this.callbacks.commit([...state.markups, mark]);
          this.select(mark);
        });
      },
      true,
    );
  }
}
