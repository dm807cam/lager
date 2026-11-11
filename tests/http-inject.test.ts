import { describe, expect, it } from 'vitest';
import { injectRuntime } from '../src/http/inject.js';

const TAG = '<script src="/__lager/runtime.js"></script>';

describe('injectRuntime', () => {
  it('after <head>', () => expect(injectRuntime('<!doctype html><html><head><title>x</title></head></html>')).toBe('<!doctype html><html><head>' + TAG + '<title>x</title></head></html>'));
  it('uppercase and attributes', () => expect(injectRuntime('<HTML><HEAD lang="de"><BODY>')).toContain('<HEAD lang="de">' + TAG));
  it('no head: after <html>', () => expect(injectRuntime('<html><body>x</body></html>')).toBe('<html>' + TAG + '<body>x</body></html>'));
  it('fragment: after doctype or at start', () => {
    expect(injectRuntime('<!DOCTYPE html><p>x</p>')).toBe('<!DOCTYPE html>' + TAG + '<p>x</p>');
    expect(injectRuntime('<p>x</p>')).toBe(TAG + '<p>x</p>');
  });
  it('injects exactly once', () => expect(injectRuntime('<head></head><head></head>').split(TAG).length).toBe(2));
  it('ignores <header>', () => expect(injectRuntime('<header>x</header>')).toBe(TAG + '<header>x</header>'));

  const META = { title: 'T', themeColor: '#336699', iconVersion: 3 };
  const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  it('viewport is added only when missing', () => {
    expect(injectRuntime('<head></head>', META)).toContain(VIEWPORT);
    expect(injectRuntime('<head><meta name="viewport" content="width=500"></head>', META)).not.toContain(VIEWPORT);
    expect(injectRuntime("<head><META content='x' NAME = viewport></head>", META)).not.toContain(VIEWPORT);
    expect(injectRuntime('<head></head>', META).split('name="viewport"').length).toBe(2);
  });
  it('page tags go right after the runtime tag, inside the head', () => {
    const out = injectRuntime('<html><head><title>x</title></head></html>', META);
    expect(out.startsWith('<html><head>' + TAG + '<link rel="manifest"')).toBe(true);
    expect(out).toContain('<link rel="icon" type="image/png" href="/__lager/icon-192.png?v=3">');
  });
  it('own manifest link, any spelling, switches the page tags off but keeps the runtime', () => {
    for (const own of ['<link rel="manifest" href="/a.json">', "<LINK REL='Manifest' href=/a.json>", '<link href="/a.json" rel = "manifest">', '<link rel="prefetch manifest" href="/a.json">']) {
      const out = injectRuntime(`<head>${own}</head>`, META);
      expect(out, own).toContain(TAG);
      expect(out, own).not.toContain('/__lager/manifest.webmanifest');
      expect(out, own).not.toContain('theme-color');
    }
    expect(injectRuntime('<head><link rel="stylesheet" href="/manifest.css"></head>', META)).toContain('/__lager/manifest.webmanifest');
  });
  it('escapes the title and re-validates the colour', () => {
    const out = injectRuntime('<head></head>', { title: '"><b>&\'x', themeColor: 'red;"><script>', iconVersion: 1 });
    expect(out).toContain('content="&quot;&gt;&lt;b&gt;&amp;&#39;x"');
    expect(out).toContain('<meta name="theme-color" content="#1f2a5c">');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('<script>');
  });
  it('an unusable icon version becomes 0', () => {
    expect(injectRuntime('<head></head>', { ...META, iconVersion: Number.NaN })).toContain('icon-180.png?v=0');
  });
});

