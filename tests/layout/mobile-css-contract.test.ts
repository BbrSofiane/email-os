import { describe, expect, it } from 'vitest';
import { allMobileCss, mobileCss, rulesOf } from '../support/css-contract';
import design from '../../DESIGN.md?raw';

describe('compact CSS contract', () => {
  it('scopes compact rules and avoids important overrides', () => {
    expect(allMobileCss).not.toContain('!important');

    for (const rule of rulesOf(allMobileCss)) {
      for (const selector of rule.selectors) {
        expect(selector).toMatch(/^\.app\[data-layout="compact"\]/);
      }
    }
  });

  it('defines every documented compact token at its documented value', () => {
    const declared = Object.values(mobileCss).join('\n');
    const tokens: Record<string, string> = {
      '--type-body': '0.9375rem',
      '--type-count': '0.8125rem',
      '--type-headline': '1.375rem',
      '--content-inset': '20px',
      '--content-inset-end': '16px',
      '--mobile-page-inset-start': '20px',
      '--mobile-page-inset-end': '16px',
      '--mobile-touch-target': '48px',
      '--mobile-top-bar-height': '56px',
      '--mobile-context-slot-height': '44px',
      '--mobile-bottom-bar-height': '50px',
      '--mobile-type-list': '0.9375rem',
      '--mobile-type-meta': '0.8125rem',
      '--mobile-type-subject': '1.375rem',
    };

    for (const [name, value] of Object.entries(tokens)) {
      expect(design).toContain(`\`${name}\``);
      expect(declared).toContain(`${name}: ${value}`);
    }

    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(declared).toContain(`--mobile-safe-${side}: env(safe-area-inset-${side}, 0px)`);
    }
  });
});
