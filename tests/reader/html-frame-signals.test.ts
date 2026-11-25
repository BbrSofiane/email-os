import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachFrameSignals, revealFrameElement, frameKeepsFocus, frameListenersRun, keepBrokenImageHeight, resetFrameListenerProbe } from '../../src/lib/html-mail/frame-signals';

function makeFrame(body: string): { frame: HTMLIFrameElement; doc: Document } {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = body;
  return { frame, doc };
}

class FakeResizeObserver {
  static last: FakeResizeObserver | null = null;
  observed: Element[] = [];
  constructor(readonly callback: () => void) { FakeResizeObserver.last = this; }
  observe(element: Element): void { this.observed.push(element); }
  disconnect(): void { this.observed = []; }
}

afterEach(() => {
  document.body.innerHTML = '';
  resetFrameListenerProbe();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('frame listener probe', () => {
  it('reports listeners that run (Chromium, jsdom)', () => {
    expect(frameListenersRun(makeFrame('').doc)).toBe(true);
  });
  it('reports listeners that never run (WebKit) and keeps the answer', () => {
    const { doc } = makeFrame('');
    doc.addEventListener = () => {};
    expect(frameListenersRun(doc)).toBe(false);
    expect(frameListenersRun(makeFrame('').doc)).toBe(false);
  });
});

describe('frame signals', () => {
  it('turns links into same-document fragment links and cleans up', () => {
    const { frame, doc } = makeFrame('<p><a data-eos-href="https://a.test/" role="link" tabindex="0">a</a> <a data-eos-href="mailto:b@b.test">b</a> <a>plain</a></p>');
    const detach = attachFrameSignals(frame, doc, { onLink: vi.fn(), releaseFocus: vi.fn() });
    const links = [...doc.querySelectorAll('a[data-eos-href]')];
    const hrefs = links.map((link) => link.getAttribute('href')!);
    // The frame's own URL: about:srcdoc in the app, about:blank in jsdom.
    expect(hrefs[0]).toMatch(/^about:blank#eos-[a-z0-9]+-0$/);
    expect(hrefs[1]).toBe(hrefs[0]!.replace(/0$/, '1'));
    expect(doc.querySelector('a:not([data-eos-href])')!.hasAttribute('href')).toBe(false);
    // Targets and the signal follow the body; each target matches its link.
    const after = [...doc.documentElement.children].slice(2).map((node) => node.localName);
    expect(after).toEqual(['eos-target', 'eos-target', 'eos-signal']);
    expect(hrefs.map((href) => doc.getElementById(href.split('#')[1]!)?.localName)).toEqual(['eos-target', 'eos-target']);
    detach();
    expect(doc.querySelectorAll('[href], eos-target, eos-signal')).toHaveLength(0);
  });

  it('reports the activated link from the fragment when the signal resizes', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { frame, doc } = makeFrame('<a data-eos-href="https://a.test/">a</a><a data-eos-href="https://b.test/">b</a>');
    const onLink = vi.fn();
    const detach = attachFrameSignals(frame, doc, { onLink, releaseFocus: vi.fn() });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const nextFrame = () => { for (const callback of frames.splice(0)) callback(0); };
    const observer = FakeResizeObserver.last!;
    expect(observer.observed.map((node) => node.localName)).toEqual(['eos-signal']);
    observer.callback();
    nextFrame();
    expect(onLink).not.toHaveBeenCalled();
    const win = frame.contentWindow!;
    const second = doc.querySelectorAll('a')[1]!;
    win.location.href = second.getAttribute('href')!;
    expect(win.location.hash).toMatch(/-1$/);
    observer.callback();
    // Nothing changes inside the observer's delivery; the next frame resets and reports.
    expect(onLink).not.toHaveBeenCalled();
    expect(win.location.hash).toMatch(/-1$/);
    observer.callback();
    nextFrame();
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onLink.mock.calls[0]?.[0]).toBe(second);
    // The fragment is reset, so the same link can signal again.
    // (jsdom keeps the idle fragment; Chrome's rendered test checks the plain URL.)
    expect(win.location.hash).toMatch(/^#eos-[a-z0-9]+-idle$/);
    observer.callback();
    nextFrame();
    expect(onLink).toHaveBeenCalledTimes(1);
    detach();
  });

  it('gives focus back after a plain click but keeps it for a selection', () => {
    vi.useFakeTimers();
    const { frame, doc } = makeFrame('<p>Some text to select</p>');
    const releaseFocus = vi.fn(() => (document.activeElement as HTMLElement | null)?.blur());
    const detach = attachFrameSignals(frame, doc, { onLink: vi.fn(), releaseFocus, pollMs: 50 });
    frame.focus();
    expect(document.activeElement).toBe(frame);
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector('p')!);
    doc.getSelection()!.addRange(range);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(200);
    expect(releaseFocus).not.toHaveBeenCalled();
    doc.getSelection()!.collapseToStart();
    vi.advanceTimersByTime(60);
    expect(releaseFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(frame);
    // Polling stops once the frame no longer has focus.
    vi.advanceTimersByTime(500);
    expect(releaseFocus).toHaveBeenCalledTimes(1);
    detach();
  });

  it('gives back focus a click put on a link, keeps keyboard focus', () => {
    const { doc } = makeFrame('<a data-eos-href="https://a.test/" tabindex="0">link</a>');
    expect(frameKeepsFocus(doc)).toBe(false);
    const link = doc.querySelector('a')!;
    link.focus();
    // jsdom counts every focus as :focus-visible; model a click, then the keyboard.
    const real = link.matches.bind(link);
    let keyboard = false;
    vi.spyOn(link, 'matches').mockImplementation((selector) => selector === ':focus-visible' ? keyboard : real(selector));
    expect(frameKeepsFocus(doc)).toBe(false);
    keyboard = true;
    expect(frameKeepsFocus(doc)).toBe(true);
  });

  it('keeps focus on other focused mail elements, such as a details summary', () => {
    // The built-in summary has focus; the details host never matches :focus-visible.
    const { doc } = makeFrame('<details open tabindex="-1">Details</details>');
    doc.querySelector('details')!.focus();
    expect(doc.activeElement?.localName).toBe('details');
    expect(frameKeepsFocus(doc)).toBe(true);
  });
});

describe('revealing a keyboard-focused element', () => {
  function rect(top: number, height: number): DOMRect {
    return { top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  }

  it('scrolls the reader so an element below the fold shows, whatever the zoom', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    document.body.append(scroller);
    const frame = document.createElement('iframe');
    scroller.append(frame);
    const doc = frame.contentDocument!;
    doc.body.innerHTML = '<a tabindex="0">link</a>';
    const link = doc.querySelector('a')!;
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000 });
    Object.defineProperty(scroller, 'clientHeight', { value: 500 });
    scroller.getBoundingClientRect = () => rect(100, 500);
    // The frame is 1200 px tall in the reader; its zoomed root reports 2400.
    frame.getBoundingClientRect = () => rect(150 - scroller.scrollTop, 1200);
    doc.documentElement.getBoundingClientRect = () => rect(0, 2400);
    link.getBoundingClientRect = () => rect(1800, 40);
    revealFrameElement(frame, link);
    // Link bottom at 150 + 920 = 1070; visible bottom 600 - 24 margin.
    expect(scroller.scrollTop).toBe(1070 - 576);
    revealFrameElement(frame, link);
    expect(scroller.scrollTop).toBe(1070 - 576);
  });

  it('reveals each newly keyboard-focused element while the frame has focus', () => {
    vi.useFakeTimers();
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    document.body.append(scroller);
    const frame = document.createElement('iframe');
    scroller.append(frame);
    const doc = frame.contentDocument!;
    doc.body.innerHTML = '<a tabindex="0">link</a>';
    const link = doc.querySelector('a')!;
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000 });
    Object.defineProperty(scroller, 'clientHeight', { value: 500 });
    scroller.getBoundingClientRect = () => rect(0, 500);
    frame.getBoundingClientRect = () => rect(-scroller.scrollTop, 1500);
    doc.documentElement.getBoundingClientRect = () => rect(0, 1500);
    link.getBoundingClientRect = () => rect(1200, 20);
    vi.spyOn(link, 'matches').mockImplementation((selector) => selector === ':focus-visible');
    const releaseFocus = vi.fn();
    const detach = attachFrameSignals(frame, doc, { onLink: vi.fn(), releaseFocus, pollMs: 50 });
    frame.focus();
    link.focus();
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(10);
    expect(releaseFocus).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(1220 - 476);
    // The same element is not revealed again (the user may scroll away).
    scroller.scrollTop = 0;
    vi.advanceTimersByTime(200);
    expect(scroller.scrollTop).toBe(0);
    detach();
  });
});

