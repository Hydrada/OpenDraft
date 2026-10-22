import { mountOcr } from "./ocr-ui";
import { PDFDocument } from "pdf-lib";
import { applyTakeoffLegend, legendRows } from "./takeoff-legend";
import { mountForms } from "./forms-ui";
let forms: ReturnType<typeof mountForms> | undefined;
import { mountSignatures } from "./signature-ui";
import { mountRedaction } from "./redaction-ui";
let redaction: ReturnType<typeof mountRedaction> | undefined;
import { importForeignAnnotations } from "./foreign-annotations";
import { pdfResources } from "./pdf-resources";
import "./compat";
import { mountAssistant } from "./ai-ui";
import { mountCollaboration } from "./collab-ui";
import type { CollabSession } from "./collab-client";
import { applyMeasurementAnnotations } from "./measurement-annotations";
import { extractDrawingVertices } from "./drawing-geometry";
import { mountRevisionSet } from './revision-set-ui';
import { mountSlipReview, slipStateKey, type SlipDocument } from './slip-ui';
import type { RevisionEntry } from './revision-journal';
import { mountBatchComparison } from './batch-ui';
import { mountRevisionComparison } from './revision-ui';
import { takeoffCsv, takeoffXlsx } from './takeoff-reports';
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { exportPdf, normalizeRotation } from "./document";
import { type PageRef } from "./organization";
import { WorkspaceHistory } from "./workspace-history";
import { materializeWorkspace } from "./workspace-export";
import { MarkupTools } from "./markup-ui";
import type { Markup } from "./annotations";
import type { MarkupLayer } from "./markup-layers";
import { MeasurementTools } from "./measurement-ui";
import { emptyTakeoff, validateTakeoff, type TakeoffState } from "./takeoff";
import type { Rect } from "./measurements";
import { markupCsv, punchListCsv, markupPdf } from "./markup-reports";
import {
  saveRecovery,
  loadRecovery,
  clearRecovery,
  type RecoverySnapshot,
} from "./recovery";
import { mountNavigation } from "./navigation";
import { preparePrint } from "./print";
// Desktop host capabilities (absent on the web): resolved once, false if the endpoint does not exist.
let desktopProbe: Promise<{ vectorPrint: boolean }> | undefined;
const desktopCapabilities = () => desktopProbe ??= fetch("/__desktop").then(response => response.ok && (response.headers.get("content-type") ?? "").includes("json") ? response.json() : { vectorPrint: false }, () => ({ vectorPrint: false }));
import { mountPageLinks } from "./hyperlinks";
import "./style.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
type Drawing = {
  id: number;
  name: string;
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
  page: number;
  zoom: number;
  rotations: Map<number, number>;
  text: Map<number, string>;
  destroy: () => Promise<void>;
  sources: Map<string, Uint8Array>;
  history: WorkspaceHistory;
  busy: boolean;
  takeoffView?: TakeoffState;
  pageGeometry?: { pageIndex: number; bounds: Rect };
  // Rendered thumbnails survive page navigation; rebuilt only when the PDF or rotations change.
  thumbs?: { pdf: PDFDocumentProxy; key: string; nodes: HTMLButtonElement[] };
  optionalContentConfig?: Awaited<
    ReturnType<PDFDocumentProxy["getOptionalContentConfig"]>
  >;
};
const drawings: Drawing[] = [];
let activeId = 0,
  nextId = 1,
  generation = 0,
  searchGeneration = 0;
