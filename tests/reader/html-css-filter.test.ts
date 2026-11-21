import { describe, expect, it } from 'vitest';
import { filterCss, filterStyleAttribute } from '../../src/lib/html-mail/css-filter';

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
  const off = { remoteImages: false };
  const on = { remoteImages: true };
  it('removes comments before filtering URLs', () => {
    expect(filterStyleAttribute('color: red /* comment */', off).css).toBe('color: red');
    expect(filterStyleAttribute('background: u/**/rl(https://x.invalid/a.png)', off)).toEqual({ css: '', blockedRemote: 1 });
  });
  it('drops escapes and backslashes', () => {
    expect(filterStyleAttribute('background: u\\72l(https://x.invalid/a.png); color: red', off).css).toBe('color: red');
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
