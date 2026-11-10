/**
 * R opens a reply from the open reader (keyboard-first). The key and the
 * "Reply" palette entry use the same rule as the reader's buttons, the
 * source is always the displayed latest message, and the key is inert wherever
 * another surface or a text field owns the keyboard.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { createBrowserFakeMailClient, fixtureRef, useGmailMode, waitFor, type BrowserFake, mountApp as sharedMountApp, press } from './helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

async function openReader(w: VueWrapper, id = 'conv-01'): Promise<void> {
  await w.get(`[data-test="conversation-row-${id}"]`).trigger('click');
  await flushPromises();
  expect(w.find('[data-test="reader"]').exists()).toBe(true);
}

async function drafts(fake: BrowserFake) {
  await flushPromises();
  return fake.listDrafts();
}

async function paletteIds(w: VueWrapper, query: string): Promise<string[]> {
  if (!w.find('[data-test="action-query"]').exists()) await w.get('[data-test="palette-trigger"]').trigger('click');
  await flushPromises();
  await w.get('[data-test="action-query"]').setValue(query);
  return w.findAll('[role="option"]').map((option) => option.attributes('id') ?? '');
}

/** Closes the palette so the next step starts from the reader or list. */
async function closePalette(w: VueWrapper): Promise<void> {
  if (!w.find('[data-test="action-query"]').exists()) return;
  press('Escape', { bubbles: true, cancelable: true }, w.get('[data-test="action-query"]').element);
  await flushPromises();
  expect(w.find('[data-test="action-query"]').exists()).toBe(false);
}

