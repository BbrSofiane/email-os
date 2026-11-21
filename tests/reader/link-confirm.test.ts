import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import LinkConfirm from '../../src/components/LinkConfirm.vue';
import type { MailClient } from '../../src/lib/ipc/client';

const openExternalLink = vi.fn();
const client = { openExternalLink } as unknown as MailClient;
const buttons = (wrapper: ReturnType<typeof mount>, label: string) => wrapper.findAll('button').find((button) => button.text() === label)!;

describe('link confirmation', () => {
  it('shows the destination, mismatch and open status', async () => {
    openExternalLink.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error());
    const w = mount(LinkConfirm, { props: { url: 'https://real.test/', text: 'other.test', client, preview: true, canOpen: true } });
    expect(w.text()).toContain('https://real.test/');
    expect(w.text()).toContain('The link text shows a different address.');
    await buttons(w, 'Open in browser').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('Modelled external open only');
    await buttons(w, 'Open in browser').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('Could not open the link.');
  });
  it('offers copy when opening is unavailable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const w = mount(LinkConfirm, { props: { url: 'https://real.test/', client, preview: false, canOpen: false } });
    expect(w.text()).toContain('Opening links is not available on this device.');
    expect(w.text()).not.toContain('Open in browser');
    await buttons(w, 'Copy link').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('https://real.test/');
    expect(w.text()).toContain('Link copied.');
    vi.unstubAllGlobals();
  });
  it('uses only the mailto address and rejects invalid addresses', async () => {
    const w = mount(LinkConfirm, { props: { url: 'mailto:a@b.test?subject=Urgent', client, preview: false, canOpen: true } });
    await buttons(w, 'New message to a@b.test').trigger('click');
    expect(w.emitted('compose')).toEqual([['a@b.test']]);
    expect(w.text()).not.toContain('Urgent');
    await w.setProps({ url: 'mailto:%0Aevil@x.test' });
    expect(w.text()).toContain('This address is not valid.');
    expect(w.findAll('button')).toHaveLength(1);
  });
});
