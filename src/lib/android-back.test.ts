import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAndroidBackBridge } from './android-back';

interface AndroidBackWindow extends Window {
  __emailOsAndroidBack?: () => boolean;
}

afterEach(() => {
  delete (window as AndroidBackWindow).__emailOsAndroidBack;
});

describe('Android Back bridge', () => {
  it('is inert outside Android', () => {
    const stop = installAndroidBackBridge(false, () => true);

    expect((window as AndroidBackWindow).__emailOsAndroidBack).toBeUndefined();
    stop();
  });

  it('delegates to the Escape ladder and removes only its own handler', () => {
    const handle = vi.fn(() => true);
    const stop = installAndroidBackBridge(true, handle);
    const back = (window as AndroidBackWindow).__emailOsAndroidBack;

    expect(back?.()).toBe(true);
    expect(handle).toHaveBeenCalledOnce();
    stop();
    expect((window as AndroidBackWindow).__emailOsAndroidBack).toBeUndefined();
  });
});
