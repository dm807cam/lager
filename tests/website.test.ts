import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain ES module without type declarations, run by the Pages workflow with Node alone.
import * as site from '../scripts/website.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lager-site-'));

describe('markdown', () => {
  it('renders the blocks a post uses', () => {
    const html = site.markdown([
      '## A heading', '', 'Some **bold**, *italic*, `code` and a [link](https://example.org).', '',
      '- one', '- two', '  - nested', '', '1. first', '2. second', '', '> quoted', '',
      '```json', '{"a": "<b>"}', '```', '', '| A | B |', '|---|--:|', '| 1 | 2 |', '', '---', '',
      '![A shelf with boxes](/assets/x.webp)',
    ].join('\n'));
    expect(html).toContain('<h3 id="a-heading">A heading</h3>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://example.org" rel="noopener">link</a>');
    expect(html).toContain('<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(html).toContain('<pre><code class="language-json">{&quot;a&quot;: &quot;&lt;b&gt;&quot;}</code></pre>');
    expect(html).toContain('<th style="text-align:right">B</th>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<figure><img src="/assets/x.webp" alt="A shelf with boxes" loading="lazy"><figcaption>A shelf with boxes</figcaption></figure>');
  });

  it('never lets HTML or script through', () => {
    const html = site.markdown('<script>alert(1)</script>\n\n[click](javascript:alert(1)) <img src=x onerror=alert(1)> [x](//evil.example)');
    expect(html).not.toMatch(/<script|<img src=x|href="javascript|href="\/\//);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('click');
  });

  it('keeps code inside a link label', () => {
    expect(site.inline('[`managedOrigins`](https://example.org/docs) and [**bold** link](/blog/)'))
      .toBe('<a href="https://example.org/docs" rel="noopener"><code>managedOrigins</code></a> and <a href="/blog/"><strong>bold</strong> link</a>');
  });

  it('keeps underscores in words and code intact', () => {
    expect(site.inline('snake_case_name and `a*b*c`')).toBe('snake_case_name and <code>a*b*c</code>');
  });
});

describe('posts', () => {
  const post = (front: string, body = 'Hello.') => `---\n${front}\n---\n${body}`;

  it('reads front matter and derives the slug, reading time and defaults', () => {
    const p = site.parsePost('2026-11-21-hello-world.md', post('title: Hello\ndescription: "A post"\ndate: 2026-11-21\ntags: [one, two]', 'word '.repeat(440)));
    expect(p).toMatchObject({ slug: 'hello-world', title: 'Hello', description: 'A post', author: 'The Lager team', tags: ['one', 'two'], minutes: 2, draft: false });
  });

  it('refuses posts it cannot publish safely', () => {
    expect(() => site.parsePost('a.md', 'no front matter')).toThrow(/front matter/);
    expect(() => site.parsePost('a.md', post('title: T\ndate: 2026-11-21'))).toThrow(/description/);
    expect(() => site.parsePost('a.md', post('title: T\ndescription: D\ndate: 21.11.2026'))).toThrow(/date/);
    expect(() => site.parsePost('2026-11-21-Bad_Slug.md', post('title: T\ndescription: D\ndate: 2026-11-21'))).toThrow(/slug/);
  });

  it('hides drafts and future posts and sorts the newest first', () => {
    const dir = tmp();
    const write = (name: string, front: string) => fs.writeFileSync(path.join(dir, name), post(`title: ${name}\ndescription: d\n${front}`));
    write('2026-11-01-old.md', 'date: 2026-11-01');
    write('2026-11-20-new.md', 'date: 2026-11-20');
    write('2026-12-24-later.md', 'date: 2026-12-24');
    write('2026-11-10-draft.md', 'date: 2026-11-10\ndraft: true');
    expect(site.loadPosts(dir, { today: '2026-11-20' }).map((p: { slug: string }) => p.slug)).toEqual(['new', 'old']);
    expect(site.loadPosts(dir, { today: '2026-12-24' }).map((p: { slug: string }) => p.slug)).toEqual(['later', 'new', 'old']);
  });
});

describe('changelog', () => {
  it('reads the real CHANGELOG.md: releases newest first, with dates and links', () => {
    const releases = site.parseChangelog(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'));
    const released = releases.filter((r: { unreleased: boolean }) => !r.unreleased);
    expect(released.length).toBeGreaterThanOrEqual(2);
    for (const r of released) {
      expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.url).toMatch(/^https:\/\/github\.com\/dm807cam\/lager\//);
      expect(r.sections.length).toBeGreaterThan(0);
    }
    expect(released.map((r: { date: string }) => r.date)).toEqual([...released.map((r: { date: string }) => r.date)].sort().reverse());
  });

  it('shows an Unreleased section only when it has entries', () => {
    const text = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-02\n\n### Added\n\n- **A thing:** works.\n\n[1.0.0]: https://example.org/v1\n';
    const releases = site.parseChangelog(text);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ version: '1.0.0', date: '2026-01-02', url: 'https://example.org/v1', sections: [{ title: 'Added', count: 1 }] });
    expect(releases[0].html).toContain('<h3 id="added">Added</h3>');
    expect(site.parseChangelog(text.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n\n- x\n'))[0].unreleased).toBe(true);
  });
});

describe('build', () => {
  it('builds the real website: changelog, blog, every post, feed, sitemap, and no broken local link', () => {
    const out = tmp();
    const result = site.build(out, { today: '2099-01-01' });
    const posts = fs.readdirSync(path.join(ROOT, 'website/blog/posts')).filter((f) => f.endsWith('.md'));
    expect(result.posts).toBe(posts.length);
    for (const file of ['index.html', 'assets/site.css', 'changelog/index.html', 'blog/index.html', 'blog/feed.xml', 'sitemap.xml', 'robots.txt']) {
      expect(fs.existsSync(path.join(out, file)), file).toBe(true);
    }
    // Markdown sources are rendered, not published.
    expect(fs.existsSync(path.join(out, 'blog/posts'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'blog/AUTHORING.md'))).toBe(false);
    const blog = fs.readFileSync(path.join(out, 'blog/index.html'), 'utf8');
    const feed = fs.readFileSync(path.join(out, 'blog/feed.xml'), 'utf8');
    for (const p of site.loadPosts(path.join(ROOT, 'website/blog/posts'), { today: '2099-01-01' })) {
      expect(fs.existsSync(path.join(out, `blog/${p.slug}/index.html`))).toBe(true);
      expect(blog).toContain(`/blog/${p.slug}/`);
      expect(feed).toContain(`https://lager.im/blog/${p.slug}/`);
    }
    // Every generated page is counted like the home page.
    const index = fs.readFileSync(path.join(ROOT, 'website/index.html'), 'utf8');
    if (site.trackerOf(index)) expect(fs.readFileSync(path.join(out, 'changelog/index.html'), 'utf8')).toContain(site.trackerOf(index));
    expect(site.checkLinks(out)).toEqual([]);
  });

  it('fails on a local link to a file that does not exist', () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, 'index.html'), '<a href="/blog/">x</a><img src="assets/nope.png"><a href="https://example.org">ok</a><a href="#top">ok</a>');
    expect(site.checkLinks(out)).toEqual(['index.html → /blog/', 'index.html → assets/nope.png']);
  });
});
