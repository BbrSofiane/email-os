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

  it('shows neutral and armed swipe cues during a drag', async () => {
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

    const row = await harness!.cdp.js<{ left: number; width: number; y: number }>(`(() => {
      const row = document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('[data-test="conversation-row-conv-01"]');
      const rect = row.getBoundingClientRect();
      return { left: rect.left, width: rect.width, y: rect.top + 24 };
    })()`);
    const startX = row.left + row.width / 2;
    await touch('touchStart', startX, row.y);
    await touch('touchMove', startX - 40, row.y);
    await harness!.cdp.js('new Promise(resolve => requestAnimationFrame(resolve))');
    const restingCue = await harness!.cdp.js<{ classes: string; transition: string }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const row = app.querySelector('[data-test="conversation-row-conv-01"]');
      const cue = row.querySelector('.row-swipe-underlay');
      return { classes: cue.className, transition: getComputedStyle(row.querySelector('.row-sender')).transitionDuration };
    })()`);
    expect(restingCue.classes.split(' ')).toContain('done');
    expect(restingCue.classes.split(' ')).not.toContain('armed');
    expect(restingCue.transition).toBe('0s');

    await touch('touchMove', startX - row.width * 0.3, row.y);
    await harness!.cdp.js('new Promise(resolve => requestAnimationFrame(resolve))');
    await touch('touchMove', startX - row.width * 0.6, row.y);
    await harness!.cdp.js('new Promise(resolve => requestAnimationFrame(resolve))');
    await harness!.cdp.js('new Promise(resolve => setTimeout(resolve, 150))');
    const armedDone = await harness!.cdp.js<{ classes: string; background: string }>(`(() => {
      const cue = document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('.row-swipe-underlay');
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.fillStyle = getComputedStyle(cue).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
      return { classes: cue.className, background: 'rgb(' + red + ', ' + green + ', ' + blue + ')' };
    })()`);
    expect(armedDone.classes.split(' ')).toContain('armed');
    expect(armedDone.background).toBe('rgb(187, 165, 237)');
    await touch('touchMove', startX, row.y);
    await touch('touchEnd');

    await touch('touchStart', startX, row.y);
    await touch('touchMove', startX + 40, row.y);
    await harness!.cdp.js('new Promise(resolve => requestAnimationFrame(resolve))');
    const armedRemind = await harness!.cdp.js<{ classes: string; background: string }>(`(() => {
      const cue = document.querySelector(${JSON.stringify(workspaceApp)}).querySelector('.row-swipe-underlay');
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.fillStyle = getComputedStyle(cue).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
      return { classes: cue.className, background: 'rgb(' + red + ', ' + green + ', ' + blue + ')' };
    })()`);
    expect(armedRemind.classes.split(' ')).toContain('remind');
    expect(armedRemind.classes.split(' ')).not.toContain('armed');
    expect(armedRemind.background).toBe('rgb(71, 70, 68)');
    await touch('touchMove', startX, row.y);
    await touch('touchEnd');
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
      barHeight: number;
      clearButton: { width: number; height: number; first: boolean };
      primaryBackground: string;
      barBackground: string;
      buttonLayouts: Array<{ left: number; right: number; top: number; bottom: number; width: number; height: number; scrollWidth: number; clientWidth: number }>;
      navigationPill: { left: number; right: number };
      bottomRegion: { top: number; left: number; right: number };
      context: { top: number; bottom: number; visible: boolean };
      buttons: Array<{ id: string | null; width: number; height: number }>;
      rowBackgrounds: string[];
    }>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      const box = element => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
      };
      const bar = app.querySelector('[data-test="selection-bar"]');
      const barBox = box(bar);
      const checkbox = app.querySelector('[data-test="row-select-conv-01"]');
      const bottom = app.querySelector('[data-test="mobile-bottom-region"]');
      const navigation = app.querySelector('.mobile-navigation');
      const clear = bar.querySelector('[data-test="selection-clear"]');
      const primary = bar.querySelector('.selection-row-primary > button:not([data-test="selection-clear"])');
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
        bar: barBox,
        barHeight: barBox.bottom - barBox.top,
        clearButton: { ...box(clear), first: bar.querySelector('button') === clear },
        primaryBackground: getComputedStyle(primary).backgroundColor,
        barBackground: getComputedStyle(bar).backgroundColor,
        buttonLayouts: [...bar.querySelectorAll('button')].map(button => ({ ...box(button), scrollWidth: button.scrollWidth, clientWidth: button.clientWidth })),
        navigationPill: { left: box(navigation).left, right: box(navigation).right },
        bottomRegion: box(bottom),
        context: { ...box(context), visible: context.getClientRects().length > 0 && getComputedStyle(context).display !== 'none' },
        buttons: [...bar.querySelectorAll('button')].map(button => ({ id: button.getAttribute('data-test'), ...box(button) })),
        rowBackgrounds: [...app.querySelectorAll('.inbox-row')].slice(0, 2).map(row => getComputedStyle(row).backgroundColor),
      };
    })()`);
    expect(measure.selected).toBe(true);
    expect(measure.rowBackgrounds[0]).toBe('rgb(71, 70, 68)');
    expect(measure.rowBackgrounds[1]).not.toBe(measure.rowBackgrounds[0]);
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
    expect(measure.barHeight).toBeLessThanOrEqual(112);
    expect(measure.clearButton.first).toBe(true);
    expect(measure.clearButton.width).toBeGreaterThanOrEqual(48);
    expect(measure.clearButton.height).toBeGreaterThanOrEqual(48);
    expect(measure.primaryBackground).not.toBe(measure.barBackground);
    expect(Math.abs(measure.bar.left - measure.navigationPill.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(measure.bar.right - measure.navigationPill.right)).toBeLessThanOrEqual(1);
    expect(measure.bar.left).toBeGreaterThanOrEqual(measure.bottomRegion.left - 1);
    expect(measure.bar.right).toBeLessThanOrEqual(measure.bottomRegion.right + 1);
    expect(measure.context.visible).toBe(true);
    expect(measure.context.top - measure.bar.bottom).toBeGreaterThanOrEqual(8);
    expect(measure.context.top - measure.bar.bottom).toBeLessThanOrEqual(16);
    expect(measure.buttons.find(button => button.id === 'selection-clear')?.height).toBeGreaterThanOrEqual(48);
    expect(measure.buttons.filter(button => button.id?.startsWith('selection-mark-') || button.id === 'selection-select-all').every(button => button.width >= 48 && button.height >= 48)).toBe(true);
    expect(measure.buttons.filter(button => button.id === 'selection-archive' || button.id === 'selection-unarchive').every(button => button.height >= 40)).toBe(true);
    expect(measure.buttonLayouts.every(button => button.left >= measure.bar.left && button.right <= measure.bar.right && button.top >= measure.bar.top && button.bottom <= measure.bar.bottom)).toBe(true);
    expect(measure.buttonLayouts.every(button => button.scrollWidth <= button.clientWidth)).toBe(true);
    for (let index = 0; index < measure.buttonLayouts.length; index += 1) {
      for (let other = index + 1; other < measure.buttonLayouts.length; other += 1) {
        const left = measure.buttonLayouts[index]!;
        const right = measure.buttonLayouts[other]!;
        const overlaps = left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
        expect(overlaps).toBe(false);
      }
    }

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
    const clearedBackgrounds = await harness!.cdp.js<string[]>(`(() => {
      const app = document.querySelector(${JSON.stringify(workspaceApp)});
      return [...app.querySelectorAll('.inbox-row')].slice(0, 2).map(row => getComputedStyle(row).backgroundColor);
    })()`);
    expect(clearedBackgrounds[0]).toBe(clearedBackgrounds[1]);
  });
});
