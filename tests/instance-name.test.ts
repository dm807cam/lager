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
  it('suggests the app name with the first free number, and nothing about the person', async () => {
    s = await showcase();
    const { core } = s.h;
    const tasks = core.apps.getApp('tasks')!;
    const uwe = core.users.get(s.ids.uwe)!;
    // "tasks" is Pia's own copy.
    expect(core.apps.suggestSlug(tasks, uwe.id)).toBe('tasks-2');
    const mine = core.apps.createInstance({ appId: tasks.id, slug: 'tasks-2', ownerId: uwe.id });
    expect(core.apps.suggestSlug(tasks, uwe.id)).toBe('tasks-3');
    // A deleted copy's name stays kept for its owner: suggested to them again, to nobody else, and not when the owner is not known yet.
    core.apps.deleteInstance(mine.id, uwe.id);
    expect(core.apps.suggestSlug(tasks, uwe.id)).toBe('tasks-2');
    expect(core.apps.suggestSlug(tasks, s.ids.pia)).toBe('tasks-3');
    expect(core.apps.suggestSlug(tasks, null)).toBe('tasks-3');
    expect(core.apps.slugFreeFor('www', uwe.id)).toBe(false);
  });

  it('suggests nothing when no short name is free, and the address then shows "…"', async () => {
    s = await showcase();
    const { core } = s.h;
    core.apps.slugFreeFor = () => false;
    expect(core.apps.suggestSlug(core.apps.getApp('tasks')!, s.ids.uwe)).toBeNull();
    const doc = new JSDOM((await request(s.h.app).get('/').set('Host', s.h.host).set('Cookie', await s.h.login('uwe@x.y', PASSWORD))).text).window.document;
    const input = doc.querySelector<HTMLInputElement>('details.getown input[name="slug"]')!;
    expect(input.hasAttribute('value')).toBe(false);
    expect(doc.querySelector(`[data-address-for="${input.id}"]`)!.textContent).toBe('http://….apps.localhost:8080');
  });

  it('on the app page, where another owner can be named, suggests no name kept for the viewer', async () => {
    s = await showcase();
    const { core } = s.h;
    const notes = core.apps.getApp('notes')!;
    // "notes-2" belonged to the administrator: a copy made here may be for someone else.
    const old = core.apps.createInstance({ appId: notes.id, slug: 'notes-2', ownerId: s.h.adminId });
    core.apps.deleteInstance(old.id, s.h.adminId);
    const doc = new JSDOM((await request(s.h.app).get('/apps/notes').set('Host', s.h.host).set('Cookie', await s.h.login())).text).window.document;
    expect(doc.getElementById('owner-email')).not.toBeNull();
    expect(doc.querySelector<HTMLInputElement>('#new-slug')!.getAttribute('value')).toBe('notes-3');
  });

  it('fills the suggestion in, explains the name and shows the address it becomes', async () => {
    s = await showcase();
    const cookie = await s.h.login('uwe@x.y', PASSWORD);
    const doc = new JSDOM((await request(s.h.app).get('/').set('Host', s.h.host).set('Cookie', cookie)).text).window.document;
    const input = doc.querySelector<HTMLInputElement>('details.getown input[name="slug"]')!;
    expect(input.getAttribute('value')).toBe('tasks-2');
    expect(input.getAttribute('pattern')).toBe('[a-z0-9]([a-z0-9\\-]*[a-z0-9])?');
    expect(input.getAttribute('autocapitalize')).toBe('none');
    const hint = doc.getElementById(input.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toBe(`${t('en', 'instance.slugHint')} http://tasks-2.apps.localhost:8080`);
    expect(doc.querySelector('label[for="new-tasks"]')!.textContent).toBe(t('en', 'home.copyName'));
    // One press gets the copy.
    const res = await request(s.h.app).post('/ui/apps/tasks/instances').set('Host', s.h.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrfToken(s.h.core, s.h.core.users.get(s.ids.uwe)!), from: 'home', slug: input.getAttribute('value')! });
    expect(res.status).toBe(302);
    expect(s.h.core.apps.getInstanceBySlug('tasks-2')!.ownerId).toBe(s.ids.uwe);
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

  it('the address follows a refused name that came back in the field, before anything is typed', () => {
    const html = `<!doctype html><body><input id="n" name="slug" value="www" data-address-template="https://__slug__.apps.example.com">
      <code data-address-for="n">https://notes-2.apps.example.com</code></body>`;
    const win = new JSDOM(html, { runScripts: 'outside-only' }).window;
    win.eval(fs.readFileSync(new URL('../src/static/app.js', import.meta.url), 'utf8'));
    expect(win.document.querySelector('code')!.textContent).toBe('https://www.apps.example.com');
  });
});
