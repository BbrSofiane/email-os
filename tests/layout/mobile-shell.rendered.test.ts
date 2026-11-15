// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_VIEWPORT, startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface InboxGeometry {
  layout: string | undefined;
  viewportWidth: number;
  documentWidth: number;
  overflowElements: Array<{ selector: string; right: number }>;
  workspaceStrip: Rect;
  topBar: Rect;
  headerStrip: Rect;
  list: Rect;
  bottomRegion: Rect;
  buttons: Rect[];
  railDisplay: string | null;
  preview: Rect;
  previewButtonOverlaps: boolean[];
  pillStyles: [
    { background: string; borderColor: string; borderWidth: string },
    { background: string; borderColor: string; borderWidth: string },
    { background: string; borderColor: string; borderWidth: string },
  ];
}

interface ReaderGeometry {
  closeInTop: boolean;
  closeAtLeft: boolean;
  actionContainer: boolean;
  pill: Rect;
  buttons: Rect[];
  overlap: boolean;
  navigationGone: boolean;
  lastMessageBottom: number;
  bottomTop: number;
  actionBackground: string;
  actionBorderColor: string;
  actionBorderWidth: string;
  contextBackground: string;
  contextBorderColor: string;
  contextBorderWidth: string;
}

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
const workspaceApp = '.workspace-panel:not([inert]) .app';
const pageRoot = new URL('../..', import.meta.url).pathname;

async function settle(harness: RenderedHarness): Promise<void> {
  await harness.cdp.js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await harness.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
}

async function click(harness: RenderedHarness, selector: string): Promise<void> {
  await harness.cdp.js(`(() => {
    const root = document.querySelector(${JSON.stringify(workspaceApp)});
    const target = root?.querySelector(${JSON.stringify(selector)});
    if (!target) throw new Error('Missing active workspace target: ' + ${JSON.stringify(selector)});
    target.click();
  })()`);
  await settle(harness);
}

async function inboxGeometry(harness: RenderedHarness): Promise<InboxGeometry> {
  return harness.cdp.js<InboxGeometry>(`(() => {
    const app = document.querySelector(${JSON.stringify(workspaceApp)});
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const topBar = app.querySelector('[data-test="mobile-top-bar"]');
    const header = app.querySelector('.app-header');
    const list = app.querySelector('.inbox-scroll');
    const bottom = app.querySelector('[data-test="mobile-bottom-region"]');
    const strip = document.querySelector('.fixture-workspaces > .workspace-header');
    const preview = app.querySelector('[data-test="preview-banner"]');
    const previewButtons = [...app.querySelectorAll('button')].filter(button => button !== preview && !preview.contains(button));
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const overflowElements = [...app.querySelectorAll('*')]
      .map(element => ({ selector: element.tagName.toLowerCase() + (element.className?.baseVal ?? element.className ? '.' + String(element.className?.baseVal ?? element.className).trim().replace(/\\s+/g, '.') : ''), right: element.getBoundingClientRect().right }))
      .filter(item => item.right > innerWidth + 1);
    return {
      layout: app.dataset.layout,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      overflowElements,
      workspaceStrip: rect(strip),
      topBar: rect(topBar),
      headerStrip: rect(header),
      list: rect(list),
      bottomRegion: rect(bottom),
      buttons: [...app.querySelectorAll('[data-test="mobile-top-bar"] button, [data-test="mobile-bottom-region"] button')]
        .filter(button => button.getClientRects().length)
        .map(rect),
      railDisplay: getComputedStyle(app.querySelector('.rail')).display,
      preview: rect(preview),
      previewButtonOverlaps: previewButtons.map(button => overlaps(rect(preview), rect(button))),
      pillStyles: ['[data-test="mobile-context-slot"]', '.mobile-navigation', '[data-test="mobile-account"]'].map(selector => {
        const element = app.querySelector(selector);
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, borderColor: style.borderTopColor, borderWidth: style.borderTopWidth };
      }),
    };
  })()`);
}

