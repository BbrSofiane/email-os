// @vitest-environment node
/** Opt-in trusted CDP keyboard/pointer evidence. Each case independently mounts synthetic state. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRenderedHarness, type RenderedHarness } from '../rendered/chromium';
import { pressRenderedKey } from '../rendered/keyboard';

const chromePath = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';

describe.skipIf(chromePath === '')('UX-03 discovery / UX-13 workspaces (real Chromium, opt-in)', () => {
  let harness: RenderedHarness | null = null;
  let cdp: RenderedHarness['cdp'];

  beforeAll(async () => {
    harness = await startRenderedHarness(chromePath, 'email-os-discovery-chrome-', new URL('../..', import.meta.url).pathname);
    cdp = harness.cdp;
    await cdp.js(MOUNT_SCRIPT);
    await cdp.js('window.__readerMount()');
    await cdp.js('window.__h.wait(150)');
  }, 120_000);

  afterAll(async () => { await harness?.close(); });

  /** Boots the app against the shared reader fixture (loaded through Vite). */
  const MOUNT_SCRIPT = `(async () => {
    const vueUrl = performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes('/node_modules/.vite/deps/vue.js'));
    const { createApp } = await import(vueUrl);
    const { default: App } = await import('/src/App.vue');
    const { createDiscoveryFixture } = await import('/tests/support/fixtures/discovery.fixture.ts');
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

  const press = (key: string, options: { shift?: boolean; ctrl?: boolean } = {}): Promise<void> => pressRenderedKey(cdp!, key, options, 'discovery');

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

  it('UX-08: trusted S, archived Starred, unstar removal and Back (synthetic memory only)', async () => {
    await cdp!.js(`(async () => {
      const vueUrl = performance.getEntriesByType('resource').map(x=>x.name).find(n=>n.includes('/node_modules/.vite/deps/vue.js'));
      const {createApp} = await import(vueUrl);
      const {default:App} = await import('/src/App.vue');
      const {createBrowserFakeMailClient} = await import('/src/lib/ipc/browser-fake.ts');
      const root = document.querySelector('#app'); root.__vue_app__?.unmount();
      const fake = createBrowserFakeMailClient();
      fake.controls.setAccount({mode:'gmail',connection:'connected',mutationAccess:'enabled'});
      window.__stars = fake;
      createApp(App,{client:fake,mode:'browser-preview'}).mount(root);
    })()`);
    await cdp!.js('window.__h.wait(250)');
    await click('[data-test="conversation-row-conv-01"]');
    await press('Escape'); await cdp!.js('window.__h.wait(60)');
    await press('s'); await cdp!.js('window.__h.wait(100)');
    expect(await cdp!.js(`document.querySelector('[data-test="conversation-row-conv-01"] [data-test="row-stars"]').textContent`)).toContain('★');
    await cdp!.js(`window.__stars.setArchived({conversation:{accountId:'gmail-account',conversationId:'conv-01'},archived:true,requestId:'rendered-archive'})`);
    await cdp!.js('window.__h.wait(100)');
    await click('[data-test="rail-starred"]'); await cdp!.js('window.__h.wait(100)');
    expect(await cdp!.js(`document.querySelector('[data-test="starred-coverage"]').textContent`)).toContain('not provider-complete');
    await click('[data-test="palette-trigger"]'); await cdp!.js('window.__h.wait(60)');
    await cdp!.cmd('Input.insertText', { text: 'unstar' });
    await press('Enter'); await cdp!.js('window.__h.wait(100)');
    expect(await cdp!.js(`document.querySelector('[data-test="inbox-empty"]').textContent`)).toContain('No known starred');
    await click('[data-test="context-back"]'); await cdp!.js('window.__h.wait(100)');
    expect(await cdp!.js(`document.querySelector('[data-test="inbox-title"]').textContent`)).toBe('Inbox');
  });

  /** Isolated in-memory client with manually settled IO; never touches a provider. */
  async function mountSplit(options: { saved?: boolean; delayedList?: boolean } = {}): Promise<void> {
    await setViewport(1200);
    await cdp!.js(`(async () => {
      const vueUrl = performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes('/node_modules/.vite/deps/vue.js'));
      const { createApp } = await import(vueUrl);
      const { default: App } = await import('/src/App.vue');
      const { createBrowserFakeMailClient } = await import('/src/lib/ipc/browser-fake.ts');
      const root = document.querySelector('#app'); root.__vue_app__?.unmount();
      const fake = createBrowserFakeMailClient();
      const row = (await fake.listConversations()).conversations[0];
      window.__splitDefinition = { name: 'Clients', criterion: 'sender', value: row.primaryCorrespondent.mailbox, enabled: true, hideWhenEmpty: false };
      if (${!!options.saved}) await fake.saveSavedSplit(row.ref.accountId, window.__splitDefinition);
      const control = window.__splitControl = { saves: 0, mutations: 0 };
      const client = { ...fake, saveSavedSplit: (...args) => {
        control.saves++;
        return new Promise((resolve, reject) => {
          control.reject = () => reject({ kind: 'storage_unavailable' });
          control.resolve = async () => { await fake.saveSavedSplit(...args); resolve(); };
        });
      } };
      for (const name of ['setArchived', 'setRead', 'undoOperation', 'setArchivedGroup', 'setReadGroup', 'undoOperationGroup']) {
        if (fake[name]) client[name] = (...args) => { control.mutations++; return fake[name](...args); };
      }
      if (${!!options.delayedList}) client.listConversations = () => new Promise((resolve, reject) => {
        control.rejectList = () => reject({ kind: 'storage_unavailable' });
      });
      createApp(App, { client, mode: 'browser-preview' }).mount(root);
      await window.__h.wait(150);
    })()`);
    await cdp!.cmd('Page.bringToFront');
  }

  async function openCreateSplit(): Promise<void> {
    await click('[data-test="palette-trigger"]');
    await cdp!.cmd('Input.insertText', { text: 'Create split' });
    await press('Enter');
    await cdp!.js('window.__h.wait(60)');
  }

  async function submitSplit(): Promise<void> {
    await openCreateSplit();
    await cdp!.js('window.__h.wait(40)');
    await cdp!.cmd('Input.insertText', { text: 'Clients' });
    await click('[data-test="split-value"]');
    await cdp!.cmd('Input.insertText', { text: await cdp!.js<string>('window.__splitDefinition.value') });
    // Submit from the value field so failure must restore that field, not just
    // repeat mount-time focus. Enter is trusted and exercises native submit.
    await press('Enter');
    await cdp!.js('window.__h.wait(60)');
  }

  it('lets initial/body and unavailable-list Tab reach Commands and create a split', async () => {
    for (const delayedList of [false, true]) {
      await mountSplit({ delayedList });
      expect(await cdp!.js('document.activeElement === document.body')).toBe(true);
      await press('Tab');
      expect(await cdp!.js('document.activeElement === document.body')).toBe(false);
      const reached = new Set<string | null>();
      for (let i = 0; i < 15 && !reached.has('palette-trigger'); i++) {
        reached.add(await activeTest());
        if (!reached.has('palette-trigger')) await press('Tab');
      }
      expect(reached.has('palette-trigger')).toBe(true);
      expect(await cdp!.js(`!!document.querySelector('[data-test="split-settings"]')`)).toBe(false);
      await press('Enter');
      await cdp!.cmd('Input.insertText', { text: 'Create split' });
      await press('Enter');
      await cdp!.js('window.__h.wait(60)');
      expect(await activeTest()).toBe('split-name');
      await press('Escape');
      expect(await activeTest()).toBe('palette-trigger');
      if (delayedList) {
        await cdp!.js('window.__splitControl.rejectList(); window.__h.wait(80)');
        expect(await cdp!.js(`!!document.querySelector('[data-test="inbox-error"]')`)).toBe(true);
        await cdp!.js('document.activeElement.blur()');
        // Split header order follows the visual order: the Destinations
        // hamburger is the first header stop, Commands sits in the right-hand
        // glyphs. Backward Tab from Commands must still reach Destinations.
        for (let i = 0; i < 8 && await activeTest() !== 'navigator-trigger'; i++) await press('Tab', { shift: true });
        expect(await activeTest()).toBe('navigator-trigger');
      } else {
        await cdp!.js(`document.querySelector('.inbox-row').focus()`);
        await press('Tab'); // No saved split: ordinary traversal to checkbox.
        expect(await cdp!.js(`document.activeElement.matches('.row-select')`)).toBe(true);
      }
    }
  });

  it('switches only from focused list state and releases both nonwrapping boundaries to native focus', async () => {
    await mountSplit({ saved: true });
    await cdp!.js(`document.querySelector('.inbox-row').focus()`);
    await press('Tab', { shift: true }); // Inbox boundary → preceding toolbar.
    expect(await cdp!.js(`document.activeElement.matches('button, input, select, a')`)).toBe(true);
    expect(await cdp!.js(`document.querySelector('[data-test="inbox-title"]').textContent`)).toBe('Inbox');
    for (let i = 0; i < 15 && await activeTest() !== 'palette-trigger'; i++) await press('Tab', { shift: true });
    expect(await activeTest()).toBe('palette-trigger');
    expect(await cdp!.js(`!!document.querySelector('[data-test="split-settings"]')`)).toBe(false);
    await cdp!.js(`document.querySelector('.inbox-row').focus()`);
    await press('Tab');
    await cdp!.js('window.__h.wait(100)');
    expect(await cdp!.js(`document.querySelector('[data-test="inbox-title"]').textContent`)).toBe('Clients');
    expect(await cdp!.js(`document.activeElement.matches('.inbox-row')`)).toBe(true);
    await press('Tab'); // Saved boundary → checkbox, not swallowed.
    expect(await cdp!.js(`document.activeElement.matches('.row-select')`)).toBe(true);
    await press('Tab', { shift: true }); // Checkbox retains native ownership.
    expect(await cdp!.js(`document.activeElement.matches('.inbox-row')`)).toBe(true);
    await press('Tab', { shift: true });
    await cdp!.js('window.__h.wait(100)');
    expect(await cdp!.js(`document.querySelector('[data-test="inbox-title"]').textContent`)).toBe('Inbox');
    expect(await cdp!.js(`document.activeElement.matches('.inbox-row')`)).toBe(true);
    await click('[data-test="palette-trigger"]');
    await cdp!.cmd('Input.insertText', { text: 'Edit split' });
    await press('Enter');
    expect(await activeTest()).toBe('split-name');
    await press('Tab');
    expect(await activeTest()).toBe('split-criterion');
    await press('Escape');
    expect(await activeTest()).toBe('palette-trigger');
  });

  it('toggles unread filtering through Commands, keeps total badges and restores list focus', async () => {
    await mountSplit({ saved: true });
    const inboxTotal = await cdp!.js<string>(`document.querySelector('[data-test="split-inbox"]').textContent`);
    const savedTotal = await cdp!.js<string>(`document.querySelector('[data-test="split-saved"]').textContent`);
    const all = await cdp!.js<number>(`document.querySelectorAll('.inbox-row').length`);
    expect(await cdp!.js(`!!document.querySelector('[data-test="unread-filter"]')`)).toBe(false);
    await click('[data-test="palette-trigger"]');
    await cdp!.cmd('Input.insertText', { text: 'Show unread only' });
    await press('Enter');
    await cdp!.js('window.__h.wait(120)');
    const unread = await cdp!.js<number>(`document.querySelectorAll('.inbox-row').length`);
    expect(unread).toBeGreaterThan(0);
    expect(unread).toBeLessThan(all);
    expect(await cdp!.js(`document.activeElement.matches('.inbox-row')`)).toBe(true);
    expect(await activeTest()).not.toBe('unread-filter-status'); // Status, not another control.
    expect(await cdp!.js(`document.querySelector('[data-test="unread-filter-status"]').textContent`)).toBe('Unread only');
    expect(await cdp!.js(`document.querySelector('[data-test="split-inbox"]').textContent`)).toBe(inboxTotal);
    expect(await cdp!.js(`document.querySelector('[data-test="split-saved"]').textContent`)).toBe(savedTotal);
    await click('[data-test="split-saved"]');
    await cdp!.js('window.__h.wait(100)');
    await click('[data-test="palette-trigger"]');
    await cdp!.cmd('Input.insertText', { text: 'Show all conversations' });
    await press('Enter');
    await cdp!.js('window.__h.wait(120)');
    expect(await cdp!.js(`document.querySelector('[data-test="inbox-title"]').textContent`)).toBe('Clients');
    expect(await cdp!.js(`!!document.querySelector('[data-test="unread-filter-status"]')`)).toBe(false);
    expect(await cdp!.js(`document.activeElement.matches('.inbox-row')`)).toBe(true);
    expect(await cdp!.js('window.__splitControl.mutations')).toBe(0);
  });

  it('recovers actual field focus after delayed rejection, owns displaced Escape, and never triages beneath the editor', async () => {
    await mountSplit();
    await submitSplit();
    expect(await cdp!.js('window.__splitControl.saves')).toBe(1);
    expect(await cdp!.js('document.activeElement === document.body')).toBe(true);
    for (const key of ['Escape', 'Enter', 'e', 'x', 'z']) await press(key);
    expect(await cdp!.js(`!!document.querySelector('.split-editor')`)).toBe(true);
    expect(await cdp!.js('window.__splitControl.saves')).toBe(1);
    await cdp!.js('window.__splitControl.reject(); window.__h.wait(100)');
    expect(await activeTest()).toBe('split-value');
    expect(await cdp!.js('window.__splitControl.saves')).toBe(1);
    expect(await cdp!.js(`!!document.querySelector('.split-editor [role="alert"]')`)).toBe(true);
    await cdp!.js('document.activeElement.blur()');
    for (const key of ['e', 'x', 'z']) await press(key);
    expect(await cdp!.js('window.__splitControl.mutations')).toBe(0);
    expect(await cdp!.js(`!!document.querySelector('[data-test="selection-live"]')`)).toBe(false);
    await press('Escape');
    expect(await cdp!.js(`!!document.querySelector('.split-editor')`)).toBe(false);
    expect(await activeTest()).toBe('palette-trigger');
  });

  it('does not restore rejected-save focus over a palette or after navigating away', async () => {
    await mountSplit();
    await submitSplit();
    await click('[data-test="palette-trigger"]');
    expect(await activeTest()).toBe('action-query');
    await cdp!.js('window.__splitControl.reject(); window.__h.wait(100)');
    expect(await activeTest()).toBe('action-query');
    await press('Escape');
    await press('Escape'); // visible editor can close from the palette trigger
    expect(await activeTest()).toBe('palette-trigger');
    await mountSplit();
    await submitSplit();
    await click('[data-test="rail-activity"]');
    await cdp!.js('window.__h.wait(80)');
    const focus = await activeTest();
    await cdp!.js('window.__splitControl.reject(); window.__h.wait(100)');
    expect(await cdp!.js(`!!document.querySelector('.split-editor')`)).toBe(false);
    expect(await activeTest()).toBe(focus);
    expect(await cdp!.js('window.__splitControl.mutations')).toBe(0);
  });

  it('returns successful save focus to its trigger without dismissing a newer editor', async () => {
    await mountSplit();
    await submitSplit();
    await cdp!.js('window.__splitControl.resolve(); window.__h.wait(150)');
    expect(await cdp!.js(`!!document.querySelector('.split-editor')`)).toBe(false);
    expect(await activeTest()).toBe('palette-trigger');
    await mountSplit();
    await submitSplit();
    await click('[data-test="rail-activity"]'); // dismiss pending instance
    await openCreateSplit(); // a different editor instance
    const newEditorFocus = await activeTest();
    await cdp!.js('window.__splitControl.resolve(); window.__h.wait(150)');
    expect(await cdp!.js(`!!document.querySelector('.split-editor')`)).toBe(true);
    expect(await activeTest()).toBe(newEditorFocus);
    expect(await cdp!.js('window.__splitControl.saves')).toBe(1);
    expect(await cdp!.js('window.__splitControl.mutations')).toBe(0);
    await mountSplit();
    await submitSplit();
    await click('[data-test="palette-trigger"]');
    await cdp!.js('window.__splitControl.resolve(); window.__h.wait(150)');
    expect(await activeTest()).toBe('action-query');
    await mountSplit();
    await submitSplit();
    await click('[data-test="rail-activity"]');
    await cdp!.js('window.__h.wait(80)');
    const navigatedFocus = await activeTest();
    await cdp!.js('window.__splitControl.resolve(); window.__h.wait(150)');
    expect(await activeTest()).toBe(navigatedFocus);
    expect(await cdp!.js(`!!document.querySelector('.split-editor')`)).toBe(false);
  });

  it('saves and browses one overlapping split with trusted input, archive and Undo (UX-06)', async () => {
    await cdp!.js(`(async () => {
      const vueUrl = performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes('/node_modules/.vite/deps/vue.js'));
      const { createApp } = await import(vueUrl);
      const { default: App } = await import('/src/App.vue');
      const { createBrowserFakeMailClient } = await import('/src/lib/ipc/browser-fake.ts');
      const root = document.querySelector('#app'); root.__vue_app__?.unmount();
      window.__splitFake = createBrowserFakeMailClient();
      const row = (await window.__splitFake.listConversations()).conversations[0];
      window.__splitSender = row.primaryCorrespondent.mailbox;
      createApp(App, { client: window.__splitFake, mode: 'browser-preview' }).mount(root);
      await window.__h.wait(150);
    })()`);
    await openCreateSplit();
    expect(await activeTest()).toBe('split-name');
    await cdp!.cmd('Input.insertText', { text: 'Clients' });
    await click('[data-test="split-value"]');
    await cdp!.cmd('Input.insertText', { text: await cdp!.js<string>('window.__splitSender') });
    await click('[data-test="split-save"]');
    await cdp!.js('window.__h.wait(150)');
    expect(await cdp!.js(`document.querySelector('[data-test="split-saved"]').textContent`)).toContain('Clients');
    await click('[data-test="split-saved"]');
    await cdp!.js('window.__h.wait(100)');
    const count = await cdp!.js<number>(`document.querySelectorAll('.inbox-row').length`);
    expect(count).toBeGreaterThan(0);
    await press('Tab');
    expect(await cdp!.js(`document.querySelector('[data-test="inbox-title"]').textContent`)).toBe('Clients');
    expect(await cdp!.js(`document.activeElement.matches('.row-select')`)).toBe(true);
    await cdp!.js(`document.querySelector('.inbox-row').focus()`);
    await press('Enter');
    await cdp!.js('window.__h.wait(100)');
    expect(await cdp!.js(`!!document.querySelector('[data-test="reader"]')`)).toBe(true);
    await click('[data-test="reader-archive-toggle"]');
    await cdp!.js('window.__h.wait(150)');
    await click('[data-test="reader-close"]');
    await cdp!.js('window.__h.wait(80)');
    expect(await cdp!.js(`document.querySelectorAll('.inbox-row').length`)).toBe(count - 1);
    await click('[data-test="action-notice-undo"]');
    await cdp!.js('window.__h.wait(150)');
    expect(await cdp!.js(`document.querySelectorAll('.inbox-row').length`)).toBe(count);
    await cdp!.js(`document.querySelector('.inbox-row').focus()`);
    await press('Tab', { shift: true });
    await cdp!.js('window.__h.wait(100)');
    expect(await cdp!.js(`document.querySelector('[data-test="inbox-title"]').textContent`)).toBe('Inbox');
    expect(await cdp!.js(`document.querySelectorAll('.inbox-row').length`)).toBe(18);
  });
  it('UX-10 A browses synthetic cached Trash with trusted input, literal text and no writes', async () => {
    for (const width of [1200, 999]) {
      await setViewport(width);
      await cdp!.js(`(async () => {
        const vueUrl = performance.getEntriesByType('resource').map(x => x.name).find(n => n.includes('/node_modules/.vite/deps/vue.js'));
        const { createApp } = await import(vueUrl);
        const { default: App } = await import('/src/App.vue');
        const { createBrowserFakeMailClient } = await import('/src/lib/ipc/browser-fake.ts');
        const fake = createBrowserFakeMailClient();
        fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'synthetic@example.test', mutationAccess: 'enabled' });
        fake.controls.markTriage('conv-06', 'trash');
        window.__trashWrites = [];
        for (const name of ['setArchived', 'setRead', 'setArchivedGroup', 'setReadGroup', 'createDraft']) {
          const original = fake[name].bind(fake);
          fake[name] = (...args) => { window.__trashWrites.push([name, args]); return original(...args); };
        }
        const root = document.querySelector('#app'); root.__vue_app__?.unmount();
        createApp(App, { client: fake, mode: 'browser-preview' }).mount(root);
        await window.__h.wait(200);
      })()`);
      await click('[data-test="palette-trigger"]');
      await cdp!.cmd('Input.insertText', { text: 'Go to cached Trash' });
      await press('Enter');
      await cdp!.js('window.__h.wait(200)');
      expect(await cdp!.js(`document.querySelector('[aria-label="Cached Trash browsing"]').textContent`)).toContain('not your complete Gmail Trash');
      await click('button[data-id="conv-06"]');
      await cdp!.js('window.__h.wait(200)');
      expect(await cdp!.js(`document.querySelector('[data-test="reader"]').textContent`)).toContain('<script>alert("body")</script>');
      expect(await cdp!.js(`document.querySelectorAll('[data-test="reader"] script, [data-test="reader"] img, [data-test="prepare-reply"]').length`)).toBe(0);
      for (const key of ['e', 'j', 'k']) await press(key);
      await press('u', { shift: true });
      expect(await cdp!.js('window.__trashWrites.length')).toBe(0);
      await press('Escape');
      await cdp!.js('window.__h.wait(150)');
      expect(await cdp!.js('document.activeElement?.getAttribute("data-id")')).toBe('conv-06');
      expect(await cdp!.js('window.__trashWrites.length')).toBe(0);
    }
  }, 30_000);

  it('types in the focused palette with zero mutations, highlights, contains Tab and restores focus', async () => {
    await freshMount();
    await cdp!.js(`document.querySelector('[data-test="conversation-row-read-03"]').focus()`);
    await click('[data-test="palette-trigger"]');
    await cdp!.js('window.__h.wait(80)');
    expect(await activeTest()).toBe('action-query');
    await cdp!.cmd('Input.insertText', { text: 'e/s/h' });
    for (const key of ['e', 's', 'h', 'ArrowLeft']) await press(key);
    expect(await cdp!.js(`document.querySelector('[data-test="action-query"]').value`)).toContain('e/s/h');
    expect(await cdp!.js(`window.__fixture.controls.archiveCommands.length + window.__fixture.controls.readCommands.length`)).toBe(0);
    await press('Tab'); expect(await activeTest()).toBe('action-query');
    await press('Tab', { shift: true }); expect(await activeTest()).toBe('action-query');
    await press('Escape'); await cdp!.js('window.__h.wait(60)');
    // Pointer trigger owns origin in this journey, not the previously focused row.
    expect(await activeTest()).toBe('palette-trigger');
    await click('[data-test="palette-trigger"]'); await cdp!.js('window.__h.wait(60)');
    await press('ArrowDown');
    expect(await cdp!.js(`document.querySelector('[aria-selected="true"]').textContent`)).toContain('Mark done');
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
    await press('g'); await press('h'); await press('g'); await cdp!.js('window.__h.wait(2300)'); await press('e'); await cdp!.js('window.__h.wait(100)');
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
    await cdp!.cmd('Input.insertText', { text: 'Mark done' }); await press('Enter');
    expect(await activeTest()).toBe('action-query');
    expect(await cdp!.js('window.__fixture.controls.archiveCommands.length')).toBe(0);
    await press('Escape');
  });

  async function freshWorkspaceMount(): Promise<void> {
    await setViewport(1200);
    await cdp!.js(`(async () => {
      const vueUrl = performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes('/node_modules/.vite/deps/vue.js'));
      const { createApp } = await import(vueUrl);
      const { default: Workspaces } = await import('/src/FixtureWorkspaces.vue');
      const { createFixtureWorkspaces } = await import('/src/lib/fixture-workspaces.ts');
      const root = document.querySelector('#app'); root.__vue_app__?.unmount();
      window.__sessions = createFixtureWorkspaces();
      createApp(Workspaces, { sessions: window.__sessions }).mount(root);
    })()`);
    await cdp!.js('window.__h.wait(200)');
    await cdp!.cmd('Page.bringToFront');
  }

  it('UX-13: command queries survive trusted dismissal, account switches and palette execution independently', async () => {
    await freshWorkspaceMount();
    const a = '[data-workspace="fixture-account"]';
    const b = '[data-workspace="fixture-account-two"]';
    const query = (panel: string) => cdp!.js<string>(`document.querySelector('${panel} [data-test="action-query"]').value`);
    await click(`${a} [data-test="palette-trigger"]`); await cdp!.js('window.__h.wait(60)');
    await cdp!.cmd('Input.insertText', { text: 'cached' });
    await press('Escape'); await cdp!.js('window.__h.wait(60)');
    expect(await cdp!.js(`document.querySelector('${a} [role="dialog"]') === null`)).toBe(true);
    await click('[data-test="switch-fixture-account-two"]'); await cdp!.js('window.__h.wait(80)');
    await click(`${b} [data-test="palette-trigger"]`); await cdp!.js('window.__h.wait(60)');
    expect(await query(b)).toBe('');
    await cdp!.cmd('Input.insertText', { text: 'Switch account' });
    await press('Enter'); await cdp!.js('window.__h.wait(100)');
    expect(await cdp!.js(`document.querySelector('${b}').inert`)).toBe(true);
    await click(`${a} [data-test="palette-trigger"]`); await cdp!.js('window.__h.wait(60)');
    expect(await query(a)).toBe('cached');
    // Dismiss through the actual backdrop, not a click on a covered workspace control.
    const point = await cdp!.js<{ x: number; y: number }>(`(() => {
      const backdrop = document.querySelector('${a} .action-backdrop');
      const r = backdrop.getBoundingClientRect(); const x = r.right - 8, y = r.bottom - 8;
      if (document.elementFromPoint(x, y) !== backdrop) throw new Error('Backdrop point is covered');
      return { x, y };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp!.cmd('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
    await cdp!.js('window.__h.wait(60)');
    expect(await cdp!.js(`document.querySelector('${a} [role="dialog"]') === null`)).toBe(true);
    await click(`${a} [data-test="navigator-trigger"]`); await cdp!.js('window.__h.wait(60)');
    expect(await query(a)).toBe('');
    await cdp!.cmd('Input.insertText', { text: 'Inbox' });
    await press('Escape'); await cdp!.js('window.__h.wait(60)');
    await click('[data-test="switch-fixture-account-two"]'); await cdp!.js('window.__h.wait(80)');
    await click(`${b} [data-test="palette-trigger"]`); await cdp!.js('window.__h.wait(60)');
    expect(await query(b)).toBe('Switch account');
    await press('Escape'); await cdp!.js('window.__h.wait(60)');
    await click('[data-test="switch-fixture-account"]'); await cdp!.js('window.__h.wait(80)');
    await click(`${a} [data-test="palette-trigger"]`); await cdp!.js('window.__h.wait(60)');
    expect(await query(a)).toBe('cached');
    expect(await cdp!.js(`window.__sessions.map(s => s.client.controls.activity().length)`)).toEqual([0, 0]);
    await press('Escape');
  });

  it('UX-13: pointer switches retain account-local focus/selection/scroll; inactive identical IDs stay inert', async () => {
    await freshWorkspaceMount();
    const a = '[data-workspace="fixture-account"]';
    const b = '[data-workspace="fixture-account-two"]';
    const beforeLists = await cdp!.js<Array<Array<{ ref: { accountId: string; conversationId: string } }>>>(
      `Promise.all(window.__sessions.map(async s => (await s.client.listConversations()).conversations))`,
    );
    expect(beforeLists.map(rows => rows.length)).toEqual([18, 18]);
    const expectedA = beforeLists[0]!.filter(row => row.ref.conversationId !== 'conv-03').map(row => row.ref);
    await click(`${a} [data-test="rail-inbox"]`);
    await cdp!.js(`(() => {
      const panel = document.querySelector('${a}');
      const list = panel.querySelector('.inbox-list'); list.style.height='100px'; list.style.flex='none';
      panel.querySelector('[data-test="conversation-row-conv-03"]').focus();
    })()`);
    await press('x'); await cdp!.js('window.__h.wait(80)');
    // Scrolled, with the focused conv-03 still fully inside the 100px list
    // (48px date caption + 36px rows put it at 120-156px).
    await cdp!.js(`document.querySelector('${a} .inbox-list').scrollTop = 60`);
    const scroll = await cdp!.js<number>(`document.querySelector('${a} .inbox-list').scrollTop`);
    expect(scroll).toBeGreaterThan(0);
    await click('[data-test="switch-fixture-account-two"]'); await cdp!.js('window.__h.wait(100)');
    expect(await cdp!.js(`document.querySelector('${a}').inert`)).toBe(true);
    // Browser itself rejects a programmatic attempt to focus an inert old row.
    await cdp!.js(`document.querySelector('${a} [data-test="conversation-row-conv-03"]').focus()`);
    expect(await cdp!.js(`document.activeElement.closest('${a}') !== null`)).toBe(false);
    await cdp!.js(`document.querySelector('${b} [data-test="conversation-row-conv-01"]').focus()`);
    await press('j'); await cdp!.js('window.__h.wait(60)');
    expect(await activeTest()).toBe('conversation-row-conv-02');
    await press('Enter'); await cdp!.js('window.__h.wait(80)');
    expect(await cdp!.js(`document.querySelector('${b} [data-test="reader"]') !== null`)).toBe(true);
    await click('[data-test="switch-fixture-account"]'); await cdp!.js('window.__h.wait(80)');
    expect(await activeTest()).toBe('conversation-row-conv-03');
    expect(await cdp!.js(`document.querySelector('${a} .inbox-list').scrollTop`)).toBe(scroll);
    expect(await cdp!.js(`document.querySelector('${a} [data-test="row-select-conv-03"]').checked`)).toBe(true);
    await press('e'); await cdp!.js('window.__h.wait(150)');
    // OperationSummary.conversation is account+ID; exact equality is non-vacuous
    // and also rejects a wrong conversation or an extra accidental operation.
    expect(await cdp!.js(`window.__sessions[0].client.controls.activity().map(op => ({
      conversation: op.conversation, kind: op.kind, requestedArchived: op.requestedArchived,
    }))`)).toEqual([{
      conversation: { accountId: 'fixture-account', conversationId: 'conv-03' },
      kind: 'archive', requestedArchived: true,
    }]);
    expect(await cdp!.js(`window.__sessions[1].client.controls.activity().length`)).toBe(0);
    // listConversations returns an InboxSnapshot, not an array; detail owns isInInbox.
    expect(await cdp!.js(`(async () => (await window.__sessions[0].client.getConversation({ accountId: 'fixture-account', conversationId: 'conv-03' })).isInInbox)()`)).toBe(false);
    expect(await cdp!.js(`(async () => (await window.__sessions[0].client.listConversations()).conversations.map(row => row.ref))()`)).toEqual(expectedA);
    expect(await cdp!.js(`Array.from(document.querySelectorAll('${a} [data-test^="conversation-row-"]'), row => row.dataset.test)`))
      .toEqual(expectedA.map(ref => `conversation-row-${ref.conversationId}`));
    expect(await cdp!.js(`(async () => (await window.__sessions[1].client.listConversations()).conversations)()`)).toEqual(beforeLists[1]);
    await click('[data-test="switch-fixture-account-two"]'); await cdp!.js('window.__h.wait(80)');
    await press('Escape'); await cdp!.js('window.__h.wait(80)');
    expect(await activeTest()).toBe('conversation-row-conv-02');
    expect(await cdp!.js(`Array.from(document.querySelectorAll('${b} [data-test^="conversation-row-"]'), row => row.dataset.test)`))
      .toEqual(beforeLists[1]!.map(row => `conversation-row-${row.ref.conversationId}`));
    expect(await cdp!.js(`document.title`)).toContain('you@second.example.test');
  });

});
