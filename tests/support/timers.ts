import { flushPromises } from '@vue/test-utils';
import { vi } from 'vitest';

/** Freeze the UI clock and its timers; leave setImmediate available to flushPromises. */
export function useUiTestClock(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
}

/** Drain promise work and advance fake UI timers, with a bounded virtual-time budget. */
export async function advanceUiUntil(predicate: () => boolean): Promise<void> {
  for (let elapsed = 0; elapsed < 5_000; elapsed += 10) {
    await flushPromises();
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(10);
  }
  await flushPromises();
  if (!predicate()) throw new Error('UI condition not met within 5,000ms of virtual time');
}
