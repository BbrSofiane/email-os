// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_VIEWPORT, startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
const appSelector = '.workspace-panel:not([inert]) .app';
const pageRoot = new URL('../..', import.meta.url).pathname;

describe.skipIf(!chromePath)('compact reduced motion (real Chromium)', () => {
  let harness: RenderedHarness | null = null;

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-mobile-reduced-motion-', pageRoot, PHONE_VIEWPORT);
    await harness.cdp.cmd('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await harness.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('disables row, drawer, and message sheet motion', async () => {
    const rowTransition = await harness!.cdp.js<string>(`getComputedStyle(document.querySelector(${JSON.stringify(appSelector)}).querySelector('.row-sender')).transitionDuration`);
    expect(rowTransition).toBe('0s');

    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    const drawerTransition = await harness!.cdp.js<string>(`getComputedStyle(document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="mobile-drawer"]')).transitionDuration`);
    expect(drawerTransition).toBe('0s');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="mobile-drawer-scrim"]').click()`);

    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="conversation-row-conv-01"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="reader-more"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    const sheetAnimation = await harness!.cdp.js<string>(`getComputedStyle(document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="action-sheet"]')).animationName`);
    expect(sheetAnimation).toBe('none');
  });
});
