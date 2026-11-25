import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { csrfToken } from '../src/http/session.js';
import { t } from '../src/i18n/index.js';
import { PASSWORD, showcase, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

describe('naming a new instance', () => {
  it('suggests a free name from the app and the person, with a number when it is taken', async () => {
    s = await showcase();
    const { core } = s.h;
    const tasks = core.apps.getApp('tasks')!;
    const uwe = core.users.get(s.ids.uwe)!;
    expect(core.apps.suggestSlug(tasks, uwe)).toBe('tasks-uwe');
    core.apps.createInstance({ appId: tasks.id, slug: 'tasks-uwe', ownerId: uwe.id });
    expect(core.apps.suggestSlug(tasks, uwe)).toBe('tasks-uwe-2');
    // Letters with accents and spaces become plain names.
    expect(core.apps.suggestSlug(tasks, { id: 'x', name: 'Zoë Müller', email: 'z@x.y' })).toBe('tasks-zoe');
    expect(core.apps.slugFreeFor('www', uwe.id)).toBe(false);
  });

  it('fills the suggestion in, explains the name and shows the address it becomes', async () => {
    s = await showcase();
    const cookie = await s.h.login('uwe@x.y', PASSWORD);
    const doc = new JSDOM((await request(s.h.app).get('/').set('Host', s.h.host).set('Cookie', cookie)).text).window.document;
    const input = doc.querySelector<HTMLInputElement>('details.getown input[name="slug"]')!;
    expect(input.getAttribute('value')).toBe('tasks-uwe');
    expect(input.getAttribute('pattern')).toBe('[a-z0-9]([a-z0-9\\-]*[a-z0-9])?');
    expect(input.getAttribute('autocapitalize')).toBe('none');
    const hint = doc.getElementById(input.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toBe(`${t('en', 'instance.slugHint')} http://tasks-uwe.apps.localhost:8080`);
    expect(doc.querySelector('label[for="new-tasks"]')!.textContent).toBe(t('en', 'home.copyName'));
    // One press gets the copy.
    const res = await request(s.h.app).post('/ui/apps/tasks/instances').set('Host', s.h.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrfToken(s.h.core, s.h.core.users.get(s.ids.uwe)!), from: 'home', slug: input.getAttribute('value')! });
    expect(res.status).toBe(302);
    expect(s.h.core.apps.getInstanceBySlug('tasks-uwe')!.ownerId).toBe(s.ids.uwe);
  });

  it('the script keeps the address in step with the name and focuses the field when the panel opens', () => {
    const html = `<!doctype html><body><details class="getown"><summary>Get</summary>
      <input id="n" name="slug" value="a" data-address-template="https://__slug__.apps.example.com"><code data-address-for="n">https://a.apps.example.com</code></details></body>`;
    const win = new JSDOM(html, { runScripts: 'outside-only' }).window;
    win.eval(fs.readFileSync(new URL('../src/static/app.js', import.meta.url), 'utf8'));
    const doc = win.document;
    const input = doc.querySelector('input')!;
    input.value = 'my-notes';
    input.dispatchEvent(new win.Event('input'));
    expect(doc.querySelector('code')!.textContent).toBe('https://my-notes.apps.example.com');
    const panel = doc.querySelector('details')!;
    panel.open = true;
    panel.dispatchEvent(new win.Event('toggle'));
    expect(doc.activeElement).toBe(input);
  });
});
