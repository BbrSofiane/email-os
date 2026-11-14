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
 * The second P1 guard covers larger user text: at 1000px with the long old
 * date label, a 24px root font still fits inline (the sender column gives up
 * width first); from about 26px the full inline metadata no longer fits, so
 * the adaptive compact presentation collapses the actions behind a named,
 * keyboard- and pointer-operable disclosure (still without overflow at 28px
 * and 30px) instead of trading subject collapse for horizontal overflow.
 *
 * Opt-in only: set EMAIL_OS_RENDERED_LAYOUT_CHROME to a Chrome/Chromium binary
 * path to run, e.g.
 *
 *   EMAIL_OS_RENDERED_LAYOUT_CHROME=/path/to/chrome \
 *     mise run test:rendered
 *
 * The test starts its own ephemeral Vite dev server and its own headless
 * Chrome profile (synthetic in-memory browser fake only — never real Gmail,
 * never real mail), and tears both down in `afterAll`. Default `pnpm test`
 * the default test task excludes it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';

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
  readState: { width: number; text: string; test: string | null; label: string | null } | null;
  buttons: Array<{ name: string; test: string | null; visible: boolean } & Rect>;
  focusedButtons: Array<string | null>;
  toggle: { visible: boolean; ariaExpanded: string | null } & Rect | null;
  actionsPanel: { position: string; visibility: string; width: number } | null;
}

