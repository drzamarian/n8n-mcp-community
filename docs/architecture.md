# Architecture

n8n MCP Community is a single-process TypeScript MCP stdio server. Its design
keeps policy, transport, tool contracts, and output handling small and explicit.
It has no database, inbound HTTP listener, telemetry service, external model,
browser session, or runtime plugin download.

## Request flow

```text
MCP client
  -> strict tool input schema
  -> operation-mode and exact-confirmation policy
  -> bounded tool handler
  -> same-origin n8n Public API client
  -> response schema or allowlisted projection
  -> shared sanitization and 256 KiB output bound
  -> MCP result marked untrusted
```

The server and its complete inventory are constructed without reading n8n
credentials or making a network request. A connected tool creates a short-lived
client from the current environment only after input and operation policy have
passed.

## Modules

- `src/index.ts` provides the stdio entry point and the bounded offline CLI.
- `src/server.ts` registers the canonical tool, resource, and prompt
  inventories.
- `src/config.ts` validates startup mode and lazy n8n connection settings.
- `src/security/operation-policy.ts` enforces read-only, write, and unsafe
  boundaries before handlers run.
- `src/n8n/client.ts` builds same-origin requests, rejects redirects, bounds
  bodies, applies deadlines, and converts upstream failures to fixed errors.
- `src/tools/definition.ts` is the shared tool factory for strict schemas,
  annotations, audit events, error handling, and sanitized results.
- `src/tools/*.ts` contains the 44 small domain handlers.
- `src/security/redaction.ts` performs shared structural, secret, PII, and
  prompt-injection filtering before the final output bound.
- `src/introspect/*` contains the deterministic 23-rule diagnostic engine.
- `src/resources.ts`, `src/prompts.ts`, and `src/content/node-docs.ts` contain
  immutable offline guidance.

`src/tools/registry.ts` is the runtime source of truth for tool ordering and
count. Documentation inventory tests compare that registry with the 44 README
links and 44 substantive headings in `docs/tools.md`.

## Tool contract

Every tool definition owns:

- a stable name, title, and purpose;
- one of three operation classes: `read-only`, `write`, or `unsafe`;
- a strict Zod input schema that rejects unknown fields;
- MCP annotations derived from the operation class with an explicit per-tool
  override and a conservative destructive default for every mutation;
- an optional exact-confirmation function for unsafe operations;
- a bounded handler that validates untrusted upstream structures.

The shared factory turns generic success into
`{ data, redacted, untrusted: true }`. Introspect applies the same sanitizer to
its purpose-built reduced schema, emits that schema directly, and renders one
concise summary plus one exact JSON fallback under its combined-output budget.
Errors contain a fixed code, a sanitized
message, and a random correlation ID. Non-read operations emit metadata-only
JSON audit events to stderr; they do not log arguments, URLs, response bodies,
or keys.

## n8n transport

The transport client accepts only relative paths from tool code and always
rechecks the resulting origin. It uses the supported `/api/v1` Public API
prefix, except for the root `/healthz` probe. Redirects are not followed.
Requests and responses are limited to 2 MiB and default to a 20-second timeout.
There are no automatic retries, so the server does not silently duplicate a
write.

## Deterministic Introspect

`n8n_introspect` is a local analyzer, not an agent call. A bounded collector
retrieves one workflow and a limited execution-history sample, reduces them to
diagnostic facts, and passes those facts to 23 versioned rules. Each rule can
report a finding, pass, or remain inconclusive when the available evidence is
insufficient. Deep mode adds bounded execution detail reads; it does not execute
the workflow.

Results are deterministic for the same reduced facts. Raw credential values,
execution payload values, pin data, and static workflow data are excluded from
the diagnostic output.

## Purpose-built local tools

Two tools derive useful information without unsupported n8n endpoints:

- `n8n_workflows_diff` compares only nodes and connections from two supported
  snapshots and explicitly marks historically unavailable fields.
- `n8n_list_node_types` paginates accessible workflows and reports observed
  node types. It is not an installed-node catalog.

`n8n_update_node` performs a guarded full-workflow update because the Public API
does not offer an atomic single-node patch. Two version reads reduce the race
window, but cannot eliminate it; the residual boundary is part of the public
contract.

## Adding or changing a tool

Keep the change vertical and small:

1. Prove a supported Community Edition Public API path and response shape.
2. Choose the operation class from actual side effects.
3. Add the strict input and upstream response schemas.
4. Return the smallest useful projection; do not return secret-bearing values.
5. Add positive, denial, malformed-input, and leak-regression tests.
6. Update `docs/tools.md`, the README inventory, compatibility evidence, and
   provenance review.
7. Run `npm run check` and the release gates described in `CONTRIBUTING.md`.

Changing a tool count, name, side effect, or privacy boundary requires a
versioned specification decision rather than a registry-only edit.

[Back to the documentation map](README.md)
