// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_VIEWPORT, startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
const workspaceApp = '.workspace-panel:not([inert]) .app';
const pageRoot = new URL('../..', import.meta.url).pathname;

describe.skipIf(!chromePath)('compact conversation rows (real Chromium)', () => {
  let harness: RenderedHarness | null = null;

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-mobile-list-', pageRoot, PHONE_VIEWPORT);
    await harness.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it.each([
    { width: 412, height: 915 },
    { width: 360, height: 800 },
  ])('stacks rows without overflow at $width × $height and opens on tap', async ({ width, height }) => {
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
      mobile: true,
    });
    await harness!.cdp.js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

    const rows = await harness!.cdp.js<Array<{
      sender: DOMRectReadOnly;
      subject: DOMRectReadOnly;
      preview: DOMRectReadOnly;
      time: DOMRectReadOnly;
      row: DOMRectReadOnly;
      actions: string;
      checkbox: string;
      unread: boolean;
      senderWeight: string;
      subjectWeight: string;
      paneRight: number;
    }>>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const pane = app.querySelector('.inbox-scroll');
      return [...app.querySelectorAll('.inbox-row')].slice(0, 5).map(row => {
      const rect = selector => {
        const box = row.querySelector(selector).getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      };
        const sender = row.querySelector('.row-sender');
        const subject = row.querySelector('.row-subject');
        const preview = row.querySelector('.row-preview');
        return {
          sender: rect('.row-sender'),
          subject: rect('.row-subject'),
          preview: rect('.row-preview'),
          time: rect('.row-time'),
          row: (() => {
            const box = row.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
          })(),
          actions: getComputedStyle(row.querySelector('.row-actions')).display,
          checkbox: getComputedStyle(row.querySelector('.row-select')).display,
          unread: row.querySelector('[data-test="row-unread"]') !== null,
          senderWeight: getComputedStyle(sender).fontWeight,
          subjectWeight: getComputedStyle(subject).fontWeight,
          paneRight: pane.getBoundingClientRect().right,
        };
      });
    })()`);

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.sender.top).toBeLessThan(row.subject.top);
      expect(row.subject.top).toBeLessThan(row.preview.top);
      expect(Math.abs(row.time.top - row.sender.top)).toBeLessThanOrEqual(2);
      expect(row.time.left).toBeGreaterThan(row.sender.left);
      expect(row.preview.height).toBeLessThanOrEqual(40);
      expect(row.row.height).toBeGreaterThanOrEqual(72);
      expect(row.row.right).toBeLessThanOrEqual(row.paneRight + 1);
      expect(row.actions).toBe('none');
      expect(row.checkbox).toBe('none');
      if (row.unread) {
        expect(row.senderWeight).toBe('600');
        expect(row.subjectWeight).toBe('600');
      }
    }

    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-01"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    expect(await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="reader-close"]') !== null`)).toBe(true);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="reader-close"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
  });
});
