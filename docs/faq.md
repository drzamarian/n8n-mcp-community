# Frequently asked questions

## Is this project only for n8n Community Edition?

Community Edition is the release baseline. The public surface avoids presenting
paid-only project transfers or licensed features as generally available. An
endpoint can still depend on n8n version and API-key permission; see
[Compatibility](compatibility.md).

## How many tools are included?

Exactly 44 tools, plus 5 resources and 4 prompts. Runtime, README, reference,
and contract-test inventories are checked together.

## What is the easiest installation method?

For a compatible desktop client, the planned signed MCPB will be the easiest.
Exact-version `npx` will be the portable alternative. Neither has been published
yet, so source checkout is the only current evaluation path.

## Will I need both MCPB and npx?

No. They are two installation routes for the same reviewed stdio runtime. Choose
MCPB for a verified compatible client's one-click flow or exact-version `npx`
for portable configuration.

## Can Homebrew update the MCPB?

No. An MCPB is not a Homebrew formula. No Homebrew formula is planned for
v0.1.0; bundle updates will use explicit signed releases or a compatible
client's verified update flow.

## Why do the npx examples avoid `@latest`?

An exact package version makes the installed code reviewable, upgrades
deliberate, and rollback deterministic. `@latest` can change the runtime without
changing the client configuration.

## Does Introspect call a workflow, an agent, or an AI model?

No. `n8n_introspect` reads bounded workflow and execution metadata from n8n and
runs a deterministic local 23-rule engine. It does not execute the workflow,
invoke an n8n agent, or contact an external model provider.

## Is Introspect a complete audit?

No. It analyzes a bounded sample and reports when evidence is incomplete or
inconclusive. It is a diagnostic aid, not a replacement for runtime monitoring,
security review, tests, or human judgment.

## Can I change a single node without cloning the workflow manually?

Yes. `n8n_update_node` updates one validated node path while preserving the
other writable workflow fields. The n8n Public API still requires a full
workflow PUT, so the tool discloses its non-atomic race and non-rollback limits.

## Is `n8n_list_node_types` an installed-node catalog?

No. It reports node types observed in workflows visible to the API key. It uses
only bounded Public API workflow reads and cannot prove that an unobserved type
is unavailable.

## Are credential values returned?

Generic credential tools return metadata only. Create and update accept values
for forwarding to n8n but do not include them in success output. The shared
sanitizer is defense in depth, not permission to expose secrets.

## From which version does credential listing work?

`n8n_credentials_list` was verified on n8n Community Edition 2.30.5 and 2.30.7 in this
project's compatibility contract.

## Does the server send telemetry?

No. It has no telemetry or external-AI path. Connected tools call only the
configured n8n origin; local non-read audit events go to stderr without inputs,
URLs, response bodies, or credentials.

## Is the project affiliated with n8n?

No. It is an independent MIT-licensed project. “n8n” identifies compatibility
with the n8n product and Public API.

## Who created the project?

The creator and maintainer is
[Dr. Walter Zamarian Jr.](https://www.walterzamarianjr.com/).

[Back to the documentation map](README.md)
