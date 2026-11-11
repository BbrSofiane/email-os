import { flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import { flushFakeClientAndVueUpdates, flushMacrotasks } from '../helpers';
import type { BrowserFake } from '../../src/lib/ipc/browser-fake';

export { flushFakeClientAndVueUpdates } from '../helpers';

/** Drain a Vue update and the browser timers controlled by fake timers at t=0. */
export async function flushFakeTimersZeroTick(advanceTimersByTimeAsync: () => Promise<unknown>): Promise<void> {
  await flushPromises();
  await advanceTimersByTimeAsync();
  await flushPromises();
}

/** Keep a fake client's queued work and Vue's resulting renders in order. */
export async function flushFakeClientWithMacrotasks(fake: BrowserFake, times = 2): Promise<void> {
  await flushFakeClientAndVueUpdates(fake);
  await flushMacrotasks(times);
  await flushPromises();
}

/** Drain promise/Vue work, a known number of macrotasks, then their updates. */
export async function flushVueMacrotasks(times = 2): Promise<void> {
  await flushPromises();
  await flushMacrotasks(times);
  await flushPromises();
}

/** Reader component updates that need an explicit Vue tick between promises. */
export async function flushVueNextTick(): Promise<void> {
  await flushPromises();
  await nextTick();
  await flushPromises();
}
