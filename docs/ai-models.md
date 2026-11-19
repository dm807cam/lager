# Bring your own model

Apps can call `lager.complete(prompt)` to ask a language model something from inside the page: a recipe app suggests a meal, a journal summarizes the week. That call goes to a language model **you** connect, paid with your own API key. It does not depend on which assistant built the app: an app that ChatGPT wrote calls the same model as one Claude wrote.

Under **Administration → AI model**:

1. **Add one or more providers.** Give each a name, pick its type, enter the API key (and the server address where needed), then open it and press **Send a test message**.
2. **Set up AI groups.** Each AI group picks a provider (or Off), a model and how many requests per hour each of its people may send. **Everyone else** is always there and covers everyone you have not assigned.
3. **Assign people** in the new **AI group** column under **Administration → Users**. Each person is in one AI group. AI groups are separate from the groups used for sharing apps.

| Provider | Model example | Notes |
| --- | --- | --- |
| Anthropic (Claude) | `claude-opus-5-5` | Messages API |
| OpenAI | `gpt-5` | |
| OpenRouter | `anthropic/claude-opus-5-5` | one key for hundreds of models |
| DeepSeek | `deepseek-chat` | |
| Google Gemini | `gemini-2.5-flash` | OpenAI-compatible endpoint |
| Mistral, Groq | `mistral-large-latest`, `llama-3.3-70b-versatile` | |
| Ollama (local) | `llama3.2` | no key; default address `http://127.0.0.1:11434/v1` |
| Other OpenAI-compatible server | any | enter the server address (LM Studio, vLLM, LiteLLM, Together, …) |

- **Apps opt in.** Only apps that declare `{"complete": {}}` can call the model; `check_app` reports a missing declaration. Their cards in the app overview carry a small **AI** badge (in German **KI**), so people see at a glance which apps ask a model. For an instance, the badge follows the version it runs.
- **Guests can't spend your credit.** Only signed-in people with at least contributor access to an app can use it. Each person gets the requests per hour of their AI group (60 by default) and at most three at a time, and the administrator sets the longest answer for everyone (16,000 tokens by default).
- **The key stays on the server.** It is stored encrypted with the server secret (`secret.key` or `LAGER_SECRET`). The page never shows it again, only its last four characters. Changing the secret makes the stored key unreadable, so you enter it again. Changing a provider's type or address removes its key, so a key never goes to a server it was not entered for.
- **Errors stay private.** Viewers get a short message such as "The language model rejected the request". What the provider said goes to the server log and to the administrator's test.
- **Choose Off** for an AI group (Everyone else included) to stop calls for its people. Delete a provider to forget its key; a provider an AI group still uses cannot be deleted. Deleting an AI group moves its people to Everyone else.
