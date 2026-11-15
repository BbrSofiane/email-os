// @vitest-environment node
/**
 * Inline text actions keep a 24px hit area (real Chrome, opt-in).
 *
 * The header note's link (`Retry`, `Sign in again`, `Review access`), the empty
 * Inbox line's action (`Connect Gmail`, `Sync now`, `Account`) and the Provider
 * mail note's action are one line of 12px text, so their buttons were 16px high.
 * DESIGN.md sets no minimum target size; 24px is the height it already gives
 * the ghost button ("24px tall at 12px, the old chip's hit target") and the
 * caveat target, so that is the floor here. The hit area grows by padding the
 * button and giving the same amount back as a negative margin: the glyphs, the
 * line and the header keep their size, and the extra rows of pixels still hit
 * the button (an `overflow: hidden` container must not clip them).
 *
 * Opt-in: set EMAIL_OS_RENDERED_LAYOUT_CHROME to a Chrome/Chromium binary.
 * Synthetic in-memory browser fake only; no network, no real account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
const MIN_TARGET_PX = 24;

interface Target {
  /** The button's own box. */
  height: number;
  width: number;
  /** Height the button takes in the line: its box plus vertical margins (the text line, unchanged by the hit area). */
  footprint: number;
  /** The element found at the button's centre column, 1px inside its top and bottom edges. */
  hitTop: boolean;
  hitBottom: boolean;
  fontSize: string;
}

const NONE = "connection: 'disconnected', emailAddress: null, cachedConversations: 0, initialSyncComplete: false";
const NOT_CONFIGURED = "connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false";

describe.skipIf(chromePath === '')('Inline action hit areas (real Chrome, opt-in)', () => {
  let harness: RenderedHarness | null = null;
  let cdp: RenderedHarness['cdp'];

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-inline-target-chrome-', new URL('../..', import.meta.url).pathname);
    cdp = harness.cdp;
  }, 120_000);

  afterAll(async () => { await harness?.close(); });

  const tick = (): Promise<unknown> => cdp.js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

  async function waitFor(expression: string): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (await cdp.js<boolean>(`Boolean(${expression})`)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }

  /** Fresh synthetic Gmail app with `patch` applied to the account; `rows: false` serves an empty ready list. */
  async function mount(patch: string, rows: boolean): Promise<void> {
    await cdp.cmd('Page.bringToFront');
    await cdp.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, screenWidth: 1280, screenHeight: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.js(`(async () => {
      const vueUrl = performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes('/node_modules/.vite/deps/vue.js'));
      if (!vueUrl) throw new Error('Vite Vue dep not found');
      const { createApp } = await import(vueUrl);
      const { default: App } = await import('/src/App.vue');
      const { createBrowserFakeMailClient } = await import('/src/lib/ipc/browser-fake.ts');
      const root = document.querySelector('#app');
      root.__vue_app__?.unmount();
      const fake = createBrowserFakeMailClient();
      fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'review@example.test', coverageLimit: 100, initialSyncComplete: true, cachedConversations: 18, ${patch} });
      const client = ${rows} ? fake : { ...fake, listConversations: async () => ({ conversations: [], activity: [] }) };
      createApp(App, { client, mode: 'browser-preview' }).mount(root);
    })()`);
    await waitFor(rows ? `document.querySelector('[data-test^="conversation-row-"]')` : `document.querySelector('[data-test="inbox-empty"]')`);
    await tick();
  }

  async function measure(selector: string): Promise<Target> {
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    await tick();
    return cdp.js<Target>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const x = r.left + r.width / 2;
      const hit = (y) => { const found = document.elementFromPoint(x, y); return found !== null && el.contains(found); };
      return {
        height: r.height, width: r.width,
        footprint: r.height + parseFloat(style.marginTop) + parseFloat(style.marginBottom),
        hitTop: hit(r.top + 1), hitBottom: hit(r.bottom - 1),
        fontSize: style.fontSize,
      };
    })()`);
  }

  function expectTarget(target: Target): void {
    expect(target.height).toBeGreaterThanOrEqual(MIN_TARGET_PX);
    // Both outer pixel rows of the grown area still reach the button (nothing clips or covers them).
    expect(target.hitTop).toBe(true);
    expect(target.hitBottom).toBe(true);
    // The glyphs and the line did not grow: still 12px text and a one-line (about 16px) footprint.
    expect(target.fontSize).toBe('12px');
    expect(target.footprint).toBeLessThanOrEqual(18);
  }

  it('the empty Inbox line action: Connect Gmail, Sync now, and Account', async () => {
    await mount(NONE, false);
    expectTarget(await measure('[data-test="inbox-empty-action"]'));
    await mount("initialSyncComplete: false, cachedConversations: 0", false);
    expectTarget(await measure('[data-test="inbox-empty-action"]'));
    await mount(NOT_CONFIGURED, false);
    expectTarget(await measure('[data-test="inbox-empty-action"]'));
  }, 120_000);

  it('the header note link: Sign in again, Retry, and Review access', async () => {
    await mount("connection: 'auth_required'", true);
    expectTarget(await measure('[data-test="account-status-action"]'));
    await mount("syncState: 'error', syncError: { kind: 'network_unavailable' }", true);
    expectTarget(await measure('[data-test="account-status-action"]'));
    await mount("mutationAccess: 'read_only'", true);
    expectTarget(await measure('.access-hint .header-link'));
  }, 120_000);

  it('the Provider mail account note action', async () => {
    await mount(NONE, false);
    await cdp.js(`document.querySelector('[data-test="rail-destinations"]').click()`);
    expectTarget(await measure('[data-test="destinations-account-action"]'));
  }, 60_000);

  it('the header keeps its height: the grown hit area is not extra layout', async () => {
    await mount("syncState: 'error', syncError: { kind: 'network_unavailable' }", true);
    await waitFor(`document.querySelector('[data-test="account-status-action"]')`);
    await tick();
    const header = await cdp.js<{ header: number; note: number }>(`({
      header: document.querySelector('.app-header').getBoundingClientRect().height,
      note: document.querySelector('[data-test="account-status-note"]').getBoundingClientRect().height + parseFloat(getComputedStyle(document.querySelector('[data-test="account-status-note"]')).marginTop) + parseFloat(getComputedStyle(document.querySelector('[data-test="account-status-note"]')).marginBottom),
    })`);
    expect(header.note).toBeLessThanOrEqual(18);
    expect(header.header).toBeLessThanOrEqual(80);
  }, 60_000);
});
