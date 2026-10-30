// @vitest-environment node
/**
 * UX-02 reader journey (real Chrome, opt-in).
 *
 * Drives the three-message reader journey with real keyboard/pointer input
 * (CDP Input events, not synthetic dispatched events): open → N/P → O/Shift+O
 * → message details/participant context → copy → J/K → Back, plus a reply exit
 * and controls proving no unintended mailbox writes. Also asserts the rendered
 * reader surface: purple/current message treatment, independent scrolling with
 * a persistent toolbar, the unchanged viewport-relative message anchor after a
 * background replacement, the original list anchor after reorder/removal,
 * literal hostile text with no created executable markup or remote assets, and
 * narrow/wide Contact usability across the 1000px breakpoint.
 *
 * Reuses the existing opt-in real-Chrome/CDP approach (no new dependency or
 * E2E framework) and the EMAIL_OS_RENDERED_LAYOUT_CHROME binary gate. The
 * shared synthetic fixture loads through Vite. Every case mounts a FRESH
 * fixture with explicitly arranged state (P2-10), so no case depends on
 * preceding expansion, navigation, or Inbox mutations. Narrow integration
 * regressions also pin the accepted reader/shell state and contact behavior
 * against the combined source: pruned-active contact baseline resolution,
 * direct participant focus handoff, loading focus parking / O guard /
 * reversal restoration, native reader arrow scrolling with no fetch, and
 * action-time archive neighbor ordering. Synthetic in-memory data only —
 * never real mail, never native IPC; a passing run is browser evidence only
 * and does not certify native/WKWebView/provider behavior.
 *
 *   EMAIL_OS_RENDERED_LAYOUT_CHROME=/path/to/chrome \
 *     pnpm vitest run tests/reader.rendered.test.ts
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

const CHROME_ENV = 'EMAIL_OS_RENDERED_LAYOUT_CHROME';
const chromePath = process.env[CHROME_ENV] ?? '';

interface Rect { top: number; bottom: number; left: number; right: number; width: number; height: number }

interface CdpSession {
  cmd(method: string, params?: Record<string, unknown>): Promise<any>;
  js<T>(expression: string): Promise<T>;
  close(): void;
}

describe.skipIf(chromePath === '')('Reader journey (real Chrome, opt-in)', () => {
  let server: ViteDevServer | null = null;
  let appUrl = '';
  let chrome: ReturnType<typeof spawn> | null = null;
  let profileDir: string | null = null;
  let cdp: CdpSession | null = null;
  let tornDown = false;

  beforeAll(async () => {
    server = await createServer({
      root: new URL('..', import.meta.url).pathname,
      server: { port: 0, strictPort: false },
      logLevel: 'error',
    });
    await server.listen();
    appUrl = server.resolvedUrls?.local?.[0] ?? '';
    if (!appUrl) throw new Error('Vite dev server did not report a local URL');

    profileDir = mkdtempSync(join(tmpdir(), 'email-os-reader-chrome-'));
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
    await cdp.cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.cmd('Page.navigate', { url: appUrl });
    await waitForApp(cdp);
    await cdp.js(MOUNT_SCRIPT);
    await cdp.js('window.__readerMount()');
    await cdp.js('window.__h.wait(150)');
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
    for (let i = 0; i < 100; i += 1) {
      const ready = await session.js<boolean>(
        "document.querySelector('.app') !== null && performance.getEntriesByType('resource').some((x) => x.name.includes('/node_modules/.vite/deps/vue.js'))",
      ).catch(() => false);
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Preview app (and Vite Vue dep) did not load');
  }

  /** Boots the app against the shared reader fixture (loaded through Vite). */
  const MOUNT_SCRIPT = `(async () => {
  const vueUrl = performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes('/node_modules/.vite/deps/vue.js'));
  if (!vueUrl) throw new Error('Vite Vue dep not found');
  const { createApp } = await import(vueUrl);
  const { default: App } = await import('/src/App.vue');
  const { createReaderFixtureClient } = await import('/tests/reader.fixture.ts');
  window.__readerMount = async () => {
    const root = document.querySelector('#app');
    root.__vue_app__?.unmount();
    const fixture = createReaderFixtureClient();
    window.__fixture = fixture;
    createApp(App, { client: fixture.client, mode: 'browser-preview' }).mount(root);
  };
  // Test-only mount for Shift+U: the same synthetic fixture with an
  // enabled-Gmail account-status wrapper. Production authority is unchanged;
  // only the status report differs, exactly as in the component suite.
  window.__readerMountGmail = async () => {
    const root = document.querySelector('#app');
    root.__vue_app__?.unmount();
    const fixture = createReaderFixtureClient();
    window.__fixture = fixture;
    const gmailClient = {
      ...fixture.client,
      getAccountStatus: () => Promise.resolve({
        mode: 'gmail',
        connection: 'connected',
        account: { accountId: 'reader-account', emailAddress: 'reader@example.test' },
        sync: { state: 'idle', lastSyncedAt: '2026-02-02T12:00:00Z', error: null, cachedConversations: 4, initialSyncComplete: true, coverageLimit: 0 },
        mutationAccess: 'enabled',
      }),
    };
    createApp(App, { client: gmailClient, mode: 'browser-preview' }).mount(root);
  };
  window.__h = {
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    q: (sel) => document.querySelector(sel),
    active: () => document.activeElement?.getAttribute('data-test') ?? null,
    text: (sel) => document.querySelector(sel)?.textContent ?? null,
    attr: (sel, name) => document.querySelector(sel)?.getAttribute(name) ?? null,
    exists: (sel) => document.querySelector(sel) !== null,
    rect: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    },
    /** Real click target: the viewport center of a selector (CDP dispatches the events). */
    clickPoint: (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('missing ' + sel);
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
  };
})()`;

  async function press(key: string, options: { shift?: boolean; ctrl?: boolean } = {}): Promise<void> {
    // Keep the effective key consistent with the shift modifier: Shift+U must
    // report key 'U', not a base-spread lowercase 'u'.
    const base: Record<string, unknown> = options.shift ? { key: key.toUpperCase() } : { key };
    if (options.shift) { base.modifiers = 8; }
    const keyCode: Record<string, number> = { n: 78, p: 80, o: 79, j: 74, k: 75, u: 85, Escape: 27, Enter: 13, ArrowDown: 40, ArrowUp: 38 };
    const code: Record<string, string> = { n: 'KeyN', p: 'KeyP', o: 'KeyO', j: 'KeyJ', k: 'KeyK', u: 'KeyU', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp' };
    const printable = key.length === 1;
    const keyPayload = {
      key: options.shift ? key.toUpperCase() : key,
      ...(code[key] ? { code: code[key] } : {}),
      ...(keyCode[key] ? { windowsVirtualKeyCode: keyCode[key], nativeVirtualKeyCode: keyCode[key] } : {}),
      ...(printable ? { text: options.shift ? key.toUpperCase() : key } : key === 'Enter' ? { text: '\r' } : {}),
      ...base,
    };
    await cdp!.cmd('Input.dispatchKeyEvent', { type: 'keyDown', ...keyPayload });
    await cdp!.cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...keyPayload });
  }

  async function click(selector: string): Promise<void> {
    const point = await cdp!.js<{ x: number; y: number }>(`window.__h.clickPoint(${JSON.stringify(selector)})`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp!.cmd('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
  }

  /** Real pointer move (hover) without clicking: no focus change, no activation. */
  async function hover(selector: string): Promise<void> {
    const point = await cdp!.js<{ x: number; y: number }>(`window.__h.clickPoint(${JSON.stringify(selector)})`);
    await cdp!.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  }

  async function activeTest(): Promise<string | null> {
    return cdp!.js<string | null>('window.__h.active()');
  }

  async function setViewport(width: number): Promise<void> {
    await cdp!.cmd('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp!.js('window.__h.wait(80)');
  }

  /**
   * Fresh fixture and clean 1200px viewport: every rendered case is
   * self-contained (P2-10) — no case depends on preceding expansion,
   * navigation, or Inbox mutations.
   */
  async function freshMount(): Promise<void> {
    await setViewport(1200);
    await cdp!.js('window.__readerMount()');
    await cdp!.js('window.__h.wait(250)');
  }

  /** Same fresh-fixture discipline for the enabled-Gmail status wrapper. */
  async function freshMountGmail(): Promise<void> {
    await setViewport(1200);
    await cdp!.js('window.__readerMountGmail()');
    await cdp!.js('window.__h.wait(250)');
  }

  it('runs the open → N/P → O/Shift+O → details → participant → copy journey with no unintended writes', async () => {
    // Fresh fixture: no dependency on any other case's expansion or navigation.
    await freshMount();

    // Open the fixture conversation from the list with real pointer + keyboard.
    await click('[data-test="conversation-row-read-01"]');
    await cdp!.js('window.__h.wait(200)');

    // Initial focus/expansion: the newest message toggle.
    expect(await activeTest()).toBe('message-toggle-read-01-m3');
    expect(await cdp!.js(`window.__h.attr('[data-test="message-toggle-read-01-m3"]', 'aria-expanded')`)).toBe('true');
    expect(await cdp!.js(`window.__h.attr('[data-test="message-toggle-read-01-m1"]', 'aria-expanded')`)).toBe('false');
    // Purple current-message bar plus a non-color fill indication.
    const treatment = await cdp!.js<Record<string, string | null>>(`(() => {
      const active = document.querySelector('.message-active');
      const inactive = document.querySelector('.message:not(.message-active)');
      if (!active || !inactive) return null;
      const a = getComputedStyle(active);
      const i = getComputedStyle(inactive);
      return {
        activeId: active.getAttribute('data-test'),
        inactiveId: inactive.getAttribute('data-test'),
        activeShadow: a.boxShadow,
        activeFill: a.backgroundColor,
        inactiveFill: i.backgroundColor,
      };
    })()`);
    expect(treatment?.activeId).toBe('message-read-01-m3');
    expect(treatment?.inactiveId).toBe('message-read-01-m1');
    expect(treatment?.activeShadow).toContain('inset');
    expect(treatment?.activeFill).not.toBe(treatment?.inactiveFill);

    // N/P move message focus without implicitly expanding.
    await press('p');
    await cdp!.js('window.__h.wait(60)');
    expect(await activeTest()).toBe('message-toggle-read-01-m2');
    expect(await cdp!.js(`window.__h.attr('[data-test="message-toggle-read-01-m2"]', 'aria-expanded')`)).toBe('false');
    await press('n');
    await cdp!.js('window.__h.wait(60)');
    expect(await activeTest()).toBe('message-toggle-read-01-m3');

    // O collapses the focused message; Shift+O expands all idempotently.
    await press('o');
    await cdp!.js('window.__h.wait(60)');
    expect(await cdp!.js(`window.__h.attr('[data-test="message-toggle-read-01-m3"]', 'aria-expanded')`)).toBe('false');
    await press('O', { shift: true });
    await cdp!.js('window.__h.wait(60)');
    expect(await cdp!.js(`[...document.querySelectorAll('.message-toggle')].map((t) => t.getAttribute('aria-expanded'))`)).toEqual(['true', 'true', 'true']);
    await press('O', { shift: true });
    await cdp!.js('window.__h.wait(60)');
    expect(await cdp!.js(`[...document.querySelectorAll('.message-toggle')].map((t) => t.getAttribute('aria-expanded'))`)).toEqual(['true', 'true', 'true']);

    // Hostile markup stays literal in the real DOM: no executable markup and
    // no remote assets. Script counting is scoped INSIDE the reader (P2-12) so
    // Vite's legitimate page-level bootstrap scripts cannot falsely fail it.
    const hostile = await cdp!.js<{ text: string; scripts: number; images: number; anchors: number; remoteLinks: number }>(`(() => {
      const reader = document.querySelector('[data-test="reader"]');
      return {
        text: reader?.textContent ?? '',
        scripts: reader?.querySelectorAll('script').length ?? -1,
        images: document.querySelectorAll('img').length,
        anchors: document.querySelectorAll('a').length,
        remoteLinks: document.querySelectorAll('link[rel="stylesheet"][href^="http"]').length,
      };
    })()`);
    expect(hostile.text).toContain('<script>alert("body")</script>');
    expect(hostile.scripts).toBe(0);
    expect(hostile.images).toBe(0);
    expect(hostile.anchors).toBe(0);
    expect(hostile.remoteLinks).toBe(0);

    // Participant details disclosure: open the newest message's details and
    // HOVER (real mouse move, no click) its recipient — the contact context
    // temporarily shows that participant, and leaving restores the baseline
    // (the active message's sender) without moving focus.
    await click('[data-test="message-details-summary-read-01-m3"]');
    await cdp!.js('window.__h.wait(60)');
    expect(await cdp!.js(`!!document.querySelector('[data-test="message-details-read-01-m3"]')?.open`)).toBe(true);
    await hover('[data-test="participant-to-read-01-m3-you@example.test"]');
    await cdp!.js('window.__h.wait(80)');
    // The hovered participant is the named fixture identity "You" (mailbox
    // you@example.test); the context shows the display name when present.
    expect(await cdp!.js(`window.__h.text('[data-test="contact-name"]')`)).toBe('You');
    await hover('.reader-subject');
    await cdp!.js('window.__h.wait(80)');
    expect(await cdp!.js(`window.__h.text('[data-test="contact-name"]')`)).toBe('Ada Fixture');
    // Escape dismisses the details disclosure before the reader.
    await press('Escape');
    await cdp!.js('window.__h.wait(80)');
    expect(await cdp!.js(`!!document.querySelector('[data-test="message-details-read-01-m3"]')?.open`)).toBe(false);
    expect(await cdp!.js(`window.__h.exists('[data-test="reader"]')`)).toBe(true);

    // Keyboard focus context: clicking the middle message's nameless
    // participant focuses it (message identity follows focus) and overrides
    // the contact; dismissing the disclosure ends the override, and the
    // baseline is the active message's sender until focus moves on.
    await click('[data-test="message-details-summary-read-01-m2"]');
    await cdp!.js('window.__h.wait(60)');
    await click('[data-test="participant-from-read-01-m2"]');
    await cdp!.js('window.__h.wait(80)');
    expect(await cdp!.js(`window.__h.text('[data-test="contact-name"]')`)).toBe('anon@example.test');
    await press('Escape');
    await cdp!.js('window.__h.wait(80)');
    expect(await cdp!.js(`!!document.querySelector('[data-test="message-details-read-01-m2"]')?.open`)).toBe(false);
    expect(await cdp!.js(`window.__h.text('[data-test="contact-name"]')`)).toBe('anon@example.test');
    // N returns message focus to the newest message: its sender is the baseline.
    await press('n');
    await cdp!.js('window.__h.wait(80)');
    expect(await cdp!.js(`window.__h.text('[data-test="contact-name"]')`)).toBe('Ada Fixture');

    // Copy: explicit activation only; whatever the clipboard permission
    // outcome, no draft, no navigation, and no mailbox write may happen.
    await click('[data-test="copy-email"]');
    await cdp!.js('window.__h.wait(120)');
    expect(await cdp!.js(`window.__h.exists('[data-test="copy-status"]')`)).toBe(true);
    expect(await cdp!.js(`window.__h.exists('[data-test="draft-body"]')`)).toBe(false);
    expect(await cdp!.js(`window.__h.exists('[data-test="reader"]')`)).toBe(true);
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(0);
    expect(await cdp!.js('window.__fixture.controls.readCommands.length')).toBe(0);
    expect(await cdp!.js('window.__fixture.controls.draftCreations.length')).toBe(0);
  });

  it('keeps the viewport anchor stable across a background replacement and restores the original entry after reorder/removal', async () => {
    // Fresh fixture; open read-01 explicitly (no dependency on prior cases).
    await freshMount();
    await click('[data-test="conversation-row-read-01"]');
    await cdp!.js('window.__h.wait(200)');
    expect(await cdp!.js(`window.__h.text('.reader-subject')`)).toBe('Reader journey thread');
    const scrollerSel = '[data-test="reader-scroll"]';
    await cdp!.js(`document.querySelector(${JSON.stringify(scrollerSel)}).scrollTop = 200;`);
    await cdp!.js('window.__h.wait(60)');
    const before = await cdp!.js<Rect>(`window.__h.rect('[data-test="message-toggle-read-01-m3"]')`);
    // Background snapshot replacement (same identity, fresh object).
    await cdp!.js(`window.__fixture.controls.replaceDetail('read-01')`);
    await cdp!.js('window.__h.wait(150)');
    const after = await cdp!.js<Rect>(`window.__h.rect('[data-test="message-toggle-read-01-m3"]')`);
    expect(after.top).toBeCloseTo(before.top, 5);
    expect(after.left).toBeCloseTo(before.left, 5);

    // Reorder the source list while reading; the entry conversation survives.
    await cdp!.js(`window.__fixture.controls.reorderInbox(['read-04', 'read-03', 'read-02', 'read-01'])`);
    await cdp!.js('window.__h.wait(150)');
    // Back: the ORIGINAL entry reference (read-01) is restored even though the
    // list was reordered while the reader was open.
    await press('Escape');
    await cdp!.js('window.__h.wait(150)');
    expect(await cdp!.js(`window.__h.exists('[data-test="reader"]')`)).toBe(false);
    expect(await cdp!.js(`window.__h.attr('[aria-current="true"]', 'data-test')`)).toBe('conversation-row-read-01');

    // Removed entry reference: open read-02, remove it from the inbox, and
    // Back resolves to the next surviving neighbor of the entry ordering.
    await click('[data-test="conversation-row-read-02"]');
    await cdp!.js('window.__h.wait(200)');
    expect(await cdp!.js(`window.__h.exists('[data-test="reader"]')`)).toBe(true);
    await cdp!.js(`window.__fixture.controls.removeFromInbox('read-02')`);
    await cdp!.js('window.__h.wait(150)');
    await press('Escape');
    await cdp!.js('window.__h.wait(150)');
    expect(await cdp!.js(`window.__h.attr('[aria-current="true"]', 'data-test')`)).toBe('conversation-row-read-01');
    expect(await cdp!.js(`window.__h.exists('[data-test="reader"]')`)).toBe(false);
  });

  it('keeps the reader surface self-scrolled with a persistent toolbar and works across the contact breakpoint', async () => {
    // Fresh fixture; open the long-body conversation read-01 explicitly.
    await freshMount();
    await click('[data-test="conversation-row-read-01"]');
    await cdp!.js('window.__h.wait(200)');
    expect(await cdp!.js(`window.__h.exists('[data-test="reader"]')`)).toBe(true);

    const geometry = await cdp!.js<{
      toolbarBottom: number; scrollHeight: number; clientHeight: number;
      afterToolbarBottom: number; contentTop: number;
    } | null>(`(() => {
      const toolbar = document.querySelector('[data-test="reader-toolbar"]');
      const scroller = document.querySelector('[data-test="reader-scroll"]');
      if (!toolbar || !scroller) return null;
      const before = {
        toolbarBottom: toolbar.getBoundingClientRect().bottom,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      };
      scroller.scrollTop = scroller.scrollHeight;
      return new Promise((resolve) => setTimeout(() => {
        const toolbarEl = document.querySelector('[data-test="reader-toolbar"]');
        resolve({
          ...before,
          afterToolbarBottom: toolbarEl.getBoundingClientRect().bottom,
          contentTop: document.querySelector('.messages').getBoundingClientRect().top,
        });
      }, 60));
    })()`);
    if (!geometry) throw new Error('reader toolbar/scroller geometry was not reported');
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    // The toolbar stays fixed while the content scrolls beneath it.
    expect(geometry.afterToolbarBottom).toBeCloseTo(geometry.toolbarBottom, 5);

    // Contact usability across the 1000px breakpoint (real emulated viewport).
    await cdp!.cmd('Emulation.setDeviceMetricsOverride', { width: 999, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp!.js('window.__h.wait(120)');
    expect(await cdp!.js(`window.__h.exists('[data-test="contact-disclosure"]')`)).toBe(true);
    expect(await cdp!.js(`window.__h.exists('[data-test="contact-column"]')`)).toBe(false);
    await cdp!.cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp!.js('window.__h.wait(120)');
    expect(await cdp!.js(`window.__h.exists('[data-test="contact-column"]')`)).toBe(true);
  });

  it('exits through Prepare reply into the drafts editor and leaves no mailbox writes', async () => {
    // Fresh fixture; open read-03 explicitly.
    await freshMount();
    await click('[data-test="conversation-row-read-03"]');
    await cdp!.js('window.__h.wait(200)');
    expect(await cdp!.js(`window.__h.exists('[data-test="prepare-reply"]')`)).toBe(true);
    await click('[data-test="prepare-reply"]');
    await cdp!.js('window.__h.wait(300)');
    // The reader closed; the drafts editor owns the surface.
    expect(await cdp!.js(`window.__h.exists('[data-test="draft-body"]')`)).toBe(true);
    expect(await cdp!.js(`window.__h.exists('[data-test="reader"]')`)).toBe(false);
    const source = await cdp!.js(`window.__fixture.controls.draftCreations[0]?.source ?? null`);
    expect(source).toEqual({
      kind: 'reply',
      conversation: { accountId: 'reader-account', conversationId: 'read-03' },
      sourceMessageId: 'read-03-m1',
    });
    // A visible drafts editor owns all keys (including Escape); leave through
    // its explicit Close control, then prove the mailbox was untouched.
    await click('[data-test="drawer-close"]');
    await cdp!.js('window.__h.wait(400)');
    expect(await cdp!.js(`window.__h.exists('[data-test="utility-drawer"]')`)).toBe(false);
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(0);
    expect(await cdp!.js('window.__fixture.controls.readCommands.length')).toBe(0);
  });

  it('archives with real E from message-toggle focus and keeps native Enter as expansion, toolbar guard intact', async () => {
    await freshMount();
    await click('[data-test="conversation-row-read-01"]');
    await cdp!.js('window.__h.wait(200)');
    expect(await activeTest()).toBe('message-toggle-read-01-m3');

    // Native Enter/Space semantics: one activation toggles expansion once and
    // never archives.
    await press('Enter');
    await cdp!.js('window.__h.wait(80)');
    expect(await cdp!.js(`window.__h.attr('[data-test="message-toggle-read-01-m3"]', 'aria-expanded')`)).toBe('false');
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(0);
    await press('Enter');
    await cdp!.js('window.__h.wait(80)');
    expect(await cdp!.js(`window.__h.attr('[data-test="message-toggle-read-01-m3"]', 'aria-expanded')`)).toBe('true');
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(0);

    // Real E from the focused message toggle archives the CURRENT open
    // conversation and advances to its surviving neighbor.
    await press('e');
    await cdp!.js('window.__h.wait(250)');
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(1);
    expect(await cdp!.js('window.__fixture.controls.archiveCommands[0].conversation.conversationId')).toBe('read-01');
    expect(await cdp!.js(`window.__h.text('.reader-subject')`)).toBe('Neighbor thread read-02');

    // A focused toolbar button keeps the generic exclusion: E does nothing.
    await cdp!.js(`document.querySelector('[data-test="reader-archive-toggle"]').focus()`);
    await press('e');
    await cdp!.js('window.__h.wait(150)');
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(1);
    expect(await cdp!.js(`window.__h.text('.reader-subject')`)).toBe('Neighbor thread read-02');
  });

  it('marks the open conversation unread with real Shift+U from message-toggle focus in enabled synthetic Gmail', async () => {
    await freshMountGmail();
    await click('[data-test="conversation-row-read-01"]');
    await cdp!.js('window.__h.wait(250)');
    expect(await activeTest()).toBe('message-toggle-read-01-m3');
    await press('u', { shift: true });
    await cdp!.js('window.__h.wait(250)');
    expect(await cdp!.js('window.__fixture.controls.readCommands.length')).toBe(1);
    expect(await cdp!.js('window.__fixture.controls.readCommands[0].conversation.conversationId')).toBe('read-01');
    expect(await cdp!.js('window.__fixture.controls.readCommands[0].read')).toBe(false);
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(0);
  });

  it('restores reading progress across a delayed J/K round trip through foreground loading', async () => {
    await freshMount();
    await click('[data-test="conversation-row-read-01"]');
    await cdp!.js('window.__h.wait(250)');
    // Deep reading state: all messages expanded and the viewport inside the
    // newest body. No fixture notification is sent between this scroll and J.
    await press('O', { shift: true });
    await cdp!.js(`document.querySelector('[data-test="reader-scroll"]').scrollTop = 200;`);
    await cdp!.js('window.__h.wait(80)');
    const before = await cdp!.js<Record<string, number | null>>(`(() => {
      const scroller = document.querySelector('[data-test="reader-scroll"]');
      const toggle = document.querySelector('[data-test="message-toggle-read-01-m3"]');
      return {
        scrollTop: scroller?.scrollTop ?? null,
        m3ViewportTop: toggle ? toggle.getBoundingClientRect().top : null,
        expanded: [...document.querySelectorAll('.message-toggle')].map((t) => t.getAttribute('aria-expanded')).join(','),
      };
    })()`);
    expect(before.scrollTop).toBe(200);
    expect(before.expanded).toBe('true,true,true');

    // Delay BOTH foreground detail responses; the loading state tears the old
    // message DOM down between the scroll and the return visit.
    await cdp!.js('window.__fixture.controls.delayNextDetail(150, 2)');
    await press('j');
    await cdp!.js('window.__h.wait(60)');
    expect(await cdp!.js(`window.__h.exists('[data-test="reader-loading"]')`)).toBe(true);
    await cdp!.js('window.__h.wait(250)');
    expect(await cdp!.js(`window.__h.text('.reader-subject')`)).toBe('Neighbor thread read-02');
    await press('k');
    await cdp!.js('window.__h.wait(60)');
    await cdp!.js('window.__h.wait(300)');

    // Back on read-01: exact scrollTop and stable viewport-relative geometry.
    expect(await cdp!.js(`window.__h.text('.reader-subject')`)).toBe('Reader journey thread');
    const after = await cdp!.js<Record<string, number | null>>(`(() => {
      const scroller = document.querySelector('[data-test="reader-scroll"]');
      const toggle = document.querySelector('[data-test="message-toggle-read-01-m3"]');
      return {
        scrollTop: scroller?.scrollTop ?? null,
        m3ViewportTop: toggle ? toggle.getBoundingClientRect().top : null,
        expanded: [...document.querySelectorAll('.message-toggle')].map((t) => t.getAttribute('aria-expanded')).join(','),
      };
    })()`);
    expect(after.scrollTop).toBe(200);
    expect(after.m3ViewportTop).toBeCloseTo(before.m3ViewportTop as number, 1);
    expect(after.expanded).toBe('true,true,true');
    expect(await activeTest()).toBe('message-toggle-read-01-m3');
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(0);
    expect(await cdp!.js('window.__fixture.controls.readCommands.length')).toBe(0);
  });

  it('publishes the pruned active message to the contact baseline after a background removal', async () => {
    await freshMount();
    await click('[data-test="conversation-row-read-01"]');
    await cdp!.js('window.__h.wait(250)');
    // Move reader focus to the oldest message; its sender is the contact baseline.
    await press('p');
    await cdp!.js('window.__h.wait(60)');
    await press('p');
    await cdp!.js('window.__h.wait(60)');
    expect(await activeTest()).toBe('message-toggle-read-01-m1');
    expect(await cdp!.js(`window.__h.text('[data-test="contact-name"]')`)).toBe('Ada Fixture');
    // A background replacement removes the focused message: the reader resolves
    // focus to the next surviving neighbor and publishes that identity, so the
    // shell's contact baseline follows the resolved message (anon), never the
    // removed one.
    await cdp!.js(`window.__fixture.controls.removeMessage('read-01', 'read-01-m1')`);
    await cdp!.js('window.__h.wait(300)');
    expect(await activeTest()).toBe('message-toggle-read-01-m2');
    expect(await cdp!.js(`window.__h.exists('[data-test="reader"]')`)).toBe(true);
    expect(await cdp!.js(`window.__h.text('[data-test="contact-name"]')`)).toBe('anon@example.test');
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(0);
    expect(await cdp!.js('window.__fixture.controls.readCommands.length')).toBe(0);
  });

  it('keeps a directly focused participant override through the active-message handoff from a different active message', async () => {
    await freshMount();
    await click('[data-test="conversation-row-read-01"]');
    await cdp!.js('window.__h.wait(250)');
    expect(await activeTest()).toBe('message-toggle-read-01-m3');
    // Open the OLDEST message's details (the summary click itself makes m1
    // active), then return active message focus to the NEWEST message with a
    // real native toggle click while the m1 details stay open.
    await click('[data-test="message-details-summary-read-01-m1"]');
    await cdp!.js('window.__h.wait(80)');
    await click('[data-test="message-toggle-read-01-m3"]');
    await cdp!.js('window.__h.wait(80)');
    // Discriminating state immediately before the Ravi click: m3 owns active
    // message focus AND the m1 details are still open. (With m1 already
    // active, the Ravi click could not exercise the override-before-
    // active-message handoff at all.)
    expect(await activeTest()).toBe('message-toggle-read-01-m3');
    expect(await cdp!.js(`document.querySelector('.message-active')?.getAttribute('data-test') ?? null`)).toBe('message-read-01-m3');
    expect(await cdp!.js(`!!document.querySelector('[data-test="message-details-read-01-m1"]')?.open`)).toBe(true);
    expect(await cdp!.js(`window.__h.text('[data-test="contact-name"]')`)).toBe('Ada Fixture');
    // Directly focusing Ravi (a recipient of m1) makes the reader emit Ravi's
    // contact override BEFORE the active-message event for m1; the shell must
    // keep that override instead of clearing it as stale. A legacy handler
    // that unconditionally clears overrides on the active-message event shows
    // Ada here; the current handler shows Ravi.
    await click('[data-test="participant-to-read-01-m1-ravi@example.test"]');
    await cdp!.js('window.__h.wait(150)');
    expect(await cdp!.js(`document.querySelector('.message-active')?.getAttribute('data-test') ?? null`)).toBe('message-read-01-m1');
    expect(await cdp!.js(`window.__h.text('[data-test="contact-name"]')`)).toBe('Ravi Longname');
    expect(await cdp!.js(`window.__h.exists('[data-test="reader"]')`)).toBe(true);
  });

  it('keeps reader-owned focus on the article during loading, ignores O, and restores focus on immediate K reversal while the neighbor is still loading', async () => {
    await freshMount();
    await click('[data-test="conversation-row-read-01"]');
    await cdp!.js('window.__h.wait(250)');
    await press('O', { shift: true });
    await cdp!.js('window.__h.wait(60)');
    // Delay BOTH detail responses far beyond the CDP round trips: K is
    // dispatched while B is demonstrably still loading, before any B-ready
    // snapshot — the actual A-ready -> B-loading -> A-ready lastDataKey
    // reversal (P2-04), not an ordinary A->B->A roundtrip.
    await cdp!.js('window.__fixture.controls.delayNextDetail(1000, 2)');
    await press('j');
    await cdp!.js('window.__h.wait(60)');
    expect(await cdp!.js(`window.__h.exists('[data-test="reader-loading"]')`)).toBe(true);
    // Reader-owned focus parks on the persistent reader article, not <body>.
    expect(await activeTest()).toBe('reader');
    // O during loading must not mutate the outgoing visit's saved expansion.
    await press('o');
    await cdp!.js('window.__h.wait(60)');
    // Still loading: no B-ready snapshot has arrived. Dispatch real native K
    // NOW, reversing back to A before its last successful key ever changes.
    expect(await cdp!.js(`window.__h.exists('[data-test="reader-loading"]')`)).toBe(true);
    expect(await cdp!.js(`window.__h.text('.reader-subject')`)).toBe(null);
    await press('k');
    // Both delayed responses settle; the stale J response is token-discarded
    // and the A-ready snapshot restores the saved visit.
    await cdp!.js('window.__h.wait(1600)');
    expect(await cdp!.js(`window.__h.text('.reader-subject')`)).toBe('Reader journey thread');
    // Saved expansion is restored, untouched by the loading-time O.
    expect(await cdp!.js(`[...document.querySelectorAll('.message-toggle')].map((t) => t.getAttribute('aria-expanded')).join(',')`)).toBe('true,true,true');
    expect(await activeTest()).toBe('message-toggle-read-01-m3');
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(0);
    expect(await cdp!.js('window.__fixture.controls.readCommands.length')).toBe(0);
  });

  /** Polls the reader scroller until native (possibly smooth) scrolling settles. */
  async function settledScroll(): Promise<number> {
    let previous = -1;
    for (let i = 0; i < 20; i += 1) {
      await cdp!.js('window.__h.wait(100)');
      const current = await cdp!.js<number>(`document.querySelector('[data-test="reader-scroll"]').scrollTop`);
      if (current === previous) return current;
      previous = current;
    }
    return previous;
  }

  it('leaves reader ArrowDown/ArrowUp to native scrolling with no conversation fetch, from Inbox and Activity origins', async () => {
    await freshMount();
    await click('[data-test="conversation-row-read-01"]');
    await cdp!.js('window.__h.wait(250)');
    const callsBefore = await cdp!.js<number>('window.__fixture.controls.detailCalls.length');
    await cdp!.js(`document.querySelector('[data-test="reader-scroll"]').scrollTop = 0;`);
    await cdp!.js('window.__h.wait(60)');
    // Native ArrowDown scrolls the reader scroller; no preventDefault, no fetch.
    await press('ArrowDown');
    const scrolled = await settledScroll();
    expect(scrolled).toBeGreaterThan(0);
    expect(await cdp!.js<number>('window.__fixture.controls.detailCalls.length')).toBe(callsBefore);
    expect(await cdp!.js(`window.__h.text('.reader-subject')`)).toBe('Reader journey thread');
    // ArrowUp scrolls back up natively; still no fetch, still no switch.
    await press('ArrowUp');
    const scrolledBack = await settledScroll();
    expect(scrolledBack).toBeLessThan(scrolled);
    expect(await cdp!.js<number>('window.__fixture.controls.detailCalls.length')).toBe(callsBefore);
    expect(await cdp!.js(`window.__h.exists('[data-test="reader"]')`)).toBe(true);

    // Activity-origin reader: the duplicate archive operations reference
    // read-02; arrows there stay native too and never fetch or advance.
    await press('Escape');
    await cdp!.js('window.__h.wait(150)');
    await click('[data-test="rail-activity"]');
    await cdp!.js('window.__h.wait(150)');
    await click('[data-test="activity-open-read-op-1"]');
    await cdp!.js('window.__h.wait(250)');
    expect(await cdp!.js(`window.__h.text('.reader-subject')`)).toBe('Neighbor thread read-02');
    const callsBeforeActivity = await cdp!.js<number>('window.__fixture.controls.detailCalls.length');
    await press('ArrowDown');
    await cdp!.js('window.__h.wait(120)');
    expect(await cdp!.js<number>('window.__fixture.controls.detailCalls.length')).toBe(callsBeforeActivity);
    expect(await cdp!.js(`window.__h.text('.reader-subject')`)).toBe('Neighbor thread read-02');
    expect(await cdp!.js(`window.__h.exists('[data-test="reader"]')`)).toBe(true);
  });

  it('archives with action-time neighbor ordering after a mid-reading list reorder', async () => {
    await freshMount();
    // Enter read-03 while the list is still in entry order [01,02,03,04].
    await click('[data-test="conversation-row-read-03"]');
    await cdp!.js('window.__h.wait(250)');
    expect(await cdp!.js(`window.__h.text('.reader-subject')`)).toBe('Neighbor thread read-03');
    // The list is reordered while reading: current order [01,03,02,04].
    await cdp!.js(`window.__fixture.controls.reorderInbox(['read-01', 'read-03', 'read-02', 'read-04'])`);
    await cdp!.js('window.__h.wait(150)');
    // E archives read-03; advancement must use ACTION-TIME ordering: the
    // surviving next neighbor is read-02, not the entry-order read-04.
    await press('e');
    await cdp!.js('window.__h.wait(300)');
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(1);
    expect(await cdp!.js('window.__fixture.controls.archiveCommands[0].conversation.conversationId')).toBe('read-03');
    expect(await cdp!.js(`window.__h.text('.reader-subject')`)).toBe('Neighbor thread read-02');
    expect(await cdp!.js(`window.__h.exists('[data-test="reader"]')`)).toBe(true);
  });
});
