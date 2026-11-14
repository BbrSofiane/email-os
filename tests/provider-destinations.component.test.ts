import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ProviderDestinations from '../src/components/ProviderDestinations.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { deferred } from './helpers';
import { fullDateLabel } from '../src/lib/browsing-dates';
import type { DestinationCatalog, DestinationPage } from '../src/lib/ipc/client';

function setup() {
  const client = createBrowserFakeMailClient();
  const wrapper = mount(ProviderDestinations, { props: { client, accountId: 'fixture-account' }, attachTo: document.body });
  return { client, wrapper };
}
function button(wrapper: ReturnType<typeof setup>['wrapper'], text: string) {
  const result = wrapper.findAll('button').find(b => b.text() === text);
  if (!result) throw new Error('Missing button: ' + text);
  return result;
}
describe('read-only provider destinations', () => {
  it('searches the whole catalog, shows more, and preserves an uncached page/row on reader return without writes', async () => {
    const { client, wrapper } = setup();
    const archive = vi.spyOn(client, 'setArchived');
    const read = vi.spyOn(client, 'setRead');
    await flushPromises();
    expect(wrapper.findAll('.destination-catalog li')).toHaveLength(9);
    await button(wrapper, 'Show more destinations').trigger('click');
    expect(wrapper.findAll('.destination-catalog li')).toHaveLength(17);
    await wrapper.get('input').setValue('Research');
    expect(wrapper.findAll('.destination-catalog li')).toHaveLength(1);
    expect(wrapper.find('img').exists()).toBe(false);
    await button(wrapper, '<img src=x> Research').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Mailbox total unknown');
    const row = wrapper.get('.destination-row');
    await row.trigger('click'); await flushPromises();
    expect(wrapper.get('pre').text()).toContain('<script>');
    expect(wrapper.find('script').exists()).toBe(false);
    await wrapper.get('[data-test="destination-back"]').trigger('click'); await flushPromises();
    expect(document.activeElement).toBe(row.element);
    expect(row.isVisible()).toBe(true);
    await button(wrapper, 'Next provider page (up to 25)').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('Older synthetic mail');
    expect(archive).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it('distinguishes provider Drafts and explicitly saved snapshots; errors are not empty results', async () => {
    const { client, wrapper } = setup(); await flushPromises();
    await button(wrapper, 'Provider Drafts').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('separate from editable Local drafts');
    vi.spyOn(client, 'browseProviderDestination').mockRejectedValueOnce({ kind: 'network_unavailable' });
    await button(wrapper, 'Refresh first page').trigger('click'); await flushPromises();
    // Plain sentence, not the raw kind; the previous page stays and is named as such.
    expect(wrapper.get('[role="alert"]').text()).toBe('Could not load this page. The network is unavailable. Showing the previous snapshot.');
    expect(wrapper.get('[role="alert"]').text()).not.toContain('network_unavailable');
    expect(wrapper.text()).toContain('Uncached synthetic destination mail');
    await button(wrapper, 'Use latest saved page').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('Saved local snapshot');
    expect(wrapper.text()).toContain('More provider pages may exist');
    wrapper.unmount();
  });
  it('ignores a late page after Back and does not let a page failure masquerade as empty', async () => {
    const { client, wrapper } = setup(); await flushPromises();
    const pending = deferred<DestinationPage>();
    vi.spyOn(client, 'browseProviderDestination').mockReturnValueOnce(pending.promise);
    await button(wrapper, 'Sent').trigger('click');
    await button(wrapper, 'Back to destinations').trigger('click');
    pending.resolve({ accountId: 'fixture-account', destinationId: 'SENT', conversations: [], nextCursor: null, fetchedAt: 'old' });
    await flushPromises();
    expect(wrapper.find('.destination-list').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('old');
    wrapper.unmount();
  });
  it('refuses opening a row while a page replacement is pending, never stranding the reader on a disconnected origin', async () => {
    const { client, wrapper } = setup(); await flushPromises();
    await button(wrapper, 'Sent').trigger('click'); await flushPromises();
    const pending = deferred<DestinationPage>();
    vi.spyOn(client, 'browseProviderDestination').mockReturnValueOnce(pending.promise);
    await button(wrapper, 'Next provider page (up to 25)').trigger('click');
    const staleRow = wrapper.get('.destination-row');
    expect(staleRow.attributes('disabled')).toBeDefined();
    await staleRow.trigger('click'); await flushPromises();
    expect(wrapper.find('.destination-reader').exists()).toBe(false);
    pending.resolve({ accountId: 'fixture-account', destinationId: 'SENT', conversations: [{ ref: { accountId: 'fixture-account', conversationId: 'destination-only-2' }, subject: 'Older synthetic mail', messages: [], isInInbox: true, isRead: false, pendingOperationId: null }], nextCursor: null, fetchedAt: '2025-02-02T00:00:00Z' });
    await flushPromises();
    // The page may replace itself beneath a closed reader, but no reader is
    // left open with an origin that a resolving page disconnected.
    expect(wrapper.find('.destination-reader').exists()).toBe(false);
    expect(wrapper.text()).toContain('Older synthetic mail');
    // The page snapshot time is the full viewer-local form, not the raw timestamp.
    expect(wrapper.get('time[datetime="2025-02-02T00:00:00.000Z"]').text()).toBe(fullDateLabel('2025-02-02T00:00:00Z'));
    expect(wrapper.text()).not.toContain('2025-02-02T00:00:00Z');
    const replacedRow = wrapper.get('.destination-row');
    await replacedRow.trigger('click'); await flushPromises();
    expect(wrapper.find('.destination-reader').exists()).toBe(true);
    await wrapper.get('[data-test="destination-back"]').trigger('click'); await flushPromises();
    expect(document.activeElement).toBe(replacedRow.element);
    expect(replacedRow.isVisible()).toBe(true);
    wrapper.unmount();
  });
  it('renders known To recipients as hostile-safe plain text and never fabricates Cc or Bcc', async () => {
    const { wrapper } = setup(); await flushPromises();
    await button(wrapper, 'Sent').trigger('click'); await flushPromises();
    await wrapper.get('.destination-row').trigger('click'); await flushPromises();
    expect(wrapper.get('.message-to').text()).toBe('To <img src=x> Recipient');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Cc');
    expect(wrapper.text()).not.toContain('Bcc');
    await wrapper.get('[data-test="destination-back"]').trigger('click'); await flushPromises();
    await button(wrapper, 'Next provider page (up to 25)').trigger('click'); await flushPromises();
    await wrapper.get('.destination-row').trigger('click'); await flushPromises();
    expect(wrapper.get('.message-to').text()).toBe('To sent-to@example.test');
    wrapper.unmount();
  });
});

function press(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}
const catalogRows = (wrapper: ReturnType<typeof setup>['wrapper']) => wrapper.findAll('.destination-catalog [data-row]');

describe('provider destinations: look, copy and states', () => {
  it('is styled by classes in the shared stylesheet, not by scoped bare element rules', () => {
    const source = readFileSync('src/components/ProviderDestinations.vue', 'utf8');
    expect(source).not.toMatch(/<style/);
  });

  it('opens with one Ash intro line; the detail lives in its title and hidden text', async () => {
    const { wrapper } = setup(); await flushPromises();
    const intro = wrapper.get('.destination-intro');
    expect(intro.find('span:not(.visually-hidden)').text()).toBe('Provider snapshots.');
    // The drawer title already says "read only"; the intro does not repeat it.
    expect(intro.find('span:not(.visually-hidden)').text().toLowerCase()).not.toContain('read');
    expect(intro.attributes('title')).toContain('No automatic read changes.');
    expect(intro.attributes('title')).toContain('Label and Move are not available in this increment.');
    expect(intro.get('.visually-hidden').text()).toBe('No automatic read changes. Label and Move are not available in this increment.');
    wrapper.unmount();
  });

  it('uses list-row classes, a Seam-underline search and ghost buttons', async () => {
    const { wrapper } = setup(); await flushPromises();
    expect(wrapper.get('input').classes()).toContain('destination-search');
    expect(catalogRows(wrapper)).toHaveLength(9);
    expect(catalogRows(wrapper)[0]!.element.tagName).toBe('BUTTON');
    expect(catalogRows(wrapper)[0]!.classes()).toContain('destination-item');
    expect(button(wrapper, 'Refresh catalog').classes()).toContain('drawer-ghost');
    expect(button(wrapper, 'Show more destinations').classes()).toContain('drawer-ghost');
    wrapper.unmount();
  });

  it('shows a static loading line where the list will appear, not at the bottom', async () => {
    const client = createBrowserFakeMailClient();
    const pending = deferred<DestinationCatalog>();
    vi.spyOn(client, 'listProviderDestinations').mockReturnValueOnce(pending.promise);
    const wrapper = mount(ProviderDestinations, { props: { client, accountId: 'fixture-account' }, attachTo: document.body });
    await flushPromises();
    const loading = wrapper.get('.destination-state');
    expect(loading.text()).toBe('Loading destinations…');
    expect(loading.attributes('role')).toBe('status');
    expect(wrapper.text()).not.toContain('Loading bounded provider data');
    // It sits directly before the (still empty) list, and nothing follows the list.
    expect(loading.element.nextElementSibling).toBe(wrapper.get('.destination-catalog').element);
    expect(wrapper.get('.provider-destinations').element.lastElementChild).not.toBe(loading.element);
    pending.resolve(await client.listProviderDestinations('fixture-account', false));
    await flushPromises();
    expect(wrapper.find('.destination-state').exists()).toBe(false);
    expect(catalogRows(wrapper).length).toBeGreaterThan(0);
    wrapper.unmount();
  });

  it('explains a failed first load plainly and never looks like an empty catalog', async () => {
    const client = createBrowserFakeMailClient();
    vi.spyOn(client, 'listProviderDestinations').mockRejectedValueOnce({ kind: 'network_unavailable' });
    const wrapper = mount(ProviderDestinations, { props: { client, accountId: 'fixture-account' }, attachTo: document.body });
    await flushPromises();
    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toBe('Could not load destinations. The network is unavailable. Try Refresh, or use saved data.');
    expect(wrapper.text()).not.toContain('network_unavailable');
    expect(wrapper.text()).not.toContain('No destinations match');
    // The alert is above the list, not buried under it.
    expect(alert.element.compareDocumentPosition(wrapper.get('.destination-catalog').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A later refresh failure names the snapshot that is still shown.
    await button(wrapper, 'Refresh catalog').trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    vi.spyOn(client, 'listProviderDestinations').mockRejectedValueOnce({ kind: 'rate_limited' });
    await button(wrapper, 'Refresh catalog').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Could not load destinations. The provider is rate limiting; retrying with backoff. Showing the previous snapshot.');
    wrapper.unmount();
  });

  it('says so when a search matches nothing', async () => {
    const { wrapper } = setup(); await flushPromises();
    await wrapper.get('input').setValue('zzzz-no-such-destination');
    expect(wrapper.get('.destination-state').text()).toBe('No destinations match this catalog search.');
    expect(catalogRows(wrapper)).toHaveLength(0);
    wrapper.unmount();
  });
});

describe('provider destinations: keyboard row model', () => {
  it('ArrowDown/ArrowUp and j/k move focus between catalog rows, clamped, with a roving tab stop', async () => {
    const { wrapper } = setup(); await flushPromises();
    const rows = () => catalogRows(wrapper).map((row) => row.element as HTMLElement);
    expect(rows().map((row) => row.getAttribute('tabindex'))).toEqual(['0', ...Array(8).fill('-1')]);
    rows()[0]!.focus();
    press(document.activeElement!, 'ArrowDown'); expect(document.activeElement).toBe(rows()[1]);
    press(document.activeElement!, 'j'); expect(document.activeElement).toBe(rows()[2]);
    press(document.activeElement!, 'k'); expect(document.activeElement).toBe(rows()[1]);
    press(document.activeElement!, 'ArrowUp'); expect(document.activeElement).toBe(rows()[0]);
    press(document.activeElement!, 'ArrowUp'); expect(document.activeElement).toBe(rows()[0]);
    for (let i = 0; i < 20; i += 1) press(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(rows()[8]);
    await flushPromises();
    // Tab order follows the last-focused row.
    expect(rows().map((row) => row.getAttribute('tabindex'))).toEqual([...Array(8).fill('-1'), '0']);
    wrapper.unmount();
  });

  it('prevents default on handled keys only, and leaves modified, shifted and IME keys alone', async () => {
    const { wrapper } = setup(); await flushPromises();
    const first = catalogRows(wrapper)[0]!.element as HTMLElement;
    first.focus();
    expect(press(first, 'ArrowDown').defaultPrevented).toBe(true);
    first.focus();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }] satisfies KeyboardEventInit[]) {
      first.focus();
      expect(press(first, 'j', init).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(first);
    }
    expect(press(first, 'x').defaultPrevented).toBe(false);
    wrapper.unmount();
  });

  it('does not steal j/k from the search field, and ArrowDown there enters the list', async () => {
    const { wrapper } = setup(); await flushPromises();
    const input = wrapper.get('input').element as HTMLInputElement;
    input.focus();
    expect(press(input, 'j').defaultPrevented).toBe(false);
    expect(press(input, 'k').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(press(input, 'ArrowDown').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(catalogRows(wrapper)[0]!.element);
    wrapper.unmount();
  });

  it('walks page rows the same way and keeps keys inside the drawer', async () => {
    const { client, wrapper } = setup(); await flushPromises();
    const conversation = (id: string) => ({ ref: { accountId: 'fixture-account', conversationId: id }, subject: `Subject ${id}`, messages: [], isInInbox: true, isRead: false, pendingOperationId: null });
    vi.spyOn(client, 'browseProviderDestination').mockResolvedValueOnce({
      accountId: 'fixture-account', destinationId: 'SENT', nextCursor: null, fetchedAt: '2025-02-02T00:00:00Z',
      conversations: [conversation('a'), conversation('b'), conversation('c')],
    });
    await button(wrapper, 'Sent').trigger('click'); await flushPromises();
    const list = wrapper.get('.destination-list').element as HTMLElement;
    expect(document.activeElement).toBe(list);
    const rows = () => wrapper.findAll('.destination-list [data-row]').map((row) => row.element as HTMLElement);
    expect(rows()).toHaveLength(3);
    expect(rows()[0]!.classList.contains('destination-row')).toBe(true);
    press(list, 'ArrowDown'); expect(document.activeElement).toBe(rows()[0]);
    press(document.activeElement!, 'j'); expect(document.activeElement).toBe(rows()[1]);
    press(document.activeElement!, 'k'); expect(document.activeElement).toBe(rows()[0]);
    const seen: string[] = [];
    const observer = (event: KeyboardEvent): void => { seen.push(event.key); };
    window.addEventListener('keydown', observer);
    press(document.activeElement!, 'j');
    expect(seen).toEqual([]);
    window.removeEventListener('keydown', observer);
    wrapper.unmount();
  });

  it('Escape steps back one level at a time and only then falls through to close the drawer', async () => {
    const { wrapper } = setup(); await flushPromises();
    const reached: string[] = [];
    const observer = (event: KeyboardEvent): void => { reached.push(event.key); };
    window.addEventListener('keydown', observer);
    try {
      const sent = catalogRows(wrapper).find((row) => row.text() === 'Sent')!;
      await sent.trigger('click'); await flushPromises();
      const row = wrapper.get('.destination-row');
      await row.trigger('click'); await flushPromises();
      expect(wrapper.find('.destination-reader').exists()).toBe(true);

      // reader -> page list, focus back on the opening row
      const first = press(document.activeElement!, 'Escape'); await flushPromises();
      expect(first.defaultPrevented).toBe(true);
      expect(wrapper.find('.destination-reader').exists()).toBe(false);
      expect(wrapper.find('.destination-list').isVisible()).toBe(true);
      expect(document.activeElement).toBe(row.element);

      // page list -> catalog, focus back on the destination row
      const second = press(document.activeElement!, 'Escape'); await flushPromises();
      expect(second.defaultPrevented).toBe(true);
      expect(wrapper.find('.destination-list').exists()).toBe(false);
      const sentAgain = catalogRows(wrapper).find((r) => r.text() === 'Sent')!;
      expect(document.activeElement).toBe(sentAgain.element);

      // catalog: Escape is not consumed, so App closes the drawer
      expect(reached).toEqual([]);
      const third = press(document.activeElement!, 'Escape'); await flushPromises();
      expect(third.defaultPrevented).toBe(false);
      expect(reached).toEqual(['Escape']);
    } finally {
      window.removeEventListener('keydown', observer);
    }
    wrapper.unmount();
  });

  it('leaves modified and IME Escape alone at the page level', async () => {
    const { wrapper } = setup(); await flushPromises();
    await button(wrapper, 'Sent').trigger('click'); await flushPromises();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }] satisfies KeyboardEventInit[]) {
      const event = press(wrapper.get('.destination-list').element, 'Escape', init);
      expect(event.defaultPrevented).toBe(false);
      expect(wrapper.find('.destination-list').exists()).toBe(true);
    }
    wrapper.unmount();
  });
});