describe.skipIf(chromePath === '')('InboxList rendered layout (real Chrome, opt-in)', () => {
  let harness: RenderedHarness | null = null;
  let cdp: RenderedHarness['cdp'];

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-layout-chrome-', new URL('../..', import.meta.url).pathname);
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
  const pick = (selector) => { const el = row.querySelector(selector); return el ? { width: el.getBoundingClientRect().width, text: el.textContent, test: el.getAttribute('data-test'), label: el.getAttribute('aria-label') } : null; };
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
    // The unknown read state is a visible gutter glyph with an exact name.
    expect(m.readState).not.toBeNull();
    expect(m.readState!.width).toBeGreaterThan(0);
    expect(m.readState!.test).toBe('row-read-unknown');
    expect(m.readState!.label).toBe('Read state unknown');
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
      // Actions enabled: directional read controls, Remind, and Archive stay
      // explicit, with their full accessible names on compact labels.
      expect(unknown.buttons.filter((b) => b.visible).map((b) => b.test)).toEqual([
        'row-mark-read-conv-01',
        'row-mark-unread-conv-01',
        'row-remind-conv-01',
        'row-archive-conv-01',
      ]);
      expect(unknown.buttons.filter((b) => b.visible).map((b) => b.name)).toEqual(['Mark read', 'Mark unread', 'Remind me on this device', 'Mark done']);
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
      expect(unknownPending.buttons.filter((b) => b.visible).map((b) => b.name)).toEqual(['Mark read', 'Mark unread', 'Remind me on this device', 'Mark done']);

      // Scenario 3: wider desktop sanity — nothing wedged, subject fully readable.
      await resize(1440);
      await mountGmailActions();
      await cdp!.js("window.__layoutFake.controls.markReadUnknown('conv-01')");
      await tick();
      const wide = await measure();
      assertCompactRowLayout(wide, { minVisibleChars: 20, expectPending: false, expectFullSubject: true });
      // Full fixture subject text fits (no truncation on a wide desktop); at
      // the 12px row type the whole fixture subject is ~172px wide.
      expect(wide.subject.width).toBeGreaterThan(150);
      // The sender column holds the 132px spec width on a wide list.
      expect(wide.sender.width).toBeGreaterThan(131.5);
      expect(wide.sender.width).toBeLessThanOrEqual(132.5);
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
      expect(at16.date).toBe('30 Sep 2001');
      expect(at16.buttons.filter((b) => b.visible).map((b) => b.test)).toEqual([
        'row-mark-read-conv-01',
        'row-mark-unread-conv-01',
        'row-remind-conv-01',
        'row-archive-conv-01',
      ]);
      expect(at16.toggle!.visible).toBe(false);

      // 1000px / 24px root font, same scenario: the sender column gives up
      // width first, so the expanded presentation still fits without any
      // collapse, overflow, or unreadable subject, and all four actions stay
      // visible. (Measured in the rendered harness at 1000px: the sender starts
      // shrinking at about 22px and reaches its 72px floor at about 25.5px;
      // the expanded row fits up to 25.5px and collapses from about 26px.
      // Since the Remind action and the 16px attachment glyph joined the row
      // the expanded step moved 30px → 24px; it was 20px before the rail/contact
      // layout pass. 24px is 1.5px below the collapse point with 25px of sender
      // width still to give.)
      await setRootFont(24);
      await tick();
      const at24 = await measure();
      assertCompactRowLayout(at24, { minVisibleChars: 10, expectPending: true });
      expect(at24.date).toBe('30 Sep 2001');
      expect(at24.buttons.filter((b) => b.visible).map((b) => b.test)).toEqual([
        'row-mark-read-conv-01',
        'row-mark-unread-conv-01',
        'row-remind-conv-01',
        'row-archive-conv-01',
      ]);
      expect(at24.toggle!.visible).toBe(false);
      expect(at24.sender.width).toBeLessThan(at16.sender.width);

      // 1000px / 28px root font: the sender is giving up width and the
      // expanded presentation no longer fits, so the adaptive compact
      // presentation engages — subject stays readable, nothing clips or
      // overflows, and every action moves behind the named disclosure control.
      // (Collapse point at 1000px: 25.5px → 26px. Before the Remind action and
      // the attachment glyph it was about 33px; the old 34.5px compact step
      // overflows the row by 65px today, see the bound below.) 28px is 2.25px
      // below the compact-overflow point, with 31px of sender width to spare.
      //
      // Measured upper bound where even the compact row overflows (real Chrome
      // 156, synthetic fixture, old-date row with unknown read state and a
      // pending membership; overflow = row scrollWidth − clientWidth):
      //   1000px: compact fits up to 30.25px; 30.5px overflows by 3px, 31px by
      //           11px, 32px (200% of the default) by 27px, 34.5px by 65px.
      //   1100px: collapses at about 31.5px; compact fits up to 36.5px; 37px
      //           overflows by 4px, 38px by 20px.
      //   1280px: never collapses below 38.5px; from 39px compact overflows by
      //           2px, 46px by 5px.
      // The sender and subject floors are the P1 readability guard and are not
      // traded for more headroom.
      await setRootFont(28);
      await tick();
      const at28 = await measure();
      assertCompactRowLayout(at28, { minVisibleChars: 10, expectPending: true, expectCompact: true });
      expect(at28.date).toBe('30 Sep 2001');
      // The sender gave up width before the actions collapsed (it may regain
      // a little of the width the collapse frees).
      expect(at28.sender.width).toBeLessThan(at16.sender.width);
      expect(at28.sender.width).toBeLessThan(115);

      // 1000px / 30px root font, the failure this guard exists for: compact
      // presentation, disclosure operable by pointer and keyboard, no overflow.
      // (Compact fits up to 30.25px here, so this step keeps about 1px of
      // sender width above its 72px floor: it is the last step that fits.)
      await setRootFont(30);
      await tick();
      const at30 = await measure();
      assertCompactRowLayout(at30, { minVisibleChars: 10, expectPending: true, expectCompact: true });
      expect(at30.date).toBe('30 Sep 2001');
      expect(at30.sender.width).toBeLessThan(at16.sender.width);
      await realClick(at30.toggle!);
      const open30 = await measure();
      expect(open30.toggle!.ariaExpanded).toBe('true');
      expect(open30.actionsPanel!.visibility).toBe('visible');
      await realKey('Escape');
      const closed30 = await cdp!.js<string | null>("document.querySelector('[data-test=\"row-actions-toggle-conv-01\"]').getAttribute('aria-expanded')");
      expect(closed30).toBe('false');

      // The pointer and keyboard sequence below runs at 28px, clearly inside
      // the range where the compact row fits.
      await setRootFont(28);
      await tick();
      const at28Again = await measure();
      expect(at28Again.toggle!.visible).toBe(true);

      // Pointer access: a real CDP mouse click on the disclosure toggle opens
      // the row action panel.
      await realClick(at28Again.toggle!);
      const openByPointer = await measure();
      expect(openByPointer.toggle!.ariaExpanded).toBe('true');
      expect(openByPointer.actionsPanel!.visibility).toBe('visible');
      const popoverButtons = openByPointer.buttons.filter((b) => b.visible && b.test !== 'row-actions-toggle-conv-01');
      expect(popoverButtons.map((b) => b.name)).toEqual(['Mark read', 'Mark unread', 'Remind me on this device', 'Mark done']);
      // Every disclosed action is hit-testable at its center — inside the
      // visible panel, not clipped by the row or the list scroller. The hit
      // may be the button's own glyph or label, which activates the button.
      const hitTests = await cdp!.js<Array<{ test: string | null; hitIsTarget: boolean }>>(`[...document.querySelectorAll('[data-test="conversation-row-conv-01"] button')]
        .filter((b) => b.getAttribute('data-test') !== 'row-actions-toggle-conv-01' && b.getClientRects().length > 0 && getComputedStyle(b).visibility !== 'hidden')
        .map((b) => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { test: b.getAttribute('data-test'), hitTest: hit?.getAttribute('data-test') ?? null, hitIsTarget: hit !== null && b.contains(hit) }; })`);
      expect(hitTests.map((h) => h.test)).toEqual(['row-mark-read-conv-01', 'row-mark-unread-conv-01', 'row-remind-conv-01', 'row-archive-conv-01']);
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
      expect(afterActivate.readState!.label).toBe('Read');
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
      expect(afterActivate.buttons.filter((b) => b.test !== 'row-actions-toggle-conv-01').map((b) => b.name)).toEqual(['Mark unread', 'Remind me on this device', 'Mark done']);

      // Pointer access near the list bottom: the last compact row's panel opens
      // upward so every disclosed action stays inside the visible scroller box.
      await cdp!.js("document.querySelector('[data-test=\"conversation-row-conv-17\"]').scrollIntoView({ block: 'nearest' })");
      await tick();
      const lastToggle = await cdp!.js<Rect>("(() => { const r = document.querySelector('[data-test=\"row-actions-toggle-conv-17\"]').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })()");
      await realClick(lastToggle);
      expect(await cdp!.js<boolean>("document.querySelector('[data-test=\"conversation-row-conv-17\"]').classList.contains('actions-up')")).toBe(true);
      const lastHits = await cdp!.js<Array<{ test: string | null; hitIsTarget: boolean; top: number; bottom: number }>>(`[...document.querySelectorAll('[data-test="conversation-row-conv-17"] button')]
        .filter((b) => b.getAttribute('data-test') !== 'row-actions-toggle-conv-17' && b.getClientRects().length > 0 && getComputedStyle(b).visibility !== 'hidden')
        .map((b) => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { test: b.getAttribute('data-test'), hitIsTarget: hit !== null && b.contains(hit), top: r.top, bottom: r.bottom }; })`);
      expect(lastHits.map((h) => h.test)).toEqual(['row-mark-read-conv-17', 'row-mark-unread-conv-17', 'row-remind-conv-17', 'row-archive-conv-17']);
      const viewportH = await cdp!.js<number>('innerHeight');
      for (const hit of lastHits) {
        expect(hit.hitIsTarget).toBe(true);
        expect(hit.top).toBeGreaterThanOrEqual(0);
        expect(hit.bottom).toBeLessThanOrEqual(viewportH);
      }
    } finally {
      await setRootFont('').catch(() => undefined);
      await harness?.close();
      harness = null;
    }
  }, 240_000);
});
