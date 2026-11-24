import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachFrameSignals, frameKeepsFocus, frameListenersRun, keepBrokenImageRatio, resetFrameListenerProbe } from '../../src/lib/html-mail/frame-signals';

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
    const observer = FakeResizeObserver.last!;
    expect(observer.observed.map((node) => node.localName)).toEqual(['eos-signal']);
    observer.callback();
    expect(onLink).not.toHaveBeenCalled();
    const win = frame.contentWindow!;
    const second = doc.querySelectorAll('a')[1]!;
    win.location.href = second.getAttribute('href')!;
    expect(win.location.hash).toMatch(/-1$/);
    observer.callback();
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onLink.mock.calls[0]?.[0]).toBe(second);
    // The fragment is reset, so the same link can signal again.
    // (jsdom keeps the idle fragment; Chrome's rendered test checks the plain URL.)
    expect(win.location.hash).toMatch(/^#eos-[a-z0-9]+-idle$/);
    observer.callback();
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

  it('keeps focus on a keyboard-focused element only', () => {
    const { doc } = makeFrame('<a tabindex="0">link</a>');
    expect(frameKeepsFocus(doc)).toBe(false);
    const link = doc.querySelector('a')!;
    link.focus();
    vi.spyOn(link, 'matches').mockImplementation((selector) => selector === ':focus-visible');
    expect(frameKeepsFocus(doc)).toBe(true);
  });
});

describe('broken image ratio', () => {
  it('sets the attribute ratio on a failed image only', () => {
    const doc = document.implementation.createHTMLDocument('');
    const make = (attributes: string) => {
      const holder = doc.createElement('div');
      holder.innerHTML = `<img ${attributes}>`;
      const img = holder.querySelector('img')!;
      Object.defineProperty(img, 'complete', { value: true });
      return img;
    };
    const broken = make('src="https://x.invalid/a.png" width="600" height="220"');
    keepBrokenImageRatio(broken);
    expect(broken.style.aspectRatio).toBe('600 / 220');
    const withheld = make('data-eos-src="https://x.invalid/a.png" width="600" height="220"');
    keepBrokenImageRatio(withheld);
    expect(withheld.style.aspectRatio).toBe('');
    const loaded = make('src="data:image/png;base64,AA==" width="600" height="220"');
    Object.defineProperty(loaded, 'naturalWidth', { value: 1 });
    keepBrokenImageRatio(loaded);
    expect(loaded.style.aspectRatio).toBe('');
    const unsized = make('src="https://x.invalid/a.png" width="100%"');
    keepBrokenImageRatio(unsized);
    expect(unsized.style.aspectRatio).toBe('');
  });
});
