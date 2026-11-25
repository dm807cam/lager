#!/usr/bin/env node
// Builds the lager.im website into an output folder: copies website/, and generates the changelog page from
// CHANGELOG.md and the blog from website/blog/posts/*.md (index, one page per post, an Atom feed) plus a sitemap.
// No dependencies, so the Pages workflow runs it with the runner's Node alone:
//
//   node scripts/website.mjs _site
//
// Posts are Markdown with a small front matter block; see website/blog/AUTHORING.md. Raw HTML in Markdown is
// escaped, never passed through: posts may be written by an assistant, and the page must not run what they contain.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SITE_URL = 'https://lager.im';
const REPO_URL = 'https://github.com/dm807cam/lager';

// ------------------------------------------------------------------ markdown

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** @param {unknown} s */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Only links that cannot run script: http(s), mailto, and site-relative or fragment links. */
export function safeUrl(url) {
  const u = String(url).trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null;
  if (u.startsWith('//')) return null;
  return u;
}

/** Bold, italic and strikethrough on text that is already escaped. */
function emphasis(s) {
  return s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

/** Inline Markdown: code, images, links, autolinks, bold, italic, strikethrough. Everything else is escaped. */
export function inline(text) {
  // Finished pieces wait in slots behind a marker no input can contain, so later steps never touch them.
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(text).replace(/\u0000/g, '');
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => keep(`<code>${esc(code.trim())}</code>`));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, alt, url, title) => {
    const u = safeUrl(url);
    return u === null ? keep(esc(m)) : keep(`<img src="${esc(u)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ''} loading="lazy">`);
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, label, url, title) => {
    const u = safeUrl(url);
    if (u === null) return keep(emphasis(esc(label)));
    const ext = /^https?:/i.test(u) && !u.startsWith(SITE_URL);
    return keep(`<a href="${esc(u)}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' rel="noopener"' : ''}>${emphasis(esc(label))}</a>`);
  });
  s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_, u) => keep(`<a href="${esc(u)}" rel="noopener">${esc(u)}</a>`));
  s = emphasis(esc(s));
  // A link's label may hold a code slot, so restore until no marker is left.
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
  return s;
}

export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/<[^>]*>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

/**
 * Block Markdown: headings (with ids), paragraphs, fenced code, block quotes, nested lists, tables and rules.
 * `headingOffset` shifts heading levels. Left out, the shallowest heading of the text becomes an h2: under the page's own h1,
 * whether a post starts its sections with "#" or "##", so the outline never skips a level (WCAG 1.3.1).
 */
