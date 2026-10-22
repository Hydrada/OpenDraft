import { parsePresetLibrary, serializePresetLibrary, type MarkupPreset } from './markup-presets';

export const PRESET_STORAGE_KEY = 'opendraft.markup-presets.v1';
type Callbacks = { read: (name: string, id: string) => MarkupPreset; apply: (preset: MarkupPreset) => void; error: (message: string) => void };
/** Explicit local library. Failed validation/storage never replaces the prior library. */
export class PresetPalette {
  private presets: MarkupPreset[] = [];
  private baseline: string | null = null;
  private unreadable = false;
  private select = document.createElement('select');
  private name = document.createElement('input');
  private status = document.createElement('p');
  constructor(container: HTMLElement, private callbacks: Callbacks) {
    const section = document.createElement('section');
    section.setAttribute('aria-label', 'Markup preset library');
    const heading = document.createElement('h4'); heading.textContent = 'Reusable markup presets';
    const help = document.createElement('p');
    help.textContent = 'Saving retains the tool, style and contents unencrypted in this browser. Export a backup for another installation. Applying sets drawing controls; use Add markup or drag to create a new annotation.';
    this.select.setAttribute('aria-label', 'Saved markup presets');
    this.name.setAttribute('aria-label', 'Preset name'); this.name.maxLength = 80;
    this.select.onchange = () => { this.name.value = this.presets.find(p => p.id === this.select.value)?.name ?? ''; };
    this.status.setAttribute('role', 'status');
    section.append(heading, help, this.select, this.name);
    const button = (label: string, action: () => void | Promise<void>) => {
      const b = document.createElement('button'); b.textContent = label;
      b.onclick = () => { void this.run(action); }; section.append(b);
    };
    button('Save new markup preset', () => {
      const preset = this.callbacks.read(this.name.value, crypto.randomUUID());
      this.store([...this.presets, preset], preset.id);
    });
    button('Replace selected preset', () => {
      const current = this.selected();
      const preset = this.callbacks.read(this.name.value, current.id);
      this.store(this.presets.map(p => p.id === current.id ? preset : p), preset.id);
    });
    button('Apply selected preset', () => {
      this.callbacks.apply(this.selected()); this.status.textContent = 'Preset applied to drawing controls. Existing annotations are unchanged.';
    });
    button('Delete selected preset', () => {
      const current = this.selected(); this.store(this.presets.filter(p => p.id !== current.id));
    });
    button('Export markup presets', () => {
      const blob = new Blob([serializePresetLibrary(this.presets)], {type:'application/json'});
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'opendraft-markup-presets.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.setAttribute('aria-label', 'Import markup presets');
    input.onchange = () => { void this.run(async () => {
      const file = input.files?.[0]; if (!file) return;
      try {
        if (file.size > 1024 * 1024) throw new Error('Preset file exceeds 1 MiB.');
        const imported = parsePresetLibrary(await file.text());
        this.store([...this.presets, ...imported], imported[0]?.id);
      } finally { input.value = ''; }
    }); };
    section.append(input);
    button('Clear local preset library', () => {
      if (localStorage.getItem(PRESET_STORAGE_KEY) !== this.baseline)
        throw new Error('Preset library changed in another tab. Reload before changing it.');
      localStorage.removeItem(PRESET_STORAGE_KEY);
      this.baseline = null; this.unreadable = false; this.presets = []; this.refresh();
      this.status.textContent = 'Local preset library cleared.';
    });
    section.append(this.status); container.append(section);
    try {
      this.baseline = localStorage.getItem(PRESET_STORAGE_KEY);
      if (this.baseline !== null) this.presets = parsePresetLibrary(this.baseline);
    } catch (error) {
      this.unreadable = true;
      this.status.textContent = `Local preset library could not be read: ${error instanceof Error ? error.message : String(error)}. Stored data was preserved; clear it explicitly to start again.`;
    }
    this.refresh();
  }
  /** Current library as text (for publishing a team tool set). */
  library(): string { return serializePresetLibrary(this.presets); }
  /** Adds a shared library; presets with the same id are replaced by the shared version. */
  mergeShared(text: string): number {
    const shared = parsePresetLibrary(text), ids = new Set(shared.map(preset => preset.id));
    this.store([...this.presets.filter(preset => !ids.has(preset.id)), ...shared]);
    this.status.textContent = `${shared.length} team preset(s) loaded; ${this.presets.length} preset(s) in the library.`;
    return shared.length;
  }
  private selected(): MarkupPreset {
    const value = this.presets.find(p => p.id === this.select.value);
    if (!value) throw new Error('Select a saved markup preset first.');
    // Return canonical copy so consumers cannot mutate the local library.
    return parsePresetLibrary(serializePresetLibrary([value]))[0];
  }
  private async run(action: () => void | Promise<void>) {
    try { await action(); } catch (error) { this.callbacks.error(error instanceof Error ? error.message : String(error)); }
  }
  private store(presets: MarkupPreset[], selected = '') {
    const text = serializePresetLibrary(presets), canonical = parsePresetLibrary(text);
    if (this.unreadable) throw new Error('Stored presets could not be read. Clear the local library explicitly before replacing it.');
    if (localStorage.getItem(PRESET_STORAGE_KEY) !== this.baseline)
      throw new Error('Preset library changed in another tab. Reload before changing it.');
    localStorage.setItem(PRESET_STORAGE_KEY, text);
    this.baseline = text; this.presets = canonical; this.refresh(selected);
    this.status.textContent = `${this.presets.length} preset(s) saved locally.`;
  }
  private refresh(selected = this.select.value) {
    this.select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a saved preset'; this.select.append(placeholder);
    for (const preset of this.presets) {
      const option = document.createElement('option'); option.value = preset.id; option.textContent = `${preset.name} · ${preset.kind}`; this.select.append(option);
    }
    this.select.value = selected;
    if (!this.select.value) this.select.value = '';
  }
}