describe('broken image height', () => {
  let rendered = 600;
  function make(attributes: string): HTMLImageElement {
    const holder = document.createElement('div');
    holder.innerHTML = `<img ${attributes}>`;
    const img = holder.querySelector('img')!;
    Object.defineProperty(img, 'complete', { value: true });
    Object.defineProperty(img, 'offsetWidth', { get: () => rendered });
    return img;
  }

  it('sets a pixel height from the attribute ratio on a failed image', () => {
    const broken = make('src="https://x.invalid/a.png" width="600" height="220"');
    keepBrokenImageHeight(broken);
    expect(broken.style.height).toBe('220px');
    // A later fit at another width replaces its own height.
    rendered = 300;
    keepBrokenImageHeight(broken);
    expect(broken.style.height).toBe('110px');
    rendered = 600;
  });

  it('leaves loaded, withheld, unsized and mail-sized images alone', () => {
    const withheld = make('data-eos-src="https://x.invalid/a.png" width="600" height="220"');
    const loaded = make('src="data:image/png;base64,AA==" width="600" height="220"');
    Object.defineProperty(loaded, 'naturalWidth', { value: 1 });
    const unsized = make('src="https://x.invalid/a.png" width="100%"');
    const styled = make('src="https://x.invalid/a.png" width="600" height="220" style="height: 40px"');
    for (const img of [withheld, loaded, unsized]) {
      keepBrokenImageHeight(img);
      expect(img.style.height).toBe('');
    }
    keepBrokenImageHeight(styled);
    expect(styled.style.height).toBe('40px');
  });
});
