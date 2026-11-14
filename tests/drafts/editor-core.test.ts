/**
 * DraftEditorCore status line: terse text, a keyboard-reachable disclosure for
 * the local-only caveats, and a quiet live region that announces only
 * meaningful transitions (not every autosave).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import DraftEditorCore from '../../src/components/DraftEditorCore.vue';
import type { DraftContent, DraftSource } from '../../src/lib/ipc/client';

const SOURCE: DraftSource = { kind: 'reply', conversation: { accountId: 'fixture', conversationId: 'conv-01' }, sourceMessageId: 'conv-01-m3' };
const CONTENT: DraftContent = { to: 'ada@example.test', cc: '', subject: 'Re: x', bodyText: '' };

function props(overrides: Record<string, unknown> = {}) {
  return {
    activeRef: { accountId: 'fixture', draftId: 'd1' },
    source: SOURCE,
    content: CONTENT,
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
    variant: 'reply' as const,
    recipientLabel: 'Ada Fixture',
    recipientMailbox: 'ada@example.test',
    ...overrides,
  };
}

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });

describe('draft status line', () => {
  it('stays terse and reveals the local-only caveats from a focusable toggle, not a tooltip', async () => {
    wrapper = mount(DraftEditorCore, { props: props(), attachTo: document.body });
    expect(wrapper.get('[data-test="draft-status"]').text()).toBe('Saved locally · not sent');
    expect(wrapper.find('[data-test="draft-caveat"]').exists()).toBe(false);
    const toggle = wrapper.get('[data-test="draft-caveat-toggle"]');
    expect(toggle.element.tagName).toBe('BUTTON');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(toggle.attributes('aria-label')).toBeTruthy();
    // Reachable by keyboard.
    (toggle.element as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(toggle.element);
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    const caveat = wrapper.get('[data-test="draft-caveat"]');
    expect(caveat.text()).toContain('not validated');
    expect(caveat.text()).toContain('Bcc');
    expect(toggle.attributes('aria-controls')).toBe(caveat.attributes('id'));
    await toggle.trigger('click');
    expect(wrapper.find('[data-test="draft-caveat"]').exists()).toBe(false);
  });

  it('does not make the status line itself a live region', () => {
    wrapper = mount(DraftEditorCore, { props: props() });
    expect(wrapper.get('[data-test="draft-status"]').attributes('aria-live')).toBeUndefined();
  });
});

describe('draft status announcements', () => {
  const announced = (w: VueWrapper) => w.get('[data-test="draft-status-announce"]').text();

  it('announces the first save, not the Saving…/Saved autosave cycle', async () => {
    wrapper = mount(DraftEditorCore, { props: props({ status: 'Creating local draft…' }) });
    expect(announced(wrapper)).toBe('');
    await wrapper.setProps({ status: 'Saved locally' });
    expect(announced(wrapper)).toBe('Saved locally · not sent');
    // Typing: Saving… then Saved. The live text never changes, so nothing is re-announced.
    for (let i = 0; i < 3; i += 1) {
      await wrapper.setProps({ status: 'Saving locally…' });
      expect(announced(wrapper)).toBe('Saved locally · not sent');
      await wrapper.setProps({ status: 'Saved locally' });
    }
    expect(wrapper.get('[data-test="draft-status-announce"]').attributes('role')).toBe('status');
  });

  it('announces errors and conflicts, and the recovery after them', async () => {
    wrapper = mount(DraftEditorCore, { props: props() });
    await wrapper.setProps({ status: 'Saving locally…' });
    await wrapper.setProps({ status: 'Save not confirmed', error: { kind: 'unavailable', message: 'x' } });
    expect(announced(wrapper)).toBe('Save not confirmed');
    await wrapper.setProps({ status: 'Conflict — edits preserved', conflict: true });
    expect(announced(wrapper)).toBe('Conflict — edits preserved');
    await wrapper.setProps({ status: 'Saving locally…', conflict: false, error: null });
    expect(announced(wrapper)).toBe('Conflict — edits preserved');
    await wrapper.setProps({ status: 'Saved locally' });
    expect(announced(wrapper)).toBe('Saved locally · not sent');
    // The visible error paragraph keeps its own alert role.
    await wrapper.setProps({ status: 'Save not confirmed', error: { kind: 'unavailable', message: 'x' } });
    expect(wrapper.find('[data-test="draft-error"]').attributes('role')).toBe('alert');
  });
});

describe('reply extras (Cc / Subject)', () => {
  const toggle = (w: VueWrapper) => w.get('[data-test="draft-fields-toggle"]');

  it('stays closed when To differs from the sender, because the To row is already an input', () => {
    wrapper = mount(DraftEditorCore, { props: props({ content: { ...CONTENT, to: 'list@lists.example' } }) });
    expect(wrapper.find('[data-test="draft-to-row"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="draft-to"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="draft-cc"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="draft-subject"]').exists()).toBe(false);
    expect(toggle(wrapper).attributes('aria-expanded')).toBe('false');
    expect(toggle(wrapper).attributes('disabled')).toBeUndefined();
  });

  it('does not open while To is being typed', async () => {
    wrapper = mount(DraftEditorCore, { props: props() });
    await wrapper.get('[data-test="draft-to-row"]').trigger('click');
    await wrapper.setProps({ content: { ...CONTENT, to: 'ada@example.test, ' } });
    expect(wrapper.find('[data-test="draft-cc"]').exists()).toBe(false);
    expect(toggle(wrapper).attributes('aria-expanded')).toBe('false');
  });

  it.each([
    ['Cc text', { cc: 'cc@example.test' }],
    ['a subject that is not Re:', { subject: 'Other topic' }],
  ])('stays open and locked for %s, even with a differing To', (_name, extra) => {
    wrapper = mount(DraftEditorCore, { props: props({ content: { ...CONTENT, to: 'list@lists.example', ...extra } }) });
    expect(wrapper.find('[data-test="draft-cc"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="draft-subject"]').exists()).toBe(true);
    expect(toggle(wrapper).attributes('aria-expanded')).toBe('true');
    expect(toggle(wrapper).attributes('disabled')).toBeDefined();
  });
});
