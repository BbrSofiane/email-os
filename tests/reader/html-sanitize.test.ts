// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeMailHtml } from '../../src/lib/html-mail/sanitize';

describe('mail HTML sanitisation', () => {
  it('removes active content and rewrites links', () => {
    const result = sanitizeMailHtml('<p onclick="alert(1)">Hi <a href="https://example.test/">link</a><script>alert(1)</script></p>', { remoteImages: false });
    expect(result.body).not.toContain('<script');
    expect(result.body).not.toContain('onclick');
    expect(result.body).toContain('data-eos-href="https://example.test/"');
  });
});

import { fixture, hostileCorpus } from './html-corpus';
import type { SanitizedMail } from '../../src/lib/html-mail/sanitize';

function assertInert(result: SanitizedMail, remoteImages: boolean): void {
  expect(result.body).not.toMatch(/<\/?(?:script|iframe|frame|object|embed|form|input|button|base|meta|link|svg|math|noscript|template)\b/i);
  expect(result.styles).not.toContain('<');
  const doc = new DOMParser().parseFromString(result.body, 'text/html');
  for (const element of doc.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      expect(attribute.name).not.toMatch(/^on/i);
      expect(attribute.name).not.toMatch(/^(href|srcset|ping|formaction|action|target)$/i);
      expect(attribute.value).not.toMatch(/(?:javascript|vbscript):/i);
      if (attribute.name === 'src') {
        expect(attribute.value).toMatch(remoteImages ? /^(?:data:image\/(?:png|jpeg|gif|webp);base64,|https:\/\/)/i : /^data:image\/(?:png|jpeg|gif|webp);base64,/i);
      }
    }
  }
}

describe('hostile mail corpus', () => {
  it.each(hostileCorpus.map((input, index) => [index, input] as const))('keeps input %i inert', (_index, input) => {
    for (const remoteImages of [false, true]) {
      assertInert(sanitizeMailHtml(input, { remoteImages }), remoteImages);
    }
  });
});

describe('mail fidelity', () => {
  const sanitize = (html: string, remoteImages = false) => sanitizeMailHtml(html, { remoteImages });
  const doc = (body: string) => new DOMParser().parseFromString(body, 'text/html');
  it('rewrites absolute links and drops relative links', () => {
    const links = doc(sanitize('<a href="https://EXAMPLE.test">a</a><a href="mailto:a@example.test">b</a><a href="/relative">c</a>').body).querySelectorAll('a');
    expect(links[0]?.getAttribute('data-eos-href')).toBe('https://example.test/');
    expect(links[0]?.getAttribute('role')).toBe('link');
    expect(links[0]?.getAttribute('tabindex')).toBe('0');
    expect(links[1]?.getAttribute('data-eos-href')).toBe('mailto:a@example.test');
    expect(links[2]?.hasAttribute('data-eos-href')).toBe(false);
  });
  it('blocks remote images and permits them on request', () => {
    const html = '<img src="https://x.invalid/a.png">';
    expect(sanitize(html).remoteBlocked).toBe(1);
    expect(sanitize(html).body).toContain('data-eos-src="https://x.invalid/a.png"');
    expect(sanitize(html, true).body).toContain('src="https://x.invalid/a.png"');
    expect(sanitize(fixture('newsletter')).body).toContain('data-eos-src="https://track.newsletter.invalid/open.gif?u=fixture"');
  });
  it('keeps cid and data images and withholds backgrounds', () => {
    const cid = sanitize(fixture('cid'));
    expect(cid.cidReferences).toEqual(['logo@fixture.example']);
    expect(cid.body).toContain('data-eos-cid="logo@fixture.example"');
    expect(sanitize('<img src="data:image/png;base64,AAAA">').body).toContain('src="data:image/png;base64,AAAA"');
    expect(sanitize('<table background="https://x.invalid/bg.png"></table>').body).toContain('data-eos-background="https://x.invalid/bg.png"');
  });
  it('carries body colours and detects fixture colours', () => {
    const wrapper = doc(sanitize('<body bgcolor="red" style="color: blue">x</body>').body).querySelector('.eos-mail-body');
    expect(wrapper?.getAttribute('bgcolor')).toBe('red');
    expect(wrapper?.getAttribute('style')).toBe('color: blue');
    expect(sanitize(fixture('newsletter')).hasOwnColours).toBe(true);
    expect(sanitize(fixture('person')).hasOwnColours).toBe(false);
  });
  it('marks only trailing quotes including Outlook siblings', () => {
    const reply = sanitize(fixture('reply-chain'));
    expect(reply.hasTrailingQuote).toBe(true);
    expect(doc(reply.body).querySelector('.gmail_quote')?.getAttribute('data-eos-quote')).toBe('trailing');
    expect(sanitize('<blockquote type="cite">old</blockquote><p>new</p>').hasTrailingQuote).toBe(false);
    const outlook = sanitize('<div id="divRplyFwdMsg">old</div><p>one</p><p>two</p>');
    expect(doc(outlook.body).querySelectorAll('[data-eos-quote="trailing"]')).toHaveLength(3);
  });
  it('moves filtered style blocks out of the body', () => {
    const result = sanitize('<style>p { color: red; position: fixed }</style><p>x</p>');
    expect(result.body).not.toContain('<style');
    expect(result.styles).toBe('p { color: red }');
  });
});

describe('hostile sizes', () => {
  const timed = (html: string) => {
    const start = performance.now();
    const result = sanitizeMailHtml(html, { remoteImages: false });
    return { result, ms: performance.now() - start };
  };

  it('marks quotes in linear time', () => {
    const { result, ms } = timed(`${'<p class="gmail_quote"></p>'.repeat(5_000)}<p>end</p>`);
    expect(result.hasTrailingQuote).toBe(false);
    expect(ms).toBeLessThan(5_000);
  });

  it('collects content ids once each, in order', () => {
    const { result } = timed('<img src="cid:b"><img src="cid:a"><img src="cid:b">');
    expect(result.cidReferences).toEqual(['b', 'a']);
  });

  it('keeps quote semantics', () => {
    const trailing = (html: string) => timed(html).result.hasTrailingQuote;
    expect(trailing('<div><div class="gmail_quote">q</div></div> <br>')).toBe(true);
    expect(trailing('<div><div class="gmail_quote">q</div></div>after')).toBe(false);
    expect(trailing('<div class="gmail_quote">q</div><p><b><img src="cid:a"></b></p>')).toBe(false);
    expect(trailing('<div><div id="appendonsend"></div><p>q</p></div>')).toBe(true);
    expect(trailing('<div><div id="appendonsend"></div><p>q</p></div>after')).toBe(false);
  });
});
