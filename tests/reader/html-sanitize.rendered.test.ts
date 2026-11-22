// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRenderedHarness, type RenderedHarness } from '../rendered/chromium';
import { cssBypasses, fixture, hostileCorpus } from './html-corpus';

const chrome = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
const enabled = process.env.EMAIL_OS_RUN_RENDERED === '1' && Boolean(chrome);

describe.skipIf(!enabled)('sanitised mail in Chrome', () => {
  let harness: RenderedHarness;
  const requests: string[] = [];

  beforeAll(async () => {
    harness = await startRenderedHarness(chrome, 'email-os-sanitize-', process.cwd());
    await harness.cdp.cmd('Network.enable');
    harness.cdp.on('Network.requestWillBeSent', params => {
      requests.push(params.request.url);
    });
    await harness.cdp.js("(async () => { window.sanitizeMailHtml = (await import('/src/lib/html-mail/sanitize.ts')).sanitizeMailHtml; Object.assign(window, await import('/src/lib/html-mail/css-filter.ts')); })()");
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('keeps the corpus inert in sandboxed frames', async () => {
    const corpus = [...hostileCorpus, ...['newsletter', 'person', 'cid', 'reply-chain', 'hostile'].map(fixture)]
      .map(input => input.replaceAll('alert(1)', 'parent.__eosPwned=1'));
    const result = await harness.cdp.js<{ pwned: boolean; title: string; originalTitle: string; locations: string[] }>(`(async () => {
      const inputs = ${JSON.stringify(corpus)};
      const originalTitle = document.title;
      const frames = [];
      for (const input of inputs) {
        const result = window.sanitizeMailHtml(input, { remoteImages: false });
        const frame = document.createElement('iframe');
        frame.sandbox = 'allow-same-origin';
        frame.srcdoc = ${JSON.stringify(`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'"><style>`)} + result.styles + '</style>' + result.body;
        await new Promise(resolve => { frame.onload = resolve; document.body.append(frame); });
        frame.contentDocument.addEventListener('click', event => event.preventDefault());
        frame.contentDocument.querySelectorAll('[data-eos-href]').forEach(link => link.click());
        frames.push(frame);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      return { pwned: window.__eosPwned !== undefined, title: document.title, originalTitle, locations: frames.map(frame => frame.contentWindow.location.href) };
    })()`);
    expect(result.pwned).toBe(false);
    expect(result.title).toBe(result.originalTitle);
    expect(result.locations.every(location => location === 'about:srcdoc')).toBe(true);
    expect(requests.filter(url => url.includes('.invalid'))).toEqual([]);
  }, 30_000);

  it('gives filtered CSS the meaning the filter checked, without any CSP', async () => {
    const before = requests.length;
    const findings = await harness.cdp.js<{ raw: number; filtered: string[] }>(`(async () => {
      const inputs = ${JSON.stringify(cssBypasses)};
      const load = async (style, attribute) => {
        const frame = document.createElement('iframe');
        frame.sandbox = 'allow-same-origin';
        frame.srcdoc = '<!doctype html><body><a>x</a><b>y</b></body>';
        await new Promise(resolve => { frame.onload = resolve; document.body.append(frame); });
        const doc = frame.contentDocument;
        const sheet = doc.createElement('style');
        sheet.textContent = style;
        doc.head.append(sheet);
        for (const element of doc.querySelectorAll('a, b')) element.setAttribute('style', attribute);
        return frame;
      };
      const problems = frame => {
        const found = [];
        const doc = frame.contentDocument;
        const checkRules = rules => {
          for (const rule of rules) {
            if (!/^CSS(Style|Media|Supports)Rule$/.test(rule.constructor.name)) found.push(rule.constructor.name);
            if (rule.style && /https?:/i.test(rule.style.cssText)) found.push(rule.style.cssText);
            if (rule.cssRules) checkRules(rule.cssRules);
          }
        };
        for (const sheet of doc.styleSheets) checkRules(sheet.cssRules);
        for (const element of doc.querySelectorAll('a, b')) {
          const style = frame.contentWindow.getComputedStyle(element);
          if (/fixed|sticky/.test(style.position)) found.push(style.position);
          if (/https?:/i.test(style.backgroundImage)) found.push(style.backgroundImage);
        }
        return found;
      };
      const off = { remoteImages: false };
      const filtered = [];
      let raw = 0;
      for (const css of inputs) {
        const inner = css.slice(css.indexOf('{') + 1, css.lastIndexOf('}'));
        const frame = await load(filterCss(css, off).css, filterStyleAttribute(inner, off).css);
        for (const problem of problems(frame)) filtered.push(css + ' => ' + problem);
        frame.remove();
        // Parsed but never loaded: proves the payloads are live when unfiltered.
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        if ([...sheet.cssRules].some(rule => /https?:|fixed|sticky/i.test(rule.cssText))) raw += 1;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      return { raw, filtered };
    })()`);
    expect(findings.filtered).toEqual([]);
    expect(findings.raw).toBeGreaterThan(20);
    expect(requests.slice(before).filter(url => url.includes('.invalid'))).toEqual([]);
  }, 60_000);

  it('sanitises a 512 Ki-character newsletter within the budget', async () => {
    const newsletter = fixture('newsletter');
    const table = newsletter.slice(newsletter.indexOf('<table'), newsletter.lastIndexOf('</table>') + 8);
    const input = table.repeat(Math.ceil(512 * 1024 / table.length)).slice(0, 512 * 1024);
    const ms = await harness.cdp.js<number>(`(() => {
      const start = performance.now();
      window.sanitizeMailHtml(${JSON.stringify(input)}, { remoteImages: false });
      return performance.now() - start;
    })()`);
    console.log('Sanitisation timing (ms):', ms);
    expect(ms).toBeLessThan(1500);
  }, 30_000);
});
