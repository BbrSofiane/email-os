import { readFileSync } from 'node:fs';

export function fixture(name: string): string {
  return readFileSync(`crates/mail-core/src/synthetic/html/${name}.html`, 'utf8');
}

export const bypasses = [
  '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
  '<math><mi><mglyph><svg><mtext><textarea><path id="</textarea><img onerror=alert(1) src=1>">',
  '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<a href="&#x6A;avascript:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<img src="https://x.invalid/a.png" srcset="https://y.invalid/b.png 2x">',
  '<a href="https://ok.test/" target="_top">x</a>',
  '<img name="createElement"><form name="body"></form>',
  '<style>@import url(https://x.invalid/a.css)</style>',
  '<div style="background:url(https://x.invalid/b.png)">',
  '<table background="javascript:alert(1)">',
  '<body onload=alert(1)>',
  '<details open ontoggle=alert(1)>',
  '<a href="vbscript:msgbox(1)">',
  '<img src="x" onerror="alert(1)">',
  '<iframe srcdoc="<script>alert(1)</script>">',
  '<meta http-equiv="refresh" content="0;url=https://x.invalid">',
  '<base href="https://x.invalid/">',
  '<object data="https://x.invalid/x.swf">',
];

/**
 * Stylesheets that try to make the CSS filter and a browser disagree about
 * where strings, urls, comments and blocks end. Each carries a tracker URL on
 * x.invalid or `position: fixed` (ADR 0006 decision 8).
 */
export const cssBypasses = [
  ...['\n', '\r', '\f', '\r\n'].flatMap(newline => ['"', "'"].flatMap(quote => [
    `a { x: ${quote}${newline}; background: url(https://x.invalid/s.png); y: ${quote}; }`,
    `a { x: ${quote}${newline}; position: fixed; y: ${quote}; }`,
  ])),
  'a { x: "; background: url(https://x.invalid/s.png)',
  'a { x: url(a"b); background: url(https://x.invalid/s.png); y: "); }',
  "a { x: url(a'b); background: url(https://x.invalid/s.png); y: '); }",
  'a { x: url(a b); background: url(https://x.invalid/s.png) }',
  'a { x: url(a(b); background: url(https://x.invalid/s.png) }',
  'a { x: url(a/*b); background: url(https://x.invalid/s.png); y: url(c*/d) }',
  '@media (screen { a { background: url(https://x.invalid/s.png) } }',
  '@media [ { a { color: red } } b { position: fixed }',
  'a[ { color: red } b { content: "]{}"; background: url(https://x.invalid/s.png) }',
  'a { x: (; } b { position: fixed; y: ) }',
  'a { x: (]; background: url(https://x.invalid/s.png) }',
  'a { x: {; background: url(https://x.invalid/s.png) }',
  'a { color: red } } b { position: fixed }',
  '<!-- a { position: fixed } -->',
  'a { color: red } --> b { position: fixed }',
  'a { x: "\0"; position: fixed }',
  'a { background: u/**/rl(https://x.invalid/s.png) }',
  'a { background: url/**/(https://x.invalid/s.png) }',
  'a { background: URL(HTTPS://x.invalid/s.png) }',
  'a { background: url( "https://x.invalid/s.png" ) }',
  'a { background: url("ht\ttps://x.invalid/s.png") }',
  'a { background: url(//x.invalid/s.png) }',
  'a { background: src("https://x.invalid/s.png") }',
  'a { background: image("https://x.invalid/s.png") }',
  'a { background: image-set("https://x.invalid/s.png" 1x) }',
  'a { background: -webkit-image-set("https://x.invalid/s.png" 1x) }',
  'a { background: cross-fade(url(https://x.invalid/s.png), red) }',
  'a { background: -webkit-cross-fade(url(https://x.invalid/s.png), red, 50%) }',
  'a { --u: url(https://x.invalid/s.png); background: var(--u) }',
  '@import url(https://x.invalid/s.css)',
  '@import "https://x.invalid/s.css"; a { color: red }',
  '@font-face { font-family: x; src: url(https://x.invalid/s.woff) }',
  '@namespace url(https://x.invalid/);',
  'a { color: red; b { position: fixed } }',
  'a { b { background: url(https://x.invalid/s.png) } position: fixed }',
  'a { POSITION: FIXED }',
  'a { position: fi/**/xed }',
  'a { position: -webkit-sticky }',
  'a { position:\u00a0fixed; position: sticky !important }',
  'a { position: f\\69xed }',
  `${'@media screen { '.repeat(50)}a { position: fixed }${' }'.repeat(50)}`,
];

export const hostileCorpus = [
  ...fixture('hostile').split('\n').filter(line => line.startsWith('<p>')),
  fixture('hostile'),
  ...bypasses,
];
