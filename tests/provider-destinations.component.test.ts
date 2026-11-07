import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ProviderDestinations from '../src/components/ProviderDestinations.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { deferred } from './helpers';
import type { DestinationPage } from '../src/lib/ipc/client';

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
    expect(wrapper.get('[role="alert"]').text()).toContain('network_unavailable');
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
