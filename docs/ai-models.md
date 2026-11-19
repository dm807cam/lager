# Bring your own model

Apps can call `lager.complete(prompt)` to ask a language model something from inside the page: a recipe app suggests a meal, a journal summarizes the week. That call goes to a language model **you** connect, paid with your own API key. It does not depend on which assistant built the app: an app that ChatGPT wrote calls the same model as one Claude wrote.

Under **Administration → AI model**:

1. **Add one or more providers.** Give each a name, pick its type, enter the API key (and the server address where needed), then open it and press **Send a test message**.
2. **Name your models.** Each catalog entry has a short name that apps use (for example `fast` or `smart`), a provider, the model name as the provider writes it, and one sentence on what it is good for. The name cannot be changed later; the provider and the model behind it can, so you can move `smart` to a newer model and every app follows.
3. **Set up AI groups.** Each AI group has a **default model** (or Off), **further models** that apps may pick for its people, and how many requests per hour each of its people may send. **Everyone else** is always there and covers everyone you have not assigned.
4. **Assign people** in the **AI group** column under **Administration → Users**. Each person is in one AI group. AI groups are separate from the groups used for sharing apps.

## Which model an app uses

Some apps only sort a list, others write long texts. So an app can ask for one model from the catalog:

- **The building AI picks it.** `list_models` shows the assistant the models the AI group of the person deploying allows, with your description. It declares one in the capabilities, `{"complete": {"model": "smart"}}`, or leaves it out to use each viewer's default model. A deploy that names a model this person may not use is refused.
- **The owner can change it.** On the app page, people who deploy the app choose between what the app asks for and the models of their own AI group. Assistants do the same with `set_app_model`, scripts with `PUT /api/apps/<slug>/model`. The choice applies to every instance of the app and survives redeploys; choose the first entry to follow the app's declaration again.
- **Each viewer's AI group has the last word.** When a viewer's AI group does not allow the app's model, or its provider cannot be reached, their call goes to the default model of their group. The hourly limit is always that of the viewer's group.

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
- **Choose Off** as the default model of an AI group (Everyone else included) to stop calls for its people. Delete a provider to forget its key; a provider that catalog models still use cannot be deleted. A model that is the default of an AI group cannot be deleted either; deleting any other model removes it from the further models of every group, and apps that had chosen it follow their declaration again. Deleting an AI group moves its people to Everyone else.
