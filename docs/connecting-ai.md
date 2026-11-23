# Connecting your AI

Lager talks to AI assistants through the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). Any assistant that can use a **remote MCP server over HTTP** can build, deploy and manage apps on Lager: Claude, ChatGPT, Cursor, VS Code with GitHub Copilot, Gemini CLI and others. This page shows how to connect the common ones and what differs between them.

## The connector address

The dashboard shows the address of your connector: `<LAGER_PUBLIC_URL>/mcp`, for example `https://lager.example.com/mcp`.

There are two ways to sign in:

- **OAuth** (recommended): the assistant opens a Lager sign-in page in your browser, you sign in and allow access. Lager supports dynamic client registration, PKCE and refresh tokens, so no client id or secret needs to be entered anywhere. OAuth works only if `LAGER_PUBLIC_URL` starts with `https` or the host is `localhost`.
- **API token**: for assistants that cannot do OAuth, or for scripts. Create a token in the dashboard under **Publish → API tokens** (it is shown only once) and send it as the header `Authorization: Bearer lgr_...`. Only publishers and administrators can create tokens, and changing or resetting the account's password revokes them all. API tokens work with any address.

## Claude

- **claude.ai and Claude Desktop:** Customize → Connectors → **+ Add** → **Add custom connector**, with the address `https://lager.example.com/mcp`. When connecting, you sign in to Lager and allow access. On Team and Enterprise plans an owner first adds the connector under Organization settings → Connectors; members then connect it under Customize → Connectors. The Free plan allows one custom connector.
- **Claude Code:**
  ```sh
  claude mcp add --transport http lager https://lager.example.com/mcp
  ```
  Then open `/mcp` in Claude Code and complete the sign-in. With an API token instead:
  ```sh
  claude mcp add --transport http lager https://lager.example.com/mcp \
    --header "Authorization: Bearer lgr_..."
  ```

## ChatGPT

ChatGPT adds custom MCP servers on the web without developer mode; you confirm a risk warning for each server instead. In Business, Enterprise and Edu workspaces only admins and owners may add one, unless an admin grants the permission **Create plugins with MCPs** to members:

1. Open **Plugins** in ChatGPT (chatgpt.com/plugins), click **+** and choose **Add custom MCP server**.
2. Enter a name, `https://lager.example.com/mcp` as the server URL and OAuth as the authentication, then create it as a plugin.
3. Sign in to Lager in the window that opens and allow access.
4. In a chat, type **@**, select Lager and ask for an app.

ChatGPT asks you to confirm tool calls that change something. Lager marks its reading tools as read-only, so only deploys, shares and data changes need a confirmation. Connectors that write (deploys, shares, data changes) currently work on Business, Enterprise and Edu; on Pro, ChatGPT connects custom MCP servers with read and fetch access only; for other plans, see OpenAI's documentation. OpenAI has changed this before, so check [its current documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) if the connector only offers read access.

## Cursor

Add Lager to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "lager": { "url": "https://lager.example.com/mcp" }
  }
}
```

Cursor then offers to sign in. With an API token, add `"headers": { "Authorization": "Bearer lgr_..." }` next to `url`.

## VS Code (GitHub Copilot)

Run **MCP: Add Server** from the command palette, choose **HTTP**, enter `https://lager.example.com/mcp` and the id `lager`, and save it under **Global** → **Copilot Global**. Or add it by hand to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "lager": { "type": "http", "url": "https://lager.example.com/mcp" }
  }
}
```

Sign in when VS Code asks. Use an agent that can make changes, such as **Agent**, and check that Lager's tools are turned on (the **Tools** tab of the Agent Customizations editor, or `#` in the chat input). An older `.vscode/mcp.json` with a `servers` key still works with VS Code's Local harness, which VS Code has deprecated and will remove in February 2027.

## Gemini CLI

