import { test, expect, chromium, firefox, webkit, type Page } from '@playwright/test';
// @ts-ignore Node fixture shared with unit tests.
import { drawingFixture } from '../fixture.mjs';

const origin = 'http://127.0.0.1:5173';

// Accessible-name approximation of the controls a screen reader announces (labels, aria-label,
// aria-labelledby, text content, title). The real Windows UIA tree is audited separately via Cua.
async function unnamedControls(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => { const box = (el as HTMLElement).getBoundingClientRect(); const style = getComputedStyle(el); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
    const name = (el: HTMLElement) => {
      const aria = el.getAttribute('aria-label')?.trim(); if (aria) return aria;
      const by = el.getAttribute('aria-labelledby'); if (by) return by.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
      const labels = (el as HTMLInputElement).labels; if (labels?.length) return [...labels].map(label => label.textContent ?? '').join(' ').trim();
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return (el.textContent ?? '').trim() || el.getAttribute('title') || '';
      return el.getAttribute('title') ?? '';
    };
    return [...document.querySelectorAll<HTMLElement>('button, input:not([type=hidden]), select, textarea, a[href], [role=button], [tabindex]:not([tabindex="-1"])')]
      .filter(el => visible(el) && !(el as HTMLInputElement).classList.contains('hidden'))
      .filter(el => !name(el)).map(el => el.outerHTML.slice(0, 120));
  });
}

for (const [label, type] of [['Chromium', chromium], ['Firefox', firefox], ['WebKit', webkit]] as const) {
  test(`${label}: core workflow, accessible names, keyboard operation and landmarks`, async () => {
    const browser = await type.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/');
      expect(await unnamedControls(page)).toEqual([]);
      await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'a11y.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await drawingFixture()) });
      await expect(page.getByTestId('pdf-canvas')).toBeVisible();
      await expect(page.locator('#status')).toContainText('Page 1 of 2');
      // Populate dynamic panels before auditing names again.
      await page.getByLabel('Markup tool', { exact: true }).selectOption('rectangle');
      await page.getByRole('button', { name: 'Add markup', exact: true }).click();
      await expect(page.locator('.markup-list button')).toHaveCount(1);
      await page.getByRole('button', { name: 'Propose sheet index', exact: true }).click();
      await expect(page.getByLabel('Sheet number for page 1', { exact: true })).toHaveValue('A101');
      await expect(page.getByRole('button', { name: 'Go to page 2', exact: true })).toBeVisible();
      expect(await unnamedControls(page)).toEqual([]);

      // Keyboard-only navigation: focus the toolbar control and activate with Enter/Space.
      await page.getByRole('button', { name: 'Next page', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#status')).toContainText('Page 2 of 2');
      await page.getByRole('button', { name: 'Zoom in', exact: true }).focus();
      await page.keyboard.press('Space');
      await expect(page.locator('#zoom-label')).toHaveText('125%');
      await page.getByLabel('Search document', { exact: true }).focus();
      await page.keyboard.type('Valve');
      await page.keyboard.press('Enter');
      await expect(page.locator('#search-status')).not.toBeEmpty();
      // Tab order from the first header control reaches the toolbar without traps.
      await page.locator('#open').focus();
      const reached = new Set<string>();
      for (let i = 0; i < 80; i++) { await page.keyboard.press('Tab'); reached.add(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? '')); }
      expect([...reached]).toEqual(expect.arrayContaining(['Previous page', 'Zoom in', 'Search document', 'Save PDF', 'Go to page 1']));
      // Focus must be visible on keyboard focus.
      await page.getByRole('button', { name: 'Previous page', exact: true }).focus();
      const outline = await page.evaluate(() => { const style = getComputedStyle(document.activeElement!); return style.outlineStyle !== 'none' && style.outlineWidth !== '0px' || style.boxShadow !== 'none'; });
      expect(outline).toBe(true);
      // Live regions and landmarks for assistive technology.
      await expect(page.getByRole('status').first()).toBeAttached();
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.locator('#error')).toHaveAttribute('role', 'alert');
      expect(await page.locator('html').getAttribute('lang')).toBe('en');
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });
}
