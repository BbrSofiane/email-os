import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAndroidBackBridge } from './android-back';
afterEach(() => { delete (window as any).__emailOsAndroidBack; });
describe('Android Back bridge',()=>{
 it('is inert outside Android',()=>{const stop=installAndroidBackBridge(false,()=>true);expect((window as any).__emailOsAndroidBack).toBeUndefined();stop();});
 it('delegates to the Escape ladder and removes only its own handler',()=>{const handle=vi.fn(()=>true);const stop=installAndroidBackBridge(true,handle);expect((window as any).__emailOsAndroidBack()).toBe(true);expect(handle).toHaveBeenCalledOnce();stop();expect((window as any).__emailOsAndroidBack).toBeUndefined();});
});
