/**
 * Focused ContactPane unit regressions (UX-02 P2-08): clipboard outcomes are
 * reset and fenced by the displayed contact identity/context and activation.
 * A delayed older success/failure must never publish under a newer contact nor
 * replace a newer activation's outcome, and each explicit activation writes at
 * most once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import ContactPane from '../src/components/ContactPane.vue';
import type { ContactInfo } from '../src/components/ContactPane.vue';

const ADA: ContactInfo = { displayName: 'Ada Fixture', mailbox: 'ada@example.test' };
const RAVI: ContactInfo = { displayName: 'Ravi Longname', mailbox: 'ravi@example.test' };

interface DeferredWrite {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

function deferredWrite(): DeferredWrite {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('ContactPane clipboard outcome fencing (P2-08)', () => {
  let wrapper: VueWrapper | null = null;
  let writes: string[] = [];

  function mountPane(contact: ContactInfo | null = ADA, context: 'focused' | 'open' = 'open'): VueWrapper {
    const w = mount(ContactPane, { props: { contact, context } });
    wrapper = w;
    return w;
  }

  function installClipboard(write: (text: string) => Promise<void>): void {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => write(text) },
    });
  }

  beforeEach(() => {
    writes = [];
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.restoreAllMocks();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('reports unavailable clipboard APIs immediately and honestly', async () => {
    expect(navigator.clipboard).toBeUndefined();
    const w = mountPane();
    await w.find('[data-test="copy-email"]').trigger('click');
    await flushPromises();
    const status = w.find('[data-test="copy-status"]');
    expect(status.exists()).toBe(true);
    expect(status.text()).toContain('unavailable');
    expect(status.text()).toContain('manually');
    expect(status.attributes('data-copy-ok')).toBe('false');
    expect(writes).toHaveLength(0);
  });

  it('publishes a delayed success under the same displayed contact', async () => {
    const gate = deferredWrite();
    installClipboard(async (text) => { writes.push(text); await gate.promise; });
    const w = mountPane();
    await w.find('[data-test="copy-email"]').trigger('click');
    expect(w.find('[data-test="copy-status"]').exists()).toBe(false); // reset by activation
    gate.resolve();
    await flushPromises();
    expect(writes).toEqual(['ada@example.test']);
    expect(w.find('[data-test="copy-status"]').attributes('data-copy-ok')).toBe('true');
    expect(w.find('[data-test="copy-status"]').text()).toContain('copied');
  });

  it('never publishes a delayed failure under a changed contact or context', async () => {
    const gate = deferredWrite();
    installClipboard(async (text) => { writes.push(text); await gate.promise; });
    const w = mountPane(ADA);
    await w.find('[data-test="copy-email"]').trigger('click');
    // The displayed contact changes while the old write is still pending.
    await w.setProps({ contact: RAVI });
    await flushPromises();
    expect(w.find('[data-test="copy-status"]').exists()).toBe(false);
    gate.reject(new Error('denied'));
    await flushPromises();
    // The old failure stays fenced: nothing shows under Ravi.
    expect(w.find('[data-test="copy-status"]').exists()).toBe(false);
    // A fresh activation under the new contact publishes normally.
    installClipboard(async (text) => { writes.push(text); });
    await w.find('[data-test="copy-email"]').trigger('click');
    await flushPromises();
    expect(writes).toEqual(['ada@example.test', 'ravi@example.test']);
    expect(w.find('[data-test="copy-status"]').attributes('data-copy-ok')).toBe('true');
  });

  it('clears the reported outcome when the displayed identity or context changes', async () => {
    installClipboard(async (text) => { writes.push(text); });
    const w = mountPane(ADA);
    await w.find('[data-test="copy-email"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="copy-status"]').exists()).toBe(true);
    await w.setProps({ contact: RAVI });
    await flushPromises();
    expect(w.find('[data-test="copy-status"]').exists()).toBe(false);
    // Context change alone also clears (same contact, different surface).
    await w.find('[data-test="copy-email"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="copy-status"]').exists()).toBe(true);
    await w.setProps({ context: 'focused' });
    await flushPromises();
    expect(w.find('[data-test="copy-status"]').exists()).toBe(false);
  });

  it('keeps a newer activation outcome when an older reversed completion settles later', async () => {
    const older = deferredWrite();
    const newer = deferredWrite();
    let mode: 'older' | 'newer' = 'older';
    installClipboard(async (text) => {
      writes.push(text);
      if (mode === 'older') await older.promise;
      else await newer.promise;
    });
    const w = mountPane(ADA);
    await w.find('[data-test="copy-email"]').trigger('click'); // older activation: will fail
    mode = 'newer';
    await w.setProps({ contact: RAVI });
    await w.find('[data-test="copy-email"]').trigger('click'); // newer activation: will succeed
    // Reversed completion: the newer success settles first.
    newer.resolve();
    await flushPromises();
    expect(w.find('[data-test="copy-status"]').attributes('data-copy-ok')).toBe('true');
    // The older failure settles afterwards and must not replace the newer result.
    older.reject(new Error('denied'));
    await flushPromises();
    expect(w.find('[data-test="copy-status"]').attributes('data-copy-ok')).toBe('true');
    expect(w.find('[data-test="copy-status"]').text()).toContain('copied');
    // Exactly one write per explicit activation; no replayed or extra writes.
    expect(writes).toEqual(['ada@example.test', 'ravi@example.test']);
  });
});