Add Lager to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "lager": { "httpUrl": "https://lager.example.com/mcp" }
  }
}
```

Then run `/mcp auth lager` in Gemini CLI and sign in.

## Other assistants

Any MCP client with Streamable HTTP transport works. If it supports OAuth with dynamic client registration, give it the address and sign in. Otherwise configure the address with the header `Authorization: Bearer lgr_...`. After the sign-in, Lager sends the browser back only to an address of one of these kinds: `https://…`; `http://` on this computer (`localhost`, `127.0.0.1`, `[::1]`, any port), which command-line tools and editors use; a desktop app's own scheme in reverse-domain form with at least three parts (`com.example.app:/callback`); and `cursor://…`, the scheme of Cursor's desktop app. A client that registers any other scheme is refused, because such a link would open whatever program the operating system has registered for it.

Lager forgets a registered client that holds no sign-in and was last used more than 90 days ago (showing the page that asks you to allow access counts as use); assistants register again by themselves the next time you connect. A registration may carry at most 8 KiB of client metadata.

## What every assistant gets

- **The same 25 tools**, with titles and read-only or destructive hints, and the guide for building apps (the `get_guide` tool). Lager also sends a short version of the guide as MCP server instructions; clients that do not show those to the model still find a pointer to `get_guide` in the `deploy_app` description.
- **The same app runtime.** Apps call `lager.use("db")`, `lager.complete(…)` and so on, whichever assistant writes them: an app built by ChatGPT uses the same calls and runs the same way as one built by Claude.
- **The same AI inside apps.** `lager.complete()` in an app is answered by the model your administrator connected under [Bring your own model](ai-models.md), whether that is Claude, GPT, Gemini, Mistral or a local Ollama, and regardless of which assistant built the app.

Differences between assistants:

- **The Lager skill is for Claude only** (see below). Other assistants get the same content through the guide.
- **Quality varies by model.** Smaller models more often forget to declare capabilities or use `localStorage`. Lager warns about both in the deploy result (`warnings`), and `check_app` checks an app before it is deployed.
- **Very large apps:** the whole HTML travels as one tool argument. Some assistants limit how much they write in one call; if a deploy is cut off, ask for a smaller app or deploy from a shell with an API token (`curl`, below).

## Deploying from a shell

```sh
curl -X PUT -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: text/html" \
  --data-binary @examples/notes.html \
  "https://lager.example.com/api/apps/notes?title=Notes&capabilities=%7B%22db%22%3A%7B%7D%2C%22user%22%3A%7B%7D%7D"
```

The deploy response contains the addresses of the instance (first the one under the apps domain, then custom domains), the warnings, and the instances that were not updated (`pinned`). `title` takes at most 100 characters, `note` at most 500 and `description` at most 200, each one line of plain text. An app takes at most 60 new versions per hour and a person starts at most 60 new apps per hour, through the REST API and `deploy_app` together (HTTP 409 after that; a deploy that is refused for another reason or changes nothing does not count), and keeps its newest 100 deployed versions: an older one is deleted for good unless an instance still runs it. New apps and instances cannot be named `www`, `api`, `lager`, `admin`, `mcp`, `login`, `auth`, `account`, `accounts`, `mail`, `smtp`, `ftp`, `static`, `assets`, `cdn`, `status`, `support` or `security`, nor like the platform's own host when it lies directly under the apps domain. `examples/notes.html` is a small example app (a note list with `lager.use("db")`), and `examples/board.html` is a shared pin board with uploads, presence and export (see [Building blocks](building-apps.md#building-blocks)).

## Installing the skill (Claude)

The skill [`skill/lager/SKILL.md`](../skill/lager/SKILL.md) teaches Claude to build and deploy apps with Lager even before it calls a tool. Its content is the same guide that the MCP endpoint serves (`src/guide.md`).

- **Claude Code:** `cp -r skill/lager ~/.claude/skills/lager`
- **claude.ai and Desktop:** Pack the folder `skill/lager` as a ZIP and upload it under Customize → Skills → **+** → **Create skill** → **Upload a skill**.
