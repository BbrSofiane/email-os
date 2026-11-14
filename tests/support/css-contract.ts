import { readFileSync } from 'node:fs';

/**
 * Small CSS contract helpers for tests that read the declared stylesheet.
 * They prove what the CSS says, not how a browser renders it.
 */

export const css = readFileSync('src/assets/style.css', 'utf8');

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Top-level style rules only, in source order. Rules inside at-rules are excluded. */
export function rulesOf(source: string): Array<{ selectors: string[]; decls: Array<[string, string]> }> {
  const out: Array<{ selectors: string[]; decls: Array<[string, string]> }> = [];
  const clean = stripComments(source);
  let depth = 0;
  let blockStart = 0;
  let bodyStart = 0;
  let prelude = '';
  let nestedAtRule = false;
  for (let i = 0; i < clean.length; i += 1) {
    if (clean[i] === '{') {
      if (depth === 0) {
        prelude = clean.slice(blockStart, i).trim();
        nestedAtRule = prelude.startsWith('@');
        bodyStart = i + 1;
      }
      depth += 1;
    } else if (clean[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = clean.slice(bodyStart, i);
        if (prelude && !nestedAtRule) {
          const decls: Array<[string, string]> = [];
          for (const part of body.split(';')) {
            const colon = part.indexOf(':');
            if (colon < 0) continue;
            decls.push([part.slice(0, colon).trim(), part.slice(colon + 1).trim()]);
          }
          out.push({ selectors: prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decls });
        }
        blockStart = i + 1;
      }
    } else if (clean[i] === ';' && depth === 0) {
      // Ignore statement at-rules such as @import before the next style rule.
      blockStart = i + 1;
    }
  }
  return out;
}

/** Ordered declarations from top-level rules whose selector list contains `selector`. */
export function declarationListOf(source: string, selector: string): Array<[string, string]> {
  return rulesOf(source).filter((rule) => rule.selectors.includes(selector)).flatMap((rule) => rule.decls);
}

/** Top-level source declarations for `selector` (later wins; no cascade evaluation). */
export function declarationsOf(source: string, selector: string): Record<string, string> {
  return Object.fromEntries(declarationListOf(source, selector));
}

/** Index of the first top-level rule containing `selector`, or -1. */
export function ruleIndexOf(source: string, selector: string): number {
  return rulesOf(source).findIndex((rule) => rule.selectors.includes(selector));
}

export function rootToken(name: string): string {
  const value = declarationsOf(css, ':root')[name];
  if (value === undefined) throw new Error(`missing :root token ${name}`);
  return value;
}

/** Replaces every var(--token) with its :root value, recursively. */
export function resolveVars(value: string): string {
  let current = value;
  for (let i = 0; i < 8 && /var\(--[\w-]+\)/.test(current); i += 1) {
    current = current.replace(/var\((--[\w-]+)\)/g, (_all, name: string) => rootToken(name));
  }
  return current;
}

/** WCAG 2.x relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Resolves a `var(--token)` (or a literal hex) to a hex colour. */
export function colourOf(value: string | undefined): string {
  if (value === undefined) throw new Error('missing colour');
  return resolveVars(value).toLowerCase();
}
