// @vitest-environment node
import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_VIEWPORT, startRenderedHarness, type RenderedHarness } from '../rendered/chromium';

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
  const app = `document.querySelector(${JSON.stringify(active)})`;
  const frame = `${app}.querySelector('iframe.html-message-frame:last-of-type')`;
  const doc = `${frame}.contentDocument`;

  beforeAll(async () => {
    if (output) mkdirSync(output, { recursive: true });
    h = await startRenderedHarness(chrome, 'email-os-html-reader-', root, viewport);
    h.cdp.on('Network.requestWillBeSent', (event) => requests.push(event.request.url));
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
    await wait(`${frame}?.contentDocument?.body && ${frame}.contentDocument.location.href === 'about:srcdoc'`, 'HTML frame');
    await pause();
  }
  async function shot(label: string): Promise<void> {
    if (!output) return;
    await h.cdp.js(`${frame}?.closest('.message-html-body')?.scrollIntoView({block:'center'})`);
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
    await shot('newsletter-blocked');
    await click('[data-test="load-images"]');
    await wait(`${app}.querySelector('[data-test="remote-images-bar"]') === null`, 'images bar removed');
    for (let i = 0; i < 50 && !requests.some(u => u.includes('track.newsletter.invalid')); i++) await pause(100);
    expect(requests.some(u => u.includes('images.newsletter.invalid'))).toBe(true);
    expect(requests.some(u => u.includes('track.newsletter.invalid'))).toBe(true);
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
