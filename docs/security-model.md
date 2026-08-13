# Security model

This document describes the controls and residual risks of the v0.3.0 source
candidate. It is a threat model, not a claim that the software or the connected
n8n instance is invulnerable.

## Protected assets

- the n8n Public API key and its upstream permissions;
- credential values stored in n8n;
- workflow logic, parameters, pin data, and static data;
- execution inputs, outputs, errors, and identifying metadata;
- the integrity of workflows and instance state;
- the MCP client process and its local environment.

## Trust boundaries

The MCP client, this local stdio process, the configured n8n origin, and every
piece of n8n-supplied content are separate trust domains. MCP prompts and
resources are immutable local text. Tool inputs are untrusted. n8n responses
remain untrusted even after schema validation and redaction.

The server trusts the operating system and MCP client to protect environment
variables and the stdio channel. It does not authenticate a second local user
who can already control that client process.

## Entry points and outbound paths

The runtime has one inbound protocol: MCP over local stdio. It does not listen
on a TCP port. The CLI accepts only no arguments, `doctor`, `--help`/`-h`, or
`--version`/`-v`; secrets are never CLI arguments.

Connected tools can call only the configured n8n origin through relative Public
API paths, plus `/healthz`. The HTTP client rejects origin changes and redirects.
The deterministic Introspect engine, node references, resources, and prompts
have no external-AI or documentation-download path. There is no telemetry.

This same-origin rule intentionally permits a privately addressed n8n host. The
server is designed to reach self-hosted n8n, so it is not a general private-IP
block. Protect the local process and configure only an intended n8n origin.

## Authorization and side effects

The runtime has three local modes:

- `read-only` allows only tools classified as read-only;
- `write` also allows ordinary mutation tools. Non-read tools use the
  conservative MCP destructive hint by default; reviewed additive or
  non-destructive operations publish an explicit false override;
- `unsafe` allows all tools, including destructive and externally contacting
  operations. Selecting this mode is the complete server-side gate.

Policy rejection occurs before a tool creates an n8n client. Input schemas are
strict and bounded. The upstream API key still defines the actual n8n
authorization boundary; local modes can reduce use, but cannot grant or revoke
upstream permissions.

Use a dedicated least-privilege API key. Keep the permanent client entry in
read-only mode and elevate only for a specific operation.

## Transport controls

- HTTPS is required for non-loopback hosts unless
  `N8N_ALLOW_INSECURE_HTTP=1` explicitly accepts plaintext risk.
- User information, queries, and fragments are rejected in the configured URL.
- API keys are sent only in `X-N8N-API-KEY` to the configured origin.
- Redirects are rejected rather than followed.
- Request and response bodies are bounded to 2 MiB.
- Requests default to a 20-second deadline.
- Writes are not retried automatically.
- Upstream error bodies are consumed within bounds but never returned.

TLS certificate validation is provided by the Node.js runtime. This project
does not add certificate pinning or a custom certificate authority.

## Data minimization and output handling

Tools validate upstream shapes or create an explicit projection before shared
sanitization. Generic credential tools never return credential values. Generic
execution tools force n8n's redacted-data option and omit raw execution values.
Workflow projections withhold pin and static values while reporting only their
presence.

The shared sanitizer:

- replaces secret-bearing object-key content, plus scalar and container values
  under secret-bearing semantic names, while retaining allowlisted structural
  map keys only when needed for graph or credential-schema usability;
  secret-like property descriptors retain only their non-secret structure and
  redact defaults, examples, values, and nested containers;
- filters common email, phone, Brazilian CPF/CNPJ, PIX, bearer, JWT, token, and
  prompt-injection patterns;
- removes prototype-related keys and control characters;
- bounds strings, arrays, object entries, depth, and total traversed nodes.

