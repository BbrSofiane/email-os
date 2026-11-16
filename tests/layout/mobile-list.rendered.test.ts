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

  async function touch(type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number, y?: number): Promise<void> {
    await harness!.cdp.cmd('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
    });
  }

  async function swipeRow(selector: string, deltaX: number, deltaY = 0): Promise<void> {
    const start = await harness!.cdp.js<{ x: number; y: number }>(`(() => {
      const row = document.querySelector(${JSON.stringify(workspaceApp)}).querySelector(${JSON.stringify(selector)});
      const rect = row.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + Math.min(28, rect.height / 2) };
    })()`);
    await touch('touchStart', start.x, start.y);
    await touch('touchMove', start.x + deltaX * 0.35, start.y + deltaY * 0.35);
    await touch('touchMove', start.x + deltaX * 0.7, start.y + deltaY * 0.7);
    await touch('touchMove', start.x + deltaX, start.y + deltaY);
    await touch('touchEnd');
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 300))');
  }

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
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-01"]').focus()`);

    const rows = await harness!.cdp.js<Array<{
      sender: DOMRectReadOnly;
      subject: DOMRectReadOnly;
      preview: DOMRectReadOnly;
      time: DOMRectReadOnly;
      timeVisibility: string;
      timeText: string;
      row: DOMRectReadOnly;
      actions: string;
      checkbox: string;
      unread: boolean;
      senderWeight: string;
      subjectWeight: string;
      paneRight: number;
      unreadDot: { centerX: number; centerY: number } | null;
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
        const dot = row.querySelector('[data-test="row-unread"]');
        return {
          sender: rect('.row-sender'),
          subject: rect('.row-subject'),
          preview: rect('.row-preview'),
          time: rect('.row-time'),
          timeVisibility: getComputedStyle(row.querySelector('.row-time')).visibility,
          timeText: row.querySelector('.row-time').textContent.trim(),
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
          unreadDot: dot ? (() => {
            const box = dot.getBoundingClientRect();
            return { centerX: box.left + box.width / 2, centerY: box.top + box.height / 2 };
          })() : null,
        };
      });
    })()`);

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.sender.top).toBeLessThan(row.subject.top);
      expect(row.subject.top).toBeLessThan(row.preview.top);
      expect(Math.abs(row.time.top - row.sender.top)).toBeLessThanOrEqual(2);
      expect(row.time.left).toBeGreaterThan(row.sender.left);
      expect(row.timeVisibility).toBe('visible');
      expect(row.time.width).toBeGreaterThan(0);
      expect(row.time.height).toBeGreaterThan(0);
      expect(row.timeText).not.toBe('');
      expect(row.preview.height).toBeLessThanOrEqual(40);
      expect(row.row.height).toBeGreaterThanOrEqual(72);
      expect(row.row.right).toBeLessThanOrEqual(row.paneRight + 1);
      expect(row.actions).toBe('none');
      expect(row.checkbox).toBe('none');
      if (row.unread) {
        expect(row.senderWeight).toBe('600');
        expect(row.subjectWeight).toBe('600');
        expect(row.unreadDot).not.toBeNull();
        expect(Math.abs(row.unreadDot!.centerX - (row.row.left + 10))).toBeLessThanOrEqual(2);
        expect(Math.abs(row.unreadDot!.centerY - (row.sender.top + 10))).toBeLessThanOrEqual(2);
      }
    }

    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-01"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    expect(await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="reader-close"]') !== null`)).toBe(true);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="reader-close"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
  });

  it.each([
    { width: 412, height: 915 },
    { width: 360, height: 800 },
  ])('positions the split pill above navigation at $width × $height', async ({ width, height }) => {
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
      mobile: true,
    });
    await harness!.cdp.js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-mail"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 120))');

    const pill = await harness!.cdp.js<{
      visible: boolean;
      slot: { top: number; bottom: number; left: number; right: number; width: number; height: number };
      nav: { top: number; bottom: number };
      background: string;
      slotCenter: number;
      tabs: Array<{ width: number; height: number; top: number; bottom: number; weight: string; current: boolean }>;
    }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const box = element => {
        const r = element.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
      };
      const slot = app.querySelector('.mobile-context-slot');
      const nav = app.querySelector('.mobile-navigation');
      return {
        visible: getComputedStyle(slot).display !== 'none' && slot.getClientRects().length > 0,
        slot: box(slot),
        nav: box(nav),
        background: getComputedStyle(slot).backgroundColor,
        slotCenter: box(slot).top + box(slot).height / 2,
        tabs: [...slot.querySelectorAll('.split-tab')].map(tab => ({
          ...box(tab),
          weight: getComputedStyle(tab).fontWeight,
          current: tab.getAttribute('aria-current') === 'page' || tab.getAttribute('aria-selected') === 'true',
        })),
      };
    })()`);
    expect(pill.visible).toBe(true);
    expect(pill.slot.top).toBeGreaterThanOrEqual(0);
    expect(pill.slot.bottom).toBeLessThanOrEqual(height);
    expect(pill.slot.bottom + 12).toBeCloseTo(pill.nav.top, 0);
    expect(pill.tabs.length).toBeGreaterThan(0);
    expect(pill.tabs.every(tab => tab.width >= 48 && tab.height >= 48)).toBe(true);
    expect(pill.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(pill.tabs.every(tab => Math.abs((tab.top + tab.bottom) / 2 - pill.slotCenter) <= 2)).toBe(true);
    expect(pill.tabs.find(tab => tab.current)?.weight).toBe('600');
    expect(pill.nav.bottom).toBeLessThanOrEqual(height);

    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="rail-drafts"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    expect(await harness!.cdp.js(`getComputedStyle(document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('.mobile-context-slot')).display`)).toBe('none');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-menu"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 100))');
    await harness!.cdp.js(`[...document.querySelectorAll(${JSON.stringify(workspaceApp)} + ' .mobile-drawer-row')].find(row => row.textContent.trim() === 'Reminders').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    const reminderTabs = await harness!.cdp.js<Array<{ top: number; bottom: number; pillCenter: number }>>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const pill = app.querySelector('.mobile-context-slot').getBoundingClientRect();
      return [...app.querySelectorAll('[role="tablist"] .split-tab')].map(tab => {
        const rect = tab.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, pillCenter: pill.top + pill.height / 2 };
      });
    })()`);
    expect(reminderTabs.length).toBe(3);
    expect(reminderTabs.every(tab => Math.abs((tab.top + tab.bottom) / 2 - tab.pillCenter) <= 2)).toBe(true);
  });

  it('swipes to Mark done and Undo, opens Remind, and preserves vertical scrolling', async () => {
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width: 412,
      height: 915,
      screenWidth: 412,
      screenHeight: 915,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
      mobile: true,
    });
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-mail"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');

    const first = await harness!.cdp.js<{ left: number; width: number }>(`(() => {
      const row = document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-01"]');
      const rect = row.getBoundingClientRect();
      return { left: rect.left, width: rect.width };
    })()`);
    await swipeRow('[data-test="conversation-row-conv-01"]', -first.width * 0.6);
    expect(await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-01"]') === null`)).toBe(true);
    expect(await harness!.cdp.js(`!!document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="action-notice"]')`)).toBe(true);
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="action-notice-undo"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 300))');
    expect(await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-01"]') !== null`)).toBe(true);

    await swipeRow('[data-test="conversation-row-conv-01"]', 150);
    expect(await harness!.cdp.js(`document.querySelector('[data-reminder-picker]') !== null`)).toBe(true);

    await harness!.cdp.js('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))');
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');
    const before = await harness!.cdp.js<number>(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('.inbox-scroll').scrollTop`);
    await swipeRow('[data-test="conversation-row-conv-02"]', 4, -110);
    const after = await harness!.cdp.js<number>(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('.inbox-scroll').scrollTop`);
    expect(after).toBeGreaterThan(before);
  });

  it.each([
    { width: 412, height: 915 },
    { width: 360, height: 800 },
  ])('selects on long press and keeps the selection pill clear at $width × $height', async ({ width, height }) => {
    await harness!.cdp.cmd('Page.navigate', { url: harness!.appUrl });
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 250))');
    await harness!.cdp.cmd('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
      mobile: true,
    });
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="mobile-mail"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 300))');
    const start = await harness!.cdp.js<{ x: number; y: number }>(`(() => {
      const row = document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-01"]');
      const rect = row.getBoundingClientRect();
      return { x: rect.left + 30, y: rect.top + 20 };
    })()`);
    const selectionStyles = await harness!.cdp.js<{ row: string; child: string }>(`(() => {
      const row = document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-01"]');
      return {
        row: getComputedStyle(row).userSelect,
        child: getComputedStyle(row.querySelector('.row-preview')).userSelect,
      };
    })()`);
    expect(selectionStyles).toEqual({ row: 'none', child: 'none' });
    await touch('touchStart', start.x, start.y);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 600))');
    await touch('touchEnd');
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 200))');

    const measure = await harness!.cdp.js<{
      selected: boolean;
      checkbox: { width: number; height: number; opacity: string };
      selectedRows: Array<{
        checkbox: { left: number; right: number; top: number; bottom: number; width: number };
        visualWidth: number;
        contentOverlaps: boolean[];
        unreadVisible: boolean;
      }>;
      bar: { top: number; bottom: number; left: number; right: number };
      bottomRegion: { top: number; left: number; right: number };
      context: { top: number; bottom: number; visible: boolean };
      buttons: Array<{ width: number; height: number }>;
    }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const box = element => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
      };
      const bar = app.querySelector('[data-test="selection-bar"]');
      const checkbox = app.querySelector('[data-test="row-select-conv-01"]');
      const bottom = app.querySelector('[data-test="mobile-bottom-region"]');
      const context = app.querySelector('.mobile-context-slot');
      const selectedRows = [...app.querySelectorAll('.inbox-row')].slice(0, 3).map(row => {
        const rowBox = element => {
          const rect = row.querySelector(element).getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
        };
        const input = row.querySelector('.row-select');
        const checkboxBox = rowBox('.row-select');
        const overlaps = selector => {
          const content = rowBox(selector);
          return checkboxBox.left < content.right && checkboxBox.right > content.left && checkboxBox.top < content.bottom && checkboxBox.bottom > content.top;
        };
        return {
          checkbox: checkboxBox,
          visualWidth: Number.parseFloat(getComputedStyle(input, '::before').width),
          contentOverlaps: ['.row-sender', '.row-subject', '.row-preview'].map(overlaps),
          unreadVisible: row.querySelector('[data-test="row-unread"]')?.getClientRects().length > 0,
        };
      });
      return {
        selected: app.querySelector('[data-test="selection-count"]')?.textContent.includes('1 selected') ?? false,
        checkbox: { ...box(checkbox), opacity: getComputedStyle(checkbox).opacity },
        selectedRows,
        bar: box(bar),
        bottomRegion: box(bottom),
        context: { ...box(context), visible: context.getClientRects().length > 0 && getComputedStyle(context).display !== 'none' },
        buttons: [...bar.querySelectorAll('button')].map(box),
      };
    })()`);
    expect(measure.selected).toBe(true);
    expect(await harness!.cdp.js('window.getSelection().toString()')).toBe('');
    expect(measure.checkbox.width).toBeGreaterThanOrEqual(48);
    expect(measure.checkbox.height).toBeGreaterThanOrEqual(48);
    expect(measure.checkbox.opacity).toBe('1');
    expect(measure.selectedRows).toHaveLength(3);
    for (const row of measure.selectedRows) {
      expect(row.contentOverlaps).toEqual([false, false, false]);
      expect(row.visualWidth).toBeLessThanOrEqual(24);
      expect(row.unreadVisible).toBe(false);
    }
    expect(measure.bar.top).toBeGreaterThanOrEqual(0);
    expect(measure.bar.left).toBeGreaterThanOrEqual(measure.bottomRegion.left - 1);
    expect(measure.bar.right).toBeLessThanOrEqual(measure.bottomRegion.right + 1);
    expect(measure.context.visible).toBe(true);
    expect(measure.context.top - measure.bar.bottom).toBeGreaterThanOrEqual(8);
    expect(measure.context.top - measure.bar.bottom).toBeLessThanOrEqual(16);
    expect(measure.buttons.every(button => button.width >= 48 && button.height >= 48)).toBe(true);

    const second = await harness!.cdp.js<{ x: number; y: number }>(`(() => {
      const row = document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-02"]');
      const rect = row.getBoundingClientRect();
      return { x: rect.left + 30, y: rect.top + 20 };
    })()`);
    await touch('touchStart', second.x, second.y);
    await touch('touchEnd');
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 120))');
    expect(await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="selection-count"]').textContent`)).toContain('2 selected');
    await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="selection-clear"]').click()`);
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 120))');
    expect(await harness!.cdp.js(`document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="selection-bar"]') === null`)).toBe(true);
  });
});
