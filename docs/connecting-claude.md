# Connecting Claude

How to connect Claude (claude.ai, Claude Desktop, Claude Code) to Lager and install the Lager skill.

## Adding the connector

The dashboard shows the address of your connector: `<LAGER_PUBLIC_URL>/mcp`.

OAuth, which claude.ai and Claude Desktop use when connecting, works only if `LAGER_PUBLIC_URL` starts with `https` or the host is `localhost`. API tokens work with any address.

- **claude.ai and Claude Desktop:** Settings → Connectors → add a custom connector and enter the address `<LAGER_PUBLIC_URL>/mcp`. When connecting, you sign in to Lager and allow access.
- **Claude Code:**
  ```sh
  claude mcp add --transport http lager https://lager.example.com/mcp
  ```
  Then open `/mcp` in Claude Code and complete the sign-in.
- **API token instead of OAuth:** Create a token in the dashboard under API tokens. It is shown only once. Both of these work with it:
  ```sh
  claude mcp add --transport http lager https://lager.example.com/mcp \
    --header "Authorization: Bearer lgr_..."

  curl -X PUT -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: text/html" \
    --data-binary @examples/notes.html \
    "https://lager.example.com/api/apps/notes?title=Notes&capabilities=%7B%22db%22%3A%7B%7D%2C%22user%22%3A%7B%7D%7D"
  ```

The deploy response contains the addresses of the instance (first the one under the apps domain, then custom domains), the warnings, and the instances that were not updated (`pinned`). `examples/notes.html` is a small example artifact (a note list with `claude.use("db")`), and `examples/board.html` is a shared pin board with uploads, presence and export (see [Building blocks](building-apps.md#building-blocks)).

## Installing the skill

The skill [`skill/lager/SKILL.md`](../skill/lager/SKILL.md) teaches Claude to build and deploy artifacts with Lager. Its content is the same guide that the MCP endpoint serves (`src/guide.md`).

- **Claude Code:** `cp -r skill/lager ~/.claude/skills/lager`
- **claude.ai and Desktop:** Pack the folder `skill/lager` as a ZIP and upload it under Settings → Skills.
