import { describe, expect, it } from 'vitest';
import { allMobileCss, mobileCss, rulesOf } from '../support/css-contract';
import design from '../../DESIGN.md?raw';

describe('compact CSS contract', () => {
  it('scopes compact rules and avoids important overrides', () => {
    expect(allMobileCss).not.toContain('!important');
    for (const rule of rulesOf(allMobileCss)) {
      for (const selector of rule.selectors) expect(selector).toMatch(/^\.app\[data-layout="compact"\]/);
    }
  });
  it('defines every documented compact token at its documented value', () => {
    const declared = Object.values(mobileCss).join('\n');
    const tokens: Record<string, string> = {
      '--mobile-page-inset-start': '20px', '--mobile-page-inset-end': '16px', '--mobile-touch-target': '48px',
      '--mobile-top-bar-height': '56px', '--mobile-context-slot-height': '56px', '--mobile-bottom-bar-height': '66px',
      '--mobile-type-list': '16px', '--mobile-type-meta': '14px', '--mobile-type-subject': '22px',
    };
    for (const [name, value] of Object.entries(tokens)) {
      expect(design).toContain(`\`${name}\``);
      expect(declared).toContain(`${name}: ${value}`);
    }
    for (const side of ['top', 'right', 'bottom', 'left']) expect(declared).toContain(`--mobile-safe-${side}: env(safe-area-inset-${side}, 0px)`);
  });
});
