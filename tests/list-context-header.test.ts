import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { createBrowserFakeMailClient, mountApp, press, useGmailMode } from './helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });
const title = (w: VueWrapper) => w.get('[data-test="inbox-title"]').text();
const header = (w: VueWrapper) => w.get('header.app-header');

async function mountGmail(): Promise<VueWrapper> {
  const fake = createBrowserFakeMailClient();
  useGmailMode(fake, { mutationAccess: 'enabled' });
  fake.controls.markTriage('conv-04', 'trash');
  wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

describe('Trash and Drafts headers show the context title only', () => {
  it('keeps the Inbox split nav in Inbox, Done and Starred', async () => {
    const w = await mountGmail();
    expect(header(w).find('nav[aria-label="Inbox splits"]').exists()).toBe(true);
    expect(header(w).find('[data-test="split-inbox"]').attributes('aria-current')).toBe('page');
    for (const [rail, heading] of [['rail-done', 'Cached Done'], ['rail-starred', 'Cached Starred']] as const) {
      await w.get(`[data-test="${rail}"]`).trigger('click'); await flushPromises();
      expect(title(w)).toBe(heading);
      expect(header(w).find('nav[aria-label="Inbox splits"]').exists()).toBe(true);
      expect(header(w).find('[data-test="split-inbox"]').attributes('aria-current')).toBeUndefined();
    }
  });

  it('Cached Trash: the h1 is the only title, no Inbox tab or count, Back and the rail return', async () => {
    const w = await mountGmail();
    await w.get('[data-test="rail-trash"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Cached Trash');
    expect(header(w).find('h1').classes()).not.toContain('visually-hidden');
    expect(header(w).find('nav[aria-label="Inbox splits"]').exists()).toBe(false);
    expect(header(w).find('[data-test="split-inbox"]').exists()).toBe(false);
    expect(header(w).find('.split-count').exists()).toBe(false);
    expect(w.find('[data-test="split-coverage"]').exists()).toBe(false);
    // Esc inside a Trash reader returns to the row; Esc again returns to the previous context.
    await w.get('[data-test="conversation-row-conv-04"]').trigger('click'); await flushPromises();
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(title(w)).toBe('Cached Trash');
    expect(document.activeElement).toBe(w.get('[data-test="conversation-row-conv-04"]').element);
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(title(w)).toBe('Inbox');
    expect(header(w).find('[data-test="split-inbox"]').exists()).toBe(true);
    // The header Back button and the rail Inbox entry are routes back too.
    await w.get('[data-test="rail-trash"]').trigger('click'); await flushPromises();
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Inbox');
    await w.get('[data-test="rail-trash"]').trigger('click'); await flushPromises();
    await w.get('[data-test="rail-inbox"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Inbox');
    expect(header(w).find('[data-test="split-inbox"]').attributes('aria-current')).toBe('page');
  });

  it('Drafts: the h1 is the only title, no Inbox tab or count, Back and the rail return to the row', async () => {
    const fake = createBrowserFakeMailClient();
    wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    const w = wrapper;
    await flushPromises();
    press('j', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.get('[data-test="conversation-row-conv-02"]').attributes('aria-current')).toBe('true');
    expect(header(w).find('[data-test="split-inbox"]').exists()).toBe(true);
    await w.get('[data-test="rail-drafts"]').trigger('click'); await flushPromises();
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(true);
    expect(title(w)).toBe('Drafts');
    expect(header(w).find('h1').classes()).not.toContain('visually-hidden');
    expect(header(w).find('nav[aria-label="Inbox splits"]').exists()).toBe(false);
    expect(header(w).find('[data-test="split-inbox"]').exists()).toBe(false);
    expect(header(w).find('.split-count').exists()).toBe(false);
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(title(w)).toBe('Inbox');
    expect(w.get('[data-test="conversation-row-conv-02"]').attributes('aria-current')).toBe('true');
    expect(header(w).find('[data-test="split-inbox"]').exists()).toBe(true);
    await w.get('[data-test="rail-drafts"]').trigger('click'); await flushPromises();
    await w.get('[data-test="rail-inbox"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Inbox');
    expect(header(w).find('[data-test="split-inbox"]').attributes('aria-current')).toBe('page');
  });
});
