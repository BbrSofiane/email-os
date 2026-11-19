import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import DraftEditorCore from '../../src/components/DraftEditorCore.vue';
import type { DraftContent } from '../../src/lib/ipc/client';

const content: DraftContent = { to: 'ada@example.test', cc: '', subject: 'Topic', bodyText: '' };

function editorProps(overrides: Record<string, unknown> = {}) {
  return {
    activeRef: { accountId: 'fixture', draftId: 'd1' },
    source: null,
    content,
    status: 'Saved locally',
    creating: false,
    saving: false,
    conflict: false,
    error: null,
    createError: null,
    deleting: false,
    closing: false,
    transitioning: false,
    deletePending: false,
    confirmDiscard: false,
    discardBusy: false,
    confirmReload: false,
    copyPending: false,
    recoveryRequired: false,
    canCancelReplyPreparation: false,
    closeError: null,
    variant: 'new' as const,
    ...overrides,
  };
}

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('draft field mobile keyboard hints', () => {
  it('keeps recipient inputs as text and configures the appropriate keyboard hints', async () => {
    wrapper = mount(DraftEditorCore, { props: editorProps(), attachTo: document.body });
    await wrapper.get('[data-test="draft-fields-toggle"]').trigger('click');

    for (const selector of ['[data-test="draft-to"]', '[data-test="draft-cc"]']) {
      const field = wrapper.get(selector);
      expect(field.attributes('type')).toBe('text');
      expect(field.attributes('inputmode')).toBe('email');
      expect(field.attributes('autocapitalize')).toBe('none');
      expect(field.attributes('autocorrect')).toBe('off');
      expect(field.attributes('spellcheck')).toBe('false');
      expect(field.attributes('enterkeyhint')).toBe('next');
    }

    const subject = wrapper.get('[data-test="draft-subject"]');
    expect(subject.attributes('enterkeyhint')).toBe('next');
    expect(subject.attributes('autocapitalize')).toBe('sentences');
    expect(wrapper.get('[data-test="draft-body"]').attributes('autocapitalize')).toBe('sentences');
  });

  it('moves Enter from To to Subject when Cc is hidden', async () => {
    wrapper = mount(DraftEditorCore, { props: editorProps(), attachTo: document.body });
    const to = wrapper.get('[data-test="draft-to"]');
    const subject = wrapper.get('[data-test="draft-subject"]');
    await to.trigger('keydown', { key: 'Enter' });
    expect(document.activeElement).toBe(subject.element);
  });

  it('moves Enter through visible To, Cc, Subject and Body fields', async () => {
    wrapper = mount(DraftEditorCore, { props: editorProps(), attachTo: document.body });
    await wrapper.get('[data-test="draft-fields-toggle"]').trigger('click');
    const fields = [
      wrapper.get('[data-test="draft-to"]'),
      wrapper.get('[data-test="draft-cc"]'),
      wrapper.get('[data-test="draft-subject"]'),
      wrapper.get('[data-test="draft-body"]'),
    ];

    for (let index = 0; index < fields.length - 1; index += 1) {
      await fields[index]!.trigger('keydown', { key: 'Enter' });
      expect(document.activeElement).toBe(fields[index + 1]!.element);
    }
  });

  it('leaves Enter to the IME while composition is active', async () => {
    wrapper = mount(DraftEditorCore, { props: editorProps(), attachTo: document.body });
    const to = wrapper.get('[data-test="draft-to"]');
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    to.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(wrapper.get('[data-test="draft-subject"]').element);
  });
});
