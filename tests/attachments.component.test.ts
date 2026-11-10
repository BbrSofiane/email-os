import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import AttachmentChooser from '../src/components/AttachmentChooser.vue';
import App from '../src/App.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { createReaderFixtureClient } from './reader.fixture';
import { deferred } from './helpers';
import type { Conversation } from '../src/lib/ipc/client';

const conversation: Conversation = { ref: { accountId: 'fixture-account', conversationId: 'c1' }, subject: 'Files', isInInbox: true, pendingOperationId: null,
  messages: [{ id: 'm1', from: { displayName: null, mailbox: 'a@example.test' }, to: [], sentAt: '',
    bodyText: 'https://example.test/document javascript:alert(1) file:///tmp/x mailto:a@example.test <img src="https://evil.test/x">' }] };
const file = { messageId: 'm1', attachmentId: 'a1', filename: '../../evil.html', mimeType: 'text/html', size: 29 };
let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });
function button(text: string) { return wrapper!.findAll('button').find(b => b.text() === text)!; }
async function chooser() {
  const client = createBrowserFakeMailClient();
  const list = vi.spyOn(client, 'listAttachments').mockResolvedValue([file]);
  const save = vi.spyOn(client, 'saveAttachment').mockResolvedValue({ filename: 'unique.download' });
  const open = vi.spyOn(client, 'openExternalLink').mockResolvedValue();
  wrapper = mount(AttachmentChooser, { props: { client, conversation, preview: false }, attachTo: document.body });
  await flushPromises(); return { client, list, save, open };
}
describe('UX-12 download-only chooser', () => {
  it('only offers known HTTP(S) links/files, never auto-opens or creates a viewer/remote resource', async () => {
    const { save, open, list } = await chooser();
    expect(list).toHaveBeenCalledExactlyOnceWith(conversation.ref);
    expect(save).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(wrapper!.find('iframe, object, embed, img, a').exists()).toBe(false);
    // The long caveat moved into the title; the visible line is one short sentence.
    const note = wrapper!.get('.chooser-note');
    expect(note.text()).toBe('Download only. Files save inert with a .download suffix; nothing is opened.');
    expect(note.attributes('title')).toContain('PDF preview is unavailable');
    expect(note.attributes('title')).toContain('32 cached files and 32 plain-text links');
    expect(wrapper!.text()).toContain('text/html, 29 B');
    expect(wrapper!.text()).not.toContain('bytes');
    expect(wrapper!.findAll('[aria-label="Links"] li')).toHaveLength(2);
    await wrapper!.findAll('button').find(b => b.text() === 'Open link…')!.trigger('click');
    expect(open).not.toHaveBeenCalled();
    await button('Open in browser').trigger('click');
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.test/document');
    await button('Save').trigger('click'); await flushPromises();
    expect(save).toHaveBeenCalledWith({ conversation: conversation.ref, messageId: 'm1', attachmentId: 'a1', requestId: expect.any(String) });
    expect(wrapper!.text()).toContain('No file was opened');
  });
  it('labels each file button `Save` with the file name in its accessible name, like the inline list', async () => {
    const client = createBrowserFakeMailClient();
    vi.spyOn(client, 'listAttachments').mockResolvedValue([
      file,
      { ...file, attachmentId: 'a2', filename: 'invoice\u202Efdp.exe', mimeType: 'application/octet-stream' },
    ]);
    wrapper = mount(AttachmentChooser, { props: { client, conversation, preview: false }, attachTo: document.body });
    await flushPromises();
    const saves = wrapper.findAll('[aria-label="Files"] button');
    expect(saves.map((b) => b.text())).toEqual(['Save', 'Save']);
    // displayFileName strips bidi controls (the name is otherwise literal); the format matches MessageAttachments.
    expect(saves.map((b) => b.attributes('aria-label'))).toEqual(['Save ../../evil.html', 'Save invoicefdp.exe']);
    expect(wrapper.text()).not.toContain('Save to Downloads');
  });
  it('names the lists Files and Links, with no empty-files line while a file is listed', async () => {
    await chooser();
    expect(wrapper!.find('[aria-label="Files"]').exists()).toBe(true);
    expect(wrapper!.find('[aria-label="Links"]').exists()).toBe(true);
    expect(wrapper!.find('[aria-label^="Known"]').exists()).toBe(false);
    expect(wrapper!.text()).not.toContain('No cached files');
  });
  it('says one short sentence when no files are cached, and leaves the links sentence alone', async () => {
    const client = createBrowserFakeMailClient();
    vi.spyOn(client, 'listAttachments').mockResolvedValue([]);
    const bare: Conversation = { ...conversation, messages: [{ ...conversation.messages[0]!, bodyText: 'No links here.' }] };
    wrapper = mount(AttachmentChooser, { props: { client, conversation: bare, preview: false }, attachTo: document.body });
    await flushPromises();
    const empty = wrapper.findAll('p').filter((p) => p.text().startsWith('No cached files'));
    expect(empty).toHaveLength(1);
    expect(empty[0]!.text()).toBe('No cached files. Sync to fetch any that are missing.');
    expect(wrapper.text()).not.toMatch(/inventory|Legacy|fetchable/);
    expect(wrapper.text()).toContain('No HTTP(S) links found in cached plain text. Email addresses are not browser links.');
  });
  it.each(['not_found', 'network_unavailable', 'invalid_request'])('keeps a dismissal/retry path on %s', async (kind) => {
    const { save } = await chooser(); save.mockRejectedValue({ kind });
    await button('Save').trigger('click'); await flushPromises();
    expect(wrapper!.find('[role="alert"]').text()).toContain('File not saved');
    await wrapper!.find('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });
  it('cancels transfer on explicit cancellation and dismissal, ignoring late success', async () => {
    const { client, save } = await chooser();
    const result = deferred<{ filename: string }>(); save.mockReturnValue(result.promise);
    const cancel = vi.spyOn(client, 'cancelAttachment');
    await button('Save').trigger('click');
    const request = save.mock.calls[0]![0];
    await button('Cancel transfer').trigger('click');
    expect(cancel).toHaveBeenCalledWith(request.requestId);
    wrapper!.unmount(); wrapper = null;
    result.resolve({ filename: 'late.download' }); await flushPromises();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  describe('keeps keyboard focus inside the modal while a transfer runs', () => {
    it('keeps the focused Save mounted and aria-disabled as Saving…, then idle again with focus unchanged', async () => {
      const { save } = await chooser();
      const result = deferred<{ filename: string }>(); save.mockReturnValue(result.promise);
      const saveButton = button('Save'); const element = saveButton.element as HTMLButtonElement;
      element.focus();
      await saveButton.trigger('click');
      expect(save).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(element);
      expect(element.hasAttribute('disabled')).toBe(false);
      expect(element.getAttribute('aria-disabled')).toBe('true');
      expect(element.textContent?.trim()).toBe('Saving…');
      expect(element.getAttribute('aria-label')).toBe('Saving ../../evil.html');
      await saveButton.trigger('click');
      expect(save).toHaveBeenCalledTimes(1);
      result.resolve({ filename: 'unique.download' }); await flushPromises();
      expect(document.activeElement).toBe(element);
      expect(element.getAttribute('aria-disabled')).toBeNull();
      expect(element.textContent?.trim()).toBe('Save');
    });
    it('hands focus to the Save button when the focused Cancel transfer button goes away', async () => {
      const { save } = await chooser();
      const result = deferred<{ filename: string }>(); save.mockReturnValue(result.promise);
      await button('Save').trigger('click');
      const cancel = button('Cancel transfer').element as HTMLButtonElement;
      cancel.focus();
      result.reject({ kind: 'cancelled' }); await flushPromises();
      expect(wrapper!.findAll('button').some((b) => b.text() === 'Cancel transfer')).toBe(false);
      expect(document.activeElement).toBe(button('Save').element);
    });
    it('keeps Escape and the Tab trap alive by never dropping focus to <body> after a failed save', async () => {
      const { save } = await chooser();
      save.mockRejectedValue({ kind: 'network_unavailable' });
      const element = button('Save').element as HTMLButtonElement; element.focus();
      await button('Save').trigger('click'); await flushPromises();
      expect(document.activeElement).toBe(element);
      await wrapper!.get('[role="dialog"]').trigger('keydown', { key: 'Escape' });
      expect(wrapper!.emitted('close')).toHaveLength(1);
    });
  });
  it('discloses oversized and retained files without an active save control', async () => {
    const { save } = await chooser();
    await wrapper!.setProps({ conversation: { ...conversation, retainedSnapshotAt: '2026-01-01' } });
    expect(button('Save').attributes('disabled')).toBeDefined();
    expect(save).not.toHaveBeenCalled();
  });
  it('shows human sizes and the 5 MB limit message instead of a Save button for large files', async () => {
    const client = createBrowserFakeMailClient();
    vi.spyOn(client, 'listAttachments').mockResolvedValue([{ ...file, attachmentId: 'big', filename: 'big.bin', mimeType: 'application/octet-stream', size: 6 * 1024 * 1024 }]);
    wrapper = mount(AttachmentChooser, { props: { client, conversation, preview: false }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.text()).toContain('big.bin — application/octet-stream, 6.0 MB');
    expect(wrapper.text()).toContain('Over the 5 MB limit; cannot download.');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Save')).toBe(false);
  });
  it('native Cmd+O opens a chooser rather than choosing a resource; browser Cmd+O stays reserved', async () => {
    for (const mode of ['native', 'browser-preview'] as const) {
      const fixture = createReaderFixtureClient();
      wrapper = mount(App, { props: { client: fixture.client, mode }, attachTo: document.body });
      await flushPromises();
      await wrapper.find('[data-test="conversation-row-read-01"]').trigger('click');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushPromises();
      const open = vi.spyOn(fixture.client, 'openExternalLink');
      const save = vi.spyOn(fixture.client, 'saveAttachment');
      const event = new KeyboardEvent('keydown', { key: 'o', metaKey: true, bubbles: true, cancelable: true });
      window.dispatchEvent(event); await flushPromises();
      expect(wrapper.find('.attachment-chooser').exists()).toBe(mode === 'native');
      expect(event.defaultPrevented).toBe(mode === 'native');
      expect(open).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
      wrapper.unmount(); wrapper = null;
    }
  });
  it('preserves mounted reader expansion, scroll and origin focus after chooser dismissal', async () => {
    const fixture = createReaderFixtureClient();
    wrapper = mount(App, { props: { client: fixture.client, mode: 'browser-preview' }, attachTo: document.body });
    await flushPromises();
    await wrapper!.find('[data-test="conversation-row-read-01"]').trigger('dblclick');
    // Reader opens via Enter on focused row in the existing journey.
    if (!wrapper!.find('[data-test="reader"]').exists()) {
      await wrapper!.find('[data-test="conversation-row-read-01"]').trigger('click');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    await flushPromises();
    const toggles = wrapper!.findAll('.message-toggle');
    await toggles[0]!.trigger('click');
    const expansion = toggles.map(t => t.attributes('aria-expanded'));
    const scroller = wrapper!.find('.reader-scroll').element as HTMLElement; scroller.scrollTop = 317;
    const origin = wrapper!.find('[data-test="files-links"]').element as HTMLButtonElement; origin.focus();
    await wrapper!.find('[data-test="files-links"]').trigger('click'); await flushPromises();
    expect(wrapper!.find('main').attributes('inert')).toBeDefined();
    await wrapper!.find('[role="dialog"]').trigger('keydown', { key: 'Escape' }); await flushPromises();
    expect(wrapper!.findAll('.message-toggle').map(t => t.attributes('aria-expanded'))).toEqual(expansion);
    expect(wrapper!.find('.reader-scroll').element).toBe(scroller); expect(scroller.scrollTop).toBe(317);
    expect(document.activeElement).toBe(origin);
    expect(fixture.controls.archiveCommands).toHaveLength(0);
  });
});
