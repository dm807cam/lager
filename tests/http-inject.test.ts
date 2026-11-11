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
});
