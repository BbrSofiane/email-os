import { describe, expect, it } from 'vitest';
import { allMobileCss, mobileCss, mobileCssFiles, rulesOf } from '../support/css-contract';
import design from '../../DESIGN.md?raw';

describe('compact CSS contract', () => {
  it('scopes compact rules and avoids important overrides', () => {
    expect(allMobileCss).not.toContain('!important');

    for (const rule of rulesOf(allMobileCss)) {
      for (const selector of rule.selectors) {
        expect(selector).toMatch(/^(?:\.app\[data-layout="compact"\]|body:has\(\.app\[data-layout="compact"\]\))/);
      }
    }
  });

  it('allows only documented media queries and covers every mobile animation with reduced motion', () => {
    for (const name of mobileCssFiles) {
      const source = mobileCss[name]!;
      const queries = [...source.matchAll(/@media\s*([^\{]+)\{/g)].map((match) => match[1]!.trim());
      const allowed = ['(max-width: 719px)', '(prefers-reduced-motion: reduce)'];
      if (name === 'compose.css') {
        const shortCompose = '(max-height: 460px)';
        expect(design).toContain(`\`${shortCompose}\``);
        allowed.push(shortCompose);
      }
      for (const query of queries) {
        expect(allowed).toContain(query);
      }

      const hasMotion = /(?:transition|animation)\s*:\s*(?!none(?:\s|;|$))[^;]+;/i.test(source);
      if (hasMotion) expect(source).toContain('@media (prefers-reduced-motion: reduce)');
    }
  });

  it('styles compact outcome notices as wrapped pills with a touch sized Undo', () => {
    expect(mobileCss['notices.css']).toContain('.app[data-layout="compact"] .list-dock .action-notice');
    expect(mobileCss['notices.css']).toContain('width: calc(100% - 32px)');
    expect(mobileCss['notices.css']).toContain('min-height: 48px');
    expect(mobileCss['notices.css']).toContain('.action-notice-hint');
    expect(mobileCss['notices.css']).toContain('.command-error');
    expect(mobileCss['notices.css']).toContain('.reminder-confirmation');
  });

  it('styles compact draft failures above the fields with a visible retry target', () => {
    const compose = mobileCss['compose.css'];
    expect(compose).toContain('.app[data-layout="compact"] .compose-card .composer-actions [data-test="retry-draft-save"]');
    expect(compose).toContain('.app[data-layout="compact"] .reply-composer.compact-compose-sheet .composer-actions [data-test="retry-draft-save"]');
    expect(compose).toContain('font-size: var(--mobile-type-list)');
    expect(compose).toContain('color: var(--warning)');
    expect(compose).toContain('min-height: 48px');
    expect(compose).toContain('border: 1px solid var(--divider)');
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

  it('defines the compact conversation row stack and list state targets', () => {
    const list = mobileCss['list.css'];
    expect(list).toContain('.app[data-layout="compact"] .inbox-row');
    expect(list).toContain('grid-template-rows: auto auto auto');
    expect(list).toContain('min-height: 72px');
    expect(list).toContain('padding: 12px 16px 12px 20px');
    expect(list).toContain('grid-template-columns: minmax(96px, 1fr) auto');
    expect(list).toContain('white-space: nowrap');
    expect(list).toContain('-webkit-line-clamp: 2');
    expect(list).toContain('.app[data-layout="compact"] .row-read-state');
    expect(list).toContain('.app[data-layout="compact"] .row-actions');
    expect(list).toContain('.app[data-layout="compact"] .inbox-list.selecting .row-select');
    expect(list).toContain('.app[data-layout="compact"] .inbox-row.focused:not(:focus-visible)');
    expect(list).toContain('.app[data-layout="compact"] .row-group');
    expect(list).toContain('.app[data-layout="compact"] .inbox-empty');
  });

  it('stacks the compact Drafts intro and rows with touch sized actions', () => {
    const pages = mobileCss['pages.css']!;
    expect(pages).toContain('.drafts-pane .context-coverage');
    expect(pages).toContain('flex-direction: column');
    expect(pages).toContain('.drafts-pane .context-row');
    expect(pages).toContain('min-height: 64px');
    expect(pages).toContain('.drafts-pane .context-row-actions button');
    expect(pages).toContain('min-height: 48px');
  });

  it('covers compact utility pages with the shared app surface', () => {
    const pages = mobileCss['pages.css']!;
    const pushedPageRules = rulesOf(pages).filter((rule) => rule.selectors.some((selector) =>
      selector.endsWith('.utility-drawer') || selector.endsWith('.contact-disclosure-panel')));
    const pushedPageDeclarations = pushedPageRules.flatMap((rule) => rule.decls);
    const utilityDrawer = rulesOf(pages).find((rule) =>
      rule.selectors.includes('.app[data-layout="compact"] .utility-drawer'));

    expect(utilityDrawer?.decls).toContainEqual(['position', 'absolute']);
    expect(utilityDrawer?.decls).toContainEqual(['inset', '0']);
    expect(pushedPageDeclarations).not.toContainEqual(['inset', '24px 0 0']);
    expect(pushedPageDeclarations).not.toContainEqual(['padding-top', '24px']);
    expect(pages).toContain('.utility-drawer .drawer-header');
    expect(pages).toContain('min-height: var(--mobile-top-bar-height)');
  });

  it('defines compact attachment sheet and startup gate targets', () => {
    const pages = mobileCss['pages.css'];
    expect(pages).toContain('.attachment-chooser');
    expect(pages).toContain('border-radius: 16px 16px 0 0');
    expect(pages).toContain('.app[data-layout="compact"] .transition-card');
    expect(pages).toContain('.app[data-layout="compact"] .transition-primary');
    expect(pages).toContain('min-height: 48px');
  });
});
