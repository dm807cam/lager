# Languages and appearance

Interface languages, adding a translation, and light and dark mode.

## Languages

Lager ships in English, French, Spanish and German. English is the default and the source of every text.

The language of a page is chosen in this order: the signed-in account's language setting (Account page), the language switcher in the page footer (stored in the `lager_lang` cookie), the browser's `Accept-Language` header, and finally `LAGER_DEFAULT_LOCALE`. Mails use the recipient's language where it is known. Dates and sizes are written the way the chosen language writes them.

To add a language (see also the [contributing guide](../CONTRIBUTING.md#translations)):

1. Copy `src/i18n/en.ts` to a new file such as `src/i18n/it.ts` and translate the values. Keep the `{name}` placeholders, and keep "Lager", product names such as "Claude" or "ChatGPT", and the role name "Publisher" as they are.
2. In `src/i18n/index.ts`, import the catalog and add it to `CATALOGS`, `LOCALES` and `LOCALE_NAMES`.
3. Add the language to the small table in `src/runtime/runtime.js` (`SAVE_FILE`) that holds the one sentence the browser runtime shows itself: the confirmation before a download (it also formats the file size).

The type checker reports every missing key. `npm test` checks that every catalog has the same keys and placeholders and that every value differs from the English one (except a short list of words that are the same in that language); that every key is used and every `t()` call uses an existing key; that no German appears in the source outside the catalogs; that no page handler, and not the OAuth server, contains inline human-facing text (an HTML text node, a capitalised sentence or a titled attribute in a string or template literal, in any language; error messages for programs, SQL and header values are exempt); and that the pages, the error pages, every notice and every mail render in each language without leftover placeholders. The test cannot judge whether a translation is good, or catch a lowercase phrase that sits outside any HTML.

## Light and dark

The web interface follows the device's light or dark setting. The account menu has a theme switch that cycles between system, light and dark; the choice is kept in that browser only (local storage), and a tiny script in the page head applies it before the first paint so there is no flash. Without JavaScript the pages work the same and simply follow the system setting. The interface loads one stylesheet and one small script from the platform host (`/static/app.<hash>.css` and `.js`, cached for a year because the hash changes with the content) and nothing from anywhere else.
