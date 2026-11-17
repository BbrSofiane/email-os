// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_VIEWPORT, startRenderedHarness, type RenderedHarness } from '../rendered/chromium';
import { pressRenderedKey } from '../rendered/keyboard';

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
    const geometry = await harness!.cdp.js<{ width: number; viewport: number; pane: { top: number; bottom: number }; subject: { top: number; bottom: number; left: number }; statusLeft: number | null; readStateLeft: number | null; firstSenderLeft: number; messages: { top: number; bottom: number }; bodySize: string | null; archiveColor: string; previousOpacity: string; previousColor: string; lastBottom: number; bottomTop: number; actionTop: number; replyBar: { top: number; bottom: number; height: number } | null; messageMore: { width: number; height: number } | null; headerLines: Array<{ senderCenter: number; senderRight: number; dateCenter: number; dateLeft: number }>; scrollHeight: number; clientHeight: number }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      const pane = app.querySelector('.reader-pane').getBoundingClientRect();
      const subject = app.querySelector('.reader-subject').getBoundingClientRect();
      const status = app.querySelector('[data-test="reader-meta-row"]');
      const statusText = status?.querySelector('[data-test="reader-status-word"]') ?? status;
      const firstSender = app.querySelector('.message-from').getBoundingClientRect();
      const messages = app.querySelector('.messages').getBoundingClientRect();
      const scroller = app.querySelector('[data-test="reader-scroll"]');
      const last = app.querySelector('.message:last-child').getBoundingClientRect();
      const body = app.querySelector('.message-body');
      return {
        width: document.documentElement.scrollWidth,
        viewport: innerWidth,
        pane: { top: pane.top, bottom: pane.bottom },
        subject: { top: subject.top, bottom: subject.bottom, left: subject.left },
        statusLeft: statusText ? statusText.getBoundingClientRect().left : null,
        readStateLeft: app.querySelector('[data-test="reader-read-state"]')?.getBoundingClientRect().left ?? null,
        firstSenderLeft: firstSender.left,
        messages: { top: messages.top, bottom: messages.bottom },
        bodySize: body ? getComputedStyle(body).fontSize : null,
        archiveColor: getComputedStyle(app.querySelector('[data-test="reader-archive-toggle"]')).color,
        previousOpacity: getComputedStyle(app.querySelector('[data-test="reader-prev"]')).opacity,
        previousColor: getComputedStyle(app.querySelector('[data-test="reader-prev"]')).color,
        lastBottom: last.bottom,
        bottomTop: app.querySelector('[data-test="mobile-bottom-region"]').getBoundingClientRect().top,
        actionTop: app.querySelector('[data-test="mobile-reader-actions"]').getBoundingClientRect().top,
        replyBar: app.querySelector('[data-test="mobile-reply-bar"]')?.getBoundingClientRect().toJSON() ?? null,
        messageMore: app.querySelector('[data-test="message-more"]')?.getBoundingClientRect().toJSON() ?? null,
        headerLines: [...app.querySelectorAll('.message')].map(message => {
          const sender = message.querySelector('.message-from').getBoundingClientRect();
          const date = message.querySelector('.message-time').getBoundingClientRect();
          return { senderCenter: (sender.top + sender.bottom) / 2, senderRight: sender.right, dateCenter: (date.top + date.bottom) / 2, dateLeft: date.left };
        }),
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      };
    })()`);
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.subject.top).toBeGreaterThanOrEqual(geometry.pane.top);
    if (geometry.statusLeft !== null) {
      expect(Math.abs(geometry.subject.left - geometry.statusLeft)).toBeLessThanOrEqual(1);
    }
    if (geometry.readStateLeft !== null) {
      expect(Math.abs(geometry.subject.left - geometry.readStateLeft)).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(geometry.subject.left - geometry.firstSenderLeft)).toBeLessThanOrEqual(1);
    expect(geometry.messages.bottom).toBeLessThanOrEqual(geometry.pane.bottom + geometry.scrollHeight);
    expect(geometry.bodySize).toBe('16px');
    expect(geometry.archiveColor).toBe('rgb(187, 165, 237)');
    expect(geometry.previousOpacity).toBe('1');
    expect(geometry.previousColor).toBe('rgb(142, 138, 135)');
    expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.bottomTop);
    for (const line of geometry.headerLines) {
      expect(Math.abs(line.senderCenter - line.dateCenter)).toBeLessThanOrEqual(3);
      expect(line.dateLeft).toBeGreaterThan(line.senderRight);
    }
    expect(geometry.replyBar).not.toBeNull();
    expect(geometry.replyBar!.height).toBeGreaterThanOrEqual(48);
    expect(Math.abs((geometry.actionTop - geometry.replyBar!.bottom) - 12)).toBeLessThanOrEqual(1);
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
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="reader-more"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      const row = [...app.querySelectorAll('[data-test="action-sheet"] button')].find(button => button.textContent.includes('Contact details'));
      if (!row) throw new Error('Missing Contact details action');
      row.click();
    })()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    const contactPage = await harness!.cdp.js<{ exists: boolean; text: string; coversTop: boolean; readerOpen: boolean; pageRect: DOMRectReadOnly; appRect: DOMRectReadOnly }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      const page = app.querySelector('[data-test="contact-disclosure-panel"]');
      const pageRect = page?.getBoundingClientRect();
      const topLeft = document.elementFromPoint(pageRect.left + 3, pageRect.top + 3);
      const topRight = document.elementFromPoint(pageRect.right - 3, pageRect.top + 3);
      return {
        exists: !!page,
        text: page?.textContent ?? '',
        coversTop: !!page && page.contains(topLeft) && page.contains(topRight),
        readerOpen: !!app.querySelector('[data-test="reader"]'),
        pageRect: pageRect && { top: pageRect.top, left: pageRect.left, right: pageRect.right, bottom: pageRect.bottom },
        appRect: (() => { const rect = app.getBoundingClientRect(); return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom }; })(),
      };
    })()`);
    expect(contactPage.exists).toBe(true);
    expect(contactPage.text).toContain('Ada Fixture');
    expect(contactPage.coversTop, JSON.stringify(contactPage)).toBe(true);
    expect(contactPage.readerOpen).toBe(true);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="contact-disclosure-close"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    expect(await harness!.cdp.js(`!!document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="reader"]')`)).toBe(true);
    await harness!.cdp.js(`(() => document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="message-more"]').click())()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    const messageMenu = await harness!.cdp.js<{ title: string | null; rows: number; panelBottom: number; appBottom: number; rowBounds: Array<{ top: number; bottom: number }>; protectedPoints: boolean[] }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      const dialog = app.querySelector('[data-test="action-sheet"]');
      const rect = element => element.getBoundingClientRect();
      const panel = rect(dialog);
      const appRect = rect(app);
      const points = [app.querySelector('[data-test="mobile-reply-bar"]'), app.querySelector('[data-test="mobile-reader-actions"]')];
      return {
        title: dialog.querySelector('h2')?.textContent ?? null,
        rows: dialog.querySelectorAll('button').length,
        panelBottom: panel.bottom,
        appBottom: appRect.bottom,
        rowBounds: [...dialog.querySelectorAll('button')].map(row => ({ top: rect(row).top, bottom: rect(row).bottom })),
        protectedPoints: points.map(element => {
          const box = rect(element);
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return !!hit && (dialog.contains(hit) || app.querySelector('[data-test="action-sheet-scrim"]').contains(hit));
        }),
      };
    })()`);
    expect(messageMenu.title).toBe('Ada Fixture');
    expect(messageMenu.rows).toBe(3);
    expect(Math.abs(messageMenu.panelBottom - messageMenu.appBottom)).toBeLessThanOrEqual(1);
    expect(messageMenu.protectedPoints.every(Boolean)).toBe(true);
    for (const row of messageMenu.rowBounds) {
      expect(row.top).toBeGreaterThanOrEqual(0);
      expect(row.bottom).toBeLessThanOrEqual(height);
    }
    await pressRenderedKey(harness!.cdp, 'Escape');
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    const escapeState = await harness!.cdp.js<{ sheet: boolean; reader: boolean }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      return { sheet: !!app.querySelector('[data-test="action-sheet"]'), reader: !!app.querySelector('[data-test="reader"]') };
    })()`);
    expect(escapeState.sheet).toBe(false);
    expect(escapeState.reader).toBe(true);
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      app.querySelector('[data-test="reader-archive-toggle"]').click();
    })()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 500))');
    const notice = await harness!.cdp.js<{ rect: { top: number; bottom: number; left: number; right: number }; statusWidth: number; statusClient: number; undoHeight: number; replyTop: number; actionTop: number; visibleKeycaps: number }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      const rect = element => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right }; };
      const toast = app.querySelector('[data-test="action-notice"]');
      const status = toast.querySelector('[data-test="action-notice-status"]');
      const visibleKeycaps = [...app.querySelectorAll('.list-dock kbd')].filter(keycap => {
        const box = keycap.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }).length;
      return {
        rect: rect(toast),
        statusWidth: status.scrollWidth,
        statusClient: status.clientWidth,
        undoHeight: toast.querySelector('[data-test="action-notice-undo"]')?.getBoundingClientRect().height ?? 0,
        replyTop: app.querySelector('[data-test="mobile-reply-bar"]')?.getBoundingClientRect().top ?? innerHeight,
        actionTop: app.querySelector('[data-test="mobile-reader-actions"]').getBoundingClientRect().top,
        visibleKeycaps,
      };
    })()`);
    expect(notice.rect.top).toBeGreaterThanOrEqual(0);
    expect(notice.rect.bottom).toBeLessThanOrEqual(notice.replyTop);
    expect(notice.rect.bottom).toBeLessThanOrEqual(notice.actionTop);
    expect(notice.statusWidth).toBeLessThanOrEqual(notice.statusClient);
    expect(notice.undoHeight).toBeGreaterThanOrEqual(48);
    expect(notice.visibleKeycaps).toBe(0);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="action-notice-undo"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 400))');
    const restored = await harness!.cdp.js<{ action: string; noticeHeight: number }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      return {
        action: app.querySelector('[data-test="reader-archive-toggle"]').textContent.trim(),
        noticeHeight: app.querySelector('[data-test="action-notice"]').getBoundingClientRect().height,
      };
    })()`);
    expect(restored.action).toBe('Mark done (E)');
    expect(restored.noticeHeight).toBe(0);
  });
});
