const esc = (s: string): string =>
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
