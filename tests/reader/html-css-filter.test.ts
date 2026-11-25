import { describe, expect, it } from 'vitest';
import { filterCss, filterStyleAttribute } from '../../src/lib/html-mail/css-filter';
import { tokenizeCss } from '../../src/lib/html-mail/css-tokenizer';
import { cssBypasses } from './html-corpus';

describe('mail CSS filtering', () => {
  it('filters remote images and dangerous declarations', () => {
    const result = filterStyleAttribute('color: red; background: url(https://x.invalid/a); position: fixed', { remoteImages: false });
    expect(result.css).toBe('color: red');
    expect(result.blockedRemote).toBe(1);
  });
  it('retains nested media rules and removes imports', () => {
    const result = filterCss('@import url(https://x.invalid); @media screen { p { color: red } }', { remoteImages: false });
    expect(result.css).toContain('@media');
    expect(result.css).not.toContain('@import');
  });
});

describe('CSS filter rules', () => {
  it('drops cascade layers, so mail cannot outrank the frame signal rules', () => {
    const result = filterCss('@layer eos-signal { eos-signal { width: 5px !important; } } @layer x; p { color: red; }', { remoteImages: false });
    expect(result.css).not.toMatch(/@layer|eos-signal|5px/);
    expect(result.css).toContain('color');
  });
  const off = { remoteImages: false };
  const on = { remoteImages: true };
  it('removes comments before filtering URLs', () => {
    expect(filterStyleAttribute('color: red /* comment */', off).css).toBe('color: red');
    expect(filterStyleAttribute('background: u/**/rl(https://x.invalid/a.png)', off).css).toBe('');
    expect(filterStyleAttribute('border: 1px/**/solid', off).css).toBe('border: 1px solid');
  });
  it('drops escapes and backslashes', () => {
    expect(filterStyleAttribute('background: u\\72l(https://x.invalid/a.png); color: red', off).css).toBe('');
    expect(filterCss('p { color: r\\ed }', off).css).toBe('');
  });
  it('drops unsupported at-rules', () => {
    for (const input of ['@import url(https://x.invalid/i.css);', '@font-face { font-family: x }', '@keyframes x { from { color: red } }', '@namespace url(https://x.invalid);', '@charset "utf-8";']) {
      expect(filterCss(input, off).css).toBe('');
    }
  });
  it('filters nested media and supports rules', () => {
    const css = '@media (max-width: 600px) { .a { color: red } .b { background: url(https://x.invalid/b.png) } }';
    expect(filterCss(css, off)).toEqual({ css: '@media (max-width: 600px) {\n.a { color: red }\n}', blockedRemote: 1 });
    expect(filterCss(css, on).css).toContain('.b { background: url(https://x.invalid/b.png) }');
    expect(filterCss('@supports (display: grid) { .a { color: red; position: fixed } }', off).css).toBe('@supports (display: grid) {\n.a { color: red }\n}');
  });
  it.each(['expression(alert(1))', 'javascript:alert(1)', 'vbscript:x', '-moz-binding', 'behavior', 'image-set(url(x))'])('drops dangerous value %s', value => {
    expect(filterStyleAttribute(`color: ${value}`, off).css).toBe('');
  });
  it('drops fixed and sticky positions', () => {
    expect(filterStyleAttribute('position: fixed; position: sticky; position: relative', off).css).toBe('position: relative');
  });
  it.each([
    ['data:image/png;base64,AAAA', true], ['data:image/svg+xml,abc', false],
    ['cid:a@b', true], ['http://x', false], ['a.png', false],
  ])('filters URL %s', (url, allowed) => {
    expect(Boolean(filterStyleAttribute(`background: url(${url})`, off).css)).toBe(allowed);
  });
  it('respects quoted delimiters', () => {
    expect(filterCss('p { content: "}; url("; color: red }', off).css).toBe('p { content: "}; url("; color: red }');
  });
  it('drops less-than in declarations and selectors', () => {
    expect(filterStyleAttribute('content: "</style><img src=x onerror=alert(1)>"', off).css).toBe('');
    expect(filterCss('p<x { color: red }', off).css).toBe('');
  });
  it.each(['p { color: red', 'p { content: "x }', 'p { color: red /*'])('does not inject malformed rules: %s', css => {
    expect(filterCss(css, off).css).toBe('');
  });
  it('keeps child combinators', () => {
    expect(filterCss('td > table { color: red }', off).css).toBe('td > table { color: red }');
  });
});

