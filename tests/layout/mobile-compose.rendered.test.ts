// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_VIEWPORT, startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
const pageRoot = new URL('../..', import.meta.url).pathname;
const appSelector = '.workspace-panel:not([inert]) .app';

describe.skipIf(!chromePath)('compact compose geometry', () => {
  let harness: RenderedHarness | null = null;

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-mobile-compose-', pageRoot, PHONE_VIEWPORT);
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it.each([{ width: 412, height: 915 }, { width: 360, height: 800 }])('fits compose and reply at $width × $height, including a short viewport', async ({ width, height }) => {
    await harness!.cdp.cmd('Page.reload');
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 500))');
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width, height, screenWidth: width, screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor, mobile: true,
    });
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      window.__composeSheetPoints = ['mobile-menu', 'mobile-compose'].map(test => {
        const element = app.querySelector('[data-test="' + test + '"]');
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
    })()`);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="mobile-compose"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 400))');
    const initial = await geometry(harness!);
    expect(initial.appHeight).toBeLessThanOrEqual(height);
    expect(initial.inputSize).toBe('16px');
    expect(initial.header.top).toBeGreaterThanOrEqual(0);
    expect(initial.footer.bottom).toBeLessThanOrEqual(height);
    expect(initial.body.height).toBeGreaterThan(120);
    expect(initial.overflow).toBeLessThanOrEqual(width);
    const newMessage = await harness!.cdp.js<{ boxMatches: boolean; hitResults: boolean[]; titleLeft: number; closeLeft: number; closeSize: { width: number; height: number }; glyphSize: { width: number; height: number } }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      const sheet = app.querySelector('[data-test="compose-card"]');
      const rect = element => element.getBoundingClientRect();
      const appBox = rect(app);
      const sheetBox = rect(sheet);
      return {
        boxMatches: ['top', 'right', 'bottom', 'left'].every(edge => Math.abs(sheetBox[edge] - appBox[edge]) <= 1),
        hitResults: window.__composeSheetPoints.map(point => {
          const hit = document.elementFromPoint(point.x, point.y);
          return !!hit && sheet.contains(hit);
        }),
        titleLeft: rect(sheet.querySelector('.composer-heading h2')).left,
        closeLeft: rect(sheet.querySelector('[data-test="compose-sheet-close"]')).left,
        closeSize: { width: rect(sheet.querySelector('[data-test="compose-sheet-close"]')).width, height: rect(sheet.querySelector('[data-test="compose-sheet-close"]')).height },
        glyphSize: { width: rect(sheet.querySelector('[data-test="compose-sheet-close"] svg')).width, height: rect(sheet.querySelector('[data-test="compose-sheet-close"] svg')).height },
      };
    })()`);
    expect(newMessage.boxMatches).toBe(true);
    expect(newMessage.hitResults.every(Boolean)).toBe(true);
    expect(newMessage.titleLeft).toBeLessThan(newMessage.closeLeft);
    expect(Math.abs(newMessage.closeSize.width - 48)).toBeLessThanOrEqual(1);
    expect(Math.abs(newMessage.closeSize.height - 48)).toBeLessThanOrEqual(1);
    expect(Math.abs(newMessage.glyphSize.width - 24)).toBeLessThanOrEqual(1);
    expect(Math.abs(newMessage.glyphSize.height - 24)).toBeLessThanOrEqual(1);
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width, height: 500, screenWidth: width, screenHeight: 500,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor, mobile: true,
    });
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    const short = await geometry(harness!);
    expect(short.header.top).toBeGreaterThanOrEqual(0);
    expect(short.footer.bottom).toBeLessThanOrEqual(500);
    expect(short.body.height).toBeGreaterThanOrEqual(120);
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width, height: 420, screenWidth: width, screenHeight: 420,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor, mobile: true,
    });
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    await expectKeyboardLayout(harness!, 420);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="compose-sheet-close"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 400))');
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width, height, screenWidth: width, screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor, mobile: true,
    });
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="conversation-row-conv-01"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 300))');
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      window.__replySheetPoints = ['reader-close', 'mobile-reply-bar', 'mobile-reader-actions'].map(test => {
        const element = app.querySelector('[data-test="' + test + '"]');
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
    })()`);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="mobile-reply-bar"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 400))');
    const reply = await geometry(harness!);
    expect(reply.footer.bottom).toBeLessThanOrEqual(height);
    expect(reply.body.height).toBeGreaterThanOrEqual(120);
    expect(reply.inputSize).toBe('16px');
    const overlay = await harness!.cdp.js<{ boxMatches: boolean; appBox: { top: number; right: number; bottom: number; left: number }; sheetBox: { top: number; right: number; bottom: number; left: number }; bodyHeight: number; hitResults: boolean[]; textHit: boolean; titleLeft: number; closeLeft: number; closeSize: { width: number; height: number }; glyphSize: { width: number; height: number } }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      const sheet = app.querySelector('[data-test="reply-composer"]');
      const box = element => element.getBoundingClientRect();
      const appBox = box(app);
      const sheetBox = box(sheet);
      const points = window.__replySheetPoints.map(point => {
        const hit = document.elementFromPoint(point.x, point.y);
        return !!hit && sheet.contains(hit);
      });
      const messageRect = box(app.querySelector('.message-from'));
      const messageHit = document.elementFromPoint(messageRect.left + messageRect.width / 2, messageRect.top + messageRect.height / 2);
      return {
        boxMatches: ['top', 'right', 'bottom', 'left'].every(edge => Math.abs(sheetBox[edge] - appBox[edge]) <= 1),
        appBox: { top: appBox.top, right: appBox.right, bottom: appBox.bottom, left: appBox.left },
        sheetBox: { top: sheetBox.top, right: sheetBox.right, bottom: sheetBox.bottom, left: sheetBox.left },
        bodyHeight: box(sheet.querySelector('.field-textarea')).height,
        hitResults: points,
        textHit: !!messageHit && !!messageHit.closest('.message-from'),
        titleLeft: box(sheet.querySelector('.composer-heading h2')).left,
        closeLeft: box(sheet.querySelector('[data-test="reply-sheet-close"]')).left,
        closeSize: { width: box(sheet.querySelector('[data-test="reply-sheet-close"]')).width, height: box(sheet.querySelector('[data-test="reply-sheet-close"]')).height },
        glyphSize: { width: box(sheet.querySelector('[data-test="reply-sheet-close"] svg')).width, height: box(sheet.querySelector('[data-test="reply-sheet-close"] svg')).height },
      };
    })()`);
    expect(overlay.sheetBox.top).toBeCloseTo(overlay.appBox.top, 0);
    expect(overlay.sheetBox.right).toBeCloseTo(overlay.appBox.right, 0);
    expect(overlay.sheetBox.bottom).toBeCloseTo(overlay.appBox.bottom, 0);
    expect(overlay.sheetBox.left).toBeCloseTo(overlay.appBox.left, 0);
    expect(overlay.hitResults.every(Boolean)).toBe(true);
    expect(overlay.textHit).toBe(false);
    expect(overlay.bodyHeight).toBeGreaterThanOrEqual(200);
    expect(overlay.titleLeft).toBeLessThan(overlay.closeLeft);
    expect(Math.abs(overlay.closeSize.width - 48)).toBeLessThanOrEqual(1);
    expect(Math.abs(overlay.closeSize.height - 48)).toBeLessThanOrEqual(1);
    expect(Math.abs(overlay.glyphSize.width - 24)).toBeLessThanOrEqual(1);
    expect(Math.abs(overlay.glyphSize.height - 24)).toBeLessThanOrEqual(1);
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width, height: 420, screenWidth: width, screenHeight: 420,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor, mobile: true,
    });
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    await expectKeyboardLayout(harness!, 420);
  });
});

