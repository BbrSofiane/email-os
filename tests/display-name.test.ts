import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import MessageAttachments from '../src/components/MessageAttachments.vue';
import AttachmentChooser from '../src/components/AttachmentChooser.vue';
import { displayFileName } from '../src/lib/display-name';
import { createBrowserFakeMailClient, fixtureRef } from './helpers';

const RLO = '‮';
const SPOOF = `invoice${RLO}fdp.exe`;

describe('displayFileName', () => {
  it('strips every bidi control and keeps the real character order', () => {
    expect(displayFileName(SPOOF)).toBe('invoicefdp.exe');
    expect(displayFileName('a‪b‫c‬d‭e⁦f⁧g⁨h⁩i‎j‏k؜l')).toBe('abcdefghijkl');
  });
  it('leaves ordinary names, including right-to-left scripts, alone', () => {
    expect(displayFileName('report 2025.pdf')).toBe('report 2025.pdf');
    expect(displayFileName('דוח.pdf')).toBe('דוח.pdf');
  });
  it('names an empty or all-control name', () => {
    expect(displayFileName('')).toBe('Unnamed attachment');
    expect(displayFileName(RLO)).toBe('Unnamed attachment');
    expect(displayFileName(null)).toBe('Unnamed attachment');
  });
});

describe('attachment names are shown without bidi controls', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });
  const file = { messageId: 'm1', attachmentId: 'a1', filename: SPOOF, mimeType: 'application/pdf', size: 100 };

  it('inline row: text, title and button label', () => {
    wrapper = mount(MessageAttachments, {
      props: { messageId: 'm1', files: [file], loadState: 'ready', retained: false, pending: null, target: null, status: '', error: '' },
    });
    const name = wrapper.get('.attachment-name');
    expect(name.text()).toBe('invoicefdp.exe');
    expect(name.attributes('title')).toBe('invoicefdp.exe');
    expect(wrapper.get('[data-test="attachment-save"]').attributes('aria-label')).toBe('Save invoicefdp.exe');
    expect(wrapper.html()).not.toContain(RLO);
  });

  it('chooser list', async () => {
    const client = createBrowserFakeMailClient();
    client.listAttachments = async () => [file];
    wrapper = mount(AttachmentChooser, {
      props: { client, conversation: { ref: fixtureRef('conv-01'), messages: [], subject: 's' } as never, preview: false },
      attachTo: document.body,
    });
    await flushPromises();
    expect(wrapper.text()).toContain('invoicefdp.exe — application/pdf');
    expect(wrapper.html()).not.toContain(RLO);
  });
});
