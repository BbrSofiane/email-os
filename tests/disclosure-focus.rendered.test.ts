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
 * Opt-in only: set EMAIL_OS_DISCLOSURE_FOCUS_CHROME to a Chrome/Chromium binary
 * path to run, e.g.
 *
 *   EMAIL_OS_DISCLOSURE_FOCUS_CHROME=/path/to/chrome \
 *     pnpm vitest run tests/disclosure-focus.rendered.test.ts
 *
 * The test starts its own ephemeral Vite dev server and its own headless
 * Chrome profile (synthetic in-memory browser fake only — never real Gmail,
 * never real mail), and tears both down in `finally`. Default `pnpm test`
 * runs skip it (jsdom environment stays default).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

const CHROME_ENV = 'EMAIL_OS_DISCLOSURE_FOCUS_CHROME';
const chromePath = process.env[CHROME_ENV] ?? '';

interface Rect { x: number; y: number; width: number; height: number }
interface FocusInfo {
  test: string | null;
  tag: string | null;
  inCentral: boolean;
  inRail: boolean;
  centralInertAttr: string | null;
}
interface ArchiveOp { conversationId: string; requestedArchived: boolean; status: string }

interface CdpSession {
  cmd(method: string, params?: Record<string, unknown>): Promise<any>;
  js<T>(expression: string): Promise<T>;
  close(): void;
}

describe.skipIf(chromePath === '')('App covered central surface focus safety (real Chrome, opt-in)', () => {
  let server: ViteDevServer | null = null;
  let appUrl = '';
  let chrome: ReturnType<typeof spawn> | null = null;
  let profileDir: string | null = null;
  let cdp: CdpSession | null = null;
  let tornDown = false;

  beforeAll(async () => {
    server = await createServer({
      root: new URL('..', import.meta.url).pathname,
      // Inline overrides win over vite.config.ts (whose fixed port could clash).
      server: { port: 0, strictPort: false },
      logLevel: 'error',
    });
    await server.listen();
    appUrl = server.resolvedUrls?.local?.[0] ?? '';
    if (!appUrl) throw new Error('Vite dev server did not report a local URL');

    profileDir = mkdtempSync(join(tmpdir(), 'email-os-disclosure-focus-chrome-'));
    chrome = spawn(
      chromePath,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    cdp = await connectCdp(profileDir);
    await cdp.cmd('Page.enable');
    await cdp.cmd('Page.navigate', { url: appUrl });
    await waitForApp(cdp);
  }, 120_000);

  afterAll(async () => {
    await teardown();
  });

  async function teardown(): Promise<void> {
    if (tornDown) return;
    tornDown = true;
    try { cdp?.close(); } catch { /* already closed */ }
    cdp = null;
    chrome?.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    chrome?.kill('SIGKILL');
    chrome = null;
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
    profileDir = null;
    await server?.close();
    server = null;
  }

  async function connectCdp(profile: string): Promise<CdpSession> {
    // Headless Chrome writes the chosen debugging port into DevToolsActivePort.
    let port: string | null = null;
    for (let i = 0; i < 100 && !port; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] ?? null; } catch { /* not yet */ }
    }
    if (!port) throw new Error('Chrome did not expose a DevTools port');
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('Chrome exposed no page target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    let nextId = 0;
    const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: any; error?: unknown };
      if (message.id === undefined) return;
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    const cmd = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20_000);
      waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    return {
      cmd,
      async js<T>(expression: string): Promise<T> {
        const result = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value as T;
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
    };
  }

  async function waitForApp(session: CdpSession): Promise<void> {
    // The dev-server root mounts the default preview shell; its module graph
    // also registers the Vue dep URL used by the bootstrap below.
    for (let i = 0; i < 100; i += 1) {
      const ready = await session.js<boolean>(
        "document.querySelector('.app') !== null && performance.getEntriesByType('resource').some((x) => x.name.includes('/node_modules/.vite/deps/vue.js'))",
      ).catch(() => false);
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Preview app (and Vite Vue dep) did not load');
  }

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
  async function pressTab(shift: boolean): Promise<void> {
    if (shift) {
      await cdp!.cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
    }
    const modifiers = shift ? 8 : 0;
    await cdp!.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers });
    await cdp!.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers });
    if (shift) {
      await cdp!.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
    }
    await tick();
  }

  /**
   * Native Enter activation exactly as a real user's keypress reaches the
   * browser: keyDown with carriage-return text plus keyUp. This is the
   * activation path the global shortcut guard cannot intercept.
   */
  async function pressEnter(): Promise<void> {
    await cdp!.cmd('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r',
    });
    await cdp!.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await tick();
  }

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
      await teardown();
    }
  }, 180_000);
});