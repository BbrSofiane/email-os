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
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width: PHONE_VIEWPORT.width,
      height: PHONE_VIEWPORT.height,
      screenWidth: PHONE_VIEWPORT.width,
      screenHeight: PHONE_VIEWPORT.height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
      mobile: true,
    });
    await harness!.cdp.cmd('Page.reload');
    const ready = await harness!.cdp.js<boolean>(`new Promise(resolve => {
      const deadline = Date.now() + 5000;
      const check = () => {
        if (document.querySelector(${JSON.stringify(workspaceApp)})) {
          resolve(true);
        } else if (Date.now() >= deadline) {
          resolve(false);
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    })`);
    expect(ready).toBe(true);
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
    const geometry = await harness!.cdp.js<{ intro: DOMRectReadOnly; button: DOMRectReadOnly; empty: DOMRectReadOnly; paneLeft: number; paneRight: number }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const pane = app.querySelector('[data-test="reminders-panel"]');
      const introElement = app.querySelector('[data-test="reminders-coverage"]');
      const intro = introElement.getBoundingClientRect();
      const button = app.querySelector('[data-test="reminders-refresh"]').getBoundingClientRect();
      const empty = app.querySelector('[data-test="reminders-empty"]').getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(introElement.firstChild);
      const paneRect = pane.getBoundingClientRect();
      return { intro: { top: intro.top, bottom: intro.bottom, left: text.getBoundingClientRect().left }, button: { top: button.top, height: button.height, left: button.left, right: button.right }, empty: { top: empty.top, left: empty.left }, paneLeft: paneRect.left, paneRight: paneRect.right };
    })()`);
    expect(geometry.button.top).toBeGreaterThanOrEqual(geometry.intro.bottom);
    expect(geometry.empty.top).toBeLessThan(geometry.button.top);
    expect(geometry.button.height).toBeGreaterThanOrEqual(48);
    expect(geometry.button.right).toBeLessThanOrEqual(geometry.paneRight - 16);
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

  it.each([{ width: 412, height: 915 }, { width: 360, height: 800 }])('aligns the Search form controls at $width × $height', async ({ width, height }) => {
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width, height, screenWidth: width, screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor, mobile: true,
    });
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-search"]').click()`);
    const form = await harness!.cdp.js<{ inset: number; starts: number[]; submit: DOMRectReadOnly }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const input = app.querySelector('[data-test="search-input"]');
      const style = getComputedStyle(input);
      const inputTextLeft = input.getBoundingClientRect().left
        + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      return {
        inset: app.getBoundingClientRect().left + 20,
        starts: [
          inputTextLeft,
          app.querySelector('.search-cache-toggle input').getBoundingClientRect().left,
          app.querySelector('.search-syntax summary').getBoundingClientRect().left,
        ],
        submit: app.querySelector('[data-test="search-submit"]').getBoundingClientRect().toJSON(),
      };
    })()`);
    expect(Math.max(...form.starts) - Math.min(...form.starts)).toBeLessThanOrEqual(2);
    for (const start of form.starts) {
      expect(Math.abs(start - form.inset)).toBeLessThanOrEqual(2);
    }
    expect(form.submit.width).toBeGreaterThanOrEqual(48);
    expect(form.submit.height).toBeGreaterThanOrEqual(48);
  });

  it('sizes compact Search controls and shows submitted results without overflow', async () => {
    const inbox = await harness!.cdp.js<{ scrollTop: number; focused: string }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const list = app.querySelector('.inbox-scroll');
      list.scrollTop = 180;
      return {
        scrollTop: list.scrollTop,
        focused: list.querySelector('[aria-current="true"]').dataset.test,
      };
    })()`);
    expect(inbox.scrollTop).toBeGreaterThan(0);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-search"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    const visibleInboxRows = await harness!.cdp.js<number>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      return [...app.querySelectorAll('.inbox-row')].filter(row => row.getClientRects().length > 0).length;
    })()`);
    expect(visibleInboxRows).toBe(0);
    await harness!.cdp.js(`document.querySelector('[data-test="search-input"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    const restored = await harness!.cdp.js<{ scrollTop: number; focused: string }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      return {
        scrollTop: app.querySelector('.inbox-scroll').scrollTop,
        focused: document.activeElement.dataset.test,
      };
    })()`);
    expect(restored).toEqual(inbox);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-search"]').click()`);
    const searchPage = await harness!.cdp.js<{ slotHeight: number; title: boolean; searchCurrent: string | null; inboxCurrent: string | null }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      return {
        slotHeight: app.querySelector('.mobile-context-slot').getBoundingClientRect().height,
        title: app.querySelector('[data-test="mobile-top-bar"]').textContent.includes('Search'),
        searchCurrent: app.querySelector('[data-test="mobile-search"]').getAttribute('aria-current'),
        inboxCurrent: app.querySelector('[data-test="mobile-mail"]').getAttribute('aria-current'),
      };
    })()`);
    expect(searchPage.slotHeight).toBe(0);
    expect(searchPage.title).toBe(true);
    expect(searchPage.searchCurrent).toBe('page');
    expect(searchPage.inboxCurrent).toBeNull();
    const syntax = await harness!.cdp.js<{ closed: boolean; listHeight: number; summaryHeight: number }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const details = app.querySelector('.search-syntax');
      const summary = details.querySelector('summary');
      return {
        closed: !details.open,
        listHeight: app.querySelector('[data-test="search-help"]').getBoundingClientRect().height,
        summaryHeight: summary.getBoundingClientRect().height,
      };
    })()`);
    expect(syntax.closed).toBe(true);
    expect(syntax.listHeight).toBe(0);
    expect(syntax.summaryHeight).toBeGreaterThanOrEqual(48);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('.search-syntax summary').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 50))');
    expect(await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="search-help"]').getBoundingClientRect().height`)).toBeGreaterThan(0);
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
    expect(await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('.mobile-context-slot').getBoundingClientRect().height`)).toBe(0);
    for (const width of [412, 360]) {
      await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
        width,
        height: width === 412 ? 915 : 800,
        screenWidth: width,
        screenHeight: width === 412 ? 915 : 800,
        deviceScaleFactor: 2.625,
        mobile: true,
      });
      const result = await harness!.cdp.js<{ visible: boolean; overflow: boolean; lefts: number[]; clear: DOMRectReadOnly; viewport: number }>(`(() => {
        const app = document.querySelector(${JSON.stringify(workspaceApp)});
        const header = app.querySelector('[data-test="search-results-header"]');
        const query = app.querySelector('[data-test="search-results-query"]');
        const coverage = app.querySelector('[data-test="search-coverage"]');
        const correspondent = app.querySelector('.inbox-list .row-group');
        const sender = app.querySelector('.inbox-list .row-sender');
        const textLeft = element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().left;
        };
        const clear = app.querySelector('[data-test="search-clear"]').getBoundingClientRect();
        return {
          visible: !!header && !!correspondent && !!sender,
          overflow: app.scrollWidth > app.clientWidth,
          lefts: [textLeft(query), textLeft(coverage), textLeft(correspondent), sender.getBoundingClientRect().left],
          clear: { left: clear.left, right: clear.right, width: clear.width, height: clear.height },
          viewport: document.documentElement.clientWidth,
        };
      })()`);
      expect(result.visible).toBe(true);
      expect(result.overflow).toBe(false);
      expect(Math.max(...result.lefts) - Math.min(...result.lefts), `${width}px anchor positions: ${result.lefts.join(', ')}`).toBeLessThanOrEqual(1);
      expect(result.clear.width).toBeGreaterThanOrEqual(48);
      expect(result.clear.height).toBeGreaterThanOrEqual(48);
      expect(result.clear.left).toBeGreaterThanOrEqual(0);
      expect(result.clear.right).toBeLessThanOrEqual(result.viewport);
    }
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width: PHONE_VIEWPORT.width,
      height: PHONE_VIEWPORT.height,
      screenWidth: PHONE_VIEWPORT.width,
      screenHeight: PHONE_VIEWPORT.height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
      mobile: true,
    });
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

  it('uses centred, inset aligned disclosure summaries in Search and Settings', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-search"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    const search = await harness!.cdp.js<{ left: number; height: number; centerDelta: number; chevronWidth: string }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const summary = app.querySelector('.search-syntax > summary');
      const box = summary.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(summary);
      const textBox = range.getBoundingClientRect();
      return {
        left: box.left,
        height: box.height,
        centerDelta: Math.abs((textBox.top + textBox.bottom) / 2 - (box.top + box.bottom) / 2),
        chevronWidth: getComputedStyle(summary, '::before').width,
      };
    })()`);

    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Settings').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    const settings = await harness!.cdp.js<{ left: number; height: number; centerDelta: number; chevronWidth: string }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const summary = app.querySelector('[data-test="utility-drawer"] .settings-note summary');
      const box = summary.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(summary);
      const textBox = range.getBoundingClientRect();
      return {
        left: box.left,
        height: box.height,
        centerDelta: Math.abs((textBox.top + textBox.bottom) / 2 - (box.top + box.bottom) / 2),
        chevronWidth: getComputedStyle(summary, '::before').width,
      };
    })()`);

    for (const summary of [search, settings]) {
      expect(Math.abs(summary.left - 20)).toBeLessThanOrEqual(1);
      expect(summary.height).toBeGreaterThanOrEqual(48);
      expect(summary.centerDelta).toBeLessThanOrEqual(2);
      expect(summary.chevronWidth).toBe('8px');
    }
    expect(Math.abs(search.left - settings.left)).toBeLessThanOrEqual(1);
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
      const geometry = await harness!.cdp.js<{ appTop: number; pageTop: number; backTop: number; backCenter: number; menuTop: number; menuCenter: number; cornersCovered: boolean[]; titleLeft: number; titleSize: string; titleWeight: string; closeExists: boolean }>(`(() => {
        const app = document.querySelector(${JSON.stringify(workspaceApp)});
        const page = app.querySelector('[data-test="utility-drawer"]');
        const pageRect = page.getBoundingClientRect();
        const appRect = app.getBoundingClientRect();
        const back = page.querySelector('[data-test="drawer-close"]').getBoundingClientRect();
        const menu = app.querySelector('[data-test="mobile-menu"]').getBoundingClientRect();
        const title = page.querySelector('.drawer-header h2');
        return {
          appTop: appRect.top,
          pageTop: pageRect.top,
          backTop: back.top,
          backCenter: (back.top + back.bottom) / 2,
          menuTop: menu.top,
          menuCenter: (menu.top + menu.bottom) / 2,
          cornersCovered: [
            [pageRect.left + 3, pageRect.top + 3],
            [pageRect.right - 3, pageRect.top + 3],
          ].map(([x, y]) => page.contains(document.elementFromPoint(x, y))),
          titleLeft: title.getBoundingClientRect().left,
          titleSize: getComputedStyle(title).fontSize,
          titleWeight: getComputedStyle(title).fontWeight,
          closeExists: !!page.querySelector('.drawer-close-icon'),
        };
      })()`);
      expect(Math.abs(geometry.pageTop - geometry.appTop)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.backTop - geometry.menuTop)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.backCenter - geometry.menuCenter)).toBeLessThanOrEqual(1);
      expect(geometry.cornersCovered.every(Boolean)).toBe(true);
      expect(Math.abs(geometry.titleLeft - destination.titleLeft)).toBeLessThanOrEqual(1);
      expect(geometry.titleSize).toBe(destination.titleSize);
      expect(geometry.titleWeight).toBe(destination.titleWeight);
      expect(geometry.closeExists).toBe(false);
    }

    await expectPushedPage('Settings');
    await expectPushedPage('Activity');

    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="drawer-close"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-mail"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('.inbox-row').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="reader-more"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      [...app.querySelectorAll('[data-test="action-sheet"] button')]
        .find((button) => button.textContent.includes('Contact details')).click();
    })()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    const contact = await harness!.cdp.js<{ appTop: number; pageTop: number; backTop: number; backCenter: number; menuTop: number; menuCenter: number; cornersCovered: boolean[] }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const page = app.querySelector('[data-test="contact-disclosure-panel"]');
      const pageRect = page.getBoundingClientRect();
      const appRect = app.getBoundingClientRect();
      const back = page.querySelector('[data-test="contact-disclosure-close"]').getBoundingClientRect();
      return {
        appTop: appRect.top,
        pageTop: pageRect.top,
        backTop: back.top,
        backCenter: (back.top + back.bottom) / 2,
        menuTop: ${JSON.stringify(destination.menu.top)},
        menuCenter: ${JSON.stringify((destination.menu.top + destination.menu.bottom) / 2)},
        cornersCovered: [
          [pageRect.left + 3, pageRect.top + 3],
          [pageRect.right - 3, pageRect.top + 3],
        ].map(([x, y]) => page.contains(document.elementFromPoint(x, y))),
      };
    })()`);
    expect(Math.abs(contact.pageTop - contact.appTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(contact.backTop - contact.menuTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(contact.backCenter - contact.menuCenter)).toBeLessThanOrEqual(1);
    expect(contact.cornersCovered.every(Boolean)).toBe(true);
  });

  it.each([{ width: 412, height: 915 }, { width: 360, height: 800 }])('fits the Contact targets at $width × $height', async ({ width, height }) => {
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width, height, screenWidth: width, screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor, mobile: true,
    });
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-01"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="reader-more"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      [...app.querySelectorAll('[data-test="action-sheet"] button')]
        .find(button => button.textContent.includes('Contact details')).click();
    })()`);
    const geometry = await harness!.cdp.js<{
      page: DOMRectReadOnly;
      horizontalOverflow: boolean;
      fields: { text: DOMRectReadOnly; copy: DOMRectReadOnly; opacity: string }[];
      recent: DOMRectReadOnly[];
      search: { box: DOMRectReadOnly; borderWidth: string; scrollWidth: number; clientWidth: number };
      identityBottom: number;
      recentTop: number;
    }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const page = app.querySelector('[data-test="contact-disclosure-panel"]');
      const pane = page.querySelector('[data-test="contact-pane"]');
      const recent = [...pane.querySelectorAll('.contact-recent button')];
      const search = pane.querySelector('[data-test="contact-find-mail"]');
      const box = element => element.getBoundingClientRect().toJSON();
      return {
        page: box(page),
        horizontalOverflow: [document.documentElement, page, pane, ...recent]
          .some(element => element.scrollWidth > element.clientWidth),
        fields: [...pane.querySelectorAll('.contact-line')].map(line => {
          const copy = line.querySelector('.contact-copy');
          return {
            text: box(line.querySelector('.contact-name, .contact-mailbox')),
            copy: box(copy),
            opacity: getComputedStyle(copy).opacity,
          };
        }),
        recent: recent.map(box),
        search: {
          box: box(search),
          borderWidth: getComputedStyle(search).borderWidth,
          scrollWidth: search.scrollWidth,
          clientWidth: search.clientWidth,
        },
        identityBottom: box(pane.querySelector('.contact-line:last-of-type')).bottom,
        recentTop: box(pane.querySelector('.contact-recent')).top,
      };
    })()`);
    expect(geometry.horizontalOverflow).toBe(false);
    expect(geometry.page.left).toBeGreaterThanOrEqual(0);
    expect(geometry.page.right).toBeLessThanOrEqual(width);
    expect(geometry.fields).toHaveLength(2);
    for (const { text, copy, opacity } of geometry.fields) {
      expect(copy.width).toBe(48);
      expect(copy.height).toBe(48);
      expect(opacity).toBe('1');
      expect(copy.left).toBeGreaterThanOrEqual(text.right);
      expect(copy.right).toBeLessThanOrEqual(geometry.page.right);
    }
    expect(geometry.recent.length).toBeGreaterThan(1);
    for (const row of geometry.recent) {
      expect(row.height).toBeGreaterThanOrEqual(48);
      expect(row.left).toBeGreaterThanOrEqual(geometry.page.left);
      expect(row.right).toBeLessThanOrEqual(geometry.page.right);
    }
    const search = geometry.search;
    expect(search.box.height).toBeGreaterThanOrEqual(48);
    expect(search.box.left).toBe(geometry.page.left + 20);
    expect(search.box.left).toBe(geometry.fields[0]!.text.left);
    expect(search.box.top).toBeGreaterThanOrEqual(geometry.identityBottom);
    expect(search.box.bottom).toBeLessThanOrEqual(geometry.recentTop);
    expect(search.borderWidth).toBe('0px');
    expect(search.scrollWidth).toBeLessThanOrEqual(search.clientWidth);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="contact-find-mail"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    const query = await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="search-results-query"]')?.textContent.trim()`);
    expect(query).toBe('Search: from:"ada@example.test"');
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
        controls: [...settings.querySelectorAll('select')].map(control => control.getBoundingClientRect().height),
        width: page.clientWidth,
        contentWidth: settings.scrollWidth,
        closeHasSvg: !!close.querySelector('svg'),
        closeTextVisible: [...close.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0),
        headingSizes: [...page.querySelectorAll('.compact-settings-heading')].map(heading => getComputedStyle(heading).fontSize),
      };
    })()`);
    expect(geometry.controls.length).toBe(2);
    expect(geometry.controls.every(height => height >= 48)).toBe(true);
    expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.closeHasSvg).toBe(true);
    expect(geometry.closeTextVisible).toBe(false);
    expect(geometry.headingSizes).toEqual(['15px', '15px']);
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

  it.each([{ width: 412, height: 915 }, { width: 360, height: 800 }])('renders Settings hierarchy and aligned radio controls at $width × $height', async ({ width, height }) => {
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
      mobile: true,
    });
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Settings').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    const geometry = await harness!.cdp.js<{
      rows: number[];
      lefts: number[];
      firstBottom: number;
      secondTop: number;
      legendSize: number;
      headingSize: number;
      emptyStatusDisplay: string;
    }>(`(() => {
      const page = document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="reminder-settings-dialog"]');
      const rect = element => element.getBoundingClientRect();
      const headings = [...page.querySelectorAll('.compact-settings-heading')];
      const legend = page.querySelector('.swipe-settings legend');
      const firstRadio = page.querySelector('.swipe-settings input[type="radio"]');
      const hour = page.querySelector('label[for="reminder-default-hour"]');
      const lastReminderControl = page.querySelector('.reminder-settings form select:last-of-type');
      const status = page.querySelector('.swipe-settings [role="status"]');
      return {
        rows: [...page.querySelectorAll('.swipe-settings label')].map(row => rect(row).height),
        lefts: [rect(headings[0]).left, rect(headings[1]).left, rect(legend).left, rect(firstRadio).left, rect(hour).left],
        firstBottom: rect(lastReminderControl).bottom,
        secondTop: rect(headings[1]).top,
        legendSize: Number.parseFloat(getComputedStyle(legend).fontSize),
        headingSize: Number.parseFloat(getComputedStyle(headings[1]).fontSize),
        emptyStatusDisplay: getComputedStyle(status).display,
      };
    })()`);
    expect(geometry.rows).toHaveLength(6);
    expect(geometry.rows.every(height => height >= 48)).toBe(true);
    expect(geometry.lefts.every(left => Math.abs(left - geometry.lefts[0]!) <= 1)).toBe(true);
    expect(geometry.secondTop - geometry.firstBottom).toBeGreaterThanOrEqual(40);
    expect(geometry.legendSize).toBeLessThan(geometry.headingSize);
    expect(geometry.emptyStatusDisplay).toBe('none');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('input[name="swipe-left"][value="none"]').click()`);
    expect(await harness!.cdp.js(`localStorage.getItem('email-os.swipe-preferences.v1')`)).toContain('"left":"none"');
  });
});
