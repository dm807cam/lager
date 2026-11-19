# 0015. A model catalog, allowed models per AI group and a model per app

- Status: Accepted
- Date: 2026-11-19

## Context

[ADR 0011](0011-bring-your-own-model.md) gave every AI group one provider and one model. But the right model depends on the app: a list that sorts groceries needs a fast, cheap model, an app that drafts letters a stronger one. The assistant that builds an app knows best what the app does, so it should be able to choose. The operator still pays and must keep control over who may use the expensive models.

## Decision

- The administrator keeps a **catalog of models**. Each entry has a fixed short name (`fast`, `smart`, …) that apps refer to, a provider, the provider's model name and a sentence on what it is good for. The provider and model behind a name can change; the name cannot, so apps never break on an upgrade.
- An **AI group** has a default model (or Off) and a list of **further models** its people may use. Its hourly limit stays as before.
- An app asks for a model with `{"complete": {"model": "<name>"}}` in a version's capabilities. The building AI sees the choices with `list_models`, which shows only what the AI group of the person deploying allows, and a deploy that names any other model is refused. The model is part of the version, so a rollback brings back the model the code was written for.
- Those who deploy an app can **choose** a model for it on the app page, with `set_app_model` or `PUT /api/apps/<slug>/model`, again only among the models of their own AI group. The choice belongs to the app, applies to all its instances and wins over the declaration until it is cleared.
- At runtime the call goes to the app's model when the **viewer's** AI group allows it and its provider works, otherwise to the default model of the viewer's group. The viewer's group also supplies the hourly limit.

Rejected:
- Model names typed freely into app declarations: every app would hard-code one provider's naming, and the operator could not swap models.
- Choosing the model per call (`lager.complete(…, {model})`): more surface for little gain, since one app rarely needs two models. It can come later on top of the catalog.
- An exception for administrators when they deploy or choose: they can change their own AI group, and one rule is easier to explain.

## Consequences

- One more step when setting up: add a provider, name at least one model, then give AI groups a default model.
- Apps must still work with whichever model answers, because a viewer can always fall back to their group's default.
- A model that is the default of a group cannot be deleted; deleting another model clears it from allowed lists and from apps that chose it.
