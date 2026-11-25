import { expect, it } from 'vitest';
import { FRAME_SIGNAL_CSS } from '../../src/lib/html-mail/frame-document';
import { NATIVE_FRAME_GLOBALS } from '../../src/lib/html-mail/frame-guard';
import { FRAME_PROBE_SOURCE } from './html-frame-probe';

it('is a standalone expression with the guard global names', () => {
  expect(() => new Function('return ' + FRAME_PROBE_SOURCE)).not.toThrow();
  const list = FRAME_PROBE_SOURCE.match(/const globals = (\[[^\]]+\])/);
  expect(list).not.toBeNull();
  expect(new Function('return ' + list![1])()).toEqual([...NATIVE_FRAME_GLOBALS]);
});

it('checks the frame signal CSS the app uses', () => {
  const css = FRAME_PROBE_SOURCE.match(/const signalCss = (".*");/);
  expect(css).not.toBeNull();
  expect(JSON.parse(css![1]!)).toBe(FRAME_SIGNAL_CSS);
});