export function markdown(src, { headingOffset } = {}) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  if (headingOffset === undefined) {
    let fenced = false;
    const levels = lines.filter((l) => { if (/^```/.test(l)) fenced = !fenced; return !fenced && /^#{1,6}\s/.test(l); }).map((l) => /^#+/.exec(l)[0].length);
    headingOffset = levels.length ? 2 - Math.min(...levels) : 1;
  }
  const out = [];
  let i = 0;
  const isBlank = (l) => /^\s*$/.test(l);
  const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const startsBlock = (l) => /^(#{1,6})\s/.test(l) || /^```/.test(l) || /^>\s?/.test(l) || listRe.test(l) || /^(\*{3,}|-{3,}|_{3,})\s*$/.test(l) || /^\|.*\|\s*$/.test(l);

  function list(baseIndent) {
    const first = listRe.exec(lines[i]);
    const ordered = /\d/.test(first[2]);
    const start = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    while (i < lines.length) {
      const m = listRe.exec(lines[i]);
      if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
      let text = m[3]; i++;
      const children = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const sub = listRe.exec(lines[i]);
        if (sub && sub[1].length > baseIndent) { children.push(list(sub[1].length)); continue; }
        if (sub || startsBlock(lines[i].trimStart())) break;
        text += ' ' + lines[i].trim(); i++;
      }
      if (i < lines.length && isBlank(lines[i]) && listRe.test(lines[i + 1] ?? '') && listRe.exec(lines[i + 1])[1].length === baseIndent) i++;
      items.push(`<li>${inline(text)}${children.join('')}</li>`);
    }
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</${tag}>`;
  }

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m;
    if ((m = /^```\s*([\w+-]*)\s*$/.exec(line))) {
      const lang = m[1]; const code = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      // A long line scrolls sideways; tabindex lets a keyboard reach the block to scroll it (WCAG 2.1.1).
      out.push(`<pre tabindex="0"><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      const level = Math.min(6, m[1].length + headingOffset);
      out.push(`<h${level} id="${slugify(m[2])}">${inline(m[2])}</h${level}>`); i++;
    } else if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>'); i++;
    } else if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdown(quote.join('\n'), { headingOffset })}</blockquote>`);
    } else if (listRe.test(line)) {
      out.push(list(listRe.exec(line)[1].length));
    } else if (/^\|.*\|\s*$/.test(line) && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
      out.push(`<div class="table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, k) => td('td', c, k)).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else {
      const para = [];
      while (i < lines.length && !isBlank(lines[i]) && !(para.length && startsBlock(lines[i]))) para.push(lines[i++].trim());
      const text = para.join(' ');
      // An image alone in its paragraph becomes a figure with its alt text as the caption.
      const fig = /^!\[([^\]]+)\]\(([^)\s]+)\)$/.exec(text);
      out.push(fig && safeUrl(fig[2]) !== null ? `<figure>${inline(text)}<figcaption>${inline(fig[1])}</figcaption></figure>` : `<p>${inline(text)}</p>`);
    }
  }
  return out.join('\n');
}

/** Plain text of Markdown, for descriptions, reading time and the feed. */
export const plain = (md) => String(md).replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#>*_`|~-]+/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ posts

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Front matter (`key: value`, lists as `[a, b]`) and body of a post. Throws with the file name on anything missing. */
export function parsePost(file, text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(String(text).replace(/\r\n?/g, '\n'));
  if (!m) throw new Error(`${file}: a post starts with a front matter block between two "---" lines`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${file}: cannot read front matter line "${line}"`);
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    meta[kv[1]] = v;
  }
  for (const key of ['title', 'description', 'date']) if (!meta[key]) throw new Error(`${file}: front matter needs "${key}"`);
  if (!DATE_RE.test(meta.date)) throw new Error(`${file}: date must look like 2026-11-20`);
  const base = path.basename(file, '.md');
  const slug = meta.slug || base.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`${file}: the slug "${slug}" may only use a-z, 0-9 and single hyphens`);
  const body = m[2].trim();
  const words = plain(body).split(' ').filter(Boolean).length;
  return {
    file, slug, title: meta.title, description: meta.description, date: meta.date, author: meta.author || 'The Lager team',
    tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [], image: meta.image || '',
    draft: meta.draft === 'true', ai: meta.ai === 'true', body, html: markdown(body), minutes: Math.max(1, Math.round(words / 220)), words,
  };
}

export function loadPosts(dir, { includeDrafts = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!fs.existsSync(dir)) return [];
  const posts = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => parsePost(f, fs.readFileSync(path.join(dir, f), 'utf8')))
    // A post dated in the future waits until its day, so a merged post can be scheduled.
    .filter((p) => includeDrafts || (!p.draft && p.date <= today))
    .sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : b.date.localeCompare(a.date)));
  const seen = new Set();
  for (const p of posts) { if (seen.has(p.slug)) throw new Error(`two posts share the slug "${p.slug}"`); seen.add(p.slug); }
  return posts;
}

// ------------------------------------------------------------------ changelog

/** Releases from a Keep a Changelog file: [{version, date, url, html, sections: [{title, items}]}], newest first. */
export function parseChangelog(text) {
  // Links in CHANGELOG.md are relative to the repository (docs/…); on the website they point to GitHub.
  const src = String(text).replace(/\r\n?/g, '\n').replace(/\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+)\)/gi, `](${REPO_URL}/blob/main/$1)`);
  const links = Object.fromEntries([...src.matchAll(/^\[([^\]]+)\]:\s*(\S+)\s*$/gm)].map((m) => [m[1], m[2]]));
  const parts = src.split(/^## /m).slice(1);
  return parts.map((part) => {
    const nl = part.indexOf('\n');
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    const body = (nl < 0 ? '' : part.slice(nl + 1)).replace(/^\[[^\]]+\]:\s*\S+\s*$/gm, '').trim();
    const hm = /^\[?([^\]\s]+)\]?(?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/.exec(head);
    const version = hm ? hm[1] : head;
    const sections = body.split(/^### /m).slice(1).map((s) => {
      const k = s.indexOf('\n');
      return { title: s.slice(0, k).trim(), count: (s.match(/^- /gm) || []).length };
    });
    return { version, date: hm && hm[2] ? hm[2] : '', url: links[version] || '', unreleased: /^unreleased$/i.test(version), sections, html: markdown(body, { headingOffset: 0 }) };
  }).filter((r) => r.unreleased ? r.sections.length > 0 : true);
}

// ------------------------------------------------------------------ pages

const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Comments under a post, from our own Lager. The page id is the post's address, so a post keeps its thread whatever the host. */
const COMMENTS_URL = 'https://kommentare.ontheblock.xyz/';
export function commentsBox(slug) {
  return `<section class="comments" aria-label="Comments">
  <!-- Comments: on our own Lager (${COMMENTS_URL}), embedded with frame-ancestors. Visitors write as guests; every comment is approved before it shows. -->
  <div id="lager-comments" data-site="lager.im" data-page="/blog/${esc(slug)}/" data-lang="en" data-theme="auto" data-accent="#b45309"></div>
  <script>
  (function(){
    var box=document.getElementById("lager-comments");
    var u=new URL("${COMMENTS_URL}");
    u.searchParams.set("site",box.getAttribute("data-site")||location.hostname);
    u.searchParams.set("page",box.getAttribute("data-page")||location.pathname);
    u.searchParams.set("u",location.href.split("#")[0]);
    ["theme","accent","lang"].forEach(function(k){var v=box.getAttribute("data-"+k);if(v)u.searchParams.set(k,v)});
    var f=document.createElement("iframe");
    f.src=u.href;f.title="Comments";f.loading="lazy";
    f.style.cssText="width:100%;border:0;height:360px;display:block";
    box.appendChild(f);
    window.addEventListener("message",function(e){
      if(e.source===f.contentWindow&&e.data&&e.data.lagerCommentsHeight)f.style.height=e.data.lagerCommentsHeight+"px";
    });
  })();
  </script>
</section>`;
}

/** The cookie-free statistics snippet of the home page, so every generated page is counted the same way. */
export function trackerOf(indexHtml) {
  const m = /<!-- Byline[\s\S]*?<\/script>\n?/.exec(indexHtml);
  return m ? m[0] : '';
}

function shell({ title, description, url, body, active, tracker, type = 'website', extraHead = '' }) {
  const full = title === 'Lager' ? title : `${title} · Lager`;
  const nav = [['/blog/', 'Blog', 'blog'], ['/changelog/', 'Changelog', 'changelog'], ['https://github.com/dm807cam/lager/blob/main/docs/README.md', 'Docs', 'docs']];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#1f2a5c">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="${type}">
<meta property="og:url" content="${esc(SITE_URL + url)}">
<meta property="og:image" content="${SITE_URL}/assets/hero.webp">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${esc(SITE_URL + url)}">
<link rel="icon" href="/assets/icon-192.png">
<link rel="apple-touch-icon" href="/assets/icon-192.png">
<link rel="alternate" type="application/atom+xml" title="The Lager blog" href="/blog/feed.xml">
<link rel="stylesheet" href="/assets/site.css">
${extraHead}${tracker}</head>
<body>
<header class="site">
  <div class="wrap">
    <a class="brand" href="/"><img src="/assets/icon-192.png" alt="" width="32" height="32">Lager</a>
    <nav aria-label="Main">
      ${nav.map(([href, label, key]) => `<a${active === key ? ' class="on"' : ''} href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`).join('\n      ')}
      <a class="gh" href="${REPO_URL}">GitHub</a>
    </nav>
  </div>
</header>
<main>
${body}
</main>
<footer>
  <div class="wrap">
    <p><strong>Lager</strong> is German for storeroom. Free software under the AGPL.</p>
    <nav aria-label="Footer">
      <a href="/">Home</a>
      <a href="/blog/">Blog</a>
      <a href="/blog/feed.xml">Feed</a>
      <a href="/changelog/">Changelog</a>
      <a href="${REPO_URL}">GitHub</a>
      <a href="${REPO_URL}/discussions">Discussions</a>
    </nav>
    <p class="small">Lager is an independent project and is not affiliated with or endorsed by Anthropic or OpenAI. Claude and ChatGPT are trademarks of their owners.</p>
  </div>
</footer>
</body>
</html>
`;
}

const tagList = (tags) => (tags.length ? `<ul class="tags">${tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
const INSTALL = 'curl -fsSL https://raw.githubusercontent.com/dm807cam/lager/main/install.sh | sudo bash';

export function blogIndexPage(posts, tracker) {
  const [lead, ...rest] = posts;
  const card = (p, big) => `<article class="post-card${big ? ' lead' : ''}">
  <p class="meta"><time datetime="${p.date}">${fmtDate(p.date)}</time> · ${p.minutes} min read</p>
  <h${big ? 2 : 3}><a href="/blog/${p.slug}/">${esc(p.title)}</a></h${big ? 2 : 3}>
  <p>${esc(p.description)}</p>
  ${tagList(p.tags)}
</article>`;
  const body = `<div class="wrap page">
  <p class="eyebrow">The Lager blog</p>
  <h1>Things you can build when your AI has a place to put them</h1>
  <p class="lede">Ideas, walk-throughs and small stories about apps that live on Lager. <a href="/blog/feed.xml">Subscribe with any feed reader</a>.</p>
  ${posts.length ? `${card(lead, true)}<div class="post-grid">${rest.map((p) => card(p, false)).join('\n')}</div>` : '<p class="empty">The first post is on its way.</p>'}
</div>`;
  return shell({ title: 'Blog', description: 'Ideas, walk-throughs and stories about apps that live on Lager.', url: '/blog/', body, active: 'blog', tracker });
}

export function postPage(post, { newer, older }, tracker) {
  const jsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: post.title, description: post.description, datePublished: post.date, author: { '@type': 'Organization', name: post.author }, url: `${SITE_URL}/blog/${post.slug}/` }).replace(/</g, '\\u003c');
  const body = `<article class="wrap post">
  <p class="back"><a href="/blog/">← All posts</a></p>
  <header class="post-head">
    <p class="meta"><time datetime="${post.date}">${fmtDate(post.date)}</time> · ${post.minutes} min read · ${esc(post.author)}</p>
    <h1>${esc(post.title)}</h1>
    <p class="lede">${esc(post.description)}</p>
    ${tagList(post.tags)}
    ${post.ai ? '<p class="ai-note">This post was created with the assistance of AI and reviewed by the Lager team.</p>' : ''}
  </header>
  <div class="prose">
${post.html}
  </div>
  ${commentsBox(post.slug)}
  <aside class="cta">
    <h2>Try it on your own server</h2>
    <p>One command sets up Lager on a Raspberry Pi or any 64-bit Linux machine. Then ask your assistant for an app.</p>
    <pre tabindex="0" role="group" aria-label="Install command"><code>${esc(INSTALL)}</code></pre>
    <p><a class="btn primary" href="${REPO_URL}#quick-start">Get started</a> <a class="btn ghost" href="/blog/feed.xml">Follow the blog</a></p>
  </aside>
  <nav class="pager" aria-label="More posts">
    ${newer ? `<a href="/blog/${newer.slug}/"><span>Newer</span>${esc(newer.title)}</a>` : '<span></span>'}
    ${older ? `<a class="older" href="/blog/${older.slug}/"><span>Older</span>${esc(older.title)}</a>` : '<span></span>'}
  </nav>
</article>`;
  return shell({ title: post.title, description: post.description, url: `/blog/${post.slug}/`, body, active: 'blog', tracker, type: 'article',
    extraHead: `<meta property="article:published_time" content="${post.date}">\n<script type="application/ld+json">${jsonLd}</script>\n` });
}

export function changelogPage(releases, tracker) {
  const items = releases.map((r) => `<section class="release${r.unreleased ? ' next' : ''}" id="${r.unreleased ? 'unreleased' : `v${esc(r.version)}`}">
  <div class="release-head">
    <h2>${r.unreleased ? 'Coming in the next release' : `Lager ${esc(r.version)}`}</h2>
    <p class="meta">${r.unreleased ? 'Already on <code>main</code> and in the <code>:edge</code> image' : `<time datetime="${r.date}">${r.date ? fmtDate(r.date) : ''}</time>`}${r.url && !r.unreleased ? ` · <a href="${esc(r.url)}" rel="noopener">${r.version === releases[releases.length - 1].version ? 'Release' : 'Compare'} on GitHub</a>` : ''}</p>
    <ul class="counts">${r.sections.map((s) => `<li class="k-${slugify(s.title)}">${esc(s.title)} <b>${s.count}</b></li>`).join('')}</ul>
  </div>
  <div class="prose">
${r.html}
  </div>
</section>`).join('\n');
  const latest = releases.find((r) => !r.unreleased);
  const body = `<div class="wrap page">
  <p class="eyebrow">Changelog</p>
  <h1>What's new in Lager</h1>
  <p class="lede">Every release, as it appears in <a href="${REPO_URL}/blob/main/CHANGELOG.md" rel="noopener">CHANGELOG.md</a>.${latest ? ` The latest is <a href="#v${esc(latest.version)}">${esc(latest.version)}</a>.` : ''} Running the installer again updates your server.</p>
  ${items}
</div>`;
  return shell({ title: 'Changelog', description: 'Every Lager release and what it changed.', url: '/changelog/', body, active: 'changelog', tracker });
}

export function atomFeed(posts) {
  const updated = posts[0] ? `${posts[0].date}T08:00:00Z` : new Date().toISOString();
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>The Lager blog</title>
  <subtitle>Things you can build when your AI has a place to put them.</subtitle>
  <link href="${SITE_URL}/blog/feed.xml" rel="self"/>
  <link href="${SITE_URL}/blog/"/>
  <id>${SITE_URL}/blog/</id>
  <updated>${updated}</updated>
  <icon>${SITE_URL}/assets/icon-192.png</icon>
${posts.slice(0, 30).map((p) => `  <entry>
    <title>${esc(p.title)}</title>
    <link href="${SITE_URL}/blog/${p.slug}/"/>
    <id>${SITE_URL}/blog/${p.slug}/</id>
    <published>${p.date}T08:00:00Z</published>
    <updated>${p.date}T08:00:00Z</updated>
    <author><name>${esc(p.author)}</name></author>
    <summary>${esc(p.description)}</summary>
    <content type="html">${esc(p.html)}</content>
${p.tags.map((t) => `    <category term="${esc(t)}"/>`).join('\n')}
  </entry>`).join('\n')}
</feed>
`;
}

export function sitemap(posts) {
  const urls = ['/', '/blog/', '/changelog/', ...posts.map((p) => `/blog/${p.slug}/`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE_URL}${u}</loc></url>`).join('\n')}
</urlset>
`;
}

// ------------------------------------------------------------------ build

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (skip(src, entry)) continue;
    if (entry.isDirectory()) copyDir(src, dst, skip);
    else fs.copyFileSync(src, dst);
  }
}

/** Every local src and href of the built pages must exist, so a broken link fails the build, not the visitor. */
export function checkLinks(outDir) {
  const missing = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(outDir).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(file, 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(ref)) continue;
      const clean = decodeURI(ref.split(/[?#]/)[0]);
      if (!clean) continue;
      let target = clean.startsWith('/') ? path.join(outDir, clean) : path.join(path.dirname(file), clean);
      if (clean.endsWith('/')) target = path.join(target, 'index.html');
      if (!fs.existsSync(target)) missing.push(`${path.relative(outDir, file)} → ${ref}`);
    }
  }
  return missing;
}

export function build(outDir, { root = ROOT, today } = {}) {
  const site = path.join(root, 'website');
  const postsDir = path.join(site, 'blog', 'posts');
  fs.rmSync(outDir, { recursive: true, force: true });
  // Markdown sources (posts, the authoring guide) are rendered, not served.
  copyDir(site, outDir, (src, entry) => !entry.isDirectory() && src.endsWith('.md'));
  const posts = loadPosts(postsDir, { today });
  const tracker = trackerOf(fs.readFileSync(path.join(site, 'index.html'), 'utf8'));
  const write = (rel, content) => { const f = path.join(outDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
  fs.rmSync(path.join(outDir, 'blog', 'posts'), { recursive: true, force: true });
  write('blog/index.html', blogIndexPage(posts, tracker));
  posts.forEach((p, k) => write(`blog/${p.slug}/index.html`, postPage(p, { newer: posts[k - 1], older: posts[k + 1] }, tracker)));
  write('blog/feed.xml', atomFeed(posts));
  write('changelog/index.html', changelogPage(parseChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')), tracker));
  write('sitemap.xml', sitemap(posts));
  write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  const missing = checkLinks(outDir);
  if (missing.length) throw new Error(`Missing files:\n  ${missing.join('\n  ')}`);
  return { posts: posts.length, pages: posts.length + 2 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] || '_site');
  try {
    const r = build(out);
    console.log(`Built ${out}: ${r.posts} post(s), changelog, feed and sitemap.`);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
