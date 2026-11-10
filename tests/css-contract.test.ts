// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { declarationListOf, declarationsOf, ruleIndexOf, rulesOf } from './css-contract';

describe('CSS source contract helpers', () => {
  it('keeps declarations inside conditional at-rules out of unconditional source contracts', () => {
    const source = `
      @import "theme.css";
      .card { color: black; }
      @media (max-width: 600px) {
        .card { color: red; }
      }
      @supports (display: grid) {
        .card { display: grid; }
      }
      .card { border: 0; }
    `;

    expect(declarationsOf(source, '.card')).toEqual({ color: 'black', border: '0' });
    expect(declarationListOf(source, '.card')).toEqual([['color', 'black'], ['border', '0']]);
    expect(ruleIndexOf(source, '.card')).toBe(0);
    expect(rulesOf(source)).toHaveLength(2);
  });
});
