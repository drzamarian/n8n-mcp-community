# Compatibility

Compatibility claims are evidence-bound. This document separates completed
release evidence from the client-matrix gates that remain open.

## Current source-candidate evidence

| Component              | Status                                                       |
| ---------------------- | ------------------------------------------------------------ |
| Node.js 22.23.1        | Complete local gate passes                                   |
| Node.js 24.18.0        | Complete local gate passes                                   |
| MCP transport          | stdio inventory verified as 44 tools, 5 resources, 4 prompts |
| macOS on Apple silicon | Development and local verification environment               |
| Linux and Windows      | No public release claim yet                                  |
| npm artifact           | Availability requires matching npm provenance readback       |
| MCPB artifact          | Availability requires a matching signed GitHub release asset |

The package declares Node.js `>=22.0.0`. That engine range is an acceptance
floor, not evidence that every later major has completed the release matrix.
The supported release lines for v0.1.2 are Node.js 22 and 24.

## n8n Community Edition

The v0.1.2 floor candidate is n8n Community Edition 2.30.5, with 2.30.7 as the
current comparison target. The compiled public 44-tool candidate passed fresh,
disposable lifecycles on both versions with synthetic fixtures, API-key
revocation, resource cleanup, enforced candidate-process egress isolation, and
zero container or network residue. Linux and Windows client-lifecycle claims
remain gated on the release matrix.

The server uses supported Public API routes and `/healthz`. It does not rely on
browser cookies, interactive `/rest` routes, paid project transfers, arbitrary
workflow execution, or runtime node-catalog downloads.

`n8n_credentials_list` is supported only from n8n 2.30.5 onward. Project
selectors are intentionally absent because v0.1.2 does not present paid project
capabilities as Community features. Other tools may also depend on endpoint
availability and the permissions assigned to the API key; an HTTP 403 does not
by itself mean the endpoint is absent.

## Below-floor instances

The n8n Public API does not expose an instance version, so this server never
detects, reports, or fabricates a running n8n version. Instead, floor
compatibility is diagnosed from endpoint availability, and an operator pointed at
an instance below the 2.30.5 floor will observe the following.

`doctor` performs no network request by default. Setting `N8N_MCP_DOCTOR_PROBE=1`
makes it run a bounded, read-only floor probe against the configured instance:
a single-page (`limit=1`) read of `GET /workflows` (a reachability control
present on every release) and `GET /credentials` (a namespace available only from
the 2.30.5 floor). The probe reads no workflow, credential, or other value — only
whether each endpoint is `available`, `not_found`, or `error` — and emits one
overall `diagnosis`:

- `floor_compatible` — the instance is reachable and every floor-marker endpoint
  responded.
- `below_floor_indicators` — the instance is reachable but a floor-marker endpoint
  returned 404, which is characteristic of a release below the documented floor.
- `inconclusive` — the instance could not be reached usefully, or a marker failed
  for a reason that does not distinguish version (for example an HTTP 403 from
  API-key scope, or a 5xx).

At the tool layer, a request that fails with HTTP 404 against a floor-marker
namespace (`/credentials`, `/insights`, `/community-packages`) returns the stable
`upstream_error` code with a guidance sentence naming the floor: "This endpoint
requires the documented support floor, n8n Community 2.30.5 or newer, or the
resource does not exist." The workflow version-history endpoint keeps its own
existing 404 mapping and is deliberately excluded from this guidance to avoid a
double diagnosis. No URL, response body, or version number is included in either
surface.

## Deliberate exclusions

v0.1.2 does not include:

- folders or data tables;
- beta evaluation endpoints;
- paid-only project or transfer operations;
- arbitrary workflow execution;
- execution annotations;
- an authoritative installed-node catalog.

Execution annotations remain a paired backlog proposal. See the
[roadmap](../ROADMAP.md).

## MCP clients

The protocol implementation is client-neutral stdio. A generic source
configuration is documented now; client-specific support claims require an
end-to-end launch, inventory readback, resource read, prompt retrieval, tool
call, restart, upgrade, and removal test for the final release artifact. See
[Clients](clients.md) for the current client boundary.

## How compatibility will be accepted

The release gate requires, for each n8n target version:

1. a fresh disposable Community Edition instance with synthetic data;
2. the exact packaged runtime, not an untracked local variant;
3. positive and denial-path MCP calls for every tool;
4. proof of exact request method, path, query, and body for sensitive tools;
5. cleanup evidence proving no test container, key, or fixture remains;
6. immutable reports tied to the exact source revision and artifact digest.

The local npm and unsigned MCPB candidates already pass reviewed artifact
installation under the committed dependency policy, inventory parity,
license/notice, SBOM generation, and checksum/reproducibility checks. The
separate no-override consumer probe retains the upstream residual documented in
the security model. Signature verification plus client-specific install,
upgrade, rollback, and uninstall evidence on every claimed operating system
remain release gates.

[Back to the documentation map](README.md)
