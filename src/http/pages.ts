export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CSS = `:root{--bg:#f6f7fb;--surface:#fff;--text:#1b1f33;--muted:#5a6178;--border:#d5d9e6;--navy:#1f2a5c;--accent:#f58220;--on-accent:#1f2a5c;--link:#1f2a5c;--err:#b00020;--ok:#0b6b3a}
@media (prefers-color-scheme:dark){:root{--bg:#10142b;--surface:#1a2040;--text:#e8eaf6;--muted:#a3a9c6;--border:#343c6b;--link:#ffb067;--err:#ff8a9b;--ok:#6fdc9f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
header.top{background:var(--navy);color:#fff}
header.top .in{max-width:60rem;margin:0 auto;padding:.6rem 1rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}
header.top img{width:40px;height:40px;border-radius:10px;display:block}
header.top .name{font-size:1.25rem;font-weight:700;letter-spacing:.02em}
header.top .who{margin-left:auto;display:flex;align-items:center;gap:.75rem;font-size:.9rem}
header.top form{margin:0}
main{max-width:24rem;margin:2rem auto;padding:0 1rem}
main.wide{max-width:60rem}
h1{font-size:1.5rem;margin:0 0 1rem}h2{font-size:1.2rem;margin:2rem 0 .75rem}h3{font-size:1rem;margin:1rem 0 .4rem}
a{color:var(--link)}
label{display:block;margin:1rem 0 .25rem}
input,select{font:inherit;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);max-width:100%}
main:not(.wide) input{width:100%}
button{font:inherit;font-weight:600;padding:.45rem .9rem;border:0;border-radius:6px;background:var(--accent);color:var(--on-accent);cursor:pointer}
button.quiet{background:transparent;color:inherit;border:1px solid currentColor;font-weight:400}
header.top button.quiet{color:#fff}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
main:not(.wide) button{margin-top:1.25rem}
.err{color:var(--err)}.ok{color:var(--ok)}.muted{color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1rem;margin:0 0 1rem}
.card h3:first-child{margin-top:0}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.row form{margin:0;display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:.35rem .5rem .35rem 0;border-bottom:1px solid var(--border);vertical-align:middle}
.scroll{overflow-x:auto}
code,.mono{font-family:ui-monospace,monospace;font-size:.9em;word-break:break-all}
.token{display:block;padding:.6rem;background:var(--bg);border:1px dashed var(--accent);border-radius:6px;margin:.5rem 0}`;

/** Shared shell: header with icon and name, optional `headerExtra` on the right, favicon. */
export function page(title: string, body: string, opts: { wide?: boolean; headerExtra?: string } = {}): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" type="image/webp" href="/icon.webp">
<style>${CSS}</style></head>
<body><header class="top"><div class="in"><img src="/icon.webp" alt="" width="40" height="40"><span class="name">Lager</span>${opts.headerExtra ?? ''}</div></header>
<main${opts.wide ? ' class="wide"' : ''}>${body}</main></body></html>`;
}

export function loginPage(returnPath: string, error?: string): string {
  return page('Anmelden', `<h1>Anmelden</h1>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/login">
<input type="hidden" name="return" value="${esc(returnPath)}">
<label for="email">E-Mail</label><input id="email" name="email" type="email" autocomplete="username" required autofocus>
<label for="password">Passwort</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Anmelden</button>
</form>`);
}

export const notFoundPage = (): string => page('Nicht gefunden', '<h1>Nicht gefunden</h1><p>Seite nicht gefunden.</p>');
export const forbiddenPage = (): string =>
  page('Kein Zugriff', '<h1>Kein Zugriff</h1><p>Du hast keinen Zugriff auf diese Anwendung. Bitte wende dich an die Besitzerin oder den Besitzer.</p>');
export const badCodePage = (): string =>
  page('Anmeldung ungültig', '<h1>Anmeldung ungültig</h1><p>Der Anmeldelink ist ungültig oder abgelaufen. Bitte öffne die Anwendung erneut.</p>');

const hidden = (fields: Record<string, string>): string =>
  Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n');

/** OAuth consent: names the connecting client and where the browser is sent afterwards. */
export function consentPage(clientName: string, redirectHost: string, userName: string, fields: Record<string, string>): string {
  return page('Zugriff erlauben', `<h1>Zugriff erlauben?</h1>
<p><strong>${esc(clientName)}</strong> möchte in deinem Namen auf Lager zugreifen: Apps deployen, Versionen aktivieren und die Daten deiner Instanzen lesen und ändern.</p>
<p>Angemeldet als ${esc(userName)}. Nach der Entscheidung geht es weiter zu <strong>${esc(redirectHost)}</strong>.</p>
<form method="post" action="/authorize">
${hidden(fields)}
<button type="submit" name="decision" value="approve">Erlauben</button>
<button type="submit" name="decision" value="deny">Ablehnen</button>
</form>`);
}

export const consentInvalidPage = (): string =>
  page('Anfrage ungültig', '<h1>Anfrage ungültig</h1><p>Die Zugriffsanfrage ist abgelaufen oder ungültig. Bitte starte die Verbindung erneut.</p>');
