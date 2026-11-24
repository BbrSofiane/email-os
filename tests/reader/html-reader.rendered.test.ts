// @vitest-environment node
import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_VIEWPORT, startRenderedHarness, type RenderedHarness } from '../rendered/chromium';
import { pressRenderedEnter, pressRenderedKey, pressRenderedTab } from '../rendered/keyboard';
import { WEBKIT_LISTENER_MODEL } from '../rendered/webkit-listener-model';

const chrome = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
const enabled = process.env.EMAIL_OS_RUN_RENDERED === '1' && !!chrome;
const output = process.env.EMAIL_OS_SCREENSHOT_DIR ?? '';
const root = new URL('../..', import.meta.url).pathname;
const active = '.workspace-panel:not([inert]) .app';
const dialog = '[role="dialog"][aria-label="Open link"]';

describe.skipIf(!enabled).each([
  ['desktop', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false, touch: false }],
  ['phone', PHONE_VIEWPORT],
])('HTML reader (%s)', (name, viewport) => {
  let h: RenderedHarness;
  const requests: string[] = [];
  /** Referrer policy and header of every remote image the mail loaded. */
  const referrers: string[] = [];
  const app = `document.querySelector(${JSON.stringify(active)})`;
  const frame = `${app}.querySelector('iframe.html-message-frame:last-of-type')`;
  const doc = `${frame}.contentDocument`;

  beforeAll(async () => {
    if (output) mkdirSync(output, { recursive: true });
    h = await startRenderedHarness(chrome, 'email-os-html-reader-', root, viewport);
    h.cdp.on('Network.requestWillBeSent', (event) => {
      requests.push(event.request.url);
      if (event.request.url.includes('newsletter.invalid')) {
        referrers.push(`${event.request.referrerPolicy}:${event.request.headers.Referer ?? ''}`);
      }
    });
    await h.cdp.cmd('Network.enable');
  }, 120_000);
  afterAll(async () => { await h?.close(); });

  async function wait(expression: string, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (await h.cdp.js<boolean>(`!!(${expression})`).catch(() => false)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  async function pause(ms = 300): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)); }
  async function fresh(): Promise<void> {
    await h.cdp.cmd('Page.navigate', { url: h.appUrl });
    await wait(`${app}?.querySelector('.inbox-row')`, 'inbox');
  }
  async function open(subject: string): Promise<void> {
    await wait(`[...${app}.querySelectorAll('.inbox-row')].some(row => row.textContent.includes(${JSON.stringify(subject)}))`, subject);
    await h.cdp.js(`([...${app}.querySelectorAll('.inbox-row')].find(row => row.textContent.includes(${JSON.stringify(subject)}))).click()`);
    await wait(`${app}.querySelector('[data-test="reader"]')`, 'reader');
  }
  async function click(selector: string): Promise<void> {
    await wait(`${app}.querySelector(${JSON.stringify(selector)})`, selector);
    await h.cdp.js(`${app}.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function readyFrame(): Promise<void> {
    await wait(`${frame}?.contentDocument?.querySelector('.eos-mail-body')?.childNodes.length > 0 && ${frame}.contentDocument.location.href === 'about:srcdoc'`, 'HTML frame');
    await pause();
  }
  async function shot(label: string): Promise<void> {
    if (!output) return;
    // Tall mail stays at the top, where its header and the images bar show.
    await h.cdp.js(`(() => { const body = ${frame}?.closest('.message-html-body'); if (body && body.clientHeight < innerHeight / 2) body.scrollIntoView({block:'center'}); })()`);
    await pause();
    await h.saveScreenshot(`${output}/${name}-${label}.png`);
  }
  async function link(value: string): Promise<void> {
    await h.cdp.js(`(() => { const a = [...${doc}.querySelectorAll('[data-eos-href]')].find(a => a.dataset.eosHref.includes(${JSON.stringify(value)})); if (!a) throw Error('Missing link'); a.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); })()`);
    await wait(`document.querySelector(${JSON.stringify(dialog)})`, 'link confirmation');
  }
  async function dialogButton(label: string): Promise<void> {
    await h.cdp.js(`(() => { const b = [...document.querySelector(${JSON.stringify(dialog)}).querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(label)})); if (!b) throw Error('Missing dialog button'); b.click(); })()`);
  }
  const invalid = () => requests.filter(url => url.includes('.invalid'));

  it('blocks newsletter images per visit, fits the frame and switches formats', async () => {
    await fresh(); const before = invalid().length;
    await open('Fixture Weekly: issue 12'); await readyFrame();
    await wait(`${app}.querySelector('[data-test="remote-images-bar"]')`, 'blocked images');
    expect(await h.cdp.js(`${frame}.getAttribute('sandbox')`)).toBe('allow-same-origin');
    expect(invalid().length).toBe(before);
    const size = await h.cdp.js<{ height: number; scrollHeight: number; width: number; scrollWidth: number; zoom: number }>(`(() => { const f = ${frame}, d = f.contentDocument; return {height:f.clientHeight, scrollHeight:d.scrollingElement.scrollHeight, width:f.clientWidth, scrollWidth:d.documentElement.scrollWidth, zoom:parseFloat(getComputedStyle(d.documentElement).zoom)} })()`);
    expect(size.scrollHeight).toBeLessThanOrEqual(size.height + 2);
    if (name === 'phone') {
      expect(size.zoom).toBeGreaterThanOrEqual(0.5);
      expect(size.zoom).toBeLessThan(1);
      expect(size.scrollWidth * size.zoom <= size.width + 2 || size.zoom === 0.5).toBe(true);
    }
    const gaps = await h.cdp.js<{ left: number; right: number }>(`(() => { const d = ${doc}, root = d.documentElement.getBoundingClientRect(), table = d.querySelector('table table').getBoundingClientRect(); return { left: table.left - root.left, right: root.right - table.right }; })()`);
    expect(gaps.right).toBeGreaterThan(0);
    expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(2);
    await shot('newsletter-blocked');
    await click('[data-test="load-images"]');
    await wait(`${app}.querySelector('[data-test="remote-images-bar"]') === null`, 'images bar removed');
    for (let i = 0; i < 50 && !requests.some(u => u.includes('track.newsletter.invalid')); i++) await pause(100);
    expect(requests.some(u => u.includes('images.newsletter.invalid'))).toBe(true);
    expect(requests.some(u => u.includes('track.newsletter.invalid'))).toBe(true);
    expect(referrers.length).toBeGreaterThan(0);
    expect([...new Set(referrers)]).toEqual(['no-referrer:']);
    await shot('newsletter-loaded');
    await click('[data-test="message-format-toggle-m-19-1"]');
    expect(await h.cdp.js(`${app}.querySelector('.message-body')?.textContent.length > 0`)).toBe(true);
    await click('[data-test="message-format-toggle-m-19-1"]'); await readyFrame();
    await click('[data-test="reader-close"]');
    const count = invalid().length;
    await open('Fixture Weekly: issue 12'); await readyFrame();
    await wait(`${app}.querySelector('[data-test="remote-images-bar"]')`, 'images blocked again');
    await pause(); expect(invalid().length).toBe(count);
  }, 60_000);

  it('confirms web and mailto links and prefills compose', async () => {
    await fresh(); await open('Plan for next week'); await readyFrame(); await shot('html-only');
    expect(await h.cdp.js(`getComputedStyle(${doc}.documentElement).backgroundColor`)).toBe('rgba(0, 0, 0, 0)');
    await link('https://docs.example.test/plan');
    expect(await h.cdp.js(`document.querySelector(${JSON.stringify(dialog)}).textContent`)).toContain('https://docs.example.test/plan');
    await dialogButton('Keep reading');
    await wait(`!document.querySelector(${JSON.stringify(dialog)})`, 'dialog closed');
    // Returning to the window refreshes the mailbox under the open message.
    for (let i = 0; i < 2; i += 1) {
      await h.cdp.js(`window.dispatchEvent(new Event('focus'))`);
      await pause(600);
    }
    await link('https://docs.example.test/plan');
    await shot('link-confirm'); await dialogButton('Keep reading');
    await wait(`!document.querySelector(${JSON.stringify(dialog)})`, 'dialog closed');
    expect(await h.cdp.js(`${doc}.location.href`)).toBe('about:srcdoc');
    await link('mailto:');
    expect(await h.cdp.js(`document.querySelector(${JSON.stringify(dialog)}).textContent`)).toContain('ana@ridpath.example');
    await shot('mailto-confirm'); await dialogButton('New message to');
    await wait(`${app}.querySelector('[data-test="draft-to"]')?.value === 'ana@ridpath.example'`, 'prefilled recipient');
    expect(await h.cdp.js(`${app}.querySelector('[data-test="draft-to"]').value`)).toBe('ana@ridpath.example');
  }, 60_000);

  it('loads cid images while withholding the remote banner', async () => {
    await fresh(); const count = invalid().length; await open('Logo proof'); await readyFrame();
    await wait(`${doc}.querySelector('img[data-eos-cid]')?.naturalWidth > 0`, 'inline image');
    expect(await h.cdp.js(`${doc}.querySelector('img[data-eos-cid]').src`)).toMatch(/^data:image\/png;base64,/);
    expect(invalid().length).toBe(count); await shot('cid');
    await click('[data-test="load-images"]');
    for (let i = 0; i < 50 && invalid().length === count; i++) await pause(100);
    expect(invalid().length).toBeGreaterThan(count);
  }, 60_000);

  it('collapses and expands the trailing HTML quote', async () => {
    await fresh(); await open('Re: Venue options'); await readyFrame();
    await wait(`${app}.querySelector('[data-test="message-quote-toggle-m-22-2"]')`, 'quote toggle');
    expect(await h.cdp.js(`getComputedStyle(${doc}.querySelector('[data-eos-quote]')).display`)).toBe('none');
    const height = await h.cdp.js<number>(`${frame}.clientHeight`); await shot('reply-collapsed');
    await click('[data-test="message-quote-toggle-m-22-2"]');
    await wait(`getComputedStyle(${doc}.querySelector('[data-eos-quote]')).display !== 'none' && ${frame}.clientHeight > ${height}`, 'expanded quote');
    await shot('reply-expanded');
  }, 60_000);

  it('isolates hostile content and confirms every surviving link', async () => {
    await fresh(); const count = invalid().length; const title = await h.cdp.js<string>('document.title');
    await open('Hostile HTML sample'); await readyFrame(); await pause(700); await shot('hostile');
    expect(await h.cdp.js('window.__eosPwned === undefined')).toBe(true);
    expect(await h.cdp.js('document.title')).toBe(title); expect(invalid().length).toBe(count);
    const links = await h.cdp.js<string[]>(`[...${doc}.querySelectorAll('[data-eos-href]')].map(a => a.dataset.eosHref)`);
    expect(links.length).toBeGreaterThan(0);
    for (const url of links) {
      await link(url);
      if (url.includes('login.bank.invalid')) expect(await h.cdp.js(`document.querySelector(${JSON.stringify(dialog)}).textContent`)).toContain('The link text shows a different address.');
      await dialogButton('Keep reading'); await wait(`!document.querySelector(${JSON.stringify(dialog)})`, 'dialog closed');
      expect(await h.cdp.js(`${doc}.location.href`)).toBe('about:srcdoc');
    }
    expect(links.some(url => url.includes('login.bank.invalid'))).toBe(true);
    expect(invalid().length).toBe(count);
  }, 60_000);

  it('shows plain text when HTML is too large', async () => {
    await fresh(); await open('Oversized HTML sample');
    await wait(`${app}.querySelector('[data-test="html-too-large"]')`, 'size notice');
    expect(await h.cdp.js(`${app}.querySelector('[data-test="html-too-large"]').textContent`)).toContain('Formatted version too large to show.');
    expect(await h.cdp.js(`${app}.querySelector('iframe.html-message-frame')`)).toBeNull();
    expect(await h.cdp.js(`${app}.querySelector('.message-body')?.textContent`)).toContain("This message's formatted version is larger");
    await shot('oversized');
  }, 60_000);

  it.skipIf(name !== 'desktop')('forwards Escape from the frame to close the reader', async () => {
    await fresh(); await open('Fixture Weekly: issue 12'); await readyFrame();
    await h.cdp.js(`${doc}.body.click(); ${frame}.contentWindow.focus()`);
    await h.cdp.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await h.cdp.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait(`!${app}.querySelector('[data-test="reader"]')`, 'reader closed');
  }, 60_000);
});

/**
 * The same reader with Chrome made to refuse listeners on the mail frame as
 * WebKit does (owner's macOS check of PR #92): links, keys and fitting must
 * work through the frame signals alone (ADR 0006, implementation record 12).
 */
describe.skipIf(!enabled)('HTML reader without frame listeners (WebKit model)', () => {
  let h: RenderedHarness;
  const requests: string[] = [];
  const app = `document.querySelector(${JSON.stringify(active)})`;
  const frame = `${app}.querySelector('iframe.html-message-frame:last-of-type')`;
  const doc = `${frame}.contentDocument`;
  const subject = `${app}.querySelector('.reader-subject')?.textContent`;

  beforeAll(async () => {
    h = await startRenderedHarness(chrome, 'email-os-html-webkit-', root, { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false, touch: false });
    h.cdp.on('Network.requestWillBeSent', (event) => { requests.push(event.request.url); });
    await h.cdp.cmd('Network.enable');
    await h.cdp.cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
    await h.cdp.cmd('Page.addScriptToEvaluateOnNewDocument', { source: WEBKIT_LISTENER_MODEL });
    await h.cdp.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `window.__eosErrors = []; addEventListener('error', (event) => window.__eosErrors.push(String(event.message)));` });
  }, 120_000);
  afterAll(async () => { await h?.close(); });

  async function wait(expression: string, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (await h.cdp.js<boolean>(`!!(${expression})`).catch(() => false)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  async function pause(ms = 300): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)); }
  async function open(name: string): Promise<void> {
    await h.cdp.cmd('Page.navigate', { url: h.appUrl });
    await wait(`[...(${app}?.querySelectorAll('.inbox-row') ?? [])].some(row => row.textContent.includes(${JSON.stringify(name)}))`, name);
    await h.cdp.js(`([...${app}.querySelectorAll('.inbox-row')].find(row => row.textContent.includes(${JSON.stringify(name)}))).click()`);
    await wait(`${frame}?.contentDocument?.querySelector('eos-signal') && ${frame}.contentDocument.location.href === 'about:srcdoc'`, 'HTML frame on the WebKit path');
    await pause();
  }
  /** Viewport point of an element in the frame (desktop: the frame is not zoomed). */
  async function point(selector: string, text = ''): Promise<{ x: number; y: number }> {
    return h.cdp.js(`(() => {
      const f = ${frame}, el = [...f.contentDocument.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.includes(${JSON.stringify(text)}));
      el.scrollIntoView({ block: 'center' });
      const a = f.getBoundingClientRect(), b = el.getBoundingClientRect();
      return { x: a.left + b.left + Math.min(b.width / 2, 12), y: a.top + b.top + b.height / 2 };
    })()`);
  }
  async function mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', at: { x: number; y: number }): Promise<void> {
    await h.cdp.cmd('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
  async function click(at: { x: number; y: number }): Promise<void> {
    await mouse('mouseMoved', at); await mouse('mousePressed', at); await pause(80); await mouse('mouseReleased', at);
  }
  async function dialogText(): Promise<string> {
    await wait(`document.querySelector(${JSON.stringify(dialog)})`, 'link confirmation');
    return h.cdp.js<string>(`document.querySelector(${JSON.stringify(dialog)}).textContent`);
  }
  async function dialogButton(label: string): Promise<void> {
    await h.cdp.js(`[...document.querySelector(${JSON.stringify(dialog)}).querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(label)})).click()`);
    await wait(`!document.querySelector(${JSON.stringify(dialog)})`, 'dialog closed');
  }

  it('confirms clicked links every time and leaves the frame where it was', async () => {
    const before = requests.length;
    await open('Plan for next week');
    expect(await h.cdp.js(`${doc}.querySelector('a[data-eos-href]').getAttribute('href')`)).toMatch(/^about:srcdoc#eos-[a-z0-9]+-0$/);
    for (let i = 0; i < 2; i++) {
      const scroll = await h.cdp.js<number>(`${frame}.closest('.reader')?.scrollTop ?? 0`);
      await click(await point('a', 'the plan'));
      expect(await dialogText()).toContain('https://docs.example.test/plan');
      await dialogButton('Keep reading');
      expect(await h.cdp.js(`${doc}.location.href`)).toBe('about:srcdoc');
      expect(await h.cdp.js(`${frame}.closest('.reader')?.scrollTop ?? 0`)).toBe(scroll);
    }
    await click(await point('a', 'email Ana'));
    expect(await dialogText()).toContain('ana@ridpath.example');
    await dialogButton('New message to');
    await wait(`${app}.querySelector('[data-test="draft-to"]')?.value === 'ana@ridpath.example'`, 'prefilled recipient');
    expect(requests.slice(before).filter(url => url.includes('example.test') || url.startsWith('mailto:'))).toEqual([]);
  }, 60_000);

  it('activates a link reached with Tab by Enter', async () => {
    await open('Plan for next week');
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await pressRenderedTab(h.cdp, false, () => pause(60));
      reached = await h.cdp.js<boolean>(`${doc}.activeElement?.textContent === 'the plan'`);
    }
    expect(reached).toBe(true);
    await pause(250);
    // Keyboard focus stays in the frame.
    expect(await h.cdp.js(`document.activeElement === ${frame}`)).toBe(true);
    await pressRenderedEnter(h.cdp, () => pause(100));
    expect(await dialogText()).toContain('https://docs.example.test/plan');
    await dialogButton('Keep reading');
  }, 60_000);

  it('gives keys back to the reader after a click in the message but keeps a selection', async () => {
    await open('Plan for next week');
    const first = await h.cdp.js<string>(subject);
    await click(await point('li', 'Review the outline'));
    await wait(`document.activeElement !== ${frame} && ${app}.querySelector('.reader')?.contains(document.activeElement)`, 'focus back in the reader');
    await pressRenderedKey(h.cdp, 'j');
    await wait(`${subject} && ${subject} !== ${JSON.stringify(first)}`, 'next conversation');
    await pressRenderedKey(h.cdp, 'k');
    await wait(`${subject} === ${JSON.stringify(first)}`, 'previous conversation');

    await wait(`${frame}?.contentDocument?.querySelector('eos-signal') && ${frame}.contentDocument.location.href === 'about:srcdoc'`, 'frame again');
    await pause();
    const start = await point('li', 'Review the outline');
    const end = await point('li', 'Share feedback');
    await mouse('mouseMoved', start); await mouse('mousePressed', start);
    for (let step = 1; step <= 5; step++) {
      await h.cdp.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + ((end.x + 60 - start.x) * step) / 5, y: start.y + ((end.y - start.y) * step) / 5, button: 'left', buttons: 1 });
      await pause(60);
    }
    // While the button is down the frame keeps focus, so the selection can grow.
    expect(await h.cdp.js(`document.activeElement === ${frame}`)).toBe(true);
    await mouse('mouseReleased', { x: end.x + 60, y: end.y });
    await pause(400);
    expect((await h.cdp.js<string>(`${doc}.getSelection().toString()`)).length).toBeGreaterThan(5);
    expect(await h.cdp.js(`document.activeElement === ${frame}`)).toBe(true);
  }, 60_000);

  it('draws links as the listener path does, with or without the fragment href', async () => {
    for (const name of ['Fixture Weekly: issue 12', 'Hostile HTML sample', 'Plan for next week']) {
      await open(name);
      const differences = await h.cdp.js<string[]>(`(() => {
        const out = [];
        for (const a of ${doc}.querySelectorAll('a[data-eos-href]')) {
          const look = () => { const c = getComputedStyle(a); return [c.color, c.textDecorationLine, c.cursor].join(' | '); };
          const href = a.getAttribute('href');
          const withHref = look(); a.removeAttribute('href'); const without = look(); a.setAttribute('href', href);
          if (withHref !== without) out.push(a.textContent.trim() + ': ' + withHref + ' vs ' + without);
        }
        return out;
      })()`);
      expect(differences, name).toEqual([]);
    }
  }, 60_000);

  it('fits without a ResizeObserver loop while the column and images change', async () => {
    await open('Fixture Weekly: issue 12');
    await h.cdp.js(`${app}.querySelector('[data-test="load-images"]').click()`);
    await wait(`${frame}?.contentDocument?.querySelector('img[width="600"]')?.complete && ${frame}.contentDocument.querySelector('eos-signal')`, 'images settled');
    // Narrow and widen the column: fits change the zoom and so the observed images.
    for (const width of [700, 420, 1100, 520, 1100]) {
      await h.cdp.cmd('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await pause(250);
    }
    await click(await point('p', ''));
    await pressRenderedKey(h.cdp, 'j');
    await pause(600);
    expect(await h.cdp.js<string[]>('window.__eosErrors')).toEqual([]);
  }, 60_000);

  it('fits images that load or fail and keeps the size of a failed image', async () => {
    await open('Fixture Weekly: issue 12');
    await h.cdp.js(`${app}.querySelector('[data-test="load-images"]').click()`);
    await wait(`${frame}?.contentDocument?.querySelector('img[width="600"]')?.getAttribute('src') && ${frame}.contentDocument.querySelector('eos-signal')`, 'images requested');
    await wait(`${doc}.querySelector('img[width="600"]').complete`, 'header image settled');
    await pause(600);
    const result = await h.cdp.js<{ height: string; width: number; boxHeight: number; frame: number; content: number }>(`(() => {
      const f = ${frame}, img = f.contentDocument.querySelector('img[width="600"]');
      return { height: img.style.height, width: img.offsetWidth, boxHeight: img.offsetHeight, frame: f.clientHeight, content: f.contentDocument.scrollingElement.scrollHeight };
    })()`);
    expect(result.height).toMatch(/px$/);
    expect(Math.abs(result.boxHeight - (result.width * 220) / 600)).toBeLessThanOrEqual(2);
    expect(result.content).toBeLessThanOrEqual(result.frame + 2);
  }, 60_000);
});
