// @vitest-environment node
/** Opt-in trusted CDP keyboard/pointer evidence. Each case independently mounts synthetic state. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

const CHROME_ENV = 'EMAIL_OS_RENDERED_LAYOUT_CHROME';
const chromePath = process.env[CHROME_ENV] ?? '';

interface CdpSession {
  cmd(method: string, params?: Record<string, unknown>): Promise<any>;
  js<T>(expression: string): Promise<T>;
  close(): void;
}

describe.skipIf(chromePath === '')('UX-03 discovery (real Chrome, opt-in)', () => {
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

    profileDir = mkdtempSync(join(tmpdir(), 'email-os-discovery-chrome-'));
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
    const { createApp } = await import(vueUrl);
    const { default: App } = await import('/src/App.vue');
    const { createDiscoveryFixture } = await import('/tests/discovery.fixture.ts');
    window.__readerMount = async () => {
      const root = document.querySelector('#app'); root.__vue_app__?.unmount();
      const fixture = createDiscoveryFixture(); window.__fixture = fixture;
      await fixture.seedDone();
      createApp(App, { client: fixture.client, mode: 'browser-preview' }).mount(root);
    };
    window.__h = {
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      active: () => document.activeElement?.getAttribute('data-test'),
      clickPoint: (sel) => {
        const el = document.querySelector(sel); if (!el) throw new Error('missing ' + sel);
        el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2 };
      },
    };
  })()`;

  async function press(key: string, options: { shift?: boolean; ctrl?: boolean } = {}): Promise<void> {
    // Keep the effective key consistent with the shift modifier: Shift+U must
    // report key 'U', not a base-spread lowercase 'u'.
    const effectiveKey = options.shift && key.length === 1 ? key.toUpperCase() : key;
    const base: Record<string, unknown> = { key: effectiveKey };
    if (options.shift) { base.modifiers = 8; }
    const keyCode: Record<string, number> = { n: 78, p: 80, o: 79, j: 74, k: 75, u: 85, Escape: 27, Enter: 13, Tab: 9, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38 };
    const code: Record<string, string> = { n: 'KeyN', p: 'KeyP', o: 'KeyO', j: 'KeyJ', k: 'KeyK', u: 'KeyU', Tab: 'Tab', ArrowLeft: 'ArrowLeft', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp' };
    const printable = key.length === 1;
    const keyPayload = {
      key: effectiveKey,
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
    await cdp!.js(`document.querySelector('#discovery-scroll-test')?.remove()`);
    await cdp!.js('window.__readerMount()');
    await cdp!.js('window.__h.wait(250)');
    // Activate the fresh page with trusted input before arranging focus/scroll.
    // Otherwise Chrome's first pointer event replays page-activation focusin
    // on the programmatically focused row and legitimately reveals it.
    await cdp!.cmd('Page.bringToFront');
    await click('[data-test="rail-inbox"]');
    await cdp!.js('window.__h.wait(60)');
  }

  it('types in the focused palette with zero mutations, highlights, contains Tab and restores focus', async () => {
    await freshMount();
    await cdp!.js(`document.querySelector('[data-test="conversation-row-read-03"]').focus()`);
    await click('[data-test="palette-trigger"]');
    await cdp!.js('window.__h.wait(80)');
    expect(await activeTest()).toBe('action-query');
    await cdp!.cmd('Input.insertText', { text: 'e/s/h' });
    for (const key of ['e', 's', 'h', 'ArrowLeft']) await press(key);
    expect(await cdp!.js(`document.querySelector('input').value`)).toContain('e/s/h');
    expect(await cdp!.js(`window.__fixture.controls.archiveCommands.length + window.__fixture.controls.readCommands.length`)).toBe(0);
    await press('Tab'); expect(await activeTest()).toBe('action-query');
    await press('Tab', { shift: true }); expect(await activeTest()).toBe('action-query');
    await press('Escape'); await cdp!.js('window.__h.wait(60)');
    // Pointer trigger owns origin in this journey, not the previously focused row.
    expect(await activeTest()).toBe('palette-trigger');
    await click('[data-test="palette-trigger"]'); await cdp!.js('window.__h.wait(60)');
    await press('ArrowDown');
    expect(await cdp!.js(`document.querySelector('[aria-selected="true"]').textContent`)).toContain('Mark Done');
    expect(await cdp!.js(`getComputedStyle(document.querySelector('[aria-selected="true"]')).borderLeftColor`)).not.toBe('rgba(0, 0, 0, 0)');
    // The active result must remain visible even in a short scrolling palette.
    await cdp!.js(`document.querySelector('.action-overlay').style.maxHeight = '180px'`);
    for (let index = 0; index < 7; index += 1) await press('ArrowDown');
    await cdp!.js('window.__h.wait(60)');
    const highlight = await cdp!.js<{ top: number; bottom: number; outerTop: number; outerBottom: number }>(`(() => { const r = document.querySelector('[aria-selected="true"]').getBoundingClientRect(); const o = document.querySelector('.action-overlay').getBoundingClientRect(); return {top:r.top,bottom:r.bottom,outerTop:o.top,outerBottom:o.bottom}; })()`);
    expect(highlight.top).toBeGreaterThanOrEqual(highlight.outerTop);
    expect(highlight.bottom).toBeLessThanOrEqual(highlight.outerBottom);
    await press('Escape');
  });

  it.each(['pointer', 'row-origin'] as const)('palette → cached Done → reader Back → context Back restores exact ID and nonzero list geometry (%s)', async (origin) => {
    await freshMount();
    // Constrain only the fixture's scrollport to exercise real nonzero geometry with three rows.
    await cdp!.js(`(() => {
      const list = document.querySelector('.inbox-list'); list.style.height = '50px'; list.style.flex = 'none';
      document.querySelector('[data-test="conversation-row-read-03"]').focus();
    })()`);
    // Let the focus/layout/ResizeObserver turn finish before arranging the reading offset.
    await cdp!.js(`window.__h.wait(100)`);
    await cdp!.js(`document.querySelector('.inbox-list').scrollTop = 26`);
    await cdp!.js(`window.__h.wait(60)`);
    const geometry = `(() => { const list = document.querySelector('.inbox-list'); const row = document.querySelector('[data-test="conversation-row-read-03"]'); return { scroll: list.scrollTop, offset: row.getBoundingClientRect().top - list.getBoundingClientRect().top }; })()`;
    const before = await cdp!.js<{ scroll: number; offset: number }>(geometry);
    expect(before.scroll).toBeGreaterThan(0);
    // Keep the same test viewport constraint across list remounts.
    await cdp!.js(`(() => { const style = document.createElement('style'); style.textContent = '.inbox-list { height: 50px !important; flex: none !important; }'; style.id = 'discovery-scroll-test'; document.head.append(style); })()`);
    if (origin === 'pointer') await click('[data-test="palette-trigger"]');
    else {
      // Preserve row focus as native Cmd+K would. This tests its origin geometry,
      // not OS/WKWebView interception (which still requires the native checklist).
      expect(await activeTest()).toBe('conversation-row-read-03');
      await cdp!.js(`document.querySelector('[data-test="palette-trigger"]').click()`);
    }
    await cdp!.js('window.__h.wait(60)');
    await cdp!.cmd('Input.insertText', { text: 'Go to cached Done' }); await press('Enter'); await cdp!.js('window.__h.wait(150)');
    expect(await cdp!.js(`document.querySelector('[data-test="inbox-title"]').textContent`)).toBe('Cached Done');
    expect(await cdp!.js(`document.querySelector('[data-test="done-coverage"]').textContent`)).toContain('not provider-complete');
    await click('[data-test="conversation-row-read-01"]'); await cdp!.js('window.__h.wait(100)');
    await press('Escape'); await cdp!.js('window.__h.wait(100)');
    expect(await activeTest()).toBe('conversation-row-read-01');
    await click('[data-test="context-back"]'); await cdp!.js('window.__h.wait(120)');
    expect(await activeTest()).toBe('conversation-row-read-03');
    const after = await cdp!.js<{ scroll: number; offset: number }>(geometry);
    expect(after.scroll).toBe(before.scroll); expect(after.offset).toBe(before.offset);
    expect(await cdp!.js(`window.__fixture.controls.archiveCommands.length + window.__fixture.controls.readCommands.length`)).toBe(0);
    await cdp!.js(`document.querySelector('#discovery-scroll-test').remove()`);
  });

  it('Left navigator is list-only, restores focus, and G E obeys cancellation and timeout', async () => {
    await freshMount();
    await cdp!.js(`document.querySelector('[data-test="conversation-row-read-02"]').focus()`);
    await press('ArrowLeft'); await cdp!.js('window.__h.wait(60)');
    expect(await cdp!.js(`document.querySelector('[role="dialog"]').getAttribute('aria-label')`)).toBe('Destination navigator');
    await press('ArrowLeft'); expect(await activeTest()).toBe('action-query');
    await press('Escape'); await cdp!.js('window.__h.wait(60)');
    expect(await activeTest()).toBe('conversation-row-read-02');
    await press('g'); await press('h'); await press('g'); await cdp!.js('window.__h.wait(1100)'); await press('e'); await cdp!.js('window.__h.wait(100)');
    expect(await cdp!.js('window.__fixture.doneCalls()')).toBe(0);
    expect(await cdp!.js('window.__fixture.controls.archiveCommands[0].conversation.conversationId')).toBe('read-02');
    await press('g'); await press('e'); await cdp!.js('window.__h.wait(120)');
    expect(await cdp!.js(`document.querySelector('[data-test="inbox-title"]').textContent`)).toBe('Cached Done');
    await click('[data-test="conversation-row-read-01"]'); await cdp!.js('window.__h.wait(80)');
    await press('ArrowLeft'); expect(await cdp!.js(`document.querySelector('[role="dialog"]') !== null`)).toBe(false);
    await click('[data-test="navigator-trigger"]'); await cdp!.js('window.__h.wait(60)');
    await press('Escape'); expect(await cdp!.js(`document.querySelector('[data-test="reader"]') !== null`)).toBe(true);
  });
  it('fences delayed destination errors and capability changes under trusted input', async () => {
    await freshMount();
    await cdp!.js(`window.__fixture.delayDone(350); window.__fixture.failDone({ kind: 'storage_unavailable' })`);
    await click('[data-test="rail-done"]');
    await click('[data-test="rail-inbox"]');
    await cdp!.js('window.__h.wait(450)');
    expect(await cdp!.js(`document.querySelector('[data-test="inbox-title"]').textContent`)).toBe('Inbox');
    expect(await cdp!.js(`document.querySelector('[data-test="inbox-error"]') !== null`)).toBe(false);
    await click('[data-test="palette-trigger"]'); await cdp!.js('window.__h.wait(60)');
    expect(await cdp!.js(`document.querySelector('#action-archive') !== null`)).toBe(true);
    await cdp!.js('window.__fixture.setEnabled(false); window.__h.wait(80)');
    expect(await cdp!.js(`document.querySelector('#action-archive') !== null`)).toBe(false);
    await cdp!.cmd('Input.insertText', { text: 'Mark Done' }); await press('Enter');
    expect(await activeTest()).toBe('action-query');
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(0);
    await press('Escape');
  });

});
