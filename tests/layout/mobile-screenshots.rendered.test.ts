// @vitest-environment node
/**
 * Review screenshots of the compact (phone) layout, taken from the browser
 * preview in real Chromium. Not an assertion suite and not part of
 * `test:rendered`: it runs only when both EMAIL_OS_RENDERED_LAYOUT_CHROME and
 * EMAIL_OS_SCREENSHOT_DIR are set (`mise run screenshots:mobile`), and writes
 * one PNG per surface for a person to look at.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { PHONE_VIEWPORT, startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
const outputDir = process.env.EMAIL_OS_SCREENSHOT_DIR ?? '';
const pageRoot = new URL('../..', import.meta.url).pathname;
/** The preview mounts two workspaces; only the active one is visible. */
const activeApp = '.workspace-panel:not([inert]) .app';

describe.skipIf(!chromePath || !outputDir)('compact layout review screenshots', () => {
  let harness: RenderedHarness | null = null;

  beforeAll(async () => {
    mkdirSync(outputDir, { recursive: true });
    harness = await startRenderedHarness(chromePath, 'email-os-mobile-shots-', pageRoot, PHONE_VIEWPORT);
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  async function pause(ms = 250): Promise<void> {
    await harness!.cdp.js(`new Promise(resolve => setTimeout(resolve, ${ms}))`);
  }

  /** Wait until `expression` (evaluated in the active workspace) is truthy. */
  async function waitFor(expression: string, label: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await harness!.cdp.js<boolean>(`(() => {
        const app = document.querySelector(${JSON.stringify(activeApp)});
        if (!app) return false;
        return !!(${expression});
      })()`);
      if (ready) {
        await pause();
        return;
      }
      await pause(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function viewport(width: number, height: number, mobile: boolean): Promise<void> {
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: mobile ? PHONE_VIEWPORT.deviceScaleFactor : 1,
      mobile,
    });
  }

  /** Fresh preview state: reload and wait for the inbox rows. */
  async function freshInbox(): Promise<void> {
    await harness!.cdp.cmd('Page.navigate', { url: harness!.appUrl });
    await waitFor(`app.querySelector('.inbox-row')`, 'inbox rows');
  }

  async function click(selector: string): Promise<void> {
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(activeApp)});
      const target = app.querySelector(${JSON.stringify(selector)});
      if (!target) throw new Error('Missing ' + ${JSON.stringify(selector)});
      target.click();
    })()`);
    await pause();
  }

  async function longPressFirstRow(): Promise<void> {
    const point = await harness!.cdp.js<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector(${JSON.stringify(activeApp)}).querySelector('.inbox-row').getBoundingClientRect();
      return { x: rect.left + 28, y: rect.top + 20 };
    })()`);
    await harness!.cdp.cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await pause(600);
    await harness!.cdp.cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitFor(`app.querySelector('[data-test="selection-bar"]')`, 'selection bar');
  }

  async function swipeCue(name: string, direction: 'left' | 'right', distance: number): Promise<void> {
    await freshInbox();
    const point = await harness!.cdp.js<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector(${JSON.stringify(activeApp)}).querySelector('.inbox-row').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + Math.min(28, rect.height / 2) };
    })()`);
    await harness!.cdp.cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await harness!.cdp.cmd('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: point.x + (direction === 'left' ? -distance : distance), y: point.y, id: 1 }],
    });
    await shot(name);
    await harness!.cdp.cmd('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 1 }] });
    await harness!.cdp.cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await pause(180);
  }

  /** Activate a compact drawer destination by its short row label. */
  async function chooseDrawerRow(text: string): Promise<void> {
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(activeApp)});
      const row = [...app.querySelectorAll('.mobile-drawer-row')]
        .find(candidate => candidate.textContent.trim() === ${JSON.stringify(text)});
      if (!row) throw new Error('Missing drawer row ' + ${JSON.stringify(text)});
      row.click();
    })()`);
    await pause(400);
  }

  async function shot(name: string): Promise<void> {
    await pause();
    await harness!.saveScreenshot(`${outputDir}/${name}.png`);
  }

  it('captures the list surfaces', async () => {
    await viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height, true);
    await freshInbox();
    await shot('inbox');
    await longPressFirstRow();
    await shot('selection');
    await harness!.cdp.js('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))');
    await pause(150);

    await freshInbox();
    await click('.inbox-row');
    await waitFor(`app.querySelector('[data-test="mobile-reader-actions"] [data-test="reader-archive-toggle"]')`, 'reader archive action');
    await click('[data-test="reader-archive-toggle"]');
    await waitFor(`app.querySelector('[data-test="action-notice-undo"]')`, 'inbox Undo action');
    await click('[data-test="reader-close"]');
    await shot('inbox-undo-toast');
    await freshInbox();

    await harness!.cdp.js(`(() => {
      const list = document.querySelector(${JSON.stringify(activeApp)}).querySelector('.inbox-scroll');
      list.scrollTop = list.scrollHeight;
    })()`);
    await shot('inbox-scrolled-end');
  }, 120_000);

  it('captures the swipe cues while each row is held mid-gesture', async () => {
    await viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height, true);
    await freshInbox();
    const rowWidth = await harness!.cdp.js<number>(`document.querySelector(${JSON.stringify(activeApp)}).querySelector('.inbox-row').getBoundingClientRect().width`);
    await swipeCue('swipe-done', 'left', 80);
    await swipeCue('swipe-done-armed', 'left', rowWidth * 0.6);
    await swipeCue('swipe-remind-armed', 'right', rowWidth * 0.6);
  }, 120_000);

  it('captures the reader', async () => {
    await viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height, true);
    await freshInbox();
    await click('.inbox-row');
    await waitFor(`app.querySelector('[data-test="reader"] .message')`, 'reader messages');
    await shot('reader');

    await harness!.cdp.js(`(() => {
      const scroller = document.querySelector(${JSON.stringify(activeApp)}).querySelector('[data-test="reader-scroll"]');
      scroller.scrollTop = scroller.scrollHeight;
    })()`);
    await shot('reader-scrolled-end');
    await click('[data-test="message-more"]');
    await shot('reader-message-sheet');
    await harness!.cdp.js('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))');
    await pause(150);
    const messageSheetClosed = await harness!.cdp.js<boolean>(`document.querySelector(${JSON.stringify(activeApp)}).querySelector('[data-test="action-sheet"]') === null`);
    if (!messageSheetClosed) throw new Error('Message action sheet did not close before reader More screenshot');
    await click('[data-test="reader-more"]');
    await shot('reader-more-sheet');
    await freshInbox();
    await click('.inbox-row');
    await waitFor(`app.querySelector('[data-test="mobile-reader-actions"] [data-test="reader-archive-toggle"]')`, 'reader Mark done action');
    await click('[data-test="reader-archive-toggle"]');
    await waitFor(`app.querySelector('[data-test="action-notice-undo"]')`, 'reader Undo action');
    await shot('reader-undo-toast');
  }, 120_000);

  it('captures the overlays and secondary surfaces', async () => {
    await viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height, true);

    await freshInbox();
    await click('[data-test="mobile-menu"]');
    await shot('drawer');

    await chooseDrawerRow('Drafts');
    await shot('drafts');

    await freshInbox();
    await click('[data-test="mobile-menu"]');
    await chooseDrawerRow('Reminders');
    await shot('reminders');

    await freshInbox();
    await click('[data-test="mobile-compose"]');
    await shot('compose');
    await viewport(PHONE_VIEWPORT.width, 500, true);
    await shot('compose-keyboard');
    await viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height, true);
    await click('[data-test="compose-sheet-close"]');

    await freshInbox();
    await click('.inbox-row');
    await waitFor(`app.querySelector('[data-test="mobile-reply-bar"]')`, 'reader reply bar');
    await click('[data-test="mobile-reply-bar"]');
    await waitFor(`app.querySelector('[data-test="reply-composer"]')`, 'reply composer');
    await shot('reply');

    await freshInbox();
    await click('[data-test="mobile-search"]');
    await shot('search');

    await freshInbox();
    const accountAvailable = await harness!.cdp.js<boolean>(`(() => {
      const button = document.querySelector(${JSON.stringify(activeApp)})?.querySelector('[data-test="mobile-account"]');
      return !!button && !button.disabled;
    })()`);
    if (accountAvailable) {
      await click('[data-test="mobile-account"]');
      await waitFor(`app.querySelector('[data-test="utility-drawer"]')`, 'Account page');
      await shot('account');
    } else {
      rmSync(`${outputDir}/account.png`, { recursive: false, force: true });
    }

    await freshInbox();
    await click('[data-test="mobile-menu"]');
    await chooseDrawerRow('Activity');
    await shot('activity');

    await freshInbox();
    await click('[data-test="mobile-menu"]');
    await chooseDrawerRow('Settings');
    await shot('settings');

    await freshInbox();
    await click('[data-test="mobile-search"]');
    await harness!.cdp.js(`(() => { const input = document.querySelector(${JSON.stringify(activeApp)}).querySelector('[data-test="search-input"]'); input.value = 'from:ada'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector(${JSON.stringify(activeApp)}).querySelector('[data-test="search-submit"]').click(); })()`);
    await waitFor(`app.querySelector('[data-test="search-results-header"]')`, 'search results');
    await shot('search-results');

    await freshInbox();
    await click('[data-test="mobile-menu"]');
    await click('[data-test="mobile-drawer-commands"]');
    await shot('palette');

    await freshInbox();
    await click('.inbox-row');
    await click('[data-test="reader-more"]');
    await harness!.cdp.js(`(() => {
      const row = [...document.querySelectorAll(${JSON.stringify(activeApp)} + ' [data-test="action-sheet"] button')]
        .find(button => button.textContent.includes('Contact details'));
      if (!row) throw new Error('Missing Contact details action');
      row.click();
    })()`);
    await waitFor(`app.querySelector('[data-test="contact-disclosure-panel"]')`, 'Contact details page');
    await shot('contact');

    await freshInbox();
    await click('.inbox-row');
    await click('[data-test="reader-remind"]');
    await shot('reminder-picker');
  }, 180_000);

  it('captures the regular layout for comparison', async () => {
    await viewport(1200, 800, false);
    await freshInbox();
    await shot('desktop-inbox');

    await click('.inbox-row');
    await waitFor(`app.querySelector('[data-test="reader"] .message')`, 'reader messages');
    await shot('desktop-reader');
  }, 120_000);
});
