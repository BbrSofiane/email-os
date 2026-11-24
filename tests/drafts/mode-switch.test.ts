/**
 * ADR 0005 section 3: a mode switch is an account transition. The open draft
 * is saved before `switchMode` is sent; when the save fails, nothing switches
 * and the editor keeps its text and its error.
 */
import { advanceUiUntil, useUiTestClock } from '../support/timers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { MailClient } from '../../src/lib/ipc/client';
import { closeUtilityDrawer, createBrowserFakeMailClient, openDraftsList, openUtilityDrawer } from '../helpers';
import { mountDraftsApp, startNewDraft } from '../support/drafts';
import { CONNECT_AFTER_SWITCH_KEY } from '../../src/composables/useModeChoice';

const state = vi.hoisted(() => ({ reload: vi.fn() }));
vi.mock('../../src/lib/ipc', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/ipc')>()),
  isAndroidShell: () => true,
}));
vi.mock('../../src/lib/reload', () => ({ reloadPage: state.reload }));

describe('mode switch and the open draft', () => {
  beforeEach(useUiTestClock);
  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
    state.reload.mockReset();
  });

  it('offers "Use your own mail" in the demo mailbox and saves the draft before switching', async () => {
    const fake = createBrowserFakeMailClient();
    const calls: string[] = [];
    const client: MailClient = {
      ...fake,
      saveDraft: async (command) => {
        calls.push(`save:${command.content.bodyText}`);
        return fake.saveDraft(command);
      },
      switchMode: async (mode) => {
        calls.push(`switch:${mode}`);
        return { chosen: true, mode };
      },
    };
    const w = await mountDraftsApp(fake, client);
    await openDraftsList(w);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('kept across the switch');

    await openUtilityDrawer(w, 'account');
    await advanceUiUntil(() => w.find('[data-test="account-switch-mode-button"]').exists());
    const button = w.get('[data-test="account-switch-mode-button"]');
    expect(button.text()).toBe('Use your own mail');
    await button.trigger('click');
    await flushPromises();

    const switchAt = calls.indexOf('switch:gmail');
    expect(switchAt).toBeGreaterThan(-1);
    expect(calls.slice(0, switchAt)).toContain('save:kept across the switch');
    expect(state.reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(CONNECT_AFTER_SWITCH_KEY)).toBe('true');
    w.unmount();
  });

  it('does not switch while the draft cannot be saved', async () => {
    const fake = createBrowserFakeMailClient();
    const switchMode = vi.fn(async (mode: 'fixture' | 'gmail') => ({ chosen: true, mode }));
    const client: MailClient = {
      ...fake,
      saveDraft: () => Promise.reject({ kind: 'storage_unavailable' }),
      switchMode,
    };
    const w = await mountDraftsApp(fake, client);
    await openDraftsList(w);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('not lost');

    // Leaving the editor goes through the same protected save; a failed save
    // keeps the editor, so the switch cannot be reached, let alone sent.
    await openUtilityDrawer(w, 'account');
    await flushPromises();
    const button = w.find('[data-test="account-switch-mode-button"]');
    if (button.exists()) {
      await button.trigger('click');
      await flushPromises();
    }

    expect(switchMode).not.toHaveBeenCalled();
    expect(state.reload).not.toHaveBeenCalled();
    expect(w.find('[data-test="draft-body"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('not lost');
    if (w.find('[data-test="account-panel"]').exists()) await closeUtilityDrawer(w);
    w.unmount();
  });
});
