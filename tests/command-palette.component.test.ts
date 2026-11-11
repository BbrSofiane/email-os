import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { compactShortcut, matchesQuery } from '../src/lib/action-palette';
import { createDiscoveryFixture } from './discovery.fixture';
import { createBrowserFakeMailClient, mountApp, press, useGmailMode } from './helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });
async function openPalette(query = '') {
  const fixture = createDiscoveryFixture();
  await fixture.seedDone();
  wrapper = mountApp(fixture.client, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  await wrapper.get('[data-test="palette-trigger"]').trigger('click');
  await flushPromises();
  if (query) await wrapper.get('[data-test="action-query"]').setValue(query);
  return { fixture, w: wrapper };
}
const ids = (w: VueWrapper) => w.findAll('[role="option"]').map((option) => option.attributes('id'));

describe('command palette structure', () => {
  it('groups commands under quiet labels with a glyph per item and no placeholder characters', async () => {
    const { w } = await openPalette();
    const labels = w.findAll('.action-group').map((node) => node.text());
    expect(labels).toEqual(expect.arrayContaining(['Conversation', 'Go to', 'Keys']));
    expect(labels.indexOf('Conversation')).toBeLessThan(labels.indexOf('Go to'));
    for (const option of w.findAll('[role="option"]')) expect(option.find('svg').exists()).toBe(true);
    expect(w.get('.command-overlay').text()).not.toMatch(/[ϟ↗]/);
    expect(w.find('.action-heading').exists()).toBe(false);
    expect(w.get('[data-test="action-query"]').attributes('aria-label')).toBe('Command');
  });

  it('lists bound keys without making them options', async () => {
    const { w } = await openPalette();
    const keys = w.get('.action-keys');
    expect(keys.findAll('kbd').map((kbd) => kbd.text())).toEqual(expect.arrayContaining(['J', 'K', 'X', 'Shift+J', 'Shift+K']));
    expect(keys.find('[role="option"]').exists()).toBe(false);
    await w.get('[data-test="action-query"]').setValue('range');
    expect(w.get('.action-keys').text()).toContain('Extend selection');
    expect(w.find('[role="option"]').exists()).toBe(false);
  });

  it('shows the compact bound key for each command, with chord timing in the tooltip', async () => {
    const { w } = await openPalette();
    expect(w.get('#action-done kbd').text()).toBe('G then E');
    expect(w.get('#action-done kbd').attributes('title')).toBeUndefined();
    expect(w.get('#action-archive kbd').text()).toBe('E');
    expect(w.get('#action-unread kbd').text()).toBe('Shift+U');
  });

  async function palette(gmail: boolean, archiveFirst: boolean) {
    const fake = createBrowserFakeMailClient(); if (gmail) useGmailMode(fake);
    wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushPromises();
    if (archiveFirst) {
      (wrapper.get('[data-test="conversation-row-conv-01"]').element as HTMLElement).focus();
      press('e', { bubbles: true, cancelable: true }, document.activeElement!);
      await flushPromises();
    }
    await wrapper.get('[data-test="palette-trigger"]').trigger('click');
    await flushPromises();
    return wrapper;
  }
  async function expectFinds(w: VueWrapper, pairs: Array<[string, string]>) {
    for (const [query, id] of pairs) {
      await w.get('[data-test="action-query"]').setValue(query);
      expect(ids(w), query).toContain(id);
    }
  }

  it('finds Undo by "undo", a synonym and its key once there is something to undo', async () => {
    const w = await palette(false, true);
    await expectFinds(w, [['undo', 'action-undo'], ['revert', 'action-undo'], ['z', 'action-undo'], ['finish', 'action-archive']]);
    await w.get('[data-test="action-query"]').setValue('archive');
    expect(ids(w)[0]).toBe('action-archive');
  });

  it('finds commands by alias', async () => {
    const w = await palette(true, false);
    await expectFinds(w, [['favorite', 'action-star'], ['bin', 'action-trash'], ['older', 'action-search'], ['history', 'action-activity']]);
  });

  it('says what did not match instead of claiming no commands exist', async () => {
    const { w } = await openPalette('qqqq');
    expect(w.get('.command-overlay [role="status"]').text()).toBe('No command matches “qqqq”.');
  });

  it('keeps the navigator a single unlabelled list without key hints', async () => {
    const fixture = createDiscoveryFixture();
    wrapper = mountApp(fixture.client, 'browser-preview', { attachTo: document.body });
    await flushPromises();
    press('ArrowLeft', { bubbles: true }, document.body);
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.find('.action-group').exists()).toBe(false);
    expect(wrapper.find('.action-keys').exists()).toBe(false);
    await wrapper.get('[data-test="action-query"]').setValue('qqqq');
    expect(wrapper.get('.command-overlay [role="status"]').text()).toBe('No destination matches “qqqq”.');
  });
});

describe('palette matching', () => {
  it('matches aliases, every word, and the exact bound key', () => {
    expect(matchesQuery('undo', 'Undo last action', ['revert'], ['Z'])).toBe(true);
    expect(matchesQuery('revert', 'Undo last action', ['revert'], ['Z'])).toBe(true);
    expect(matchesQuery('z', 'Undo last action', [], ['Z'])).toBe(true);
    expect(matchesQuery('go done', 'Go to cached Done', [], [''])).toBe(true);
    expect(matchesQuery('go inbox', 'Go to cached Done', [], [''])).toBe(false);
    expect(matchesQuery('shift+e', 'Mark Not Done', [], ['Shift+E'])).toBe(true);
    expect(matchesQuery('e/s/h', 'Mark Done', ['done'], ['E'])).toBe(false);
  });
  it('drops only the trailing timing note from chords', () => {
    expect(compactShortcut('G then H (within 1 second)')).toBe('G then H');
    expect(compactShortcut('Shift+U')).toBe('Shift+U');
  });
});