describe.skipIf(!chromePath)('mobile frame geometry (real Chromium)', () => {
  let harness: RenderedHarness | null = null;

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-mobile-frame-', pageRoot, PHONE_VIEWPORT);
    await settle(harness);
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it.each([
    { width: 412, height: 915 },
    { width: 360, height: 800 },
  ])('keeps the inbox frame inside $width × $height', async ({ width, height }) => {
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
      mobile: true,
    });
    await settle(harness!);
    const geometry = await inboxGeometry(harness!);

    expect(geometry.layout).toBe('compact');
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.overflowElements).toEqual([]);
    expect(geometry.workspaceStrip.bottom).toBeLessThanOrEqual(geometry.topBar.top + 1);
    expect(geometry.topBar.bottom).toBeLessThanOrEqual(geometry.headerStrip.top + geometry.headerStrip.height + 1);
    expect(geometry.headerStrip.bottom).toBeLessThanOrEqual(geometry.list.top + 1);
    expect(geometry.bottomRegion.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottomRegion.bottom).toBeLessThanOrEqual(height);
    expect(geometry.railDisplay).toBe('none');
    for (const style of geometry.pillStyles) {
      expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(style.background).toBe(geometry.pillStyles[0].background);
      expect(style.borderColor).toBe(geometry.pillStyles[0].borderColor);
      expect(style.borderWidth).toBe(geometry.pillStyles[0].borderWidth);
    }
    expect(geometry.preview.width).toBeGreaterThan(0);
    expect(geometry.preview.height).toBeGreaterThan(0);
    expect(geometry.previewButtonOverlaps.every(overlap => !overlap)).toBe(true);

    for (const button of geometry.buttons) {
      expect(button.width).toBeGreaterThanOrEqual(48);
      expect(button.height).toBeGreaterThanOrEqual(48);
    }

    const scroller = await harness!.cdp.js<{ rowBottom: number; bottomTop: number }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const list = app.querySelector('.inbox-scroll');
      list.scrollTop = list.scrollHeight;
      const last = list.querySelector('li:last-child');
      const row = last.getBoundingClientRect();
      const bottom = app.querySelector('[data-test="mobile-bottom-region"]').getBoundingClientRect();
      return { rowBottom: row.bottom, bottomTop: bottom.top };
    })()`);
    expect(scroller.rowBottom).toBeLessThan(scroller.bottomTop);
  });

  it('moves reader actions into the bottom pill and returns to the list', async () => {
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width: 412, height: 915, screenWidth: 412, screenHeight: 915,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor, mobile: true,
    });
    await settle(harness!);
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      app.querySelector('[data-test="conversation-row-conv-01"]').click();
    })()`);
    await settle(harness!);

    const reader = await harness!.cdp.js<ReaderGeometry>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const rect = element => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      };
      const close = app.querySelector('[data-test="reader-close"]');
      const top = app.querySelector('[data-test="mobile-top-bar"]').getBoundingClientRect();
      const actions = app.querySelector('[data-test="mobile-reader-actions"]');
      const pill = actions.getBoundingClientRect();
      const buttons = [...app.querySelectorAll('[data-test="reader-toolbar"] button')].map(rect);
      const overlaps = buttons.some((a, index) => buttons.slice(index + 1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
      const scroller = app.querySelector('.reader-scroll');
      scroller.scrollTop = scroller.scrollHeight;
      const lastMessage = scroller.querySelector('[data-test="reader-message"]:last-child') ?? scroller.lastElementChild;
      return {
        closeInTop: close.closest('[data-test="mobile-top-bar"]') !== null,
        closeAtLeft: close.getBoundingClientRect().left <= top.left + 60,
        actionContainer: actions.contains(app.querySelector('[data-test="reader-toolbar"]')),
        pill: rect(actions),
        buttons,
        overlap: overlaps,
        navigationGone: app.querySelector('[aria-label="Primary"]') === null,
        lastMessageBottom: lastMessage.getBoundingClientRect().bottom,
        bottomTop: app.querySelector('[data-test="mobile-bottom-region"]').getBoundingClientRect().top,
        actionBackground: getComputedStyle(actions).backgroundColor,
        actionBorderColor: getComputedStyle(actions).borderTopColor,
        actionBorderWidth: getComputedStyle(actions).borderTopWidth,
        contextBackground: getComputedStyle(app.querySelector('[data-test="mobile-context-slot"]')).backgroundColor,
        contextBorderColor: getComputedStyle(app.querySelector('[data-test="mobile-context-slot"]')).borderTopColor,
        contextBorderWidth: getComputedStyle(app.querySelector('[data-test="mobile-context-slot"]')).borderTopWidth,
      };
    })()`);

    expect(reader.closeInTop).toBe(true);
    expect(reader.closeAtLeft).toBe(true);
    expect(reader.actionContainer).toBe(true);
    expect(reader.navigationGone).toBe(true);
    expect(reader.actionBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(reader.actionBackground).toBe(reader.contextBackground);
    expect(reader.actionBorderColor).toBe(reader.contextBorderColor);
    expect(reader.actionBorderWidth).toBe(reader.contextBorderWidth);
    expect(reader.overlap).toBe(false);
    expect(reader.lastMessageBottom).toBeLessThan(reader.bottomTop);

    for (const button of reader.buttons) {
      expect(button.width).toBeGreaterThanOrEqual(48);
      expect(button.height).toBeGreaterThanOrEqual(48);
      expect(button.left).toBeGreaterThanOrEqual(0);
      expect(button.right).toBeLessThanOrEqual(412);
      expect(button.top).toBeGreaterThanOrEqual(0);
      expect(button.bottom).toBeLessThanOrEqual(915);
      expect(button.left).toBeGreaterThanOrEqual(reader.pill.left);
      expect(button.right).toBeLessThanOrEqual(reader.pill.right);
    }

    await click(harness!, '[data-test="reader-close"]');
    const backToList = await harness!.cdp.js<{ reader: boolean; navigation: boolean }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      return { reader: app.querySelector('[data-test="reader-close"]') !== null, navigation: app.querySelector('[aria-label="Primary"]') !== null };
    })()`);
    expect(backToList.reader).toBe(false);
    expect(backToList.navigation).toBe(true);
  });
});

describe.skipIf(!chromePath)('regular frame geometry', () => {
  let harness: RenderedHarness | null = null;

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-desktop-frame-', pageRoot);
    await settle(harness);
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('keeps the regular desktop shell', async () => {
    const state = await harness!.cdp.js<{ layout: string | undefined; rail: string; contact: string; mobile: boolean }>(`(() => {
      const app = document.querySelector('.workspace-panel:not([inert]) .app');
      return {
        layout: app.dataset.layout,
        rail: getComputedStyle(app.querySelector('.rail')).display,
        contact: getComputedStyle(app.querySelector('.contact-column')).display,
        mobile: app.querySelector('[data-test="mobile-top-bar"], [data-test="mobile-bottom-region"]') !== null,
      };
    })()`);

    expect(state.layout).toBe('regular');
    expect(state.rail).not.toBe('none');
    expect(state.contact).not.toBe('none');
    expect(state.mobile).toBe(false);
  });
});
