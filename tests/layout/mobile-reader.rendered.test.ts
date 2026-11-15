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
    const geometry = await harness!.cdp.js<{ width: number; viewport: number; pane: { top: number; bottom: number }; subject: { top: number; bottom: number }; messages: { top: number; bottom: number }; bodySize: string | null; lastBottom: number; bottomTop: number; scrollHeight: number; clientHeight: number }>(`(() => {
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
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      };
    })()`);
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.subject.top).toBeGreaterThanOrEqual(geometry.pane.top);
    expect(geometry.messages.bottom).toBeLessThanOrEqual(geometry.pane.bottom + geometry.scrollHeight);
    expect(geometry.bodySize).toBe('16px');
    expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.bottomTop);
  });
});
