// @vitest-environment node
/**
 * Review screenshots of the compact (phone) layout, taken from the browser
 * preview in real Chromium. Not an assertion suite and not part of
 * `test:rendered`: it runs only when both EMAIL_OS_RENDERED_LAYOUT_CHROME and
 * EMAIL_OS_SCREENSHOT_DIR are set (`mise run screenshots:mobile`), and writes
 * one PNG per surface for a person to look at.
 */
import { mkdirSync } from 'node:fs';
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

  /** Activate the overlay option whose label contains `text` (overlays render outside <main>). */
  async function chooseOverlayOption(text: string): Promise<void> {
    await harness!.cdp.js(`(() => {
      const app = document.querySelector(${JSON.stringify(activeApp)});
      const option = [...app.querySelectorAll('[role="option"]')]
        .find(candidate => candidate.textContent.includes(${JSON.stringify(text)}));
      if (!option) throw new Error('Missing overlay option ' + ${JSON.stringify(text)});
      option.click();
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

    await harness!.cdp.js(`(() => {
      const list = document.querySelector(${JSON.stringify(activeApp)}).querySelector('.inbox-scroll');
      list.scrollTop = list.scrollHeight;
    })()`);
    await shot('inbox-scrolled-end');
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
  }, 120_000);

  it('captures the overlays and secondary surfaces', async () => {
    await viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height, true);

    await freshInbox();
    await click('[data-test="mobile-menu"]');
    await shot('destinations-overlay');

    await chooseOverlayOption('Drafts');
    await shot('drafts');

    await freshInbox();
    await click('[data-test="mobile-menu"]');
    await chooseOverlayOption('Reminders');
    await shot('reminders');

    await freshInbox();
    await click('[data-test="mobile-compose"]');
    await shot('compose');

    await freshInbox();
    await click('[data-test="mobile-search"]');
    await shot('search');

    await freshInbox();
    await click('[data-test="mobile-account"]');
    await shot('account');
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
