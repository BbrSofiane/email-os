// @vitest-environment node
/**
 * Covered-action focus safety regression (real Chrome, real activation).
 *
 * P1 guard: while a utility drawer (Account/Activity/Drafts) or the narrow
 * Contact disclosure overlays the central surface, the covered central rows
 * must be isolated from NATIVE user interaction — real Tab/Shift+Tab traversal
 * must not land on covered row actions, and a native Enter (keyDown with
 * carriage-return text plus keyUp) must not activate anything underneath. The
 * global shortcut guard cannot stop native button activation, so these probes
 * drive input through CDP Input events only. Programmatic HTMLElement.click()
 * is never used as evidence that the covered surface rejects activation
 * (programmatic clicks bypass user hit-testing); synthetic clicks appear only
 * where activation is the expected, positive outcome (rail toggles during
 * setup/teardown of the scenario, and mailbox actions after dismissal).
 *
 * Opt-in only: set EMAIL_OS_RENDERED_LAYOUT_CHROME to a Chrome/Chromium binary
 * path to run, e.g.
 *
 *   EMAIL_OS_RENDERED_LAYOUT_CHROME=/path/to/chrome \
 *     mise run test:rendered
 *
 * The test starts its own ephemeral Vite dev server and its own headless
 * Chrome profile (synthetic in-memory browser fake only — never real Gmail,
 * never real mail), and tears both down in `finally`. Default `pnpm test`
 * the default test task excludes it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRenderedHarness, type RenderedHarness } from './rendered/chromium';
import { pressRenderedEnter, pressRenderedTab } from './rendered/keyboard';

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';

interface Rect { x: number; y: number; width: number; height: number }
interface FocusInfo {
  test: string | null;
  tag: string | null;
  inCentral: boolean;
  inRail: boolean;
  centralInertAttr: string | null;
}
interface ArchiveOp { conversationId: string; requestedArchived: boolean; status: string }

describe.skipIf(chromePath === '')('App covered central surface focus safety (real Chrome, opt-in)', () => {
  let harness: RenderedHarness | null = null;
  let cdp: RenderedHarness['cdp'];

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-disclosure-focus-chrome-', new URL('..', import.meta.url).pathname);
    cdp = harness.cdp;
  }, 120_000);

  afterAll(async () => { await harness?.close(); });

  /** Replaces the default shell with a fresh synthetic browser-fake app. */
  const MOUNT_SCRIPT = `(async () => {
  const vueUrl = performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes('/node_modules/.vite/deps/vue.js'));
  if (!vueUrl) throw new Error('Vite Vue dep not found');
  const { createApp } = await import(vueUrl);
  const { default: App } = await import('/src/App.vue');
  const { createBrowserFakeMailClient } = await import('/src/lib/ipc/browser-fake.ts');
  window.__focusMount = async () => {
    const root = document.querySelector('#app');
    root.__vue_app__?.unmount();
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'review@example.test', mutationAccess: 'enabled', coverageLimit: 100 });
    window.__focusFake = fake;
    createApp(App, { client: fake, mode: 'browser-preview' }).mount(root);
  };
  await window.__focusMount();
})()`;

  const FOCUS_INFO_SCRIPT = `(() => {
  const el = document.activeElement;
  const region = (sel) => document.querySelector(sel);
  const inRegion = (r) => !!r && el !== null && r.contains(el);
  const central = region('[data-test="central-surface"]');
  return {
    test: el ? el.getAttribute('data-test') : null,
    tag: el ? el.tagName : null,
    inCentral: inRegion(central),
    inRail: inRegion(region('.rail')),
    centralInertAttr: central ? central.getAttribute('inert') : null,
  };
})()`;

  const ARCHIVE_OPS_SCRIPT = `(() => {
  const ops = window.__focusFake.controls.activity();
  return ops.filter((op) => op.requestedArchived === true)
    .map((op) => ({ conversationId: op.conversation.conversationId, requestedArchived: op.requestedArchived, status: op.status }));
})()`;

  async function resize(width: number): Promise<void> {
    // Headless background pages can suspend the animation frames used by tick.
    // Activate this isolated test page before waiting for real layout/focus.
    await cdp!.cmd('Page.bringToFront');
    await cdp!.cmd('Emulation.setDeviceMetricsOverride', { width, height: 720, screenWidth: width, screenHeight: 720, deviceScaleFactor: 1, mobile: false });
    await tick();
  }

  async function tick(): Promise<void> {
    await cdp!.js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }

  async function mountGmailActions(): Promise<void> {
    await cdp!.js(MOUNT_SCRIPT);
    await tick();
  }

  /** Real user pointer activation on a named control (never a synthetic .click()). */
  async function pointerActivate(testId: string): Promise<void> {
    const rect = await cdp!.js<Rect>(`(() => {
      const el = document.querySelector('[data-test="${testId}"]');
      if (!el) throw new Error('missing control ${testId}');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await cdp!.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await cdp!.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await tick();
  }

  /** Real keyboard Tab (forward when shift=false, Shift+Tab when shift=true). */
  const pressTab = (shift: boolean): Promise<void> => pressRenderedTab(cdp!, shift, tick);

  /**
   * Native Enter activation exactly as a real user's keypress reaches the
   * browser: keyDown with carriage-return text plus keyUp. This is the
   * activation path the global shortcut guard cannot intercept.
   */
  const pressEnter = (): Promise<void> => pressRenderedEnter(cdp!, tick);

  async function focusInfo(): Promise<FocusInfo> {
    return cdp!.js<FocusInfo>(FOCUS_INFO_SCRIPT);
  }

  async function archiveOps(): Promise<ArchiveOp[]> {
    return cdp!.js<ArchiveOp[]>(ARCHIVE_OPS_SCRIPT);
  }

  async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  it('isolates covered central actions under Activity and Contact disclosures and restores them after dismissal', async () => {
    try {
      await resize(1000);
      await mountGmailActions();
      expect(await cdp!.js<string | null>('document.querySelector(\'[data-test="central-surface"]\').getAttribute("inert")')).toBeNull();

      // ---------------------------------------------------------------------
      // Scenario 1: the Activity utility drawer covers the central list.
      // ---------------------------------------------------------------------
      await pointerActivate('rail-activity');
      expect(await cdp!.js<string | null>('document.querySelector(\'[data-test="utility-drawer"]\') !== null ? "open" : null')).toBe('open');
      expect(await focusInfo()).toMatchObject({ centralInertAttr: '' });
      // The rail and the active drawer themselves are not inert.
      expect(await cdp!.js<boolean>('[...document.querySelectorAll(".rail [data-test]")].every((el) => !el.closest(".rail").hasAttribute("inert"))')).toBe(true);

      // Real Shift+Tab from the drawer Close control must never land on a
      // covered central row action; the previous stop is a rail control.
      await cdp!.js('document.querySelector(\'[data-test="drawer-close"]\').focus()');
      expect(await focusInfo()).toMatchObject({ test: 'drawer-close', inCentral: false });
      await pressTab(true);
      let info = await focusInfo();
      expect(info.inCentral).toBe(false);
      expect(info.inRail).toBe(true);
      expect(info.test?.startsWith('rail-')).toBe(true);

      // The visible drawer Close control is still reachable in the forward
      // direction, and traversal still skips the inert central surface.
      await cdp!.js('document.querySelector(\'[data-test="rail-activity"]\').focus()');
      await pressTab(false);
      info = await focusInfo();
      expect(info.inCentral).toBe(false);
      expect(info.inRail || info.test === 'drawer-close').toBe(true);

      // Native Enter where focus actually landed (a rail control) must not
      // archive any covered conversation. The rail activation may switch the
      // disclosure, but no central row action may fire.
      await cdp!.js('window.__focusFake.controls.flush()');
      const before = await archiveOps();
      await pressEnter();
      await cdp!.js('window.__focusFake.controls.flush()');
      expect(await archiveOps()).toEqual(before);
      expect(await focusInfo()).toMatchObject({ centralInertAttr: '' });
      expect(await focusInfo()).toMatchObject({ inCentral: false });

      // Dismiss the drawer with its own Close control (real pointer press).
      await pointerActivate('drawer-close');
      expect(await focusInfo()).toMatchObject({ centralInertAttr: null });

      // Normal central interaction is restored: a native Enter on a row
      // action really archives that conversation again.
      await cdp!.js('document.querySelector(\'[data-test="row-archive-conv-01"]\').focus()');
      await pressEnter();
      await cdp!.js('window.__focusFake.controls.flush()');
      const restored = await archiveOps();
      expect(restored).toContainEqual({ conversationId: 'conv-01', requestedArchived: true, status: 'confirmed' });

      // ---------------------------------------------------------------------
      // Scenario 2: the narrow Contact disclosure (viewport below 1000px).
      // ---------------------------------------------------------------------
      await resize(900);
      await waitFor(
        async () => (await cdp!.js<string | null>('document.querySelector(\'[data-test="contact-disclosure"]\')?.getAttribute("data-test") ?? null')) !== null,
        'the narrow Contact toggle to appear',
      );
      await pointerActivate('contact-disclosure');
      expect(await cdp!.js<string | null>('document.querySelector(\'[data-test="contact-disclosure-panel"]\') !== null ? "open" : null')).toBe('open');
      expect(await focusInfo()).toMatchObject({ centralInertAttr: '' });
      expect(await cdp!.js<boolean>('[...document.querySelectorAll(".rail [data-test]")].every((el) => !el.closest(".rail").hasAttribute("inert"))')).toBe(true);

      // Rail controls stay available: the Activity toggle still takes focus
      // while the Contact disclosure is open (inert blocks focus()).
      await cdp!.js('document.querySelector(\'[data-test="rail-activity"]\').focus()');
      expect(await focusInfo()).toMatchObject({ test: 'rail-activity', inRail: true, inCentral: false });

      // Real Shift+Tab from the disclosure Close control stops at the rail
      // Contact toggle; it must not enter the covered central list.
      await cdp!.js('document.querySelector(\'[data-test="contact-disclosure-close"]\').focus()');
      await pressTab(true);
      info = await focusInfo();
      expect(info.inCentral).toBe(false);
      expect(info.inRail).toBe(true);
      expect(info.test).toBe('contact-disclosure');

      // Native Enter on that rail control toggles the disclosure closed and
      // must not archive anything underneath.
      await cdp!.js('window.__focusFake.controls.flush()');
      const beforeContact = await archiveOps();
      await pressEnter();
      await cdp!.js('window.__focusFake.controls.flush()');
      expect(await archiveOps()).toEqual(beforeContact);
      expect(await cdp!.js<string | null>('document.querySelector(\'[data-test="contact-disclosure-panel"]\') !== null ? "open" : null')).toBeNull();

      // Central interaction is restored after the disclosure is dismissed.
      expect(await focusInfo()).toMatchObject({ centralInertAttr: null });
      await cdp!.js('document.querySelector(\'[data-test="row-archive-conv-02"]\').focus()');
      await pressEnter();
      await cdp!.js('window.__focusFake.controls.flush()');
      expect(await archiveOps()).toContainEqual({ conversationId: 'conv-02', requestedArchived: true, status: 'confirmed' });
    } finally {
      await harness?.close();
      harness = null;
    }
  }, 180_000);
});