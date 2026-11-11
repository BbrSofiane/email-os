import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';

export interface CdpSession {
  cmd(method: string, params?: Record<string, unknown>): Promise<any>;
  js<T>(expression: string): Promise<T>;
  close(): void;
}

export interface RenderedHarness {
  server: ViteDevServer;
  appUrl: string;
  chrome: ChildProcess;
  profileDir: string;
  cdp: CdpSession;
  close(): Promise<void>;
}

/** Start one isolated Vite + Chromium profile for one rendered test suite. */
export async function startRenderedHarness(chromePath: string, profilePrefix: string, root: string): Promise<RenderedHarness> {
  let server: ViteDevServer | null = null;
  let chrome: ChildProcess | null = null;
  let profileDir: string | null = null;
  let cdp: CdpSession | null = null;
  let closed = false;
  const startup = new AbortController();
  try {
    server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: 'error' });
    await server.listen();
    const appUrl = server.resolvedUrls?.local?.[0] ?? '';
    if (!appUrl) throw new Error('Vite dev server did not report a local URL');
    profileDir = mkdtempSync(join(tmpdir(), profilePrefix));
    chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profileDir}`, 'about:blank'], {
      stdio: 'ignore',
      // Headless test Chrome needs no DBus. Unanswered desktop-service calls can
      // block its first navigation for 25s, beyond the 20s CDP command timeout.
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent', DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/nonexistent' },
    });
    const spawnError = new Promise<never>((_, reject) => chrome!.on('error', reject));
    cdp = await Promise.race([connectCdp(profileDir, startup.signal), spawnError]);
    await cdp.cmd('Page.enable');
    await cdp.cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.cmd('Page.navigate', { url: appUrl });
    await waitForApp(cdp);
    const ownedServer = server, ownedChrome = chrome, ownedProfile = profileDir, ownedCdp = cdp;
    return { server: ownedServer, appUrl, chrome: ownedChrome, profileDir: ownedProfile, cdp: ownedCdp, close: async () => {
      if (closed) return;
      closed = true;
      try { ownedCdp.close(); } catch { /* already closed */ }
      ownedChrome.kill();
      await new Promise((resolve) => setTimeout(resolve, 300));
      ownedChrome.kill('SIGKILL');
      rmSync(ownedProfile, { recursive: true, force: true });
      await ownedServer.close();
    } };
  } catch (error) {
    startup.abort();
    try { cdp?.close(); } catch { /* partial setup */ }
    chrome?.kill('SIGKILL');
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
    await server?.close();
    throw error;
  }
}

async function connectCdp(profile: string, signal: AbortSignal): Promise<CdpSession> {
  let port: string | null = null;
  for (let i = 0; i < 100 && !port; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    signal.throwIfAborted();
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] ?? null; } catch { /* not yet */ }
  }
  if (!port) throw new Error('Chrome did not expose a DevTools port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('Chrome exposed no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('Timed out connecting to Chrome DevTools')); }, 10_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); ws.close(); reject(new Error('Could not connect to Chrome DevTools')); }, { once: true });
  });
  let nextId = 0;
  const waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: any; error?: unknown };
    if (message.id === undefined) return;
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result);
  });
  ws.addEventListener('close', () => {
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error('Chrome DevTools connection closed')); }
    waiting.clear();
  });
  const cmd = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20_000);
    waiting.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { cmd, async js<T>(expression: string): Promise<T> {
    const result = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value as T;
  }, close() { try { ws.close(); } catch { /* ignore */ } } };
}

async function waitForApp(session: CdpSession): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const ready = await session.js<boolean>("document.querySelector('.app') !== null && performance.getEntriesByType('resource').some((x) => x.name.includes('/node_modules/.vite/deps/vue.js'))").catch(() => false);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Preview app (and Vite Vue dep) did not load');
}
