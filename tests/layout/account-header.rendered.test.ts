// @vitest-environment node
/**
 * Header tab floor and contact-column collapse (real Chrome, opt-in; DESIGN.md gap 18).
 *
 * jsdom cannot lay anything out, so these pin the measured behaviour in a real
 * browser: at 1030px with two tabs, `Unread only` and a failed sync, the Inbox
 * tab keeps its full label and the `Sync failed` lead and its Retry link are
 * not clipped; and with zero rows the contact column leaves the grid.
 *
 * Opt-in only: set EMAIL_OS_RENDERED_LAYOUT_CHROME to a Chrome/Chromium binary:
 *
 *   EMAIL_OS_RENDERED_LAYOUT_CHROME=/path/to/chrome mise run test:rendered
 *
 * It starts its own Vite server and headless Chrome profile and uses the
 * synthetic in-memory browser fake only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';

interface Fit {
  /** The element's box width and the width its text needs, from a Range over the text. */
  boxWidth: number;
  textWidth: number;
  /** Right edge of the element and of the header, both in viewport pixels. */
  right: number;
  headerRight: number;
  scrollWidth: number;
  clientWidth: number;
}

describe.skipIf(chromePath === '')('Account header and contact column layout (real Chrome, opt-in)', () => {
  let harness: RenderedHarness | null = null;
  let cdp: RenderedHarness['cdp'];

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-account-header-chrome-', new URL('../..', import.meta.url).pathname);
    cdp = harness.cdp;
  }, 120_000);

  afterAll(async () => { await harness?.close(); });

  /** Mounts a fresh synthetic Gmail app; `rows: false` serves an empty ready list. */
  const MOUNT_SCRIPT = (options: { rows: boolean; split: boolean; syncFailed: boolean; unreadOnly: boolean }) => `(async () => {
  const vueUrl = performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes('/node_modules/.vite/deps/vue.js'));
  if (!vueUrl) throw new Error('Vite Vue dep not found');
  const { createApp } = await import(vueUrl);
  const { default: App } = await import('/src/App.vue');
  const { createBrowserFakeMailClient } = await import('/src/lib/ipc/browser-fake.ts');
  const root = document.querySelector('#app');
  root.__vue_app__?.unmount();
  const fake = createBrowserFakeMailClient();
  fake.controls.setAccount({
    mode: 'gmail', connection: 'connected', emailAddress: 'review@example.test', 
    coverageLimit: 100, initialSyncComplete: true,
    ${options.syncFailed ? "syncState: 'error', syncError: { kind: 'network_unavailable' }," : ''}
  });
  if (${options.split}) {
    const snap = await fake.listConversations();
    await fake.saveSavedSplit(snap.conversations[0].ref.accountId, { name: 'Clients and partners 2026', criterion: 'domain', value: 'example.test', enabled: true, hideWhenEmpty: false });
  }
  const client = ${options.rows} ? fake : { ...fake, listConversations: async () => ({ conversations: [], activity: [] }) };
  createApp(App, { client, mode: 'browser-preview' }).mount(root);
})()`;

  async function tick(): Promise<void> {
    await cdp.js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }

  async function resize(width: number): Promise<void> {
    // Headless background pages can suspend animation frames; activate the page first.
    await cdp.cmd('Page.bringToFront');
    await cdp.cmd('Emulation.setDeviceMetricsOverride', { width, height: 800, screenWidth: width, screenHeight: 800, deviceScaleFactor: 1, mobile: false });
    await tick();
  }

  async function mount(options: { rows?: boolean; split?: boolean; syncFailed?: boolean; unreadOnly?: boolean } = {}): Promise<void> {
    const full = { rows: true, split: false, syncFailed: false, unreadOnly: false, ...options };
    await cdp.js(MOUNT_SCRIPT(full));
    await waitFor(`document.querySelector('[data-test="split-inbox"]') !== null`);
    if (full.rows) await waitFor(`document.querySelector('[data-test^="conversation-row-"]') !== null`);
    else await waitFor(`document.querySelector('[data-test="inbox-empty"]') !== null`);
    if (full.unreadOnly) {
      await cdp.js(`document.querySelector('[data-test="palette-trigger"]').click()`);
      await waitFor(`document.querySelector('#action-toggle-unread-filter') !== null`);
      await cdp.js(`document.querySelector('#action-toggle-unread-filter').click()`);
      await waitFor(`document.querySelector('[data-test="unread-filter-status"]') !== null`);
    }
    await tick();
  }

  async function waitFor(expression: string): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (await cdp.js<boolean>(`Boolean(${expression})`)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }

  /** How much of `selector`'s text fits: its box, its text and its right edge against the header's. */
  const fit = (selector: string): Promise<Fit> => cdp.js<Fit>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('missing ' + ${JSON.stringify(selector)});
    const range = document.createRange();
    range.selectNodeContents(el);
    return {
      boxWidth: el.getBoundingClientRect().width,
      textWidth: range.getBoundingClientRect().width,
      right: el.getBoundingClientRect().right,
      headerRight: document.querySelector('.app-header').getBoundingClientRect().right,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  })()`);

  const tracks = (): Promise<number> => cdp.js<number>(
    `getComputedStyle(document.querySelector('.app-main')).gridTemplateColumns.trim().split(/\\s+/).length`,
  );

  describe('1030px header with two tabs, Unread only and a failed sync', () => {
    it('keeps both tabs whole: the Inbox label at its full width and the tab strip without overflow', async () => {
      await resize(1030);
      await mount({ split: true, syncFailed: true, unreadOnly: true });
      const label = await fit('[data-test="split-inbox"] .split-label');
      expect(label.textWidth).toBeGreaterThan(30);
      expect(label.boxWidth).toBeGreaterThanOrEqual(label.textWidth - 0.5);
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
      // The trail (hint, note, chip) must not crush the tab column: the strip fits in its own cell.
      const strip = await cdp.js<{ overflow: number; lastRight: number; stripRight: number }>(`(() => {
        const strip = document.querySelector('.header-tabs');
        const tabs = [...strip.querySelectorAll('.split-tab')];
        return {
          overflow: strip.scrollWidth - strip.clientWidth,
          lastRight: tabs.at(-1).getBoundingClientRect().right,
          stripRight: strip.getBoundingClientRect().right,
        };
      })()`);
      expect(strip.overflow).toBeLessThanOrEqual(1);
      expect(strip.lastRight).toBeLessThanOrEqual(strip.stripRight + 0.5);
    });

    it('shows the Sync failed lead and the Retry link whole, inside the header', async () => {
      await resize(1030);
      await mount({ split: true, syncFailed: true, unreadOnly: true });
      await waitFor(`document.querySelector('[data-test="account-status-note"]:not(.visually-hidden)') !== null`);
      const lead = await fit('[data-test="account-status-note"] .note-lead');
      expect(lead.boxWidth).toBeGreaterThanOrEqual(lead.textWidth - 0.5);
      expect(lead.scrollWidth).toBeLessThanOrEqual(lead.clientWidth + 1);
      expect(lead.right).toBeLessThanOrEqual(lead.headerRight + 0.5);
      const retry = await fit('[data-test="account-status-note"] .header-link');
      expect(retry.boxWidth).toBeGreaterThanOrEqual(retry.textWidth - 0.5);
      expect(retry.right).toBeLessThanOrEqual(retry.headerRight + 0.5);
    });
  });

  describe('contact column', () => {
    it('is a grid track while the list has rows', async () => {
      await resize(1200);
      await mount();
      expect(await cdp.js<boolean>(`document.querySelector('[data-test="contact-column"]') !== null`)).toBe(true);
      expect(await tracks()).toBe(3);
    });

    it('leaves the grid with zero rows, so the list takes the width', async () => {
      await resize(1200);
      await mount({ rows: false });
      expect(await cdp.js<boolean>(`document.querySelector('[data-test="contact-column"]') !== null`)).toBe(false);
      expect(await tracks()).toBe(2);
    });
  });
});
