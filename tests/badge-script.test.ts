// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
const SOURCE = fs.readFileSync(path.resolve(process.cwd(), 'src/runtime/badge.js'), 'utf8');

function load(attrs: Record<string, string> = {}): void {
  const script = document.createElement('script');
  const all = { 'data-label': 'Made with Lager', 'data-link-label': 'Made with Lager: learn more', 'data-close': 'Hide', 'data-href': 'https://github.com/dm807cam/lager', ...attrs };
  for (const [k, v] of Object.entries(all)) script.setAttribute(k, v);
  document.head.appendChild(script);
  Object.defineProperty(document, 'currentScript', { value: script, configurable: true });
  (0, eval)(SOURCE);
}

const host = (): HTMLElement | null => document.querySelector('lager-badge');

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  delete g.__lagerBadge;
  localStorage.clear();
});

describe('badge.js', () => {
  it('draws a link with the given text in its own shadow root', () => {
    load();
    const root = host()!.shadowRoot!;
    const link = root.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://github.com/dm807cam/lager');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('aria-label')).toBe('Made with Lager: learn more');
    expect(link.textContent).toBe('Made with Lager');
    expect(root.querySelector('button')!.getAttribute('aria-label')).toBe('Hide');
    // The app's styles live outside the shadow root.
    expect(document.body.querySelectorAll('a')).toHaveLength(0);
  });

  it('closing hides it and is remembered on this device', () => {
    load();
    host()!.shadowRoot!.querySelector('button')!.click();
    expect(host()).toBeNull();
    expect(localStorage.getItem('lager.badge.hidden')).toBe('1');
    delete g.__lagerBadge;
    load();
    expect(host()).toBeNull();
  });

  it('draws only once, and never with a link that is not https', () => {
    load();
    load();
    expect(document.querySelectorAll('lager-badge')).toHaveLength(1);
    document.body.innerHTML = '';
    delete g.__lagerBadge;
    load({ 'data-href': 'javascript:alert(1)' });
    expect(host()).toBeNull();
  });

  it('still works when the browser refuses storage', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); }, configurable: true });
    try {
      load();
      expect(host()).not.toBeNull();
      host()!.shadowRoot!.querySelector('button')!.click();
      expect(host()).toBeNull();
    } finally {
      Object.defineProperty(window, 'localStorage', original);
    }
  });
});
