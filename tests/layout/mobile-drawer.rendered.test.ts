// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_VIEWPORT, startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
const appSelector = '.workspace-panel:not([inert]) .app';
const pageRoot = new URL('../..', import.meta.url).pathname;

describe.skipIf(!chromePath)('compact navigation drawer (real Chromium)', () => {
  let harness: RenderedHarness | null = null;

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-mobile-drawer-', pageRoot, PHONE_VIEWPORT);
    await harness.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it.each([
    { width: 412, height: 915 },
    { width: 360, height: 800 },
  ])('keeps the drawer and its rows inside $width × $height', async ({ width, height }) => {
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
      mobile: true,
    });
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 220))');

    const geometry = await harness!.cdp.js<{
      drawer: { left: number; right: number; top: number; bottom: number; width: number; height: number };
      scrim: { left: number; right: number; top: number; bottom: number };
      rows: Array<{ height: number; textHeight: number; textLineHeight: number }>;
      overflow: number;
    }>(`(() => {
      const app = document.querySelector(${JSON.stringify(appSelector)});
      const box = element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const drawer = app.querySelector('[data-test="mobile-drawer"]');
      const scrim = app.querySelector('[data-test="mobile-drawer-scrim"]');
      const rows = [...drawer.querySelectorAll('.mobile-drawer-row')].map(row => {
        const text = row.querySelector('span').getBoundingClientRect();
        return { height: row.getBoundingClientRect().height, textHeight: text.height, textLineHeight: parseFloat(getComputedStyle(row).lineHeight) };
      });
      const overflow = [...drawer.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).length;
      return { drawer: box(drawer), scrim: box(scrim), rows, overflow };
    })()`);
    expect(geometry.drawer.left).toBeGreaterThanOrEqual(0);
    expect(geometry.drawer.right).toBeLessThanOrEqual(width);
    expect(geometry.drawer.width).toBeLessThanOrEqual(320);
    expect(geometry.drawer.top).toBeGreaterThanOrEqual(0);
    expect(geometry.drawer.bottom).toBeLessThanOrEqual(height);
    expect(geometry.scrim.left).toBe(0);
    expect(geometry.scrim.right).toBe(width);
    expect(geometry.rows.length).toBeGreaterThan(5);
    expect(geometry.rows.every(row => row.height >= 48 && row.textHeight <= row.textLineHeight + 1)).toBe(true);
    expect(geometry.overflow).toBe(0);

    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="mobile-drawer-scrim"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    expect(await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="mobile-drawer"]') === null`)).toBe(true);
  });

  it('opens Reminders from the drawer and Drafts hides it', async () => {
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(appSelector)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Reminders').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    expect(await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[role="tablist"][aria-label="Reminder membership"]') !== null`)).toBe(true);

    await harness!.cdp.js(`document.querySelector(${JSON.stringify(appSelector)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(appSelector)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Drafts').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    expect(await harness!.cdp.js(`getComputedStyle(document.querySelector(${JSON.stringify(appSelector)}).querySelector('.mobile-context-slot')).display`)).toBe('none');
  });
});
