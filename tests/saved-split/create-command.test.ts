import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';

import { createBrowserFakeMailClient, mountApp } from '../helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

async function createCommand(w: VueWrapper): Promise<void> {
  await w.get('[data-test="palette-trigger"]').trigger('click');
  await w.get('[data-test="action-query"]').setValue('create split');
  await w.get('[data-test="action-query"]').trigger('keydown', { key: 'Enter' });
  await flushPromises();
}

it('creates only through Commands, focuses the editor and returns Cancel to Commands', async () => {
  const fake = createBrowserFakeMailClient();
  const archive = vi.spyOn(fake, 'setArchived');
  wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  expect(wrapper.find('[data-test="split-settings"]').exists()).toBe(false);
  expect(wrapper.findAll('button').some((button) => /create split/i.test(button.text()))).toBe(false);
  await wrapper.get('[data-test="navigator-trigger"]').trigger('click');
  expect(wrapper.find('#action-create-split').exists()).toBe(false);
  await wrapper.get('[data-test="action-query"]').trigger('keydown', { key: 'Escape' });
  await createCommand(wrapper);
  expect(wrapper.find('[data-test="action-query"]').exists()).toBe(false);
  expect(document.activeElement).toBe(wrapper.get('[data-test="split-name"]').element);
  await wrapper.get('[data-test="split-name"]').setValue('Unsaved');
  await wrapper.get('[data-test="split-name"]').trigger('keydown', { key: 'Escape' });
  await flushPromises();
  expect(wrapper.find('.split-editor').exists()).toBe(false);
  expect(document.activeElement).toBe(wrapper.get('[data-test="palette-trigger"]').element);
  const account = (await fake.getAccountStatus()).account!.accountId;
  expect(await fake.getSavedSplit(account)).toBeNull();
  expect(archive).not.toHaveBeenCalled();
});

it('saves one split, switches to the Edit split command, and returns focus to Commands', async () => {
  const fake = createBrowserFakeMailClient();
  wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  await createCommand(wrapper);
  await wrapper.get('[data-test="split-name"]').setValue('Ada');
  await wrapper.get('[data-test="split-value"]').setValue('ada@example.test');
  await wrapper.get('form.split-editor').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[data-test="split-saved"]').text()).toContain('Ada');
  expect(document.activeElement).toBe(wrapper.get('[data-test="palette-trigger"]').element);
  expect(wrapper.find('[data-test="split-settings"]').exists()).toBe(false);
  expect(wrapper.findAll('button').some((button) => /edit split/i.test(button.text()))).toBe(false);
  await wrapper.get('[data-test="palette-trigger"]').trigger('click');
  expect(wrapper.find('#action-create-split').exists()).toBe(false);
  expect(wrapper.get('#action-edit-split .action-copy > span').text()).toBe('Edit split');
  await wrapper.get('[data-test="action-query"]').setValue('edit split');
  await wrapper.get('[data-test="action-query"]').trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect((wrapper.get('[data-test="split-name"]').element as HTMLInputElement).value).toBe('Ada');
  await wrapper.get('[data-test="split-name"]').trigger('keydown', { key: 'Escape' });
  await flushPromises();
  expect(document.activeElement).toBe(wrapper.get('[data-test="palette-trigger"]').element);
});

it.each(['disabled', 'hidden'] as const)('edits a %s existing split through Commands without creating another definition', async (state) => {
  const fake = createBrowserFakeMailClient();
  const account = (await fake.getAccountStatus()).account!.accountId;
  await fake.saveSavedSplit(account, {
    name: 'Existing', criterion: 'sender', value: 'nobody@absent.test',
    enabled: state !== 'disabled', hideWhenEmpty: true,
  });
  const archive = vi.spyOn(fake, 'setArchived');
  wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  expect(wrapper.find('[data-test="split-saved"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="split-settings"]').exists()).toBe(false);
  await wrapper.get('[data-test="navigator-trigger"]').trigger('click');
  expect(wrapper.find('#action-edit-split').exists()).toBe(false);
  await wrapper.get('[data-test="action-query"]').trigger('keydown', { key: 'Escape' });
  await wrapper.get('[data-test="palette-trigger"]').trigger('click');
  expect(wrapper.find('#action-create-split').exists()).toBe(false);
  await wrapper.get('#action-edit-split').trigger('click');
  await flushPromises();
  expect(document.activeElement).toBe(wrapper.get('[data-test="split-name"]').element);
  expect((wrapper.get('[data-test="split-name"]').element as HTMLInputElement).value).toBe('Existing');
  await wrapper.get('[data-test="split-name"]').setValue('Updated');
  await wrapper.get('form.split-editor').trigger('submit');
  await flushPromises();
  expect(await fake.getSavedSplit(account)).toMatchObject({ name: 'Updated', enabled: state !== 'disabled' });
  expect(document.activeElement).toBe(wrapper.get('[data-test="palette-trigger"]').element);
  expect(archive).not.toHaveBeenCalled();
});

it.each(['reader', 'activity', 'done'] as const)('opens creation from %s without retaining a covered editor or stealing its input focus', async (surface) => {
  const fake = createBrowserFakeMailClient();
  wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  if (surface === 'reader') await wrapper.get('.inbox-row').trigger('click');
  if (surface === 'activity') await wrapper.get('[data-test="rail-activity"]').trigger('click');
  if (surface === 'done') await wrapper.get('[data-test="rail-done"]').trigger('click');
  await flushPromises();
  await createCommand(wrapper);
  expect(wrapper.find('[data-test="reader"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="utility-drawer"]').exists()).toBe(false);
  expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Inbox');
  expect(document.activeElement).toBe(wrapper.get('[data-test="split-name"]').element);
});

it('supports native Cmd+K followed by typed Create split and Enter', async () => {
  const fake = createBrowserFakeMailClient();
  wrapper = mountApp(fake, 'native', { attachTo: document.body });
  await flushPromises();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
  await flushPromises();
  await wrapper.get('[data-test="action-query"]').setValue('Create split');
  await wrapper.get('[data-test="action-query"]').trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect(document.activeElement).toBe(wrapper.get('[data-test="split-name"]').element);
});
