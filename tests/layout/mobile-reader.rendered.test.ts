// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_VIEWPORT, startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
const pageRoot = new URL('../..', import.meta.url).pathname;
const appSelector = '.workspace-panel:not([inert]) .app';

describe.skipIf(!chromePath)('compact reader geometry', () => {
  let harness: RenderedHarness | null = null;

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-mobile-reader-', pageRoot, PHONE_VIEWPORT);
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it.each([{ width: 412, height: 915 }, { width: 360, height: 800 }])('fits the reader at $width × $height', async ({ width, height }) => {
    await harness!.cdp.cmd('Page.reload');
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 500))');
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width, height, screenWidth: width, screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor, mobile: true,
    });
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      app.querySelector('[data-test="conversation-row-conv-01"]').click();
    })()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    const geometry = await harness!.cdp.js<{ width: number; viewport: number; pane: { top: number; bottom: number }; subject: { top: number; bottom: number }; messages: { top: number; bottom: number }; bodySize: string | null; lastBottom: number; bottomTop: number; actionTop: number; replyBar: { top: number; bottom: number; height: number } | null; messageMore: { width: number; height: number } | null; scrollHeight: number; clientHeight: number }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      const pane = app.querySelector('.reader-pane').getBoundingClientRect();
      const subject = app.querySelector('.reader-subject').getBoundingClientRect();
      const messages = app.querySelector('.messages').getBoundingClientRect();
      const scroller = app.querySelector('[data-test="reader-scroll"]');
      const last = app.querySelector('.message:last-child').getBoundingClientRect();
      const body = app.querySelector('.message-body');
      return {
        width: document.documentElement.scrollWidth,
        viewport: innerWidth,
        pane: { top: pane.top, bottom: pane.bottom },
        subject: { top: subject.top, bottom: subject.bottom },
        messages: { top: messages.top, bottom: messages.bottom },
        bodySize: body ? getComputedStyle(body).fontSize : null,
        lastBottom: last.bottom,
        bottomTop: app.querySelector('[data-test="mobile-bottom-region"]').getBoundingClientRect().top,
        actionTop: app.querySelector('[data-test="mobile-reader-actions"]').getBoundingClientRect().top,
        replyBar: app.querySelector('[data-test="mobile-reply-bar"]')?.getBoundingClientRect().toJSON() ?? null,
        messageMore: app.querySelector('[data-test="message-more"]')?.getBoundingClientRect().toJSON() ?? null,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      };
    })()`);
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.subject.top).toBeGreaterThanOrEqual(geometry.pane.top);
    expect(geometry.messages.bottom).toBeLessThanOrEqual(geometry.pane.bottom + geometry.scrollHeight);
    expect(geometry.bodySize).toBe('16px');
    expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.bottomTop);
    expect(geometry.replyBar).not.toBeNull();
    expect(geometry.replyBar!.height).toBeGreaterThanOrEqual(48);
    expect(geometry.replyBar!.bottom).toBeLessThanOrEqual(geometry.actionTop);
    expect(geometry.messageMore).not.toBeNull();
    expect(geometry.messageMore!.width).toBe(48);
    expect(geometry.messageMore!.height).toBe(48);
    await harness!.cdp.js(`(() => document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="reader-more"]').click())()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    const sheet = await harness!.cdp.js<{ panel: { top: number; bottom: number }; viewport: number; rows: Array<{ width: number; height: number }>; toolbar: Array<{ name: string | null; width: number; height: number }> }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      const panel = app.querySelector('[data-test="action-sheet"]').getBoundingClientRect();
      return {
        panel: { top: panel.top, bottom: panel.bottom },
        viewport: innerHeight,
        rows: [...app.querySelectorAll('[data-test="action-sheet"] button')].map(row => {
          const box = row.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
        toolbar: [...app.querySelectorAll('[data-test="reader-toolbar"] button')].map(button => {
          const box = button.getBoundingClientRect();
          return { name: button.getAttribute('data-test'), width: box.width, height: box.height };
        }),
      };
    })()`);
    expect(sheet.panel.top).toBeGreaterThanOrEqual(0);
    expect(sheet.panel.bottom).toBeLessThanOrEqual(sheet.viewport);
    expect(sheet.rows.length).toBeGreaterThan(0);
    for (const row of sheet.rows) expect(row.height).toBeGreaterThanOrEqual(48);
    expect(sheet.toolbar.map(button => button.name)).toEqual([
      'reader-star', 'reader-remind', 'reader-archive-toggle', 'reader-prev', 'reader-next', 'reader-more',
    ]);
    for (const button of sheet.toolbar) {
      expect(button.width).toBeGreaterThanOrEqual(48);
      expect(button.height).toBeGreaterThanOrEqual(48);
    }
    await harness!.cdp.js(`(() => document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="action-sheet"] button:not(:disabled)').click())()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    const closed = await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="action-sheet"]') === null`);
    expect(closed).toBe(true);
    await harness!.cdp.js(`(() => document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="message-more"]').click())()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    const messageMenu = await harness!.cdp.js<{ title: string | null; rows: number }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      const dialog = app.querySelector('[data-test="action-sheet"]');
      return { title: dialog.querySelector('h2')?.textContent ?? null, rows: dialog.querySelectorAll('button').length };
    })()`);
    expect(messageMenu.title).toBe('Ada Fixture');
    expect(messageMenu.rows).toBe(3);
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      app.querySelector('[data-test="action-sheet-scrim"]').click();
      app.querySelector('[data-test="reader-archive-toggle"]').click();
    })()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 500))');
    const notice = await harness!.cdp.js<{ rect: { top: number; bottom: number; left: number; right: number }; statusWidth: number; statusClient: number; undoHeight: number; replyTop: number; actionTop: number }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      const rect = element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right }; };
      const toast = app.querySelector('[data-test="action-notice"]');
      const status = toast.querySelector('[data-test="action-notice-status"]');
      return {
        rect: rect(toast),
        statusWidth: status.scrollWidth,
        statusClient: status.clientWidth,
        undoHeight: toast.querySelector('[data-test="action-notice-undo"]')?.getBoundingClientRect().height ?? 0,
        replyTop: app.querySelector('[data-test="mobile-reply-bar"]')?.getBoundingClientRect().top ?? innerHeight,
        actionTop: app.querySelector('[data-test="mobile-reader-actions"]').getBoundingClientRect().top,
      };
    })()`);
    expect(notice.rect.top).toBeGreaterThanOrEqual(0);
    expect(notice.rect.bottom).toBeLessThanOrEqual(notice.replyTop);
    expect(notice.rect.bottom).toBeLessThanOrEqual(notice.actionTop);
    expect(notice.statusWidth).toBeLessThanOrEqual(notice.statusClient);
    expect(notice.undoHeight).toBeGreaterThanOrEqual(48);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="action-notice-undo"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 400))');
    const restored = await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="action-notice-status"]')?.textContent ?? ''`);
    expect(restored).toMatch(/Restored|Restoring|Cancelled/);
  });
});
