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

export const hostileCorpus = [
  ...fixture('hostile').split('\n').filter(line => line.startsWith('<p>')),
  fixture('hostile'),
  ...bypasses,
];
