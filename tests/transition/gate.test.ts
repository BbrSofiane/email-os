/**
 * The startup gate for the one-time legacy-fixture transition (ADR 0002 stage
 * 4): every phase, the verbatim disclosure, the failure copy, the cancel path
 * (closing the window) and that the app never mounts behind it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { effectScope } from 'vue';
import FixtureTransitionGate from '../../src/components/FixtureTransitionGate.vue';
import StartupRoot from '../../src/StartupRoot.vue';
import {
  DISCLOSURE_ACTION,
  DISCLOSURE_CANCEL_NOTE,
  DISCLOSURE_PARAGRAPHS,
  DISCLOSURE_TITLE,
  failureMessage,
  useFixtureTransition,
} from '../../src/composables/useFixtureTransition';
import type { FixtureTransitionStatus, MailClient } from '../../src/lib/ipc/client';
import { createBrowserFakeMailClient } from '../../src/lib/ipc/browser-fake';
import { deferred } from '../helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

const needs: FixtureTransitionStatus = { state: 'needs_disclosure', legacyMegabytes: 3 };

describe('useFixtureTransition', () => {
  const run = async (status: FixtureTransitionStatus) => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setFixtureTransition(status);
    const scope = effectScope();
    const gate = scope.run(() => useFixtureTransition(fake))!;
    await gate.load();
    return { fake, gate, scope };
  };

  it.each([
    [{ state: 'not_needed' }, 'clear'],
    [{ state: 'done' }, 'clear'],
    [needs, 'disclosure'],
    [{ state: 'failed', failure: { kind: 'backup_failed' } }, 'failed'],
  ] as const)('%j -> %s', async (status, phase) => {
    const { gate, scope } = await run(status as FixtureTransitionStatus);
    expect(gate.phase.value).toBe(phase);
    expect(gate.blocking.value).toBe(phase !== 'clear');
    scope.stop();
  });

  it('accept goes through working to clear, and is idempotent for a double click', async () => {
    const { fake, gate, scope } = await run(needs);
    const first = gate.accept();
    const second = gate.accept(); // a second click while the first runs
    expect(gate.phase.value).toBe('working');
    await Promise.all([first, second]);
    expect(gate.phase.value).toBe('clear');
    expect(fake.controls.fixtureTransitionAccepts()).toBe(1);
    scope.stop();
  });

  it('a failed attempt shows the failure and can be retried to completion', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setFixtureTransition(needs, { state: 'failed', failure: { kind: 'insufficient_disk', requiredMegabytes: 20, availableMegabytes: 4 } });
    const scope = effectScope();
    const gate = scope.run(() => useFixtureTransition(fake))!;
    await gate.load();
    await gate.accept();
    expect(gate.phase.value).toBe('failed');
    expect(failureMessage(gate.status.value!)).toContain('about 20 MB');
    // Space was freed: the same gate retries.
    fake.controls.setFixtureTransition({ state: 'failed', failure: { kind: 'insufficient_disk', requiredMegabytes: 20, availableMegabytes: 4 } }, { state: 'done' });
    await gate.accept();
    expect(gate.phase.value).toBe('clear');
    scope.stop();
  });

  it('is unavailable when the status cannot be read, and recovers on the next read', async () => {
    const fake = createBrowserFakeMailClient();
    let failing = true;
    const client = { ...fake, getFixtureTransitionStatus: async () => { if (failing) throw { kind: 'storage_unavailable' }; return { state: 'not_needed' } as const; } } as MailClient;
    const scope = effectScope();
    const gate = scope.run(() => useFixtureTransition(client))!;
    await gate.load();
    expect(gate.phase.value).toBe('unavailable');
    failing = false;
    await gate.load();
    expect(gate.phase.value).toBe('clear');
    scope.stop();
  });

  it('an accept that rejects re-reads the (crash safe) backend state instead of guessing', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setFixtureTransition(needs);
    const client = { ...fake, acceptFixtureTransition: async () => { throw { kind: 'storage_unavailable' }; } } as MailClient;
    const scope = effectScope();
    const gate = scope.run(() => useFixtureTransition(client))!;
    await gate.load();
    await gate.accept();
    expect(gate.phase.value).toBe('disclosure'); // the backend still says: not done, ask again
    scope.stop();
  });
});

describe('failure copy says what happened and that nothing was lost', () => {
  it.each([
    [{ kind: 'insufficient_disk', requiredMegabytes: 20, availableMegabytes: 4 }, 'Free up about 20 MB (4 MB is available)'],
    [{ kind: 'backup_failed' }, 'nothing was changed and your existing demo mailbox is intact'],
    [{ kind: 'reset_failed' }, 'The backup is safe'],
  ] as const)('%j', (failure, fragment) => {
    expect(failureMessage({ state: 'failed', failure })).toContain(fragment);
  });
});

describe('FixtureTransitionGate', () => {
  it('shows the disclosure verbatim with the size, focuses its heading and offers one action', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setFixtureTransition(needs);
    wrapper = mount(FixtureTransitionGate, { props: { client: fake }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('h1').text()).toBe(DISCLOSURE_TITLE);
    expect(wrapper.get('[data-test="transition-disclosure"]').text()).toContain('about 3 MB');
    for (const paragraph of DISCLOSURE_PARAGRAPHS(3)) expect(wrapper.text()).toContain(paragraph);
    expect(wrapper.get('[data-test="transition-accept"]').text()).toBe(DISCLOSURE_ACTION);
    expect(wrapper.get('[data-test="transition-cancel-note"]').text()).toBe(DISCLOSURE_CANCEL_NOTE);
    expect(document.activeElement).toBe(wrapper.get('h1').element);
    expect(wrapper.findAll('button')).toHaveLength(1);
  });

  it('emits cleared immediately when nothing needs disclosing', async () => {
    const fake = createBrowserFakeMailClient();
    wrapper = mount(FixtureTransitionGate, { props: { client: fake } });
    await flushPromises();
    expect(wrapper.emitted('cleared')).toHaveLength(1);
  });

  it('accept shows a working state, then clears', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setFixtureTransition(needs);
    const gate = deferred<FixtureTransitionStatus>();
    const client = { ...fake, acceptFixtureTransition: () => gate.promise } as MailClient;
    wrapper = mount(FixtureTransitionGate, { props: { client }, attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-test="transition-accept"]').trigger('click');
    expect(wrapper.find('[data-test="transition-working"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="transition-accept"]').exists()).toBe(false);
    gate.resolve({ state: 'done' });
    await flushPromises();
    expect(wrapper.emitted('cleared')).toHaveLength(1);
  });

  it('shows an insufficient-disk failure with the numbers and lets the user try again', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setFixtureTransition(needs, { state: 'failed', failure: { kind: 'insufficient_disk', requiredMegabytes: 25, availableMegabytes: 2 } });
    wrapper = mount(FixtureTransitionGate, { props: { client: fake }, attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-test="transition-accept"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="transition-failure"]').text()).toContain('25 MB');
    expect(wrapper.emitted('cleared')).toBeUndefined();
    fake.controls.setFixtureTransition({ state: 'failed', failure: { kind: 'insufficient_disk', requiredMegabytes: 25, availableMegabytes: 2 } }, { state: 'done' });
    await wrapper.get('[data-test="transition-retry"]').trigger('click');
    await flushPromises();
    expect(wrapper.emitted('cleared')).toHaveLength(1);
  });

  it('closing the window is the cancel path: allowed while asking, refused while the backup runs', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setFixtureTransition(needs);
    const gate = deferred<FixtureTransitionStatus>();
    const completeClose = vi.spyOn(fake, 'completeAppClose');
    const cancelClose = vi.spyOn(fake, 'cancelAppClose');
    const client = { ...fake, acceptFixtureTransition: () => gate.promise, completeAppClose: fake.completeAppClose, cancelAppClose: fake.cancelAppClose, subscribeAppClose: fake.subscribeAppClose } as MailClient;
    wrapper = mount(FixtureTransitionGate, { props: { client }, attachTo: document.body });
    await flushPromises();
    // Asking: close completes, nothing was changed.
    const first = fake.controls.requestAppClose();
    await flushPromises();
    expect(completeClose).toHaveBeenCalledWith(first.requestId);
    // Working: the window stays open.
    await wrapper.get('[data-test="transition-accept"]').trigger('click');
    const second = fake.controls.requestAppClose();
    await flushPromises();
    expect(cancelClose).toHaveBeenCalledWith(second.requestId);
    gate.resolve({ state: 'done' });
    await flushPromises();
  });

  it('reports a storage problem instead of starting', async () => {
    const fake = createBrowserFakeMailClient();
    const client = { ...fake, getFixtureTransitionStatus: async () => { throw { kind: 'storage_unavailable' }; } } as MailClient;
    wrapper = mount(FixtureTransitionGate, { props: { client } });
    await flushPromises();
    expect(wrapper.find('[data-test="transition-unavailable"]').exists()).toBe(true);
    expect(wrapper.emitted('cleared')).toBeUndefined();
  });
});

describe('StartupRoot', () => {
  it('never mounts the app behind the gate, and mounts it once cleared', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setFixtureTransition(needs);
    wrapper = mount(StartupRoot, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.find('[data-test="fixture-transition-gate"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="rail-well"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="conversation-row-conv-01"]').exists()).toBe(false);
    await wrapper.get('[data-test="transition-accept"]').trigger('click');
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushPromises();
    expect(wrapper.find('[data-test="fixture-transition-gate"]').exists()).toBe(false);
  });

  it('goes straight to the app when nothing needs disclosing (Gmail mode, fresh profile)', async () => {
    const fake = createBrowserFakeMailClient();
    wrapper = mount(StartupRoot, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.find('[data-test="fixture-transition-gate"]').exists()).toBe(false);
  });
});