describe('R: Reply from the reader', () => {
  it('opens the docked composer for the displayed latest message, like the button, and focuses the body', async () => {
    const fake = createBrowserFakeMailClient();
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReader(w);
    // The button hint shows the key; the hidden name stays "Reply".
    expect(w.get('[data-test="prepare-reply"]').attributes('title')).toContain('Reply — R');
    expect(w.get('[data-test="prepare-reply"]').text()).toBe('Reply');
    expect(w.get('[data-test="message-reply-conv-01-m3"]').attributes('title')).toBe('Reply — R. Reply targets the latest message from Ada Fixture');
    expect(w.get('[data-test="message-reply-conv-01-m3"]').attributes('aria-label')).toBe('Reply to latest message');
    expect(w.get('[data-test="prepare-reply"]').text()).not.toBe(w.get('[data-test="message-reply-conv-01-m3"]').attributes('aria-label'));

    // Focus an older message first: the source must still be the latest one.
    await w.get('[data-test="message-toggle-conv-01-m1"]').trigger('focusin');
    const event = press('r', { bubbles: true, cancelable: true });
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => w.find('[data-test="reply-composer"]').exists());
    await flushPromises();
    const [draft] = await drafts(fake);
    expect(draft!.source).toEqual({ kind: 'reply', conversation: fixtureRef('conv-01'), sourceMessageId: 'conv-01-m3' });
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    // Focus ends in the body once the draft exists; Escape closes through the protected flush.
    await waitFor(() => document.activeElement === w.get('[data-test="draft-body"]').element);
    press('Escape', { bubbles: true, cancelable: true });
    await waitFor(() => !w.find('[data-test="reply-composer"]').exists());
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect((await fake.listDrafts())).toHaveLength(1);
    await flushPromises();
    // Focus returns to the reader's active message instead of dropping to <body>.
    expect(document.activeElement).toBe(w.get('[data-test="message-toggle-conv-01-m1"]').element);
  });

  describe('hand-off of focus to the body from non-button reader focus', () => {
    /** Expands the first message so its Details summary and participant spans are reachable. */
    async function expandFirst(w: VueWrapper): Promise<void> {
      await w.get('[data-test="message-toggle-conv-01-m1"]').trigger('click');
      await flushPromises();
    }

    async function pressRFrom(w: VueWrapper, fake: BrowserFake, element: HTMLElement): Promise<void> {
      element.focus();
      expect(document.activeElement).toBe(element);
      const event = press('r', { bubbles: true, cancelable: true }, element);
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => w.find('[data-test="reply-composer"]').exists());
      await flushPromises();
      expect(await drafts(fake)).toHaveLength(1);
    }

    it.each([
      ['the reader article (focus after clicking message text)', (w: VueWrapper) => w.get('[data-test="reader"]').element as HTMLElement],
      ['a Details summary', (w: VueWrapper) => w.get('[data-test="message-details-summary-conv-01-m1"]').element as HTMLElement],
      ['a participant span', (w: VueWrapper) => w.get('[data-test="participant-from-conv-01-m1"]').element as HTMLElement],
    ])('focuses the body after R pressed from %s', async (_name, pick) => {
      const fake = createBrowserFakeMailClient();
      const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
      await openReader(w);
      await expandFirst(w);
      await pressRFrom(w, fake, pick(w));
      await waitFor(() => document.activeElement === w.get('[data-test="draft-body"]').element);
      // Typing now goes into the draft, not into the key handler.
      const body = w.get('[data-test="draft-body"]');
      await body.setValue('hello');
      expect((body.element as HTMLTextAreaElement).value).toBe('hello');
    });

    it('never takes focus from a text field the user moved to while the reply was preparing', async () => {
      const fake = createBrowserFakeMailClient();
      const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
      await openReader(w);
      const field = document.createElement('input');
      document.body.appendChild(field);
      press('r', { bubbles: true, cancelable: true });
      field.focus();
      await waitFor(() => w.find('[data-test="reply-composer"]').exists());
      await flushPromises();
      expect(document.activeElement).toBe(field);
      field.remove();
    });

    it.each([
      ['isComposing', { isComposing: true, key: 'r' }],
      ['keyCode 229', { keyCode: 229, key: 'r' }],
    ] as const)('stays inert with IME (%s) from the article, and IME keys in the body are not swallowed', async (_name, init) => {
      const fake = createBrowserFakeMailClient();
      const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
      await openReader(w);
      const article = w.get('[data-test="reader"]').element as HTMLElement;
      article.focus();
      const ignored = press(init.key, { bubbles: true, cancelable: true, ...init }, article);
      await flushPromises();
      expect(ignored.defaultPrevented).toBe(false);
      expect(await drafts(fake)).toHaveLength(0);
      expect(w.find('[data-test="reply-composer"]').exists()).toBe(false);
      // Now open the reply properly and compose with an IME: keys are left alone.
      press('r', { bubbles: true, cancelable: true }, article);
      await waitFor(() => w.find('[data-test="reply-composer"]').exists());
      await waitFor(() => document.activeElement === w.get('[data-test="draft-body"]').element);
      const imeKey = press(init.key, { bubbles: true, cancelable: true, ...init }, w.get('[data-test="draft-body"]').element);
      expect(imeKey.defaultPrevented).toBe(false);
      expect(await drafts(fake)).toHaveLength(1);
    });

    it('returns focus to the reader after Discard, not to <body>', async () => {
      const fake = createBrowserFakeMailClient();
      const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
      await openReader(w);
      await pressRFrom(w, fake, w.get('[data-test="reader"]').element as HTMLElement);
      await waitFor(() => document.activeElement === w.get('[data-test="draft-body"]').element);
      await w.get('[data-test="discard-draft"]').trigger('click');
      await waitFor(() => w.find('[data-test="confirm-discard"]').exists());
      await w.get('[data-test="confirm-discard"]').trigger('click');
      await waitFor(() => !w.find('[data-test="reply-composer"]').exists());
      await flushPromises();
      expect(await drafts(fake)).toHaveLength(0);
      expect(document.activeElement).not.toBe(document.body);
      expect(w.get('[data-test="reader"]').element.contains(document.activeElement)).toBe(true);
    });
  });

  it.each([
    ['Shift', { shiftKey: true, key: 'R' }],
    ['Ctrl', { ctrlKey: true, key: 'r' }],
    ['Meta', { metaKey: true, key: 'r' }],
    ['Alt', { altKey: true, key: 'r' }],
    ['key repeat', { repeat: true, key: 'r' }],
    ['IME composition', { isComposing: true, key: 'r' }],
    ['IME keyCode 229', { keyCode: 229, key: 'r' }],
  ] as const)('is inert with %s', async (_name, init) => {
    const fake = createBrowserFakeMailClient();
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReader(w);
    press(init.key, { bubbles: true, cancelable: true, ...init });
    await flushPromises();
    expect(await drafts(fake)).toHaveLength(0);
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(false);
  });

  it('is inert from a text field, a button other than a message toggle, and the list', async () => {
    const fake = createBrowserFakeMailClient();
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    // List: no reader, no reply.
    press('r', { bubbles: true, cancelable: true });
    await flushPromises();
    expect(await drafts(fake)).toHaveLength(0);
    await openReader(w);
    for (const tag of ['input', 'textarea']) {
      const field = document.createElement(tag);
      document.body.appendChild(field);
      field.focus();
      press('r', { bubbles: true, cancelable: true }, field);
      field.remove();
    }
    press('r', { bubbles: true, cancelable: true }, w.get('[data-test="files-links"]').element);
    await flushPromises();
    expect(await drafts(fake)).toHaveLength(0);
  });

  it('still works from the quoted-text toggle, which keeps focus after a click', async () => {
    const fake = createBrowserFakeMailClient();
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReader(w);
    // The fixture bodies carry no quote, so stand in for the toggle button the
    // reader renders inside a message: the key guard only looks at its class.
    const toggle = document.createElement('button');
    toggle.className = 'message-quote-toggle';
    w.get('[data-test="reader-messages"] .message').element.appendChild(toggle);
    toggle.focus();
    const event = press('r', { bubbles: true, cancelable: true }, toggle);
    await flushPromises();
    expect(event.defaultPrevented).toBe(true);
    expect(await drafts(fake)).toHaveLength(1);
    toggle.remove();
  });

  it('does not open a second composer while one is open and keeps typing as text', async () => {
    const fake = createBrowserFakeMailClient();
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReader(w);
    press('r', { bubbles: true, cancelable: true });
    await waitFor(() => w.find('[data-test="reply-composer"]').exists());
    await flushPromises();
    const body = w.get('[data-test="draft-body"]');
    await body.setValue('r');
    press('r', { bubbles: true, cancelable: true }, body.element);
    press('r', { bubbles: true, cancelable: true }, document.body);
    await flushPromises();
    expect(await fake.listDrafts()).toHaveLength(1);
    expect((body.element as HTMLTextAreaElement).value).toBe('r');
  });

  it.each([
    ['an incomplete conversation', (fake: BrowserFake) => fake.controls.markUnsupported('conv-01', 'plain text incomplete', false)],
    ['a retained recovery snapshot', (fake: BrowserFake) => fake.controls.markRetainedSnapshot('conv-01', '2025-02-03T04:05:06Z')],
  ])('is inert and absent from the palette for %s (the button is disabled by the same rule)', async (_name, block) => {
    const fake = createBrowserFakeMailClient();
    block(fake);
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReader(w);
    expect(w.find('[data-test="reply-blocked"]').exists()).toBe(true);
    expect(w.get('[data-test="prepare-reply"]').attributes('disabled')).toBeDefined();
    press('r', { bubbles: true, cancelable: true });
    await flushPromises();
    expect(await drafts(fake)).toHaveLength(0);
    // The palette is open and working (other commands are found), reply just is not among them.
    expect(await paletteIds(w, 'mark done')).toContain('action-archive');
    expect(await paletteIds(w, 'reply')).not.toContain('action-reply');
  });

  it('is inert in cached Trash', async () => {
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake, { mutationAccess: 'enabled' });
    fake.controls.markTriage('conv-04', 'trash');
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await w.get('[data-test="palette-trigger"]').trigger('click');
    await w.get('[data-test="action-query"]').setValue('Go to cached Trash');
    press('Enter', { bubbles: true, cancelable: true });
    await flushPromises();
    await w.get('button[data-id="conv-04"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    press('r', { bubbles: true, cancelable: true });
    await flushPromises();
    expect(await drafts(fake)).toHaveLength(0);
    expect(await paletteIds(w, 'reply')).not.toContain('action-reply');
  });

  it('lists "Reply" with R in the palette only while the reader is open and reply is allowed', async () => {
    const fake = createBrowserFakeMailClient();
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    // List view: absent, with the palette demonstrably open.
    expect(await paletteIds(w, 'reply')).not.toContain('action-reply');
    expect(await paletteIds(w, 'new message')).toContain('action-compose');
    await closePalette(w);
    await openReader(w);
    for (const query of ['reply', 'respond', 'write back', 'r']) {
      expect(await paletteIds(w, query), query).toContain('action-reply');
    }
    await w.get('[data-test="action-query"]').setValue('reply');
    const option = w.get('#action-reply');
    expect(option.text()).toContain('Reply');
    expect(option.get('kbd').text()).toBe('R');
    // Running it from the palette uses the same path as the key.
    press('Enter', { bubbles: true, cancelable: true }, w.get('[data-test="action-query"]').element);
    await waitFor(() => w.find('[data-test="reply-composer"]').exists());
    expect((await fake.listDrafts())[0]!.source).toEqual({ kind: 'reply', conversation: fixtureRef('conv-01'), sourceMessageId: 'conv-01-m3' });
  });
});
