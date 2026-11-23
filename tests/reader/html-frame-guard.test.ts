import { describe, expect, it } from 'vitest';
import { frameHasNativeGlobals, NATIVE_FRAME_GLOBALS } from '../../src/lib/html-mail/frame-guard';

describe('frame native globals guard', () => {
  it('accepts a clean same-origin frame', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    expect(frameHasNativeGlobals(frame)).toBe(false);
    frame.remove();
  });
  it.each(NATIVE_FRAME_GLOBALS)('rejects %s', (name) => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    Object.defineProperty(frame.contentWindow!, name, { value: undefined, configurable: true });
    expect(frameHasNativeGlobals(frame)).toBe(true);
    frame.remove();
  });
  it('rejects inaccessible and detached frames', () => {
    const frame = document.createElement('iframe');
    expect(frameHasNativeGlobals(frame)).toBe(true);
    Object.defineProperty(frame, 'contentWindow', { get() { throw new Error('denied'); } });
    expect(frameHasNativeGlobals(frame)).toBe(true);
  });
});