describe('CSS filter against the browser tokenizer', () => {
  const off = { remoteImages: false };
  const body = (css: string) => css.slice(css.indexOf('{') + 1, css.lastIndexOf('}'));

  it.each(cssBypasses.map(css => [css]))('lets nothing through: %j', css => {
    for (const result of [filterCss(css, off), filterStyleAttribute(css, off), filterStyleAttribute(body(css), off)]) {
      expect(result.css).not.toMatch(/invalid|fixed|sticky|@import|@font-face|\\|<|[\r\f\n"']\s*;/i);
      expect(tokenizeCss(result.css)).not.toBeNull();
    }
  });

  it.each(cssBypasses.map(css => [css]))('gives stable output: %j', css => {
    for (const options of [off, { remoteImages: true }]) {
      const sheet = filterCss(css, options).css;
      expect(filterCss(sheet, options).css).toBe(sheet);
      const style = filterStyleAttribute(body(css), options).css;
      expect(filterStyleAttribute(style, options).css).toBe(style);
    }
  });

  it('keeps ordinary mail styles', () => {
    const css = `<!--
      /* Font definitions */
      @font-face { font-family: Calibri; }
      p.MsoNormal, li.MsoNormal { margin: 0cm; font: 11.0pt/1.4 "Calibri", sans-serif; color: #1F3A5F }
      a:link { color: rgb(5 99 193 / 80%); background: linear-gradient(90deg, #fff 0%, #eee 100%) }
      td:not(.x)[align="left"] > b { width: calc(100% - 2px) !important; position: relative !important }
    -->`;
    expect(filterCss(css, off).css.split('\n')).toEqual([
      'p.MsoNormal, li.MsoNormal { margin: 0cm; font: 11.0pt/1.4 "Calibri", sans-serif; color: #1F3A5F }',
      'a:link { color: rgb(5 99 193 / 80%); background: linear-gradient(90deg, #fff 0%, #eee 100%) }',
      'td:not(.x)[align="left"] > b { width: calc(100% - 2px) !important; position: relative !important }',
    ]);
  });

  it('tokenizes numbers, names and urls as a browser does', () => {
    const kinds = (css: string) => tokenizeCss(css)?.map(token => `${token.kind} ${token.text}`);
    expect(kinds('-.5em')).toEqual(['number -.5em']);
    expect(kinds('--x')).toEqual(['ident --x']);
    expect(kinds('5url(')).toBeUndefined();
    expect(kinds('#12-->')).toEqual(['hash #12--', 'delim >']);
    expect(kinds('url( a )')).toEqual(['url url( a )']);
    expect(kinds('a\u00a0b')).toEqual(['ident a\u00a0b']);
    expect(kinds('@-5')).toEqual(['delim @', 'number -5']);
  });

  it.each([
    ['a long value', `a { color: ${'"x" '.repeat(125_000)} }`],
    ['many urls', `a { background: ${'url(""),'.repeat(62_500)} red }`],
    ['many allowed urls', `a { background: ${'url("cid:a"),'.repeat(40_000)} red }`],
    ['many rules', 'a{b:c}'.repeat(85_000)],
    ['many at-rules', '@media{'.repeat(70_000)],
    ['deep brackets', `a { b: ${'('.repeat(250_000)}${')'.repeat(250_000)} }`],
    ['many comments', `a { b: ${'/**/'.repeat(125_000)} c }`],
    ['unclosed comments', '/*'.repeat(250_000)],
    ['many quotes', `a { b: ${'"'.repeat(500_001)} }`],
    ['one long name', 'a'.repeat(500_000)],
    ['one long number', `a { b: ${'1'.repeat(500_000)} }`],
  ])('filters %s in linear time', (_name, css) => {
    const start = performance.now();
    filterCss(css, off);
    filterStyleAttribute(css, off);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
