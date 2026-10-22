import { applySheetLinks, findSheetReferences, type TextRun } from './sheet-links';
import { applySheetBookmarks, proposeSheetIndexRules, sheetIndexCsv, validateAccepted, type SheetProposal } from './ai-sheet-index';

type Options = {
  document: () => { name: string; bytes: Uint8Array; pageCount: number } | undefined;
  pageTexts: () => Promise<{ pageIndex: number; text: string }[]>;
  pageRuns: () => Promise<{ pageIndex: number; runs: TextRun[] }[]>;
  token: () => string | undefined;
  download: (bytes: Uint8Array, name: string, type?: string) => void;
  error: (message: string) => void;
};

/**
 * Optional assistant. CPU rules run locally by default; a server model is used only when the
 * reviewer selects it. Proposals are never applied automatically, and accepting them only
 * produces exported copies — drawings, markups and measurements are never modified.
 */
export function mountAssistant(container: HTMLElement, options: Options) {
  container.innerHTML = '<h3>Sheet index assistant (optional)</h3><p>Suggests sheet numbers and titles from page text. Review every row; accepted rows are exported as a CSV or as bookmarks in a PDF copy. Suggestions never change drawings, markups or measurements.</p>';
  const engineRow = document.createElement('label'); engineRow.textContent = 'Suggestion engine';
  const engine = document.createElement('select'); engine.setAttribute('aria-label', 'Suggestion engine');
  const local = document.createElement('option'); local.value = 'rules'; local.textContent = 'Local rules (CPU, offline)'; engine.append(local);
  engineRow.append(engine); container.append(engineRow);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-label', 'Assistant status');
  const table = document.createElement('table'); table.setAttribute('aria-label', 'Sheet index proposals');
  let rows: { proposal: SheetProposal; accept: HTMLInputElement; number: HTMLInputElement; title: HTMLInputElement }[] = [];
  let reviewedFor: Uint8Array | undefined;
  const button = (label: string, run: () => Promise<void>) => { const item = document.createElement('button'); item.textContent = label; item.onclick = async () => { item.disabled = true; try { await run(); } catch (error) { const message = error instanceof Error ? error.message : String(error); status.textContent = message; options.error(message); } finally { item.disabled = false; } }; container.append(item); return item; };

  const checkModel = async () => {
    const token = options.token();
    if (!token || engine.querySelector('option[value="model"]')) return;
    const response = await fetch('/api/ai/status', { headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
    const data = response?.ok ? await response.json() : undefined;
    if (data?.available) { const option = document.createElement('option'); option.value = 'model'; option.textContent = `Server model: ${data.model} (sends page text to your server)`; engine.append(option); }
  };
  engine.onfocus = () => void checkModel();

  button('Propose sheet index', async () => {
    const doc = options.document(); if (!doc) throw new Error('Open a PDF first.');
    status.textContent = 'Reading page text…';
    const pages = await options.pageTexts();
    let proposals: SheetProposal[];
    if (engine.value === 'model') {
      const token = options.token(); if (!token) throw new Error('Sign in to the collaboration server to use its model.');
      const response = await fetch('/api/ai/sheet-index', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ pageCount: doc.pageCount, pages }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Model request failed.');
      proposals = data.sheets;
    } else proposals = proposeSheetIndexRules(pages);
    reviewedFor = doc.bytes;
    table.replaceChildren();
    const head = table.insertRow(); for (const label of ['Accept', 'Page', 'Sheet number', 'Sheet title', 'Confidence', 'Evidence']) { const cell = document.createElement('th'); cell.textContent = label; head.append(cell); }
    rows = proposals.map(proposal => {
      const row = table.insertRow();
      const input = (value: string, label: string, type = 'text') => { const field = document.createElement('input'); field.type = type; field.value = value; field.setAttribute('aria-label', label); row.insertCell().append(field); return field; };
      const accept = input('', `Accept sheet on page ${proposal.pageIndex + 1}`, 'checkbox');
      row.insertCell().textContent = String(proposal.pageIndex + 1);
      const number = input(proposal.number, `Sheet number for page ${proposal.pageIndex + 1}`), title = input(proposal.title, `Sheet title for page ${proposal.pageIndex + 1}`);
      row.insertCell().textContent = `${proposal.confidence} (${proposal.source})`;
      row.insertCell().textContent = proposal.evidence;
      return { proposal, accept, number, title };
    });
    status.textContent = `${proposals.length} suggestion(s) for ${pages.length} page(s). Nothing is accepted until you check rows.`;
  });
  button('Accept high-confidence suggestions', async () => { for (const row of rows) if (row.proposal.confidence === 'high') row.accept.checked = true; status.textContent = 'High-confidence rows checked. Review them before exporting.'; });
  const accepted = () => {
    const doc = options.document(); if (!doc) throw new Error('Open a PDF first.');
    if (doc.bytes !== reviewedFor) throw new Error('The document changed since these suggestions were made. Propose again.');
    const list = validateAccepted(rows.filter(row => row.accept.checked).map(row => ({ pageIndex: row.proposal.pageIndex, number: row.number.value, title: row.title.value })), doc.pageCount);
    if (!list.length) throw new Error('Accept at least one row first.');
    return { doc, list };
  };
  button('Export reviewed sheet index CSV', async () => { const { doc, list } = accepted(); options.download(new TextEncoder().encode(sheetIndexCsv(list)), `${doc.name.replace(/\.pdf$/i, '')}-sheet-index.csv`, 'text/csv;charset=utf-8'); status.textContent = `Exported ${list.length} reviewed sheet(s).`; });
  button('Export PDF with reviewed sheet bookmarks', async () => { const { doc, list } = accepted(); options.download(await applySheetBookmarks(doc.bytes, list), `${doc.name.replace(/\.pdf$/i, '')}-indexed.pdf`); status.textContent = `Exported a copy with ${list.length} reviewed bookmark(s). The open document is unchanged.`; });
  button('Export PDF with links to reviewed sheets', async () => {
    const { doc, list } = accepted();
    const links = findSheetReferences(await options.pageRuns(), list);
    if (!links.length) throw new Error('No references to the accepted sheet numbers were found on other pages.');
    options.download(await applySheetLinks(doc.bytes, links), `${doc.name.replace(/\.pdf$/i, '')}-linked.pdf`);
    status.textContent = `Exported a copy with ${links.length} link(s) to ${new Set(links.map(link => link.target)).size} sheet(s). The open document is unchanged.`;
  });
  container.append(status, table);
}
