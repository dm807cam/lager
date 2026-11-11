export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem;color:#222}
label{display:block;margin:1rem 0 .25rem}input{width:100%;padding:.5rem;box-sizing:border-box}
button{margin-top:1.25rem;padding:.5rem 1rem}.err{color:#b00020}</style></head>
<body>${body}</body></html>`;
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

export const notFoundPage = (): string => page('Nicht gefunden', '<h1>Nicht gefunden</h1><p>Diese Seite gibt es nicht.</p>');
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
