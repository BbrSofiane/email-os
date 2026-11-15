// @vitest-environment node
import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_VIEWPORT, startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

interface FrameRect {
  x: number;
  y: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface FrameMeasure {
  layout: string | undefined;
  overflow: boolean;
  top: FrameRect | null;
  bottom: FrameRect | null;
  buttons: FrameRect[];
}

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';

describe.skipIf(!chromePath)('compact shell geometry', () => {
  let harness: RenderedHarness | null = null;

  beforeAll(async () => {
    harness = await startRenderedHarness(
      chromePath,
      'email-os-mobile-shell-',
      new URL('../..', import.meta.url).pathname,
      PHONE_VIEWPORT,
    );
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it.each([
    { width: 412, height: 915 },
    { width: 360, height: 800 },
  ])('keeps frame in bounds at $width × $height', async ({ width, height }) => {
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
      mobile: true,
    });
    await harness!.cdp.js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

    const measure = await harness!.cdp.js<FrameMeasure>(`(() => {
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      };
      const top = document.querySelector('[data-test="mobile-top-bar"]');
      const bottom = document.querySelector('[data-test="mobile-bottom-region"]');
      const buttons = [...document.querySelectorAll('[data-test="mobile-top-bar"] button, [data-test="mobile-bottom-region"] button')]
        .filter((button) => button.getClientRects().length)
        .map(rect);
      return {
        layout: document.querySelector('.app')?.dataset.layout,
        overflow: document.documentElement.scrollWidth > innerWidth,
        top: top ? rect(top) : null,
        bottom: bottom ? rect(bottom) : null,
        buttons,
      };
    })()`);

    expect(measure.layout).toBe('compact');
    expect(measure.overflow).toBe(false);
    expect(measure.top).not.toBeNull();
    expect(measure.bottom).not.toBeNull();
    expect(measure.top!.bottom).toBeLessThan(measure.bottom!.y);

    for (const button of measure.buttons) {
      expect(button.width).toBeGreaterThanOrEqual(48);
      expect(button.height).toBeGreaterThanOrEqual(48);
    }
  });

  it('writes the inbox review screenshot when enabled', async () => {
    const directory = process.env.EMAIL_OS_SCREENSHOT_DIR;
    if (!directory) {
      return;
    }

    mkdirSync(directory, { recursive: true });
    await harness!.saveScreenshot(`${directory}/inbox.png`);
  });
});
