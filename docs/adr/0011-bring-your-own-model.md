# 0011. Bring your own model: providers and AI groups

- Status: Accepted
- Date: 2026-11-18

## Context

Apps may ask a language model from inside the page (`lager.complete`). The server's operator pays for it and wants to decide which model answers whom, and how often. Different people may need different models, for example a hosted model for one group and a local Ollama for everyone else.

## Decision

- The administrator adds **providers**: a name, a type (Anthropic, OpenAI, OpenRouter, DeepSeek, Gemini, Mistral, Groq, Ollama, or any OpenAI-compatible server), an API key and, where needed, an address.
- **AI groups** pick a provider (or Off), a model and a number of requests per hour. Every person is in at most one AI group. Everyone not assigned is in the fixed group "Everyone else". AI groups are separate from the groups used for sharing.
- Only signed-in people with at least `interact` on the instance may call the model, only if the app declares `complete`, with at most three requests at a time and one global limit on answer length.
- Keys are stored encrypted with the server secret and never shown again, except for their last four characters. Changing a provider's type or address drops its key, so a key never reaches a host it was not entered for. Provider error details go to the server log and the administrator's test, never to app viewers.

Rejected: self-contained model setups (the same key typed in several places) and AI settings on sharing groups (no answer for someone in two groups).

## Consequences

- Which model answers is independent of which assistant built the app.
- The request counter lives in memory and restarts with the server.
- Apps must handle `not_configured`, `rate_limited` and provider errors. The guide tells assistants to.
