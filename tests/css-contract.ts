import { readFileSync } from 'node:fs';

/**
 * Small CSS contract helpers for tests that read the declared stylesheet.
 * They prove what the CSS says, not how a browser renders it.
 */

export const css = readFileSync('src/assets/style.css', 'utf8');

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Flat rules in source order (nested at-rules are skipped), with ordered declarations. */
export function rulesOf(source: string): Array<{ selectors: string[]; decls: Array<[string, string]> }> {
  const out: Array<{ selectors: string[]; decls: Array<[string, string]> }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripComments(source))) !== null) {
    const decls: Array<[string, string]> = [];
    for (const part of (match[2] ?? '').split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      decls.push([part.slice(0, colon).trim(), part.slice(colon + 1).trim()]);
    }
    out.push({ selectors: (match[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decls });
  }
  return out;
}

/** Ordered declarations of every rule whose selector list contains `selector`. */
export function declarationListOf(source: string, selector: string): Array<[string, string]> {
  return rulesOf(source).filter((rule) => rule.selectors.includes(selector)).flatMap((rule) => rule.decls);
}

/** Declarations of every rule that contains `selector` (later wins). */
export function declarationsOf(source: string, selector: string): Record<string, string> {
  return Object.fromEntries(declarationListOf(source, selector));
}

/** Source index of the first rule containing `selector`, or -1. */
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
