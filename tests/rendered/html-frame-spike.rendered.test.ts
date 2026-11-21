// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRenderedHarness, type RenderedHarness } from './chromium';
import { FRAME_PROBE_SOURCE, type FrameProbeResult } from './html-frame-probe';

const chrome = process.env.EMAIL_OS_RENDERED_LAYOUT_CHROME ?? '';
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const csp: string = config.app.security.csp;
const token = "img-src 'self' data:";
const guardSource = ts.transpileModule(readFileSync('src/lib/html-mail/frame-guard.ts', 'utf8').replaceAll('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

describe.skipIf(!chrome)('HTML frame spike', () => {
  let harness: RenderedHarness;
  let server: Server;
  let url: string;
  const requests: string[] = [];
  beforeAll(async () => {
    expect(csp.split(token)).toHaveLength(2);
    server = createServer((req, res) => {
      res.setHeader('Content-Security-Policy', req.url === '/wide' ? csp.replace(token, token + ' https:') : csp);
      res.end('<!doctype html><title>spike</title><body></body>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    harness = await startRenderedHarness(chrome, 'email-os-spike-', process.cwd());
    await harness.cdp.cmd('Fetch.enable', { patterns: [{ urlPattern: 'https://img.test/*' }, { urlPattern: 'https://probe-image.invalid/*' }] });
    harness.cdp.on('Fetch.requestPaused', params => {
      requests.push(params.request.url);
      void harness.cdp.cmd('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=' });
    });
  }, 120_000);
  afterAll(async () => { await harness?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });
  async function navigate(path = '/') {
    await harness.cdp.cmd('Page.navigate', { url: url + path });
    for (let i = 0; i < 100; i++) {
      if (await harness.cdp.js<boolean>(`location.href === ${JSON.stringify(url + path)} && document.readyState === 'complete'`).catch(() => false)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('navigation timed out');
  }
  const frame = `(html) => new Promise((resolve, reject) => {
    const f = document.createElement('iframe'); f.sandbox = 'allow-same-origin';
    const timer = setTimeout(() => reject(Error('frame timeout')), 3000);
    f.onload = () => { clearTimeout(timer); resolve(f); }; f.srcdoc = html; document.body.append(f);
  })`;
  it('blocks payloads', async () => {
    await navigate();
    const result = await harness.cdp.js<FrameProbeResult>(FRAME_PROBE_SOURCE);
    console.log('Probe checks:', JSON.stringify(result.checks));
    console.log('Probe image requests:', JSON.stringify(requests));
    expect(new Set(result.checks.map(c => c.name)).size).toBe(result.checks.length);
    expect(result.checks.filter(c => !c.name.includes('(informational)') && !c.pass)).toEqual([]);
  }, 30000);
  it('inherits both parent and frame image policies', async () => {
    const run = async (path: string, policy: string) => {
      await navigate(path); requests.length = 0;
      await harness.cdp.js(`(async () => { const make = ${frame}; await make(${JSON.stringify(`<meta http-equiv="Content-Security-Policy" content="img-src ${policy}"><img src="https://img.test/a.png">`)}); await new Promise(r => setTimeout(r, 500)); })()`);
      return [...requests];
    };
    expect(await run('/', 'data: https:')).toEqual([]);
    expect(await run('/wide', 'data: https:')).toEqual(['https://img.test/a.png']);
    expect(await run('/wide', 'data:')).toEqual([]);
  });
  it('detects native globals in frames', async () => {
    await navigate();
    const clean = await harness.cdp.js<boolean>(`(async () => { ${guardSource}; window.__TAURI_INTERNALS__ = {}; const make = ${frame}; const f = await make('clean'); return frameHasNativeGlobals(f); })()`);
    expect(clean).toBe(false);
    const script = await harness.cdp.cmd('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__TAURI_INTERNALS__ = {}' });
    await navigate('/wide');
    const injected = await harness.cdp.js<{ present: boolean; guarded: boolean }>(`(async () => { ${guardSource}; const make = ${frame}; const f = await make('injected'); return { present: '__TAURI_INTERNALS__' in f.contentWindow, guarded: frameHasNativeGlobals(f) }; })()`);
    console.log('Injected frame outcome:', JSON.stringify(injected));
    expect(injected.guarded).toBe(injected.present);
    await harness.cdp.cmd('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
  });
  it('measures height, intercepts links and fits wide content', async () => {
    await navigate();
    const result = await harness.cdp.js<{ height: number; href: string; location: string; width: number; before: number; after: number }>(`(async () => {
      const make = ${frame}; const f = await make('<div style="height:900px"></div><a data-eos-href="https://example.test/x" role="link" tabindex="0">x</a><table width="600"><tr><td>x</td></tr></table>');
      f.style.width = '360px'; const doc = f.contentDocument; let href = '';
      doc.addEventListener('click', e => { href = e.target.dataset.eosHref; }); doc.querySelector('a').click();
      const height = doc.documentElement.scrollHeight; const width = doc.documentElement.scrollWidth;
      const before = doc.scrollingElement.scrollWidth - f.contentWindow.innerWidth;
      doc.documentElement.style.zoom = String(360 / width);
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
      // Horizontal overflow of the frame's own scroller, measured after zoom applies.
      const after = doc.scrollingElement.scrollWidth - f.contentWindow.innerWidth;
      return { height, href, location: f.contentWindow.location.href, width, before, after };
    })()`);
    expect(result.height).toBeGreaterThanOrEqual(900); expect(result.href).toBe('https://example.test/x');
    expect(result.location).toBe('about:srcdoc'); expect(result.width).toBeGreaterThanOrEqual(600);
    console.log('Fit overflow before/after zoom:', result.before, result.after);
    expect(result.before).toBeGreaterThan(200);
    expect(result.after).toBeLessThanOrEqual(1);
  });
});
