import { expect, it } from 'vitest';
import { NATIVE_FRAME_GLOBALS } from '../../src/lib/html-mail/frame-guard';
import { FRAME_PROBE_SOURCE } from './html-frame-probe';

it('is a standalone expression with the guard global names', () => {
  expect(() => new Function('return ' + FRAME_PROBE_SOURCE)).not.toThrow();
  const list = FRAME_PROBE_SOURCE.match(/const globals = (\[[^\]]+\])/);
  expect(list).not.toBeNull();
  expect(new Function('return ' + list![1])()).toEqual([...NATIVE_FRAME_GLOBALS]);
});
