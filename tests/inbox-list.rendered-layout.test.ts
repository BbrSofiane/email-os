// @vitest-environment node
/**
 * Rendered-layout regression for the UX-01 compact row (real Chrome, real CSS).
 *
 * This is the P1 guard for the compact conversation row at the 1000 CSS px
 * supported desktop breakpoint: with an unknown read state (and, in the worst
 * case, a pending membership operation) the row metadata was unbounded and
 * collapsed the subject/snippet column to zero width. jsdom has no layout, so
 * these assertions only mean something against real rendered CSS.
 *
 * The second P1 guard covers larger user text: at 1000px with a 20px root font
 * and the long old date label, the full inline metadata overflows the row, so
 * the adaptive compact presentation collapses the actions behind a named,
 * keyboard- and pointer-operable disclosure instead of trading subject
 * collapse for horizontal overflow.
 *
 * Opt-in only: set EMAIL_OS_RENDERED_LAYOUT_CHROME to a Chrome/Chromium binary
 * path to run, e.g.
 *
 *   EMAIL_OS_RENDERED_LAYOUT_CHROME=/path/to/chrome \
 *     pnpm vitest run tests/inbox-list.rendered-layout.test.ts
 *
 * The test starts its own ephemeral Vite dev server and its own headless
 * Chrome profile (synthetic in-memory browser fake only — never real Gmail,
 * never real mail), and tears both down in `afterAll`. Default `pnpm test`
 * runs skip it (jsdom environment stays default).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

const CHROME_ENV = 'EMAIL_OS_RENDERED_LAYOUT_CHROME';
const chromePath = process.env[CHROME_ENV] ?? '';

interface Rect { left: number; right: number; top: number; bottom: number; width: number; height: number }
interface RowMeasure {
  innerWidth: number;
  clientMode: string | null;
  row: Rect;
  rowScrollWidth: number;
  rowClientWidth: number;
  listScrollWidth: number;
  listClientWidth: number;
  sender: Rect;
  subjectSnippet: Rect;
  subject: { left: number; right: number; width: number; visibleChars: number; truncated: boolean; text: string };
  meta: Rect;
  date: string | null;
  pending: { width: number; text: string } | null;
  readState: { width: number; text: string; test: string | null } | null;
  buttons: Array<{ name: string; test: string | null; visible: boolean } & Rect>;
  focusedButtons: Array<string | null>;
  toggle: { visible: boolean; ariaExpanded: string | null } & Rect | null;
  actionsPanel: { position: string; visibility: string; width: number } | null;
}

interface CdpSession {
  cmd(method: string, params?: Record<string, unknown>): Promise<any>;
  js<T>(expression: string): Promise<T>;
  close(): void;
}

describe.skipIf(chromePath === '')('InboxList rendered layout (real Chrome, opt-in)', () => {
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

    profileDir = mkdtempSync(join(tmpdir(), 'email-os-layout-chrome-'));
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
    await cdp.cmd('Page.enable');    await cdp.cmd('Page.navigate', { url: appUrl });
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
  window.__layoutMount = async (mode, options = {}) => {
    const root = document.querySelector('#app');
    root.__vue_app__?.unmount();
    const fake = createBrowserFakeMailClient();
    if (mode === 'gmail-actions') {
      fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'review@example.test', mutationAccess: 'enabled', coverageLimit: 100 });
    }
    window.__layoutFake = fake;
    // The long old-date label is the widest realistic trailing date.
    const client = options.oldDate
      ? { ...fake, listConversations: async () => {
          const snapshot = await fake.listConversations();
          return { ...snapshot, conversations: snapshot.conversations.map((r) => r.ref.conversationId === 'conv-01' || r.ref.conversationId === 'conv-17' ? { ...r, lastMessageAt: '2001-09-30T09:00:00Z' } : r) };
        } }
      : fake;
    createApp(App, { client, mode: 'browser-preview' }).mount(root);
  };
})()`;

  const MEASURE_SCRIPT = `(() => {
  const row = document.querySelector('[data-test="conversation-row-conv-01"]');
  if (!row) throw new Error('conv-01 row missing');
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const subject = row.querySelector('.row-subject');
  const textNode = subject.firstChild;
  const box = subject.getBoundingClientRect();
  // Range client rects are clipped by text-overflow: ellipsis, so they cannot
  // count hidden characters. caretRangeFromPoint walks the actually-rendered
  // prefix: the deepest text offset reachable inside the subject box is the
  // number of leading characters a reader can see.
  const midY = box.top + box.height / 2;
  let visibleChars = 0;
  for (const frac of [0.55, 0.7, 0.85, 0.95]) {
    const caret = document.caretRangeFromPoint(box.left + box.width * frac, midY);
    if (caret && caret.startContainer === textNode) visibleChars = Math.max(visibleChars, caret.startOffset);
  }
  const pick = (selector) => { const el = row.querySelector(selector); return el ? { width: el.getBoundingClientRect().width, text: el.textContent, test: el.getAttribute('data-test') } : null; };
  const isVisible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const focusedButtons = [];
  for (const button of row.querySelectorAll('button')) {
    button.focus();
    if (document.activeElement === button) focusedButtons.push(button.getAttribute('data-test'));
  }
  const toggle = row.querySelector('[data-test^="row-actions-toggle-"]');
  const panel = row.querySelector('.row-actions');
  const panelStyle = panel ? getComputedStyle(panel) : null;
  return {
    innerWidth,
    clientMode: document.querySelector('.app')?.getAttribute('data-client-mode') ?? null,
    row: rect(row),
    rowScrollWidth: row.scrollWidth,
    rowClientWidth: row.clientWidth,
    listScrollWidth: document.querySelector('.inbox-scroll').scrollWidth,
    listClientWidth: document.querySelector('.inbox-scroll').clientWidth,
    sender: rect(row.querySelector('.row-sender')),
    subjectSnippet: rect(row.querySelector('.row-subject-snippet')),
    subject: { left: box.left, right: box.right, width: box.width, visibleChars, truncated: subject.scrollWidth > subject.clientWidth + 0.5, text: subject.textContent },
    meta: rect(row.querySelector('.row-meta')),
    date: row.querySelector('.row-time')?.textContent ?? null,
    pending: pick('[data-test="row-pending"]'),
    readState: pick('[data-test="row-read-unknown"], [data-test="row-read"], [data-test="row-unread"]'),
    buttons: [...row.querySelectorAll('button')].map((b) => ({ name: (b.getAttribute('aria-label') ?? b.textContent ?? '').trim(), test: b.getAttribute('data-test'), visible: isVisible(b), ...rect(b) })),
    focusedButtons,
    toggle: toggle ? { visible: isVisible(toggle), ariaExpanded: toggle.getAttribute('aria-expanded'), ...rect(toggle) } : null,
    actionsPanel: panel && panelStyle ? { position: panelStyle.position, visibility: panelStyle.visibility, width: panel.getBoundingClientRect().width } : null,
  };
})()`;

  async function resize(width: number): Promise<void> {
    await cdp!.cmd('Emulation.setDeviceMetricsOverride', { width, height: 720, screenWidth: width, screenHeight: 720, deviceScaleFactor: 1, mobile: false });
    await tick();
  }

  async function tick(): Promise<void> {
    await cdp!.js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }

  async function mountGmailActions(options: { oldDate?: boolean } = {}): Promise<void> {
    // (Re)installs the mount helper (module imports are cached), then mounts.
    await cdp!.js(MOUNT_SCRIPT);
    await cdp!.js(`window.__layoutMount('gmail-actions', ${JSON.stringify(options)})`);
    await tick();
  }

  /** Emulates a larger user root-font preference (never overrides it in the app). */
  async function setRootFont(fontPx: number | ''): Promise<void> {
    const value = fontPx === '' ? '' : `${fontPx}px`;
    await cdp!.js(`document.documentElement.style.fontSize = ${JSON.stringify(value)}`);
    await tick();
  }

  async function measure(): Promise<RowMeasure> {
    return cdp!.js<RowMeasure>(MEASURE_SCRIPT);
  }

  /** Real CDP key event (trusted input), not HTMLElement dispatch. */
  async function realKey(key: 'Tab' | 'Enter' | 'Escape'): Promise<void> {
    const virtualKey = key === 'Tab' ? 9 : key === 'Enter' ? 13 : 27;
    // Enter needs the carriage-return text payload for Chrome to run the
    // native button-activation default action on the trusted keydown.
    await cdp!.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: virtualKey, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await cdp!.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: virtualKey });
    await tick();
  }

  /** Real CDP mouse click at the center of a measured rect (trusted input). */
  async function realClick(r: Rect): Promise<void> {
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    await cdp!.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp!.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp!.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await tick();
  }

  function assertCompactRowLayout(m: RowMeasure, options: { minVisibleChars: number; expectPending: boolean; expectFullSubject?: boolean; expectCompact?: boolean }): void {
    // Synthetic-only guard: these numbers are meaningless outside the labelled preview.
    expect(m.clientMode).toBe('browser-preview');
    expect(m.innerWidth).toBeGreaterThanOrEqual(1000);

    // The subject/snippet column never collapses; the subject itself keeps a
    // readable prefix of the fixture text visible ("Fixture thread …").
    expect(m.subjectSnippet.width).toBeGreaterThanOrEqual(120);
    expect(m.subject.width).toBeGreaterThanOrEqual(100);
    expect(m.subject.visibleChars).toBeGreaterThanOrEqual(options.minVisibleChars);
    expect(m.subject.text).toBe('Fixture thread 1: weekly status');
    if (options.expectFullSubject) {
      // Wide desktop sanity: the whole subject renders without truncation.
      expect(m.subject.truncated).toBe(false);
    }

    // Single-line scanning rhythm, no horizontal overflow anywhere in the row.
    expect(m.row.height).toBeLessThanOrEqual(48);
    expect(m.rowScrollWidth).toBeLessThanOrEqual(m.rowClientWidth + 1);
    expect(m.listScrollWidth).toBeLessThanOrEqual(m.listClientWidth + 1);

    const visibleButtons = m.buttons.filter((b) => b.visible);
    if (options.expectCompact) {
      // Adaptive compact presentation: the inline actions leave the flow behind
      // the named disclosure control — hidden, never clipped, still measurable.
      expect(m.toggle).not.toBeNull();
      expect(m.toggle!.visible).toBe(true);
      expect(m.toggle!.ariaExpanded).toBe('false');
      // The disclosure toggle is the only visible row action control.
      expect(visibleButtons.map((b) => b.test)).toEqual(['row-actions-toggle-conv-01']);
      expect(m.actionsPanel!.position).toBe('absolute');
      expect(m.actionsPanel!.visibility).toBe('hidden');
      expect(m.actionsPanel!.width).toBeGreaterThan(0);
    } else {
      // Expanded presentation: every action stays a visible, named,
      // keyboard-reachable control inside the row.
      expect(visibleButtons.length).toBeGreaterThan(0);
      for (const button of visibleButtons) {
        expect(button.width).toBeGreaterThan(0);
        expect(button.right).toBeLessThanOrEqual(m.row.right + 0.5);
        expect(button.name.length).toBeGreaterThan(0);
      }
      expect(m.actionsPanel!.visibility).toBe('visible');
      expect(m.focusedButtons).toHaveLength(visibleButtons.length);
    }

    // Pending and read-state disclosures stay visible (not clipped away).
    if (options.expectPending) {
      expect(m.pending).not.toBeNull();
      expect(m.pending!.width).toBeGreaterThan(0);
      expect(m.pending!.text).toBe('Pending…');
    }
    expect(m.readState).not.toBeNull();
    expect(m.readState!.width).toBeGreaterThan(0);
    expect(m.readState!.test).toBe('row-read-unknown');
  }

  it('keeps a readable single-line subject with unknown read state, pending membership, and row actions', async () => {
    try {
      // Scenario 1: unknown read state, actions enabled, 1000 CSS px — the P1 case.
      await resize(1000);
      await setRootFont(16);
      await mountGmailActions();
      await cdp!.js("window.__layoutFake.controls.markReadUnknown('conv-01')");
      await tick();
      const unknown = await measure();
      assertCompactRowLayout(unknown, { minVisibleChars: 10, expectPending: false });
      // Actions enabled: both directional read controls plus Archive stay explicit,
      // with their full accessible names on compact labels.
      expect(unknown.buttons.filter((b) => b.visible).map((b) => b.test)).toEqual([
        'row-mark-read-conv-01',
        'row-mark-unread-conv-01',
        'row-archive-conv-01',
      ]);
      expect(unknown.buttons.filter((b) => b.visible).map((b) => b.name)).toEqual(['Mark read', 'Mark unread', 'Archive']);
      // Pointer route works: a click really issues the read command.
      await cdp!.js("document.querySelector('[data-test=\"row-mark-read-conv-01\"]').click()");
      await tick();
      const operations = await cdp!.js<number>('window.__layoutFake.controls.activity().length');
      expect(operations).toBeGreaterThan(0);

      // Scenario 2: worst case — unknown read state plus a held unarchive
      // (realistic unknown+pending combination, never a faked pending read).
      await mountGmailActions();
      await cdp!.js(`(async () => {
        const fake = window.__layoutFake;
        fake.controls.markReadUnknown('conv-01');
        fake.controls.behavior.hold = true;
        const snapshot = await fake.listConversations();
        const target = snapshot.conversations.find((r) => r.ref.conversationId === 'conv-01');
        await fake.setArchived({ conversation: target.ref, archived: false, requestId: 'layout-regression-held-unarchive' });
      })()`);
      await tick();
      const unknownPending = await measure();
      assertCompactRowLayout(unknownPending, { minVisibleChars: 10, expectPending: true });
      expect(unknownPending.buttons.filter((b) => b.visible).map((b) => b.name)).toEqual(['Mark read', 'Mark unread', 'Archive']);

      // Scenario 3: wider desktop sanity — nothing wedged, subject fully readable.
      await resize(1440);
      await mountGmailActions();
      await cdp!.js("window.__layoutFake.controls.markReadUnknown('conv-01')");
      await tick();
      const wide = await measure();
      assertCompactRowLayout(wide, { minVisibleChars: 20, expectPending: false, expectFullSubject: true });
      // Full fixture subject text fits (no truncation on a wide desktop).
      expect(wide.subject.width).toBeGreaterThan(200);
      expect(wide.sender.width).toBeLessThanOrEqual(160.5);
    } finally {
      await setRootFont('').catch(() => undefined);
    }
  }, 180_000);

  it('collapses overflowing row actions behind an operable disclosure at a larger root font', async () => {
    const setupScenario = async (rootFont: number): Promise<void> => {
      await resize(1000);
      await setRootFont(rootFont);
      await mountGmailActions({ oldDate: true });
      // Realistic unknown+pending membership: unknown read facts plus a held
      // unarchive (a pending read setter would make read facts known).
      await cdp!.js(`(async () => {
        const fake = window.__layoutFake;
        fake.controls.markReadUnknown('conv-01');
        fake.controls.markReadUnknown('conv-05');
        fake.controls.markReadUnknown('conv-17');
        fake.controls.behavior.hold = true;
        const snapshot = await fake.listConversations();
        for (const id of ['conv-01', 'conv-17']) {
          const target = snapshot.conversations.find((r) => r.ref.conversationId === id);
          await fake.setArchived({ conversation: target.ref, archived: false, requestId: 'larger-text-held-unarchive-' + id });
        }
      })()`);
      await tick();
    };

    try {
      // 1000px / 16px root font, old date, unknown+pending: the expanded row
      // still fits, so the presentation and its stable action ids are unchanged.
      await setupScenario(16);
      const at16 = await measure();
      assertCompactRowLayout(at16, { minVisibleChars: 10, expectPending: true });
      expect(at16.date).toBe('30 Sept 2001');
      expect(at16.buttons.filter((b) => b.visible).map((b) => b.test)).toEqual([
        'row-mark-read-conv-01',
        'row-mark-unread-conv-01',
        'row-archive-conv-01',
      ]);
      expect(at16.toggle!.visible).toBe(false);

      // 1000px / 20px root font, same scenario: the expanded presentation
      // overflows the row, so the adaptive compact presentation engages —
      // subject stays readable, nothing clips or overflows, and every action
      // moves behind the named disclosure control.
      await setRootFont(20);
      await tick();
      const at20 = await measure();
      assertCompactRowLayout(at20, { minVisibleChars: 10, expectPending: true, expectCompact: true });
      expect(at20.date).toBe('30 Sept 2001');
      expect(at20.subject.width).toBeGreaterThan(at16.subject.width);

      // Pointer access: a real CDP mouse click on the disclosure toggle opens
      // the row action panel.
      await realClick(at20.toggle!);
      const openByPointer = await measure();
      expect(openByPointer.toggle!.ariaExpanded).toBe('true');
      expect(openByPointer.actionsPanel!.visibility).toBe('visible');
      const popoverButtons = openByPointer.buttons.filter((b) => b.visible && b.test !== 'row-actions-toggle-conv-01');
      expect(popoverButtons.map((b) => b.name)).toEqual(['Mark read', 'Mark unread', 'Archive']);
      // Every disclosed action is hit-testable at its center — inside the
      // visible panel, not clipped by the row or the list scroller.
      const hitTests = await cdp!.js<Array<{ test: string | null; hitIsTarget: boolean }>>(`[...document.querySelectorAll('[data-test="conversation-row-conv-01"] button')]
        .filter((b) => b.getAttribute('data-test') !== 'row-actions-toggle-conv-01' && b.getClientRects().length > 0 && getComputedStyle(b).visibility !== 'hidden')
        .map((b) => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { test: b.getAttribute('data-test'), hitTest: hit?.getAttribute('data-test') ?? null, hitIsTarget: hit === b }; })`);
      expect(hitTests.map((h) => h.test)).toEqual(['row-mark-read-conv-01', 'row-mark-unread-conv-01', 'row-archive-conv-01']);
      for (const hit of hitTests) expect(hit.hitIsTarget).toBe(true);

      // Keyboard access, part 1: Escape closes the panel and returns focus to
      // the disclosure control (real key events, not dispatched DOM events).
      // Note: the full measurement script probes button focus, so between real
      // key events these steps use lightweight attribute probes only.
      const toggleAria = () => cdp!.js<string | null>("document.querySelector('[data-test=\"row-actions-toggle-conv-01\"]').getAttribute('aria-expanded')");
      const activeTest = () => cdp!.js<string | null>("document.activeElement?.getAttribute('data-test') ?? null");
      await realKey('Escape');
      expect(await toggleAria()).toBe('false');
      expect(await activeTest()).toBe('row-actions-toggle-conv-01');

      // Keyboard access, part 2: Enter opens the disclosure from the toggle,
      // Tab reaches the first disclosed action, and Enter operates it —
      // a pending read setter makes the read facts known.
      await realKey('Enter');
      expect(await toggleAria()).toBe('true');
      expect(await activeTest()).toBe('row-actions-toggle-conv-01');
      await realKey('Tab');
      expect(await activeTest()).toBe('row-mark-read-conv-01');
      const operationsBefore = await cdp!.js<number>('window.__layoutFake.controls.activity().length');
      await realKey('Enter');
      await tick();
      const afterActivate = await measure();
      expect(afterActivate.readState!.test).toBe('row-read');
      expect(afterActivate.readState!.text).toBe('Read');
      expect(await cdp!.js<number>('window.__layoutFake.controls.activity().length')).toBeGreaterThan(operationsBefore);
      // The activated button is replaced by the read-state re-render, so focus
      // drops and the row's focusout-close folds the panel again; the row stays
      // compact, single-line, and free of horizontal overflow with the
      // remaining held unarchive pending.
      expect(afterActivate.toggle!.ariaExpanded).toBe('false');
      expect(afterActivate.row.height).toBeLessThanOrEqual(48);
      expect(afterActivate.rowScrollWidth).toBeLessThanOrEqual(afterActivate.rowClientWidth + 1);
      expect(afterActivate.listScrollWidth).toBeLessThanOrEqual(afterActivate.listClientWidth + 1);
      expect(afterActivate.subject.visibleChars).toBeGreaterThanOrEqual(10);
      expect(afterActivate.buttons.filter((b) => b.test !== 'row-actions-toggle-conv-01').map((b) => b.name)).toEqual(['Mark unread', 'Archive']);

      // Pointer access near the list bottom: the last compact row's panel opens
      // upward so every disclosed action stays inside the visible scroller box.
      await cdp!.js("document.querySelector('[data-test=\"conversation-row-conv-17\"]').scrollIntoView({ block: 'nearest' })");
      await tick();
      const lastToggle = await cdp!.js<Rect>("(() => { const r = document.querySelector('[data-test=\"row-actions-toggle-conv-17\"]').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })()");
      await realClick(lastToggle);
      expect(await cdp!.js<boolean>("document.querySelector('[data-test=\"conversation-row-conv-17\"]').classList.contains('actions-up')")).toBe(true);
      const lastHits = await cdp!.js<Array<{ test: string | null; hitIsTarget: boolean; top: number; bottom: number }>>(`[...document.querySelectorAll('[data-test="conversation-row-conv-17"] button')]
        .filter((b) => b.getAttribute('data-test') !== 'row-actions-toggle-conv-17' && b.getClientRects().length > 0 && getComputedStyle(b).visibility !== 'hidden')
        .map((b) => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { test: b.getAttribute('data-test'), hitIsTarget: hit === b, top: r.top, bottom: r.bottom }; })`);
      expect(lastHits.map((h) => h.test)).toEqual(['row-mark-read-conv-17', 'row-mark-unread-conv-17', 'row-archive-conv-17']);
      const viewportH = await cdp!.js<number>('innerHeight');
      for (const hit of lastHits) {
        expect(hit.hitIsTarget).toBe(true);
        expect(hit.top).toBeGreaterThanOrEqual(0);
        expect(hit.bottom).toBeLessThanOrEqual(viewportH);
      }
    } finally {
      await setRootFont('').catch(() => undefined);
      await teardown();
    }
  }, 240_000);
});