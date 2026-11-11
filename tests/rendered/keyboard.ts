import type { CdpSession } from './chromium';

export type RenderedKeyOptions = { shift?: boolean; ctrl?: boolean };
type Profile = 'reader' | 'discovery';

/** Dispatch the existing CDP payload used by the rendered reader/discovery journeys. */
export async function pressRenderedKey(cdp: CdpSession, key: string, options: RenderedKeyOptions = {}, profile: Profile = 'reader'): Promise<void> {
  const effectiveKey = profile === 'reader'
    ? (options.shift ? key.toUpperCase() : key)
    : (options.shift && key.length === 1 ? key.toUpperCase() : key);
  const keyCode: Record<string, number> = {
    n: 78, p: 80, o: 79, j: 74, k: 75, u: 85, Escape: 27, Enter: 13,
    ArrowDown: 40, ArrowUp: 38,
  };
  const code: Record<string, string> = {
    n: 'KeyN', p: 'KeyP', o: 'KeyO', j: 'KeyJ', k: 'KeyK', u: 'KeyU',
    ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp',
  };
  if (profile === 'discovery') {
    keyCode.Tab = 9;
    keyCode.ArrowLeft = 37;
    code.Tab = 'Tab';
    code.ArrowLeft = 'ArrowLeft';
  }
  const base: Record<string, unknown> = { key: effectiveKey };
  if (options.shift) base.modifiers = 8;
  const keyPayload = {
    key: effectiveKey,
    ...(code[key] ? { code: code[key] } : {}),
    ...(keyCode[key] ? { windowsVirtualKeyCode: keyCode[key], nativeVirtualKeyCode: keyCode[key] } : {}),
    ...(key.length === 1 ? { text: options.shift ? key.toUpperCase() : key } : key === 'Enter' ? { text: '\r' } : {}),
    ...base,
  };
  // The profiles retain their original shifted special-key and mapping behavior.
  await cdp.cmd('Input.dispatchKeyEvent', { type: 'keyDown', ...keyPayload });
  await cdp.cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...keyPayload });
}

export async function pressRenderedTab(cdp: CdpSession, shift: boolean, tick: () => Promise<void>): Promise<void> {
  if (shift) await cdp.cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
  const modifiers = shift ? 8 : 0;
  await cdp.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers });
  await cdp.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers });
  if (shift) await cdp.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
  await tick();
}

export async function pressRenderedEnter(cdp: CdpSession, tick: () => Promise<void>): Promise<void> {
  await cdp.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await cdp.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await tick();
}