Generic serialized results are limited to 256 KiB and marked `untrusted: true`.
That limit covers the complete MCP result, including its text and structured
forms. A mutation summary sets `redacted: true` whenever the original result was
truncated, even when the retained identity fields need no additional redaction.
`redacted: false` means no configured sanitizer matched; it does not certify
that content is harmless, anonymous, or free of unknown secret formats.
Introspect emits its allowlisted reduced schema directly after applying the
shared sanitizer, with separate structured and combined-output caps and an exact
JSON fallback text block; its diagnostic content remains untrusted n8n-derived
data.

## Logging

Non-read operations write one metadata-only JSON event to stderr with timestamp,
tool name, outcome, and a random correlation ID. Arguments, URLs, API keys,
request bodies, and response bodies are excluded. Errors returned over MCP use
the same correlation ID and a sanitized fixed-shape payload.

The MCP client may independently log tool inputs and outputs. Configure its
retention and access controls according to the sensitivity of the connected
n8n instance.

## Tool-specific residual risks

### Full-workflow and node updates

The n8n Public API uses a full-workflow `PUT`, not atomic compare-and-swap.
`n8n_workflows_update` requires an expected version and two matching reads
before writing. The immediate second read is the preservation source for the
full PUT. A concurrent change after that read can still be overwritten.

`n8n_update_node` requires an expected version, explicit non-atomic-risk
acknowledgement, exactly one matching target node, and two matching reads before
its `PUT`. Its mutation is also applied to the immediate second-read snapshot.
Another writer can still act between the second read and the write.
Both workflow update tools reject a post-write response that does not preserve
the expected pin/static data; the node tool also confirms that the requested
value landed on exactly one target. These errors occur after the write, so the
upstream mutation may already have occurred and cannot be rolled back. Inspect
the workflow immediately.

### Externally contacting credential tests

`n8n_credentials_test` asks n8n to test a stored credential. Depending on its
type, n8n may contact a third-party service. It is therefore unsafe, requires an
explicitly selected unsafe mode, and should be used only when that outbound
contact is authorized.

### Discovery and diagnostics

`n8n_list_node_types` observes accessible workflows only; absence from its
result is not proof that a type is uninstalled. `n8n_introspect` analyzes a
bounded sample and may return inconclusive findings. Neither tool is a complete
security audit of n8n or its host.

### Destructive operations

Unsafe mode is authorization, not a recovery mechanism. Deletes, execution
stops/retries, activation changes, archive changes, and user invitations may
have irreversible or externally visible effects. Compatible clients can add
native confirmations based on the published MCP annotations.

### Downstream dependency resolution

MCP SDK 1.30.0 permits the patched `@hono/node-server` 2.x line directly, so
this project no longer needs a package-root override that downstream consumers
would not inherit. The verification gate packs the candidate, installs it in a
disposable consumer without overrides, rejects `@hono/node-server` versions
below 2.0.5 or outside major version 2, requires a zero-finding production
audit, and proves the exact MCP inventory still starts. Candidate evidence does
not establish publication: the released version must pass the same clean
consumer audit after npm provenance and the other external release readbacks
agree.

The SDK dependency range also permits the legacy 1.x line. A separate host
project that co-installs another dependency constraining `@hono/node-server` to
1.x may therefore resolve a different graph from the clean standalone probe.
This server is distributed as a standalone stdio process, not as an embeddable
library. Projects that intentionally embed it must audit their complete
production graph and ensure `@hono/node-server` resolves to a patched 2.x
release.

## Threats outside this boundary

The server does not protect against a compromised MCP client, operating system,
Node.js runtime, npm registry, n8n host, reverse proxy, or over-privileged API
key. It does not manage n8n backups, encrypt n8n data at rest, validate workflow
business logic, or prevent a user from authorizing a harmful but syntactically
valid operation.

Review dependency provenance, pin exact releases, keep Node.js and n8n patched,
and maintain tested n8n backups before enabling writes.

## Vulnerability reporting

Follow [SECURITY.md](../SECURITY.md). Never include real keys, instance URLs,
workflow data, execution data, cookies, or credential values in a report.

[Back to the documentation map](README.md)
