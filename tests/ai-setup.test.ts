import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../src/i18n/index.js';
import { showcase, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

describe('Administration › AI model shows the setup order', () => {
  it('names the next of three steps at the top and links to it, until apps get a model by default', async () => {
    s = await showcase();
    const { core } = s.h;
    const cookie = await s.h.login();
    const page = async (): Promise<Document> => new JSDOM((await request(s!.h.app).get('/admin/ai').set('Host', s!.h.host).set('Cookie', cookie)).text).window.document;
    /** The page's status: its kind, its text and where its link leads. */
    const status = (doc: Document) => {
      const n = doc.querySelector('main .notice')!;
      return { kind: n.className.replace('notice notice-', ''), text: n.querySelector('span')!.textContent, link: n.querySelector('a')?.getAttribute('href') ?? null };
    };

    let doc = await page();
    expect(status(doc)).toEqual({ kind: 'warning', text: t('en', 'admin.ai.step.provider', { n: 1, total: 3 }), link: '#add-provider' });
    // The form it links to is open while there is no provider; there is no model form yet, and the empty list says why.
    expect(doc.querySelector('details#add-provider')!.hasAttribute('open')).toBe(true);
    expect(doc.querySelector('#add-model')).toBeNull();
    expect(doc.querySelector('.empty-detail')!.textContent).toBe(t('en', 'admin.ai.models.first'));

    const provider = core.ai.createProvider({ name: 'Local', type: 'ollama' });
    doc = await page();
    expect(status(doc)).toEqual({ kind: 'warning', text: t('en', 'admin.ai.step.model', { n: 2, total: 3 }), link: '#add-model' });
    // With a provider in the list its form folds away behind its button; the model form is open.
    expect(doc.querySelector('details#add-provider')!.hasAttribute('open')).toBe(false);
    expect(doc.querySelector('details#add-model')!.hasAttribute('open')).toBe(true);

    core.ai.createModel({ id: 'small', providerId: provider.id, model: 'llama3.2' });
    doc = await page();
    const everyone = core.ai.listGroups().find((g) => g.isDefault)!;
    expect(status(doc)).toEqual({ kind: 'warning', text: t('en', 'admin.ai.step.group', { n: 3, total: 3 }), link: `/admin/ai/groups/${everyone.id}` });

    core.ai.updateGroup(everyone.id, { name: everyone.name, modelId: 'small', hourlyLimit: everyone.hourlyLimit });
    doc = await page();
    expect(status(doc)).toEqual({ kind: 'success', text: t('en', 'admin.ai.status.ready', { model: 'small' }), link: null });
  });


  /** A provider that needs a key, saved with one that no longer decrypts (as after a change of the server secret). */
  const brokenCloud = (sc: Showcase) => {
    const cloud = sc.h.core.ai.createProvider({ name: 'Cloud', type: 'anthropic', apiKey: 'sk-test' });
    (sc.h.core.ai as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare('UPDATE ai_providers SET key_enc = ? WHERE id = ?').run('v1:broken:x:y', cloud.id);
    return cloud;
  };

  /** The page's notice: its kind, its text and where its link leads. */
  const statusOf = async (sc: Showcase) => {
    const doc = new JSDOM((await request(sc.h.app).get('/admin/ai').set('Host', sc.h.host).set('Cookie', await sc.h.login())).text).window.document;
    const n = doc.querySelector('main .notice')!;
    return { kind: n.className.replace('notice notice-', ''), text: n.querySelector('span')!.textContent, link: n.querySelector('a')?.getAttribute('href') ?? null };
  };

  it('a default model whose provider cannot be used points to that provider, not to a step that is done', async () => {
    s = await showcase();
    const { core } = s.h;
    const cloud = brokenCloud(s);
    core.ai.createModel({ id: 'big', providerId: cloud.id, model: 'claude' });
    const everyone = core.ai.listGroups().find((g) => g.isDefault)!;
    core.ai.updateGroup(everyone.id, { name: everyone.name, modelId: 'big', hourlyLimit: everyone.hourlyLimit });
    expect(await statusOf(s)).toEqual({
      kind: 'warning', text: t('en', 'admin.ai.status.unreachable', { model: 'big', provider: 'Cloud' }), link: `/admin/ai/providers/${cloud.id}`,
    });
  });

  it('says Ready only when Everyone else\'s own default works, not when another group\'s does', async () => {
    s = await showcase();
    const { core } = s.h;
    const local = core.ai.createProvider({ name: 'Local', type: 'ollama' });
    core.ai.createModel({ id: 'small', providerId: local.id, model: 'llama3.2' });
    const cloud = brokenCloud(s);
    core.ai.createModel({ id: 'big', providerId: cloud.id, model: 'claude' });
    core.ai.createGroup({ name: 'Family', modelId: 'small', hourlyLimit: 10 });
    const everyone = core.ai.listGroups().find((g) => g.isDefault)!;
    core.ai.updateGroup(everyone.id, { name: everyone.name, modelId: 'big', hourlyLimit: everyone.hourlyLimit });
    expect(core.ai.configured).toBe(true);
    const status = await statusOf(s);
    expect(status.kind).toBe('warning');
    expect(status.text).not.toBe(t('en', 'admin.ai.status.ready', { model: 'big' }));
    // With no default for Everyone else at all, a working group is reported as such, without a claim about the default.
    core.ai.updateGroup(everyone.id, { name: everyone.name, modelId: null, hourlyLimit: everyone.hourlyLimit });
    expect(await statusOf(s)).toEqual({ kind: 'success', text: t('en', 'admin.ai.status.on'), link: null });
  });
});
