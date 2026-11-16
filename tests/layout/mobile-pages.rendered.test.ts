// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

  beforeEach(async () => {
    await harness!.cdp.cmd('Page.reload');
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
  });

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
    const geometry = await harness!.cdp.js<{ intro: DOMRectReadOnly; button: DOMRectReadOnly; empty: DOMRectReadOnly; paneLeft: number }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const pane = app.querySelector('[data-test="drafts-pane"]');
      const introElement = app.querySelector('[data-test="drafts-coverage"]');
      const intro = introElement.getBoundingClientRect();
      const button = app.querySelector('[data-test="new-draft"]').getBoundingClientRect();
      const empty = app.querySelector('[data-test="draft-list-empty"]').getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(introElement.firstChild);
      return { intro: { top: intro.top, bottom: intro.bottom, left: text.getBoundingClientRect().left }, button: { top: button.top, height: button.height, left: button.left }, empty: { left: empty.left }, paneLeft: pane.getBoundingClientRect().left };
    })()`);
    expect(geometry.button.top).toBeGreaterThanOrEqual(geometry.intro.bottom);
    expect(geometry.button.height).toBeGreaterThanOrEqual(48);
    expect(Math.abs(geometry.intro.left - geometry.paneLeft - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.button.left - geometry.paneLeft - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.empty.left - geometry.paneLeft - 20)).toBeLessThanOrEqual(1);
  });

  it('stacks the Reminders intro and gives its refresh control a touch target', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Reminders').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    const geometry = await harness!.cdp.js<{ intro: DOMRectReadOnly; button: DOMRectReadOnly; empty: DOMRectReadOnly; paneLeft: number }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const pane = app.querySelector('[data-test="reminders-panel"]');
      const introElement = app.querySelector('[data-test="reminders-coverage"]');
      const intro = introElement.getBoundingClientRect();
      const button = app.querySelector('[data-test="reminders-refresh"]').getBoundingClientRect();
      const empty = app.querySelector('[data-test="reminders-empty"]').getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(introElement.firstChild);
      return { intro: { top: intro.top, bottom: intro.bottom, left: text.getBoundingClientRect().left }, button: { top: button.top, height: button.height, left: button.left }, empty: { left: empty.left }, paneLeft: pane.getBoundingClientRect().left };
    })()`);
    expect(geometry.button.top).toBeGreaterThanOrEqual(geometry.intro.bottom);
    expect(geometry.button.height).toBeGreaterThanOrEqual(48);
    expect(Math.abs(geometry.intro.left - geometry.paneLeft - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.button.left - geometry.paneLeft - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.empty.left - geometry.paneLeft - 20)).toBeLessThanOrEqual(1);
  });

  it('anchors the Reminder picker to the phone bottom with touch sized controls', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-mail"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-01"] .row-subject').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="reader-remind"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    const geometry = await harness!.cdp.js<{ picker: DOMRectReadOnly; input: DOMRectReadOnly; options: Array<{ height: number; fontSize: string }>; viewport: number; footerDisplay: string; schedule: DOMRectReadOnly; close: DOMRectReadOnly }>(`(() => {
      const picker = document.querySelector('[data-reminder-picker]');
      const rect = element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height, width: box.width, left: box.left, right: box.right }; };
      const options = [...picker.querySelectorAll('[role="option"]')].map(option => ({ ...rect(option), fontSize: getComputedStyle(option.querySelector('span')).fontSize }));
      return { picker: rect(picker), input: rect(picker.querySelector('input')), options, viewport: innerHeight, footerDisplay: getComputedStyle(picker.querySelector('footer')).display, schedule: rect(picker.querySelector('.picker-primary')), close: rect(picker.querySelector('.picker-close')) };
    })()`);
    expect(geometry.picker.bottom).toBeCloseTo(geometry.viewport, 0);
    expect(geometry.picker.left).toBe(0);
    expect(geometry.input.height).toBeGreaterThanOrEqual(48);
    expect(geometry.options.length).toBeGreaterThan(0);
    expect(geometry.options.every(option => option.height >= 48)).toBe(true);
    expect(geometry.options.every(option => Number.parseFloat(option.fontSize) >= 15)).toBe(true);
    expect(geometry.footerDisplay).toBe('none');
    expect(geometry.schedule.height).toBeGreaterThanOrEqual(48);
    expect(geometry.schedule.width).toBeGreaterThanOrEqual(geometry.picker.right * 0.8);
    expect(geometry.close.height).toBeGreaterThanOrEqual(48);
    await harness!.cdp.js(`document.querySelector('[data-reminder-picker] .picker-close').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    expect(await harness!.cdp.js(`document.querySelector('[data-reminder-picker]') === null`)).toBe(true);
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
      return { top: pageRect, bottom: pageRect, headerHeight: header.height, close, topCovered: page.contains(document.elementFromPoint(10, 30)), bottomCovered: page.contains(document.elementFromPoint(innerWidth / 2, innerHeight - 10)) };
    })()`);
    expect(geometry.top.top).toBe(24);
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

  it.each([{ width: 412, height: 915 }, { width: 360, height: 800 }])('matches pushed page headers to the destination top bar at $width × $height', async ({ width, height }) => {
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
      mobile: true,
    });
    await harness!.cdp.js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Drafts').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    const destination = await harness!.cdp.js<{ menu: DOMRectReadOnly; titleLeft: number; titleSize: string; titleWeight: string }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const menu = app.querySelector('[data-test="mobile-menu"]').getBoundingClientRect();
      const title = app.querySelector('.mobile-title');
      return {
        menu: { top: menu.top, right: menu.right, bottom: menu.bottom, left: menu.left },
        titleLeft: title.getBoundingClientRect().left,
        titleSize: getComputedStyle(title).fontSize,
        titleWeight: getComputedStyle(title).fontWeight,
      };
    })()`);

    async function expectPushedPage(name: 'Settings' | 'Activity'): Promise<void> {
      await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
      await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
      await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === '${name}').click()`);
      await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 400))');
      const geometry = await harness!.cdp.js<{ back: DOMRectReadOnly; titleLeft: number; titleSize: string; titleWeight: string; closeExists: boolean }>(`(() => {
        const app = document.querySelector(${JSON.stringify(workspaceApp)});
        const page = app.querySelector('[data-test="utility-drawer"]');
        const back = page.querySelector('[data-test="drawer-close"]').getBoundingClientRect();
        const title = page.querySelector('.drawer-header h2');
        return {
          back: { top: back.top, right: back.right, bottom: back.bottom, left: back.left },
          titleLeft: title.getBoundingClientRect().left,
          titleSize: getComputedStyle(title).fontSize,
          titleWeight: getComputedStyle(title).fontWeight,
          closeExists: !!page.querySelector('.drawer-close-icon'),
        };
      })()`);
      for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
        expect(geometry.back[edge], `${name} Back ${edge}`).toBeCloseTo(destination.menu[edge], 0);
      }
      expect(Math.abs(geometry.titleLeft - destination.titleLeft)).toBeLessThanOrEqual(1);
      expect(geometry.titleSize).toBe(destination.titleSize);
      expect(geometry.titleWeight).toBe(destination.titleWeight);
      expect(geometry.closeExists).toBe(false);
    }

    await expectPushedPage('Settings');
    await expectPushedPage('Activity');
  });

  it('sizes Reminder settings controls and allows the explanatory text to wrap', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Settings').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    const geometry = await harness!.cdp.js<{ controls: number[]; width: number; contentWidth: number; closeHasSvg: boolean; closeTextVisible: boolean; headingSizes: string[] }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const page = app.querySelector('[data-test="utility-drawer"]');
      const settings = page.querySelector('.reminder-settings');
      const close = page.querySelector('[data-test="drawer-close"]');
      return {
        controls: [...settings.querySelectorAll('select, button')].map(control => control.getBoundingClientRect().height),
        width: page.clientWidth,
        contentWidth: settings.scrollWidth,
        closeHasSvg: !!close.querySelector('svg'),
        closeTextVisible: [...close.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0),
        headingSizes: [...page.querySelectorAll('.compact-settings-heading')].map(heading => getComputedStyle(heading).fontSize),
      };
    })()`);
    expect(geometry.controls.length).toBe(4);
    expect(geometry.controls.every(height => height >= 48)).toBe(true);
    expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.closeHasSvg).toBe(true);
    expect(geometry.closeTextVisible).toBe(false);
    expect(geometry.headingSizes).toEqual(['16px', '16px']);
  });

  it('shows compact Commands as a touch sized, scrolling overlay', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-drawer-commands"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    const geometry = await harness!.cdp.js<{ panel: DOMRectReadOnly; input: DOMRectReadOnly; rows: DOMRectReadOnly[]; shortcuts: string[]; hints: string[] }>(`(() => {
      const panel = document.querySelector('.compact-command-overlay');
      const rect = element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height, left: box.left, right: box.right }; };
      return { panel: rect(panel), input: rect(panel.querySelector('input')), rows: [...panel.querySelectorAll('[role="option"]')].map(rect), shortcuts: [...panel.querySelectorAll('kbd')].map(element => getComputedStyle(element).display), hints: [...panel.querySelectorAll('.action-hint,.action-keys')].map(element => getComputedStyle(element).display) };
    })()`);
    expect(geometry.panel.top).toBeGreaterThanOrEqual(0);
    expect(geometry.panel.top).toBe(16);
    expect(geometry.panel.right).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
    expect(geometry.input.height).toBeGreaterThanOrEqual(48);
    expect(geometry.rows.length).toBeGreaterThan(0);
    expect(geometry.rows.every(row => row.height >= 48)).toBe(true);
    expect(geometry.shortcuts.every(display => display === 'none')).toBe(true);
    expect(geometry.hints.every(display => display === 'none')).toBe(true);
    await harness!.cdp.js(`(() => {
      const option = [...document.querySelectorAll('.compact-command-overlay [role="option"]')].find(row => row.textContent.includes('Go to local Drafts'));
      option.click();
    })()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    expect(await harness!.cdp.js(`!!document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="drafts-pane"]')`)).toBe(true);
  });

  it('renders Settings radio rows as 48px controls and saves a swipe choice', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Settings').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    const rows = await harness!.cdp.js<number[]>(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .swipe-settings label')].map(label => label.getBoundingClientRect().height)`);
    expect(rows.length).toBe(6);
    expect(rows.every(height => height >= 48)).toBe(true);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('input[name="swipe-left"][value="none"]').click()`);
    expect(await harness!.cdp.js(`localStorage.getItem('email-os.swipe-preferences.v1')`)).toContain('"left":"none"');
  });
});