async function expectKeyboardLayout(harness: RenderedHarness, height: number): Promise<void> {
  const layout = await harness.cdp.js<{
    viewport: number;
    app: { top: number; bottom: number };
    heading: { top: number; bottom: number };
    status: { top: number; bottom: number };
    body: { top: number; bottom: number; height: number };
    footer: { top: number; bottom: number };
    footerClosePresent: boolean;
    footerKbdCount: number;
    footerButtons: Array<{ top: number; bottom: number; height: number }>;
    footerHits: Array<{ insideSheet: boolean; dockHit: boolean }>;
  }>(`(() => {
    const app = document.querySelector(${JSON.stringify(appSelector)});
    const sheet = app.querySelector('[data-test="compose-card"], [data-test="reply-composer"]');
    const editor = sheet.querySelector('[data-test="composer"]');
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    const footer = sheet.querySelector('.composer-footer');
    const buttons = [...footer.querySelectorAll('[data-test="discard-draft"], [data-test="cancel-reply-preparation"]')];
    return {
      viewport: innerHeight,
      app: box(app),
      heading: box(sheet.querySelector('.composer-heading h2')),
      status: box(editor.querySelector('[data-test="draft-status"]')),
      body: box(editor.querySelector('.field-body')),
      footer: box(footer),
      footerClosePresent: !!footer.querySelector('[data-test="close-composer"]'),
      footerKbdCount: footer.querySelectorAll('kbd').length,
      footerButtons: buttons.map(box),
      footerHits: buttons.map(button => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { insideSheet: !!hit && sheet.contains(hit), dockHit: !!hit && !!hit.closest('.list-dock') };
      }),
    };
  })()`);
  expect(layout.viewport).toBe(height);
  expect(layout.app.top).toBeGreaterThanOrEqual(0);
  expect(layout.app.bottom).toBeLessThanOrEqual(height);
  expect(layout.heading.top).toBeGreaterThanOrEqual(0);
  expect(layout.status.top).toBeGreaterThanOrEqual(layout.heading.bottom);
  expect(layout.body.top).toBeGreaterThanOrEqual(layout.status.bottom);
  expect(layout.body.height).toBeGreaterThanOrEqual(80);
  expect(layout.footer.top).toBeGreaterThanOrEqual(layout.body.bottom);
  expect(layout.footer.bottom).toBeLessThanOrEqual(height);
  expect(layout.footerClosePresent).toBe(false);
  expect(layout.footerKbdCount).toBe(0);
  expect(layout.footerButtons.length).toBeGreaterThan(0);
  for (const button of layout.footerButtons) {
    expect(button.top).toBeGreaterThanOrEqual(0);
    expect(button.bottom).toBeLessThanOrEqual(height);
    expect(button.height).toBeGreaterThanOrEqual(48);
  }
  for (const hit of layout.footerHits) {
    expect(hit.insideSheet).toBe(true);
    expect(hit.dockHit).toBe(false);
  }
}

async function geometry(harness: RenderedHarness): Promise<{
  appHeight: number;
  header: { top: number; bottom: number };
  footer: { top: number; bottom: number };
  body: { height: number };
  inputSize: string;
  overflow: number;
}> {
  return harness.cdp.js(`(() => {
    const app = document.querySelector(${JSON.stringify(appSelector)});
    const root = app.querySelector('[data-test="compose-card"], [data-test="reply-composer"]');
    const rect = element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height }; };
    return {
      appHeight: app.getBoundingClientRect().height,
      header: rect(root.querySelector('.composer-top')),
      footer: rect(root.querySelector('.composer-footer')),
      body: rect(root.querySelector('.field-body')),
      inputSize: getComputedStyle(root.querySelector('.field-input, .field-textarea')).fontSize,
      overflow: document.documentElement.scrollWidth,
    };
  })()`);
}
