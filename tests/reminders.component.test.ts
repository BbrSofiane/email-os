import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import RemindersPanel from '../src/components/RemindersPanel.vue';
import { fullDateLabel } from '../src/lib/browsing-dates';
import App from '../src/App.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import type { PutReminder, Reminder } from '../src/lib/ipc/client';
import { useGmailMode } from './helpers';

function fixture() {
  const fake = createBrowserFakeMailClient();
  const rows: Reminder[] = [];
  const put = vi.fn(async (c: PutReminder): Promise<Reminder> => {
    const r: Reminder = { conversation: c.conversation, subject: '<script>literal</script>', revision: 1, sourceMessageId: c.sourceMessageId, dueAt: c.dueAt, condition: c.condition, phase: 'removing' };
    rows.splice(0, rows.length, r); return r;
  });
  fake.reminders = { list: vi.fn(async () => JSON.parse(JSON.stringify(rows)) as Reminder[]), put, cancel: vi.fn(async c => ({ ...rows[0]!, revision: c.expectedRevision + 1, phase: 'cancelling' as const })) };
  return { fake, rows, put };
}
describe('bounded local reminder journey', () => {
  it('prepares an immutable source, defaults conditional, retries exact lost ACK and separates returned membership', async () => {
    const { fake, rows, put } = fixture();
    const target = { accountId: 'fixture-account', conversationId: 'conv-01' };
    const panel = mount(RemindersPanel, { props: { client: fake, target } });
    await flushPromises();
    const detail = await fake.getConversation(target);
    put.mockRejectedValueOnce({ kind: 'storage_unavailable' });
    await panel.get('input[type="text"]').setValue('2030-11-03T01:30:00-05:00');
    await panel.get('form').trigger('submit'); await flushPromises();
    expect(panel.get('[role="alert"]').text()).toContain('not acknowledged');
    const first = put.mock.calls[0]![0];
    expect(first).toMatchObject({ conversation: target, sourceMessageId: detail.messages.at(-1)!.id, condition: 'if_no_reply', expectedRevision: null });
    const retry = panel.findAll('button').find(b => b.text() === 'Retry exact request')!;
    await retry.trigger('click'); await flushPromises();
    expect(put.mock.calls[1]![0]).toEqual(first);
    expect(panel.text()).toContain('removing'); expect(panel.find('script').exists()).toBe(false);
    rows[0]!.phase = 'returned';
    await panel.findAll('button').find(b => b.text() === 'Refresh reminders')!.trigger('click'); await flushPromises();
    expect(panel.text()).toContain('No pending reminders');
    await panel.findAll('nav button')[1]!.trigger('click');
    expect(panel.text()).toContain('<script>literal</script>');
    await panel.findAll('li button')[0]!.trigger('click'); expect(panel.emitted('open')![0]).toEqual([target]);
    panel.unmount();
  });
  it('keeps a rejected time editable rather than endlessly replaying a validation error', async () => {
    const { fake, put } = fixture();
    const panel = mount(RemindersPanel, { props: { client: fake, target: { accountId: 'fixture-account', conversationId: 'conv-01' } } }); await flushPromises();
    put.mockRejectedValueOnce({ kind: 'invalid_request', field: 'dueAt' });
    await panel.get('input[type="text"]').setValue('2030-11-03T01:30:00');
    await panel.get('form').trigger('submit'); await flushPromises();
    expect(panel.get('[role="alert"]').text()).toContain('timezone offset');
    expect(panel.get('fieldset').attributes('disabled')).toBeUndefined();
    await panel.get('input[type="text"]').setValue('2030-11-03T01:30:00-05:00');
    await panel.get('form').trigger('submit'); await flushPromises();
    expect(put.mock.calls[1]![0].requestId).not.toBe(put.mock.calls[0]![0].requestId);
    panel.unmount();
  });

  it('offers someday and revisioned cancel / reschedule against authoritative rows', async () => {
    const { fake, rows, put } = fixture();
    const target = { accountId: 'fixture-account', conversationId: 'conv-01' };
    const panel = mount(RemindersPanel, { props: { client: fake, target } }); await flushPromises();
    await panel.get('input[type="checkbox"]').setValue(true);
    await panel.get('select').setValue('regardless'); await panel.get('form').trigger('submit'); await flushPromises();
    expect(put.mock.calls[0]![0]).toMatchObject({ dueAt: null, condition: 'regardless' });
    rows[0]!.phase = 'pending'; rows[0]!.revision = 3;
    await panel.findAll('button').find(b => b.text() === 'Refresh reminders')!.trigger('click'); await flushPromises();
    await panel.findAll('button').find(b => b.text() === 'Reschedule')!.trigger('click');
    await panel.get('form').trigger('submit'); await flushPromises();
    expect(put.mock.calls[1]![0].expectedRevision).toBe(3);
    await panel.findAll('button').find(b => b.text().startsWith('Cancel and restore'))!.trigger('click'); await flushPromises();
    expect(fake.reminders!.cancel).toHaveBeenCalledWith(expect.objectContaining({ conversation: target, expectedRevision: 1 }));
    panel.unmount();
  });
  it('opens a returned conversation and Back restores the returned destination without auto-read', async () => {
    const { fake, rows } = fixture();
    const target = { accountId: 'fixture-account', conversationId: 'conv-01' };
    const detail = await fake.getConversation(target);
    rows.push({ conversation: target, subject: 'Returned fixture', revision: 4, sourceMessageId: detail.messages.at(-1)!.id, dueAt: '2030-01-01T00:00:00Z', condition: 'regardless', phase: 'returned' });
    const setRead = vi.spyOn(fake, 'setRead');
    const app = mount(App, { props: { client: fake, mode: 'native' }, attachTo: document.body }); await flushPromises();
    await app.findAll('button').find(b => b.text() === 'Reminders')!.trigger('click'); await flushPromises();
    await app.findComponent(RemindersPanel).findAll('nav button')[1]!.trigger('click'); await flushPromises();
    // Due times are the full viewer-local form with a machine-readable datetime.
    expect(app.findComponent(RemindersPanel).get('time[datetime="2030-01-01T00:00:00.000Z"]').text()).toBe(fullDateLabel('2030-01-01T00:00:00Z'));
    await app.findComponent(RemindersPanel).findAll('li button')[0]!.trigger('click'); await flushPromises();
    expect(app.findComponent(RemindersPanel).exists()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await flushPromises();
    expect(app.findComponent(RemindersPanel).exists()).toBe(true);
    expect(app.findComponent(RemindersPanel).findAll('nav button')[1]!.attributes('aria-pressed')).toBe('true');
    expect(setRead).not.toHaveBeenCalled(); app.unmount();
  });

  it('H opens supported fixture picker, not for bulk, text input, or Gmail; absent transport exposes no dead controls', async () => {
    const { fake } = fixture();
    const app = mount(App, { props: { client: fake, mode: 'native' }, attachTo: document.body }); await flushPromises();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true })); await flushPromises();
    expect(app.findComponent(RemindersPanel).exists()).toBe(true);
    expect(app.findComponent(RemindersPanel).find('form').exists()).toBe(true);
    const input = app.findComponent(RemindersPanel).get('input[type="text"]');
    await input.setValue('h'); await input.trigger('keydown', { key: 'h' });
    expect((input.element as HTMLInputElement).value).toBe('h');
    await app.get('[data-test="drawer-close"]').trigger('click'); await flushPromises();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', isComposing: true })); await flushPromises();
    expect(app.findComponent(RemindersPanel).exists()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' })); await flushPromises();
    expect(app.get('[data-test="selection-live"]').text()).toContain('1 selected');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' })); await flushPromises();
    expect(app.findComponent(RemindersPanel).exists()).toBe(false);
    app.unmount();
    const gmail = fixture(); useGmailMode(gmail.fake);
    const gated = mount(App, { props: { client: gmail.fake, mode: 'native' } }); await flushPromises();
    expect(gated.text()).not.toContain('Remind me'); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' })); await flushPromises();
    expect(gated.findComponent(RemindersPanel).exists()).toBe(false); gated.unmount();
    const unsupported = createBrowserFakeMailClient();
    const preview = mount(App, { props: { client: unsupported, mode: 'browser-preview' } }); await flushPromises();
    expect(preview.text()).not.toContain('Remind me'); preview.unmount();
  });
});
