import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from '../src/http/pages.js';
import { t } from '../src/i18n/index.js';
import { showcase, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

const SCRIPT = fs.readFileSync(new URL('../src/static/app.js', import.meta.url), 'utf8');

/** A page as the browser runs it: the server's markup with app.js applied. */
function run(html: string): JSDOM {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.eval(SCRIPT);
  return dom;
}

describe('show password', () => {
  it('the platform pages carry the button labels in the viewer’s language; instance hosts do not', async () => {
    s = await showcase();
    const login = new JSDOM((await request(s.h.app).get('/login').set('Host', s.h.host).set('Cookie', 'lager_lang=de')).text).window.document;
    expect(login.body.getAttribute('data-show-password')).toBe(t('de', 'password.show'));
    expect(login.body.getAttribute('data-hide-password')).toBe(t('de', 'password.hide'));
    // The pasted keys of the administration area keep a plain password field.
    const mail = new JSDOM((await request(s.h.app).get('/admin/mail').set('Host', s.h.host).set('Cookie', await s.h.login())).text).window.document;
    expect(mail.getElementById('smtp-password')!.getAttribute('data-reveal')).toBe('off');
    const ai = new JSDOM((await request(s.h.app).get('/admin/ai').set('Host', s.h.host).set('Cookie', await s.h.login())).text).window.document;
    expect(ai.getElementById('ai-key')!.getAttribute('data-reveal')).toBe('off');
    // A page served on an instance host (its origin set) carries no labels, even with a password field on it.
    const instance = new JSDOM(page('de', 'Notes', '<form><input id="p" type="password"></form>', { origin: 'http://localhost:8080' })).window.document;
    expect(instance.querySelector('#p')).not.toBeNull();
    expect([instance.body.hasAttribute('data-show-password'), instance.body.hasAttribute('data-hide-password')]).toEqual([false, false]);
  });

  it('a shown password is a password field again while a question about the form is open, and when it is sent', () => {
    const dom = new JSDOM(`<!doctype html><body data-show-password="Show password" data-hide-password="Hide password">
      <form method="post" action="/x" data-confirm="Delete your account?" data-confirm-ok="Delete"><input id="current" type="password">
      <button type="submit" id="go">Delete</button></form></body>`, { runScripts: 'outside-only' });
    const win = dom.window;
    win.HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    win.HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new win.Event('close')); };
    const types: string[] = [];
    win.HTMLFormElement.prototype.submit = function (this: HTMLFormElement) { types.push((this.querySelector('#current') as HTMLInputElement).type); };
    win.eval(SCRIPT);
    const doc = win.document;
    const input = doc.getElementById('current') as HTMLInputElement;
    (input.parentElement!.querySelector('button.reveal-btn') as HTMLButtonElement).click();
    expect(input.type).toBe('text');
    doc.querySelector('form')!.dispatchEvent(new win.SubmitEvent('submit', { cancelable: true, submitter: doc.getElementById('go') }));
    expect(doc.querySelector('dialog[open]')).not.toBeNull();
    expect(input.type).toBe('password');
    (doc.querySelector('dialog .btn-danger') as HTMLButtonElement).click();
    expect(types).toEqual(['password']);
  });

  it('a button in the field shows and hides it, and the field is a password field again when the form is sent', () => {
    const dom = run(`<!doctype html><body data-show-password="Show password" data-hide-password="Hide password">
      <form><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" autofocus>
      <input id="key" type="password" data-reveal="off"><button type="submit">Sign in</button></form></body>`);
    const doc = dom.window.document;
    const input = doc.getElementById('password') as HTMLInputElement;
    const button = input.parentElement!.querySelector('button.reveal-btn') as HTMLButtonElement;
    expect(input.parentElement!.className).toBe('reveal');
    expect([button.type, button.getAttribute('aria-pressed'), button.getAttribute('aria-label')]).toEqual(['button', 'false', 'Show password']);
    button.click();
    expect([input.type, button.getAttribute('aria-pressed'), button.getAttribute('aria-label')]).toEqual(['text', 'true', 'Hide password']);
    button.click();
    expect(input.type).toBe('password');
    button.click();
    doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    expect([input.type, button.getAttribute('aria-pressed')]).toEqual(['password', 'false']);
    // A pasted key gets no button.
    expect(doc.getElementById('key')!.parentElement!.classList.contains('reveal')).toBe(false);
  });

  it('without the labels (an instance host) the fields stay as they are', () => {
    const doc = run('<!doctype html><body><form><input id="p" type="password"></form></body>').window.document;
    expect(doc.querySelector('.reveal')).toBeNull();
  });
});
