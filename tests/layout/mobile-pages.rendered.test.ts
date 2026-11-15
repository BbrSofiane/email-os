// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_VIEWPORT, startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
const workspaceApp = '.workspace-panel:not([inert]) .app';
const pageRoot = new URL('../..', import.meta.url).pathname;

describe.skipIf(!chromePath)('compact pages (real Chromium)', () => {
  let harness: RenderedHarness | null = null;

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-mobile-pages-', pageRoot, PHONE_VIEWPORT);
    await harness.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('stacks the Drafts intro and New draft control', async () => {
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      app.querySelector('[data-test="mobile-navigation-pill"]')?.click();
    })()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      app.querySelector('[data-test="rail-drafts"]')?.click();
    })()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    const geometry = await harness!.cdp.js<{ intro: DOMRectReadOnly; button: DOMRectReadOnly }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const intro = app.querySelector('[data-test="drafts-coverage"]').getBoundingClientRect();
      const button = app.querySelector('[data-test="new-draft"]').getBoundingClientRect();
      return { intro: { top: intro.top, bottom: intro.bottom, width: intro.width }, button: { top: button.top, height: button.height } };
    })()`);
    expect(geometry.button.top).toBeGreaterThanOrEqual(geometry.intro.bottom);
    expect(geometry.button.height).toBeGreaterThanOrEqual(48);
  });

  it('stacks the Reminders intro and gives its refresh control a touch target', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Reminders').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    const geometry = await harness!.cdp.js<{ intro: DOMRectReadOnly; button: DOMRectReadOnly }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const intro = app.querySelector('[data-test="reminders-coverage"]').getBoundingClientRect();
      const button = app.querySelector('[data-test="reminders-refresh"]').getBoundingClientRect();
      return { intro: { top: intro.top, bottom: intro.bottom, width: intro.width }, button: { top: button.top, height: button.height } };
    })()`);
    expect(geometry.button.top).toBeGreaterThanOrEqual(geometry.intro.bottom);
    expect(geometry.button.height).toBeGreaterThanOrEqual(48);
    expect(geometry.intro.width).toBeGreaterThan(300);
  });

  it('anchors the Reminder picker to the phone bottom with touch sized controls', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-mail"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-01"] .row-subject').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="reader-remind"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    const geometry = await harness!.cdp.js<{ picker: DOMRectReadOnly; input: DOMRectReadOnly; options: DOMRectReadOnly[]; viewport: number }>(`(() => {
      const picker = document.querySelector('[data-reminder-picker]');
      const rect = element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height, left: box.left, right: box.right }; };
      return { picker: rect(picker), input: rect(picker.querySelector('input')), options: [...picker.querySelectorAll('[role="option"]')].map(rect), viewport: innerHeight };
    })()`);
    expect(geometry.picker.bottom).toBeCloseTo(geometry.viewport, 0);
    expect(geometry.picker.left).toBe(0);
    expect(geometry.input.height).toBeGreaterThanOrEqual(48);
    expect(geometry.options.length).toBeGreaterThan(0);
    expect(geometry.options.every(option => option.height >= 48)).toBe(true);
  });

  it('sizes compact Search controls and shows submitted results without overflow', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="search-trigger"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const input = app.querySelector('[data-test="search-input"]');
      input.value = 'from:ada';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const input = app.querySelector('[data-test="search-input"]');
      input.value = 'from:ada';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      app.querySelector('[data-test="search-submit"]').click();
    })()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 400))');
    const result = await harness!.cdp.js<{ visible: boolean; overflow: boolean }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const header = app.querySelector('[data-test="search-results-header"]');
      return { visible: !!header, overflow: app.scrollWidth > app.clientWidth };
    })()`);
    expect(result.visible).toBe(true);
    expect(result.overflow).toBe(false);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="search-trigger"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    const suggestionGeometry = await harness!.cdp.js<{ input: DOMRectReadOnly; suggestions: DOMRectReadOnly[] }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const rect = element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height, width: box.width }; };
      const input = app.querySelector('[data-test="search-input"]');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { input: rect(input), suggestions: [...app.querySelectorAll('[data-test="search-suggestion"]')].map(rect) };
    })()`);
    expect(suggestionGeometry.input.height).toBeGreaterThanOrEqual(48);
    expect(suggestionGeometry.input.width).toBeGreaterThan(200);
    expect(suggestionGeometry.suggestions.length).toBeGreaterThan(0);
    expect(suggestionGeometry.suggestions.every(row => row.height >= 48)).toBe(true);
  });

  it('makes Activity cover the app and close back to the list', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Activity').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    const geometry = await harness!.cdp.js<{ top: DOMRectReadOnly; bottom: DOMRectReadOnly; headerHeight: number; close: DOMRectReadOnly; topCovered: boolean; bottomCovered: boolean }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const page = app.querySelector('[data-test="utility-drawer"]');
      const rect = element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height, left: box.left, right: box.right }; };
      const pageRect = rect(page);
      const header = rect(page.querySelector('.drawer-header'));
      const close = rect(page.querySelector('[data-test="drawer-close"]'));
      return { top: pageRect, bottom: pageRect, headerHeight: header.height, close, topCovered: page.contains(document.elementFromPoint(10, 10)), bottomCovered: page.contains(document.elementFromPoint(innerWidth / 2, innerHeight - 10)) };
    })()`);
    expect(geometry.top.top).toBe(0);
    expect(geometry.bottom.bottom).toBeCloseTo(PHONE_VIEWPORT.height, 0);
    expect(geometry.headerHeight).toBe(56);
    expect(geometry.close.height).toBeGreaterThanOrEqual(48);
    expect(geometry.topCovered).toBe(true);
    expect(geometry.bottomCovered).toBe(true);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="drawer-close"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    expect(await harness!.cdp.js(`!document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="utility-drawer"]')`)).toBe(true);
  });

  it('keeps compact Account and Activity content inside the page with touch sized actions', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Activity').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    const activity = await harness!.cdp.js<{ overflow: boolean; buttons: number[] }>(`(() => {
      const page = document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="utility-drawer"]');
      return { overflow: page.scrollWidth > page.clientWidth, buttons: [...page.querySelectorAll('.activity button')].map(button => button.getBoundingClientRect().height) };
    })()`);
    expect(activity.overflow).toBe(false);
    expect(activity.buttons.every(height => height >= 48)).toBe(true);
  });

  it('sizes Reminder settings controls and allows the explanatory text to wrap', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Reminder settings').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    const geometry = await harness!.cdp.js<{ controls: number[]; width: number; contentWidth: number }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const page = app.querySelector('[data-test="utility-drawer"]');
      const settings = page.querySelector('.reminder-settings');
      return { controls: [...settings.querySelectorAll('select, button')].map(control => control.getBoundingClientRect().height), width: page.clientWidth, contentWidth: settings.scrollWidth };
    })()`);
    expect(geometry.controls.length).toBe(4);
    expect(geometry.controls.every(height => height >= 48)).toBe(true);
    expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.width);
  });
});
