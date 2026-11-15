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
});