let renderTask: RenderTask | undefined;
// Main-view page proxy, released when the view moves so PDF.js frees its operator lists/canvases.
let shownPage: { cleanup: () => boolean } | undefined;
let textLayer: pdfjs.TextLayer | undefined;
let markupTools: MarkupTools | undefined;
let measurementTools: MeasurementTools | undefined;
// One collaboration binding at a time: a drawing plus the page structure it joined with.
let collab: { session: CollabSession; drawing: Drawing; pages: string } | undefined;
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header class="header"><div class="brand"><span class="logo" aria-hidden="true">O</span><strong>OpenDraft</strong><small>DRAWING WORKSPACE</small></div><div class="meta">Local files · No account required</div><button id="open">＋ Open PDF</button><input class="hidden" id="file" type="file" accept="application/pdf,.pdf" multiple aria-label="Open PDF files"></header><nav class="tabs" aria-label="Open documents" id="tabs"></nav><div class="toolbar" aria-label="Document tools"><button id="previous" aria-label="Previous page">←</button><span class="page-label" id="page-label">No document</span><button id="next" aria-label="Next page">→</button><span class="separator"></span><button id="zoom-out" aria-label="Zoom out">−</button><span id="zoom-label">100%</span><button id="zoom-in" aria-label="Zoom in">＋</button><button id="rotate" aria-label="Rotate page clockwise">↻ Rotate</button><span class="separator"></span><input id="search" type="search" aria-label="Search document" placeholder="Search document…"><button id="find">Find next</button><span id="search-status" class="search-status" role="status"></span><button id="compare" aria-label="Compare drawing revisions">Compare revisions</button><button id="batch-compare">Batch revision review</button><button id="slip-review">Replace revised sheets</button><button id="revision-set">Revise drawing set</button><button id="print" aria-label="Print PDF">Print</button><button id="import-annotations" aria-label="Import existing annotations for editing">Import annotations for editing</button><button id="flatten" aria-label="Flatten OpenDraft markups">Flatten OpenDraft markups</button><button id="save" class="primary save">Save PDF</button></div><div class="organization" aria-label="Page organization"><button id="undo" aria-label="Undo edit">Undo</button><button id="redo" aria-label="Redo edit">Redo</button><span class="separator"></span><button id="earlier" aria-label="Move page earlier">Move earlier</button><button id="later" aria-label="Move page later">Move later</button><button id="delete" aria-label="Delete page">Delete page</button><button id="extract" aria-label="Extract page">Extract page</button><button id="insert" aria-label="Insert PDF pages">Insert PDF…</button><input class="hidden" id="insert-file" type="file" accept="application/pdf,.pdf" multiple aria-label="Insert PDF files"><span class="organization-warning">Full single-source reordering retains the source catalog. Extraction, deletion and merging may omit bookmarks/forms/attachments/layers; use copies.</span></div><div id="error" class="notice hidden" role="alert"></div><main class="workspace"><aside class="sidebar"><h2>Pages</h2><div id="thumbnails"></div></aside><section class="stage" aria-label="PDF viewport"><div id="empty" class="empty"><div class="icon" aria-hidden="true">▧</div><span class="eyebrow">A clearer view of your drawings</span><h1>Your next drawing starts here.</h1><p>Open a PDF from your computer to review pages, search text, and rotate sheets. Save a new PDF when you're ready.</p><button id="empty-open" class="primary">Open your first PDF</button><p>Files stay local. Recovery storage is optional.<br>Early foundation preview · Page rotation editing</p></div><div id="page" class="pagewrap"></div></section><aside class="details"><h2>Document information</h2><span class="badge">LOCAL WORKSPACE</span><h3 id="document-name">No drawing open</h3><p id="document-info">Choose a PDF to inspect its pages.</p><section aria-label="Workspace exports"><h3>Reports and takeoff export</h3><button id="report-csv">Export markup CSV</button><button id="report-pdf">Export markup PDF</button><button id="punch-csv">Export punch list CSV</button><button id="takeoff-xlsx">Export takeoff XLSX</button><button id="takeoff-csv">Export takeoff CSV</button><button id="takeoff-json">Export takeoff JSON</button><button id="takeoff-pdf">Export PDF with measurement annotations</button><button id="takeoff-legend">Export PDF with takeoff legend</button><button id="quantity-link">Update linked Excel workbook…</button><input class="hidden" id="quantity-link-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Excel workbook to link"><p>Reports include authored markups only. Takeoff JSON preserves the reviewed scale and measurement model. Save PDF does not embed measurements; the measurement-annotation export writes a copy with standard PDF dimension annotations (angles and counts are omitted).</p></section><section id="collab-tools" aria-label="Collaboration"></section><section id="assistant-tools" aria-label="Sheet index assistant"></section><section id="measurement-tools" aria-label="Measurements and takeoff"></section><section id="markup-tools" aria-label="Markup tools"></section><section id="ocr-tools" aria-label="Text recognition"></section><section id="form-tools" aria-label="Form fields"></section><section id="signature-tools" aria-label="Digital signature"></section><section id="redaction-tools" aria-label="Redaction"></section><section id="navigation" aria-label="Document navigation"></section><h3>Extracted page text</h3><pre id="text">Text from the current page appears here.</pre><h3>About this preview</h3><p>Save creates a copy with your page edits. Extraction, deletion and merging retain primary-source Info/XMP but may omit other document structures. Opt-in local recovery restores current documents; undo history is session-only. Existing source-text editing is not available. Measurement quantities require reviewed calibration and independent verification. Markup undo is session-only; retained PDFs restore the current editable markup list; undo history restarts on restore. Printing rasterizes pages at up to 200 dpi (at least 100 dpi) and supports up to 300 pages.</p></aside></main><footer class="status"><span id="status" role="status">Ready to open a drawing</span><span>OpenDraft ${__OPENDRAFT_VERSION__}</span></footer>`;
// Side-panel sections are collapsible (open by default) so a long panel stays navigable.
for (const section of Array.from(app.querySelectorAll<HTMLElement>(".details > section[aria-label]"))) {
  const panel = document.createElement("details");
  panel.open = true;
  panel.className = "panel-section";
  const summary = document.createElement("summary");
  summary.textContent = section.getAttribute("aria-label");
  section.before(panel);
  panel.append(summary, section);
}
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const active = () => drawings.find((d) => d.id === activeId);
const message = (text: string) => {
  el("status").textContent = text;
};
function error(text: string) {
  el("error").textContent = text;
  el("error").classList.toggle("hidden", !text);
}
function controls() {
  const d = active();
  for (const id of [
    "previous",
    "next",
    "zoom-out",
    "zoom-in",
    "rotate",
    "find",
    "save",
    "report-csv",
    "report-pdf",
    "punch-csv",
    "takeoff-json",
    "takeoff-csv",
    "takeoff-xlsx",
    "takeoff-pdf",
    "takeoff-legend",
    "quantity-link",
    "flatten",
    "print",
    "undo",
    "redo",
    "earlier",
    "later",
    "delete",
    "extract",
    "insert",
    "slip-review",
  ])
    el<HTMLButtonElement>(id).disabled = !d || !!d.busy;
  el<HTMLInputElement>("search").disabled = !d;
  if (d) {
    el<HTMLButtonElement>("undo").disabled = d.busy || !d.history.canUndo;
    el<HTMLButtonElement>("redo").disabled = d.busy || !d.history.canRedo;
    el<HTMLButtonElement>("earlier").disabled = d.busy || d.page === 1;
    el<HTMLButtonElement>("later").disabled =
      d.busy || d.page === d.pdf.numPages;
    el<HTMLButtonElement>("delete").disabled = d.busy || d.pdf.numPages === 1;
    el<HTMLButtonElement>("previous").disabled = d.busy || d.page === 1;
    el<HTMLButtonElement>("next").disabled =
      d.busy || d.page === d.pdf.numPages;
    el("page-label").textContent = `${d.page} / ${d.pdf.numPages}`;
    el("zoom-label").textContent = `${Math.round(d.zoom * 100)}%`;
  } else {
    el("page-label").textContent = "No document";
    el("zoom-label").textContent = "100%";
  }
  markupTools?.refresh();
  measurementTools?.refresh();
}
function tabs() {
  el("tabs").replaceChildren();
  for (const d of drawings) {
    const wrap = document.createElement("div");
    wrap.className = `tab ${d.id === activeId ? "active" : ""}`;
    const tab = document.createElement("button");
    tab.textContent = d.name + (d.history.canUndo ? " •" : "");
    tab.setAttribute("aria-label", `View ${d.name}`);
    tab.setAttribute("aria-pressed", String(d.id === activeId));
    tab.onclick = () => {
      activeId = d.id;
      void show();
    };
    const close = document.createElement("button");
    close.textContent = "×";
    close.className = "close";
    close.setAttribute("aria-label", `Close ${d.name}`);
    close.onclick = () => {
      drawings.splice(drawings.indexOf(d), 1);
      if (activeId === d.id) activeId = drawings.at(-1)?.id ?? 0;
      void show();
      void d.destroy();
    };
    wrap.append(tab, close);
    el("tabs").append(wrap);
  }
}
async function pageText(d: Drawing, n: number) {
  if (!d.text.has(n)) {
    const page = await d.pdf.getPage(n);
    const content = await page.getTextContent();
    d.text.set(
      n,
      content.items
        .map((item) =>
          "str" in item
            ? item.str + ("hasEOL" in item && item.hasEOL ? "\n" : " ")
            : "",
        )
        .join(""),
    );
  }
  return d.text.get(n)!;
}
async function show() {
  redaction?.refresh();
  forms?.refresh();
  measurementTools?.cancelPicking("Page view changed. Unfinished point capture was cancelled.");
  queueRecovery();
  error("");
  const token = ++generation;
  ++searchGeneration;
  renderTask?.cancel();
  renderTask = undefined;
  const previousPage = shownPage;
  shownPage = undefined;
  void Promise.resolve().then(() => previousPage?.cleanup());
  textLayer?.cancel();
  textLayer = undefined;
  tabs();
  controls();
  // Release large canvas backing stores now rather than at the next garbage collection.
  for (const canvas of el("page").querySelectorAll("canvas")) { canvas.width = 0; canvas.height = 0; }
  el("page").replaceChildren();
  el("thumbnails").replaceChildren();
  el("navigation").replaceChildren();
  el("search-status").textContent = "";
  const d = active();
  el("empty").classList.toggle("hidden", !!d);
  if (!d) {
    el("text").textContent = "Text from the current page appears here.";
    el("document-name").textContent = "No drawing open";
    el("document-info").textContent = "Choose a PDF to inspect its pages.";
    message("Ready to open a drawing");
    return;
  }
  el("document-name").textContent = d.name;
  el("document-info").textContent =
    `${d.pdf.numPages} pages · ${(d.bytes.length / 1024).toFixed(1)} KB · ${d.history.canUndo ? "Edited copy" : "Original view"}`;
  el("text").textContent = "Extracting text…";
  void mountNavigation(el("navigation"), d.pdf, {
    navigate: (n) => {
      d.page = n;
      void show();
    },
    layersChanged: (config) => {
      d.optionalContentConfig = config;
      void show();
    },
    isCurrent: () => token === generation,
  });
  message(`Rendering page ${d.page}…`);
  try {
    const page = await d.pdf.getPage(d.page);
    if (token !== generation) return;
    shownPage = page;
    d.pageGeometry = {
      pageIndex: d.page - 1,
      bounds: [page.view[0], page.view[1], page.view[2], page.view[3]],
    };
    measurementTools?.refresh();
    const rotation = normalizeRotation(
      page.rotate + (d.rotations.get(d.page) ?? 0),
    );
    const viewport = page.getViewport({ scale: d.zoom, rotation });
    const canvas = document.createElement("canvas");
    canvas.dataset.testid = "pdf-canvas";
    canvas.setAttribute("aria-label", `PDF page ${d.page}`);
    canvas.setAttribute("role", "img");
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (viewport.width * viewport.height * ratio * ratio > 32_000_000)
      throw new Error(
        "This page exceeds the preview canvas limit at this zoom. Zoom out to view it.",
      );
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const frame = document.createElement("div");
    frame.className = "pdf-page-frame";
    frame.style.width = `${viewport.width}px`;
    frame.style.height = `${viewport.height}px`;
    frame.append(canvas);
    el("page").append(frame);
    markupTools?.mountPage(frame, viewport, d.page - 1);
    measurementTools?.mountPage(frame, viewport, d.page - 1);
    renderTask = page.render({
      canvas,
      viewport,
      optionalContentConfigPromise: d.optionalContentConfig
        ? Promise.resolve(d.optionalContentConfig)
        : undefined,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    });
    await renderTask.promise;
    if (token !== generation) return;
    // Snapping uses only geometry on visible layers, with the same layer state as the render.
    void Promise.all([
      page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE }),
      d.optionalContentConfig ? Promise.resolve(d.optionalContentConfig) : d.pdf.getOptionalContentConfig(),
    ])
      .then(([list, layers]) => {
        if (token === generation)
          measurementTools?.setDrawingVertices(frame, d.page - 1, extractDrawingVertices(list, undefined, (properties) => layers.isVisible(properties as Parameters<typeof layers.isVisible>[0])));
      })
      .catch(() => undefined);
    const layer = document.createElement("div");
    layer.className = "textLayer";
    layer.dataset.testid = "pdf-text-layer";
    layer.setAttribute("aria-label", `Selectable text for page ${d.page}`);
    layer.style.setProperty(
      "--total-scale-factor",
      String(viewport.scale * page.userUnit),
    );
    const textContent = await page.getTextContent();
    if (token !== generation) return;
    frame.append(layer);
    textLayer = new pdfjs.TextLayer({
      textContentSource: textContent,
      container: layer,
      viewport,
    });
    await textLayer.render();
    if (token !== generation) return;
    const links = document.createElement("div");
    links.dataset.testid = "pdf-links";
    frame.append(links);
    void mountPageLinks(
      links,
      d.pdf,
      page,
      viewport,
      (n) => {
        d.page = n;
        void show();
      },
      () => token === generation,
    );
    message(`Page ${d.page} of ${d.pdf.numPages} · ${d.name}`);
    const extracted = await pageText(d, d.page);
    if (token !== generation) return;
    el("text").textContent = extracted || "No extractable text on this page.";
    void thumbnails(d, token);
  } catch (e) {
    if (
      token === generation &&
      !(e instanceof Error && e.name === "RenderingCancelledException")
    ) {
      error(
        `Unable to render page: ${e instanceof Error ? e.message : String(e)}`,
      );
      message("Rendering failed");
    }
  }
}
async function thumbnails(d: Drawing, token: number) {
  const key = JSON.stringify([...d.rotations].sort());
  if (!d.thumbs || d.thumbs.pdf !== d.pdf || d.thumbs.key !== key) d.thumbs = { pdf: d.pdf, key, nodes: [] };
  const cache = d.thumbs;
  for (const [index, node] of cache.nodes.entries()) {
    node.setAttribute("aria-current", String(index + 1 === d.page));
    el("thumbnails").append(node);
  }
  try {
    for (let n = cache.nodes.length + 1; n <= d.pdf.numPages; n++) {
      if (token !== generation || d.thumbs !== cache) return;
      const button = document.createElement("button");
      button.className = "thumbnail";
      button.setAttribute("aria-label", `Go to page ${n}`);
      button.setAttribute("aria-current", String(n === d.page));
      button.onclick = () => {
        d.page = n;
        void show();
      };
      const label = document.createElement("span");
      label.textContent = `Page ${n}`;
      button.append(label);
      el("thumbnails").append(button);
      const page = await d.pdf.getPage(n);
      if (token !== generation || d.thumbs !== cache) { button.remove(); return; }
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: 130 / Math.max(original.width, original.height),
        rotation: normalizeRotation(page.rotate + (d.rotations.get(n) ?? 0)),
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({
        canvas,
        viewport,
        optionalContentConfigPromise: d.optionalContentConfig
          ? Promise.resolve(d.optionalContentConfig)
          : undefined,
      }).promise;
      if (n !== d.page) page.cleanup();
      if (d.thumbs !== cache) return;
      button.prepend(canvas);
      cache.nodes.push(button);
      if (token !== generation) return;
    }
  } catch (e) {
    if (token === generation)
      message("Page opened; some thumbnails could not be rendered.");
  }
}
const picker = el<HTMLInputElement>("file");
el("open").onclick = el("empty-open").onclick = () => picker.click();
picker.onchange = () => {
  const files = Array.from(picker.files ?? []);
  picker.value = "";
  return openFiles(files);
};
async function openFiles(files: readonly File[], initialMarkups: readonly Markup[] = []) {
  error("");
  for (const file of files) {
    let loading: ReturnType<typeof pdfjs.getDocument> | undefined;
    try {
      if (file.size > 250 * 1024 * 1024)
        throw new Error("The preview currently supports files up to 250 MB.");
      const source = new Uint8Array(await file.arrayBuffer());
      const sourceId = String(nextId);
      // Tabs opened with markups (annotation import) display the source with those markups applied,
      // exactly as an edit would, so they render and save before the first change.
      let bytes: Uint8Array = source;
      if (initialMarkups.length) {
        const pageCount = (await PDFDocument.load(source, { updateMetadata: false })).getPageCount();
        bytes = await materializeWorkspace(new Map([[sourceId, source.slice()]]), Array.from({ length: pageCount }, (_, pageIndex) => ({ sourceId, pageIndex, rotation: 0 })), initialMarkups, false, []);
      }
      loading = pdfjs.getDocument({ ...pdfResources, data: bytes.slice(), enableXfa: false });
      const pdf = await loading.promise;
      const d: Drawing = {
        id: nextId++,
        name: file.name,
        bytes,
        pdf,
        page: 1,
        zoom: 1,
        rotations: new Map(),
        text: new Map(),
        destroy: () => loading!.destroy(),
        sources: new Map([[sourceId, source.slice()]]),
        history: new WorkspaceHistory(
          Array.from({ length: pdf.numPages }, (_, pageIndex) => ({
            sourceId,
            pageIndex,
            rotation: 0,
          })),
          initialMarkups,
        ),
        busy: false,
      };
      drawings.push(d);
      activeId = d.id;
      await show();
    } catch (e) {
      await loading?.destroy();
      error(
        `Could not open ${file.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
      message("Unable to open PDF");
    }
  }
}
// Desktop only: PDFs passed on the command line ("Open with", file association) are offered by
// the local host as one-time same-origin downloads; the web build never sets this hash.
if (location.hash === "#launch") {
  history.replaceState(null, "", location.pathname);
  void (async () => {
    try {
      const list: { token: string; name: string }[] = await (await fetch("/__launch/list")).json();
      const files: File[] = [];
      for (const item of list) {
        const response = await fetch(`/__launch/${encodeURIComponent(item.token)}`);
        if (response.ok) files.push(new File([await response.blob()], item.name, { type: "application/pdf" }));
      }
      await openFiles(files);
    } catch {
      error("Could not open the files passed to OpenDraft.");
    }
  })();
}
// Other tools' markups open as editable OpenDraft markups in a new tab; the original tab is untouched.
el("import-annotations").onclick = async () => {
  const d = active();
  if (!d) return;
  const button = el<HTMLButtonElement>("import-annotations");
  button.disabled = true;
  error("");
  try {
    const result = await importForeignAnnotations(d.bytes);
    const notes = result.skipped.length ? ` ${result.skipped.length} item(s) left unchanged: ${[...new Set(result.skipped.map(item => item.reason))].join(" ")}` : "";
    if (!result.markups.length) { message(`No importable annotations found in ${d.name}.${notes}`); return; }
    await openFiles([new File([result.bytes.slice().buffer as ArrayBuffer], d.name.replace(/\.pdf$/i, "") + " (editable markups).pdf", { type: "application/pdf" })], result.markups);
    message(`Imported ${result.markups.length} annotation(s) as editable markups in a new tab.${notes}`);
  } catch (e) {
    error(`Could not import annotations: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    button.disabled = false;
  }
};
el("previous").onclick = () => {
  const d = active();
  if (d && d.page > 1) {
    d.page--;
    void show();
  }
};
el("next").onclick = () => {
  const d = active();
  if (d && d.page < d.pdf.numPages) {
    d.page++;
    void show();
  }
};
el("zoom-in").onclick = () => {
  const d = active();
  if (d) {
    d.zoom = Math.min(3, Math.round((d.zoom + 0.25) * 100) / 100);
    void show();
  }
};
el("zoom-out").onclick = () => {
  const d = active();
  if (d) {
    d.zoom = Math.max(0.25, Math.round((d.zoom - 0.25) * 100) / 100);
    void show();
  }
};
function remapMarkups(d: Drawing, pages: readonly PageRef[]): Markup[] {
  const before = d.history.pages;
  return d.history.markups.flatMap((mark) => {
    const source = before[mark.pageIndex];
    const pageIndex = pages.findIndex(
      (page) =>
        page.sourceId === source.sourceId &&
        page.pageIndex === source.pageIndex,
    );
    return pageIndex < 0 ? [] : [{ ...mark, pageIndex }];
  });
}
function remapTakeoff(d: Drawing, pages: readonly PageRef[]): TakeoffState {
  const before = d.history.pages;
  const nextIndex = (oldIndex: number) => {
    const source = before[oldIndex];
    return pages.findIndex(
      (page) =>
        page.sourceId === source.sourceId &&
        page.pageIndex === source.pageIndex,
    );
  };
  const original = d.history.takeoff;
  return {
    scales: original.scales.flatMap((scale) => {
      const pageIndex = nextIndex(scale.pageIndex);
      return pageIndex < 0 ? [] : [{ ...scale, pageIndex }];
    }),
    records: original.records.flatMap((record) => {
      const pageIndex = nextIndex(record.pageIndex);
      return pageIndex < 0 ? [] : [{ ...record, pageIndex }];
    }),
  };
}
async function applyEdit(
  d: Drawing,
  pages: readonly PageRef[],
  action: "commit" | "undo" | "redo" = "commit",
  markups: readonly Markup[] = remapMarkups(d, pages),
  takeoff: TakeoffState = remapTakeoff(d, pages),
  layers: readonly MarkupLayer[] = d.history.layers,
  revisions: readonly RevisionEntry[] = d.history.revisions,
  remote = false,
): Promise<boolean> {
  if (d.busy) return false;
  if (collab?.drawing === d && !remote) {
    if (collab.session.readOnly) { error("Viewer role: editing is disabled in this collaboration project."); return false; }
    if (JSON.stringify(pages) !== collab.pages) { error("Leave the collaboration project before reorganizing pages."); return false; }
  }
  d.busy = true;
  controls();
  error("");
  let loading: ReturnType<typeof pdfjs.getDocument> | undefined;
  try {
    const canonicalTakeoff = validateTakeoff(takeoff, pages.length);
    const unchangedPdf =
      JSON.stringify(pages) === JSON.stringify(d.history.pages) &&
      JSON.stringify(markups) === JSON.stringify(d.history.markups) &&
      JSON.stringify(layers) === JSON.stringify(d.history.layers);
    if (unchangedPdf) {
      if (action === "commit")
        d.history.commit(pages, markups, canonicalTakeoff, layers, revisions);
      else if (action === "undo") d.history.undo();
      else d.history.redo();
      d.takeoffView = d.history.takeoff;
      if (active() === d) await show();
      if (collab?.drawing === d && !remote) void collab.session.localChanged();
      return true;
    }
    const bytes = await materializeWorkspace(d.sources, pages, markups, false, layers);
    loading = pdfjs.getDocument({ ...pdfResources, data: bytes.slice(), enableXfa: false });
    const pdf = await loading.promise;
    if (!drawings.includes(d)) {
      await loading.destroy();
      return false;
    }
    const oldDestroy = d.destroy;
    if (action === "commit") d.history.commit(pages, markups, canonicalTakeoff, layers, revisions);
    else if (action === "undo") d.history.undo();
    else d.history.redo();
    d.takeoffView = d.history.takeoff;
    d.bytes = bytes;
    d.pdf = pdf;
    d.optionalContentConfig = undefined;
    d.pageGeometry = undefined;
    d.destroy = () => loading!.destroy();
    d.text.clear();
    d.rotations.clear();
    d.page = Math.min(d.page, pdf.numPages);
    if (active() === d) await show();
    void oldDestroy().catch(() => {});
    if (collab?.drawing === d && !remote) void collab.session.localChanged();
    return true;
  } catch (e) {
    await loading?.destroy().catch(() => {});
    error(`Could not edit PDF: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    d.busy = false;
    controls();
  }
}
markupTools = new MarkupTools(el("markup-tools"), {
  getState: () => {
    const d = active();
    return d
      ? { pageIndex: d.page - 1, pageCount: d.pdf.numPages, markups: d.history.markups, layers: d.history.layers, busy: d.busy }
      : undefined;
  },
  commit: async (marks, layers) => {
    const d = active();
    if (!d || !(await applyEdit(d, d.history.pages, "commit", marks, d.history.takeoff, layers ?? d.history.layers))) {
      throw new Error(
        el("error").textContent || "The markup edit was not committed.",
      );
    }
  },
  error: (message) => error(message),
});
let collabSession: CollabSession | undefined;
void mountCollaboration(el("collab-tools"), {
  presets: { library: () => markupTools!.palette.library(), merge: (text) => markupTools!.palette.mergeShared(text) },
  host: {
    local: () => {
      const d = collab?.drawing ?? active();
      return d && drawings.includes(d) ? { markups: d.history.markups, layers: d.history.layers, takeoff: d.history.takeoff } : undefined;
    },
    install: async (state) => {
      const d = collab?.drawing ?? active();
      if (!d) return false;
      for (let attempt = 0; d.busy && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
      return applyEdit(d, d.history.pages, "commit", state.markups, state.takeoff, state.layers, d.history.revisions, true);
    },
    changed: () => {},
  },
  binding: async () => {
    const d = active();
    if (!d) throw new Error("Open the project PDF first.");
    const pages = d.history.pages;
    if (d.sources.size !== 1 || pages.some((page, index) => page.pageIndex !== index || page.replacement || page.inserted) || pages.length !== d.pdf.numPages)
      throw new Error("Collaboration requires a single unmodified source PDF page order.");
    const source = [...d.sources.values()][0];
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source.slice()));
    return { documentSha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""), pageCount: pages.length, name: d.name.replace(/\.pdf$/i, "") };
  },
  joined: (session) => {
    const d = active();
    collab = session && d ? { session, drawing: d, pages: JSON.stringify(d.history.pages) } : undefined;
  },
  error: (message) => error(message),
}).then((session) => { collabSession = session; });
mountOcr(el("ocr-tools"), {
  document: () => { const d = active(); return d ? { name: d.name, bytes: d.bytes, pdf: d.pdf, pageIndex: d.page - 1 } : undefined; },
  open: async (bytes, name) => { await openFiles([new File([bytes.slice().buffer as ArrayBuffer], name, { type: "application/pdf" })]); },
  error: (text) => error(text),
});
forms = mountForms(el("form-tools"), {
  document: () => { const d = active(); return d ? { name: d.name, bytes: d.bytes, pageIndex: d.page - 1 } : undefined; },
  showDesigned: async (bytes, name) => {
    // Re-adding to a form-design tab replaces it, so designing several fields keeps one tab.
    const previous = active(), page = previous?.page ?? 1;
    await openFiles([new File([bytes.slice().buffer as ArrayBuffer], name, { type: "application/pdf" })]);
    const opened = active();
    if (previous && previous !== opened && previous.name === name) {
      drawings.splice(drawings.indexOf(previous), 1);
      void previous.destroy();
    }
    if (opened) { opened.page = Math.min(page, opened.pdf.numPages); await show(); }
  },
  download: (bytes, name) => download(bytes, name),
  error: (text) => error(text),
});
mountSignatures(el("signature-tools"), {
  document: () => { const d = active(); return d ? { name: d.name, bytes: d.bytes, pageIndex: d.page - 1 } : undefined; },
  token: () => collabSession?.token,
  download: (bytes, name) => download(bytes, name),
  error: (text) => error(text),
});
redaction = mountRedaction(el("redaction-tools"), {
  document: () => { const d = active(); return d ? { name: d.name, bytes: d.bytes, pdf: d.pdf, pageIndex: d.page - 1 } : undefined; },
  download: (bytes, name) => download(bytes, name),
  error: (text) => error(text),
});
mountAssistant(el("assistant-tools"), {
  document: () => { const d = active(); return d ? { name: d.name, bytes: d.bytes, pageCount: d.pdf.numPages } : undefined; },
  pageTexts: async () => {
    const d = active();
    if (!d) return [];
    const pages = [];
    for (let n = 1; n <= Math.min(d.pdf.numPages, 500); n++) pages.push({ pageIndex: n - 1, text: await pageText(d, n) });
    return pages;
  },
  pageRuns: async () => {
    const d = active();
    if (!d) return [];
    const pages = [];
    for (let n = 1; n <= Math.min(d.pdf.numPages, 500); n++) {
      const content = await (await d.pdf.getPage(n)).getTextContent();
      const runs = content.items.flatMap(item => {
        if (!("str" in item) || !item.str.trim()) return [];
        const [a, b, c, dd, e, f] = item.transform, height = Math.hypot(c, dd) || Math.hypot(a, b), width = item.width || height * item.str.length * 0.6;
        const angle = Math.atan2(b, a), cos = Math.cos(angle), sin = Math.sin(angle);
        const corners = [[0, -height * 0.2], [width, -height * 0.2], [width, height], [0, height]].map(([x, y]) => [e + x * cos - y * sin, f + x * sin + y * cos]);
        const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
        return [{ str: item.str, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number] }];
      });
      pages.push({ pageIndex: n - 1, runs });
    }
    return pages;
  },
  token: () => collabSession?.token,
  download: (bytes, name, type) => download(bytes, name, type),
  error: (message) => error(message),
});
setInterval(() => {
  if (collab && drawings.includes(collab.drawing)) void collab.session.reportPresence(collab.drawing.page);
}, 10_000);
measurementTools = new MeasurementTools(el("measurement-tools"), {
  getState: () => {
    const d = active();
    return d && d.pageGeometry?.pageIndex === d.page - 1
      ? {
          pageIndex: d.page - 1,
          pageBounds: d.pageGeometry.bounds,
          busy: d.busy,
          takeoff: d.takeoffView ?? (d.takeoffView = d.history.takeoff),
        }
      : undefined;
  },
  commit: async (takeoff) => {
    const d = active();
    if (
      !d ||
      !(await applyEdit(
        d,
        d.history.pages,
        "commit",
        d.history.markups,
        takeoff,
      ))
    ) {
      throw new Error(
        el("error").textContent || "The takeoff edit was not committed.",
      );
    }
  },
  error: (message) => error(message),
});
function download(bytes: Uint8Array, name: string, mime = "application/pdf") {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: mime }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
el("rotate").onclick = () => {
  const d = active();
  if (d) {
    const pages = d.history.pages.map((p) => ({ ...p }));
    pages[d.page - 1].rotation = normalizeRotation(
      pages[d.page - 1].rotation + 90,
    );
    void applyEdit(d, pages);
  }
};
el("earlier").onclick = () => {
  const d = active();
  if (d && d.page > 1) {
    const pages = d.history.pages.map((p) => ({ ...p }));
    [pages[d.page - 2], pages[d.page - 1]] = [
      pages[d.page - 1],
      pages[d.page - 2],
    ];
    d.page--;
    void applyEdit(d, pages);
  }
};
el("later").onclick = () => {
  const d = active();
  if (d && d.page < d.pdf.numPages) {
    const pages = d.history.pages.map((p) => ({ ...p }));
    [pages[d.page - 1], pages[d.page]] = [pages[d.page], pages[d.page - 1]];
    d.page++;
    void applyEdit(d, pages);
  }
};
el("delete").onclick = () => {
  const d = active();
  if (d && d.pdf.numPages > 1) {
    const pages = d.history.pages.map((p) => ({ ...p }));
    pages.splice(d.page - 1, 1);
    void applyEdit(d, pages);
  }
};
el("undo").onclick = () => {
  const d = active();
  if (d && d.history.canUndo) {
    d.history.undo();
    const pages = d.history.pages,
      markups = d.history.markups,
      takeoff = d.history.takeoff,
      layers = d.history.layers;
    d.history.redo();
    void applyEdit(d, pages, "undo", markups, takeoff, layers);
  }
};
el("redo").onclick = () => {
  const d = active();
  if (d && d.history.canRedo) {
    d.history.redo();
    const pages = d.history.pages,
      markups = d.history.markups,
      takeoff = d.history.takeoff,
      layers = d.history.layers;
    d.history.undo();
    void applyEdit(d, pages, "redo", markups, takeoff, layers);
  }
};
el("extract").onclick = async () => {
  const d = active();
  if (!d || d.busy) return;
  d.busy = true;
  controls();
  try {
    download(
      await materializeWorkspace(
        d.sources,
        [d.history.pages[d.page - 1]],
        d.history.markups
          .filter((mark) => mark.pageIndex === d.page - 1)
          .map((mark) => ({ ...mark, pageIndex: 0 })),
        false,
        d.history.layers,
      ),
      `opendraft-page-${d.page}-${d.name}`,
    );
    message(`Extracted page ${d.page}`);
  } catch (e) {
    error(
      `Could not extract PDF: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    d.busy = false;
    controls();
  }
};
const insertPicker = el<HTMLInputElement>("insert-file");
el("insert").onclick = () => insertPicker.click();
insertPicker.onchange = async () => {
  const d = active();
  const files = Array.from(insertPicker.files ?? []);
  insertPicker.value = "";
  if (!d || d.busy || !files.length) return;
  d.busy = true;
  controls();
  const added: string[] = [];
  let pending: ReturnType<typeof pdfjs.getDocument> | undefined;
  try {
    const inserted: PageRef[] = [];
    for (const file of files) {
      if (file.size > 250 * 1024 * 1024)
        throw new Error("The preview currently supports files up to 250 MB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      pending = pdfjs.getDocument({ ...pdfResources, data: bytes.slice(), enableXfa: false });
      const pdf = await pending.promise;
      const sourceId = `insert-${nextId++}`;
      d.sources.set(sourceId, bytes);
      added.push(sourceId);
      for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++)
        inserted.push({ sourceId, pageIndex, rotation: 0 });
      await pending.destroy();
      pending = undefined;
    }
    const pages = d.history.pages.map((p) => ({ ...p }));
    pages.splice(d.page, 0, ...inserted);
    d.busy = false;
    await applyEdit(d, pages);
  } catch (e) {
    await pending?.destroy();
    for (const id of added) d.sources.delete(id);
    error(
      `Could not insert PDF: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    d.busy = false;
    controls();
  }
};
let lastQuery = "",
  lastMatch = 0;
async function search() {
  const d = active(),
    query = el<HTMLInputElement>("search").value.trim().toLocaleLowerCase();
  if (!d || !query) return;
  const token = ++searchGeneration;
  el("search-status").textContent = "Searching…";
  try {
    const start = query === lastQuery ? lastMatch : d.page - 1;
    for (let offset = 1; offset <= d.pdf.numPages; offset++) {
      const n = ((start + offset - 1) % d.pdf.numPages) + 1;
      const text = await pageText(d, n);
      if (token !== searchGeneration || d !== active()) return;
      if (text.toLocaleLowerCase().includes(query)) {
        lastQuery = query;
        lastMatch = n;
        d.page = n;
        await show();
        el("search-status").textContent = `Match on page ${n}`;
        return;
      }
    }
    if (token === searchGeneration)
      el("search-status").textContent = "No matches";
  } catch (e) {
    if (token === searchGeneration) error("Search failed for this document.");
  }
}
el("find").onclick = () => void search();
el("search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") void search();
});
el("save").onclick = async () => {
  const d = active();
  if (!d || d.busy) return;
  d.busy = true;
  controls();
  error("");
  try {
    download(d.bytes, `opendraft-${d.name}`);
    message(`Saved copy of ${d.name}`);
  } catch (e) {
    error(`Could not save PDF: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    d.busy = false;
    controls();
  }
};
el("flatten").onclick = async () => {
  const d = active();
  if (!d || d.busy) return;
  d.busy = true;
  controls();
  error("");
  try {
    download(
      await materializeWorkspace(
        d.sources,
        d.history.pages,
        d.history.markups,
        true,
        d.history.layers,
      ),
      `opendraft-flat-${d.name}`,
    );
    message(
      "Exported copy with OpenDraft markups flattened. Other source annotations may remain.",
    );
  } catch (e) {
    error(
      `Could not flatten PDF: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    d.busy = false;
    controls();
  }
};
async function exportWorkspaceReport(kind: "csv" | "punch" | "pdf" | "takeoff" | "takeoff-csv" | "takeoff-xlsx" | "takeoff-pdf" | "takeoff-legend") {
  const d = active();
  if (!d || d.busy) return;
  d.busy = true;
  controls();
  error("");
  const basename = d.name.replace(/\.pdf$/i, "");
  try {
    if (kind === "punch") {
      download(new TextEncoder().encode(punchListCsv(d.name, d.pdf.numPages, d.history.markups)), `${basename}-punch-list.csv`, "text/csv;charset=utf-8");
      message("Exported the punch list of open markups.");
      return;
    }
    if (kind === "csv")
      download(
        new TextEncoder().encode(
          markupCsv(d.name, d.pdf.numPages, d.history.markups, d.history.layers),
        ),
        `${basename}-markups.csv`,
        "text/csv;charset=utf-8",
      );
    else if (kind === "pdf")
      download(
        await markupPdf(d.name, d.pdf.numPages, d.history.markups, d.history.layers),
        `${basename}-markups.pdf`,
      );
    else if (kind === "takeoff-legend") {
      // Legend for the current page's measurements, or the whole document when the page has none.
      const pageRows = legendRows(d.history.takeoff, d.pdf.numPages, [d.page - 1]);
      const rows = pageRows.length ? pageRows : legendRows(d.history.takeoff, d.pdf.numPages);
      download(await applyTakeoffLegend(d.bytes, rows, d.page - 1, undefined, pageRows.length ? `Takeoff legend - page ${d.page}` : "Takeoff legend - all pages"), `${basename}-legend.pdf`);
      message(`Exported copy with a ${rows.length}-row takeoff legend on page ${d.page}. The open document is unchanged.`);
      return;
    }
    else if (kind === "takeoff-pdf") {
      const result = await applyMeasurementAnnotations(d.bytes, d.history.takeoff);
      download(result.bytes, `${basename}-measured.pdf`);
      message(`Exported copy with ${result.written} measurement annotation(s)${result.skipped.length ? `; ${result.skipped.length} angle/count measurement(s) omitted` : ""}. The open document is unchanged.`);
      return;
    }
    else if (kind === "takeoff-xlsx")
      download(await takeoffXlsx(d.name, d.pdf.numPages, d.history.takeoff), `${basename}-takeoff.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    else if (kind === "takeoff-csv")
      download(new TextEncoder().encode(takeoffCsv(d.name, d.pdf.numPages, d.history.takeoff)), `${basename}-takeoff.csv`, "text/csv;charset=utf-8");
    else {
      const state = validateTakeoff(d.history.takeoff, d.pdf.numPages);
      const portable = {
        format: "opendraft-takeoff",
        version: 1,
        documentName: d.name,
        pageCount: d.pdf.numPages,
        coordinateSpace: "unrotated-pdf-user-space",
        takeoff: state,
      };
      download(
        new TextEncoder().encode(JSON.stringify(portable, null, 2)),
        `${basename}-takeoff.json`,
        "application/json",
      );
    }
    message(
      kind.startsWith("takeoff")
        ? "Exported takeoff model separately. Saved PDFs do not embed measurement data."
        : "Exported authored markup report. Source annotations are not included.",
    );
  } catch (e) {
    error(
      `Could not export report: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    d.busy = false;
    controls();
  }
}
el("report-csv").onclick = () => void exportWorkspaceReport("csv");
el("punch-csv").onclick = () => void exportWorkspaceReport("punch");
el("report-pdf").onclick = () => void exportWorkspaceReport("pdf");
el("takeoff-xlsx").onclick = () => void exportWorkspaceReport("takeoff-xlsx");
el("takeoff-csv").onclick = () => void exportWorkspaceReport("takeoff-csv");
el("takeoff-json").onclick = () => void exportWorkspaceReport("takeoff");
el("takeoff-pdf").onclick = () => void exportWorkspaceReport("takeoff-pdf");
el("takeoff-legend").onclick = () => void exportWorkspaceReport("takeoff-legend");
// Quantity link: refresh OpenDraft sheets inside the user's own workbook; their formulas read them.
const quantityLinkFile = el<HTMLInputElement>("quantity-link-file");
el("quantity-link").onclick = () => quantityLinkFile.click();
quantityLinkFile.onchange = async () => {
  const d = active(), file = quantityLinkFile.files?.[0];
  quantityLinkFile.value = "";
  if (!d || !file) return;
  error("");
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error("Workbooks larger than 50 MB are not supported.");
    const { linkIntoWorkbook, quantityLinkSheets } = await import("./quantity-link");
    const updated = linkIntoWorkbook(new Uint8Array(await file.arrayBuffer()), await quantityLinkSheets(d.name, d.pdf.numPages, d.history.takeoff));
    download(updated, file.name, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    message(`Updated "OpenDraft Summary" and "OpenDraft Takeoff" in ${file.name}; other sheets are unchanged and Excel recalculates on open.`);
  } catch (e) {
    error(`Could not update the workbook: ${e instanceof Error ? e.message : String(e)}`);
  }
};
window.addEventListener("beforeunload", (event) => {
  if (drawings.some((d) => d.history.canUndo)) {
    event.preventDefault();
  }
});
controls();

// Recovery is opt-in: retaining PDF bytes on a shared browser requires an explicit choice.
const recoveryBar = document.createElement("section");
recoveryBar.className = "recovery-bar";
recoveryBar.setAttribute("aria-label", "Local session recovery");
recoveryBar.innerHTML =
  '<label><input id="retain-session" type="checkbox"> Retain PDFs on this browser for recovery</label><span>Retained PDFs are stored without encryption.</span><button id="restore-session" class="hidden">Restore retained session</button><button id="clear-session">Delete retained session</button><span id="recovery-status" role="status">Checking local recovery…</span>';
el("error").before(recoveryBar);
const retain = el<HTMLInputElement>("retain-session");
const recoveryStatus = el("recovery-status");
let pendingSnapshot: RecoverySnapshot | null = null;
let recoveryReady = false;
let persistence: Promise<void> = Promise.resolve();
let persistTimer: ReturnType<typeof setTimeout> | undefined;
function queueRecovery() {
  if (!recoveryReady || !retain.checked) return;
  clearTimeout(persistTimer);
  recoveryStatus.textContent = "Recovery save pending…";
  persistTimer = setTimeout(() => {
    const snapshot: RecoverySnapshot = {
      version: 1,
      activeId: active() ? String(activeId) : "",
      documents: drawings.map((d) => ({
        id: String(d.id),
        name: d.name,
        bytes: d.bytes.slice(),
        page: d.page,
        zoom: d.zoom,
        rotations: [],
        workspace: {
          sources: Array.from(d.sources, ([id, bytes]) => ({
            id,
            bytes: bytes.slice(),
          })),
          pages: d.history.pages,
          markups: d.history.markups,
          takeoff: d.history.takeoff,
          layers: d.history.layers,
          revisions: d.history.revisions,
        },
      })),
    };
    persistence = persistence
      .then(() => saveRecovery(snapshot))
      .then(() => {
        recoveryStatus.textContent = "Recovery saved locally";
      })
      .catch((e) => {
        recoveryStatus.textContent = e instanceof Error ? e.message : String(e);
      });
  }, 200);
}
retain.onchange = () => {
  if (retain.checked) queueRecovery();
  else {
    clearTimeout(persistTimer);
    recoveryStatus.textContent =
      "Automatic recovery off. Use Delete retained session to remove stored PDFs.";
  }
};
el("clear-session").onclick = async () => {
  retain.checked = false;
  clearTimeout(persistTimer);
  retain.disabled = true;
  try {
    await persistence;
    await clearRecovery();
    pendingSnapshot = null;
    el("restore-session").classList.add("hidden");
    recoveryStatus.textContent = "Retained PDFs deleted. Recovery is off.";
  } catch (e) {
    recoveryStatus.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    retain.disabled = false;
  }
};
el("restore-session").onclick = async () => {
  if (!pendingSnapshot) return;
  const restore = el<HTMLButtonElement>("restore-session");
  restore.disabled = true;
  const restored: Drawing[] = [];
  try {
    for (const saved of pendingSnapshot.documents) {
      let recoveredBytes = saved.rotations.length
        ? await exportPdf(saved.bytes, new Map(saved.rotations))
        : saved.bytes.slice();
      // Rebuild replacement workspaces before installing them: schema validation
      // alone cannot prove donor page bounds or consistency with saved PDF bytes.
      if (saved.workspace?.pages.some(page => page.replacement !== undefined || page.inserted === true)) {
        recoveredBytes = await materializeWorkspace(
          new Map(saved.workspace.sources.map(source => [source.id, source.bytes])),
          saved.workspace.pages, saved.workspace.markups, false, saved.workspace.layers ?? [],
        );
      }
      const loading = pdfjs.getDocument({ ...pdfResources, data: recoveredBytes.slice(),
        enableXfa: false,
      });
      let pdf: PDFDocumentProxy;
      try {
        pdf = await loading.promise;
      } catch (e) {
        await loading.destroy();
        throw e;
      }
      const id = nextId++,
        sourceId = String(id);
      restored.push({
        id,
        name: saved.name,
        bytes: recoveredBytes,
        pdf,
        page: Math.min(saved.page, pdf.numPages),
        zoom: saved.zoom,
        rotations: new Map(),
        text: new Map(),
        destroy: () => loading.destroy(),
        sources: saved.workspace
          ? new Map(
              saved.workspace.sources.map((source) => [
                source.id,
                source.bytes.slice(),
              ]),
            )
          : new Map([[sourceId, recoveredBytes.slice()]]),
        history: saved.workspace
          ? new WorkspaceHistory(
              saved.workspace.pages,
              saved.workspace.markups,
              saved.workspace.takeoff ?? emptyTakeoff(),
              saved.workspace.layers ?? [],
              saved.workspace.revisions ?? [],
            )
          : new WorkspaceHistory(
              Array.from({ length: pdf.numPages }, (_, pageIndex) => ({
                sourceId,
                pageIndex,
                rotation: 0,
              })),
            ),
        busy: false,
      });
    }
    const selected = pendingSnapshot.documents.findIndex(
      (d) => d.id === pendingSnapshot!.activeId,
    );
    drawings.push(...restored);
    activeId = restored[selected]?.id ?? restored[0]?.id ?? activeId;
    pendingSnapshot = null;
    restore.classList.add("hidden");
    retain.disabled = false;
    retain.checked = true;
    await show();
  } catch (e) {
    for (const d of restored) await d.destroy();
    recoveryStatus.textContent = `Recovery restore failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    restore.disabled = false;
  }
};
void (async () => {
  retain.disabled = true;
  el<HTMLButtonElement>("open").disabled = true;
  el<HTMLButtonElement>("empty-open").disabled = true;
  try {
    const saved = await loadRecovery();
    if (saved?.documents.length) {
      pendingSnapshot = saved;
      el("restore-session").classList.remove("hidden");
      recoveryStatus.textContent = `${saved.documents.length} retained PDF(s). Restore or delete them before enabling recovery.`;
    } else
      recoveryStatus.textContent =
        "Recovery off. PDF bytes are retained only when you opt in.";
  } catch (e) {
    recoveryStatus.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    recoveryReady = true;
    retain.disabled = !!pendingSnapshot;
    el<HTMLButtonElement>("open").disabled = false;
    el<HTMLButtonElement>("empty-open").disabled = false;
  }
})();

el("print").onclick = async () => {
  const d = active();
  if (!d || d.busy) return;
  d.busy = true;
  controls();
  error("");
  let job: Awaited<ReturnType<typeof preparePrint>> | undefined;
  try {
    // Desktop: print the original PDF as vectors through the system dialog, unless layer visibility
    // was changed from the document's defaults (the original PDF would not reflect that); the raster path honours it.
    const layersChanged = !!d.optionalContentConfig && d.optionalContentConfig.getHash() !== (await d.pdf.getOptionalContentConfig()).getHash();
    if (!layersChanged && (await desktopCapabilities()).vectorPrint) {
      message("Opening the print dialog (vector)…");
      const response = await fetch("/__print", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: d.bytes.slice() });
      if (!response.ok) throw new Error(await response.text());
      message("Print dialog opened. Pages print as vectors at the printer's full resolution.");
      return;
    }
    message("Preparing rasterized print pages…");
    job = await preparePrint(d.pdf, d.optionalContentConfig);
    job.print();
    message(`Print dialog requested (${job.dpi} dpi image pages). For vector output use the desktop app, or Save PDF and print from a PDF reader.`);
  } catch (e) {
    error(`Could not print PDF: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    job?.dispose();
    d.busy = false;
    controls();
  }
};

const revisionComparison = mountRevisionComparison(
  () => drawings.map(d => ({id: String(d.id), name: d.name, bytes: d.bytes, pageCount: d.pdf.numPages, currentPage: d.page})),
  () => String(activeId),
  async (expected,marks) => {
    if(expected.some(source=>!drawings.some(d=>String(d.id)===source.id&&d.bytes===source.bytes&&d.pdf.numPages===source.pageCount&&!d.busy)))return false;
    const d=drawings.find(d=>String(d.id)===expected[0].id)!;
    const committed=await applyEdit(d,d.history.pages,'commit',[...d.history.markups,...marks],d.history.takeoff,d.history.layers,d.history.revisions);
    if(!committed)throw new Error(el('error').textContent||'Cloud annotations were not committed.');
    return true;
  },
);
el("compare").onclick = () => revisionComparison.open();

const batchComparison = mountBatchComparison(() => drawings.map(d => ({id: String(d.id), name: d.name, bytes: d.bytes})), () => String(activeId));
el("batch-compare").onclick = () => batchComparison.open();

function slipDocuments(): SlipDocument[] {
  return drawings.map(d => ({id: String(d.id), name: d.name, bytes: d.bytes, pages: d.history.pages, markups: d.history.markups, takeoff: d.history.takeoff, layers: d.history.layers, revisions: d.history.revisions, busy: d.busy}));
}
const slipReview = mountSlipReview(slipDocuments, () => String(activeId), async change => {
  const d = drawings.find(d => String(d.id) === change.expected.id), current = slipDocuments().find(d => d.id === change.expected.id);
  if (!d || !current || d.busy || d.bytes !== change.expected.bytes || slipStateKey(current) !== slipStateKey(change.expected) || d.sources.has(change.sourceId)) return false;
  d.sources.set(change.sourceId, change.sourceBytes.slice());
  const accepted = await applyEdit(d, change.pages, 'commit', change.markups, change.takeoff, d.history.layers, [...d.history.revisions, change.entry]);
  if (!accepted) { d.sources.delete(change.sourceId); throw new Error(el("error").textContent || "The replacement was not committed."); }
  return accepted;
});
el('slip-review').onclick = () => slipReview.open();

const revisionSet = mountRevisionSet();
el('revision-set').onclick = () => revisionSet.open();
