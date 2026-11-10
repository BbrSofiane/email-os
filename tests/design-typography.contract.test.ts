// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { css, declarationsOf, rootToken } from './css-contract';

/**
 * DESIGN.md documents the reading size; style.css :root is what ships. These
 * checks keep the two equal. They read the declared values, not a render.
 */

const design = readFileSync('DESIGN.md', 'utf8');
const frontmatter = /^---\n([\s\S]*?)\n---/.exec(design)?.[1] ?? '';

/** Scalar fields of one `typography:` entry in the DESIGN.md YAML frontmatter. */
function typographyEntry(name: string): Record<string, string> {
  const lines = frontmatter.split('\n');
  const start = lines.indexOf('  ' + name + ':');
  if (start < 0) throw new Error(`DESIGN.md typography has no "${name}" entry`);
  const fields: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const field = /^ {4}(\w+): "?([^"]*)"?$/.exec(line);
    if (!field) break;
    fields[field[1]!] = field[2]!;
  }
  return fields;
}

/** The text of one Typography > Hierarchy list item, by its bold name. */
function hierarchyItem(name: string): string {
  const line = design.split('\n').find((l) => l.startsWith(`- **${name}**`));
  if (!line) throw new Error(`DESIGN.md Hierarchy has no "${name}" item`);
  return line;
}

describe('DESIGN.md reading size equals :root', () => {
  it('documents --type-reading and --leading-reading in the frontmatter', () => {
    const reading = typographyEntry('reading');
    expect(reading['fontSize']).toBe(rootToken('--type-reading'));
    expect(Number(reading['lineHeight'])).toBe(Number(rootToken('--leading-reading')));
    expect(Number(reading['fontWeight'])).toBe(Number(rootToken('--weight-regular')));
    expect(reading['fontFamily']).toBe(rootToken('--font-ui'));
  });

  it('documents the monospace fallback (--type-mono, --leading-mono) in the frontmatter', () => {
    const mono = typographyEntry('mono');
    expect(mono['fontSize']).toBe(rootToken('--type-mono'));
    expect(Number(mono['lineHeight'])).toBe(Number(rootToken('--leading-mono')));
    expect(mono['fontFamily']).toBe(rootToken('--font-mono'));
  });

  it('names the tokens and the measures in the Hierarchy, and the measures equal the CSS', () => {
    const item = hierarchyItem('Reading');
    expect(item).toContain('--type-reading');
    expect(item).toContain('--leading-reading');
    const proportional = declarationsOf(css, '.message-body')['max-width'];
    const mono = declarationsOf(css, '.message-body.message-body-mono')['max-width'];
    expect(proportional).toBe('65ch');
    expect(mono).toBe('88ch');
    expect(item).toContain(proportional!);
    expect(item).toContain(mono!);
    expect(declarationsOf(css, '.message-body')['font-size']).toBe('var(--type-reading)');
    expect(declarationsOf(css, '.message-body')['line-height']).toBe('var(--leading-reading)');
    expect(declarationsOf(css, '.message-trail')['font-size']).toBe('var(--type-reading)');
  });

  it('keeps the Two-Size Rule honest: the reading size is declared as the one exception', () => {
    const rule = design.split('\n').find((l) => l.startsWith('**The Two-Size Rule.**')) ?? '';
    expect(rule).toMatch(/reading/i);
    expect(rule).toContain('--type-reading');
  });
});
