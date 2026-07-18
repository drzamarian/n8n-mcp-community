# Compatibility

Compatibility claims are evidence-bound. This pre-release document separates
completed local release-candidate evidence from the signing, client-matrix, and
publication gates that remain closed.

## Current source-candidate evidence

| Component              | Status                                                       |
| ---------------------- | ------------------------------------------------------------ |
| Node.js 22.23.1        | Complete local gate passes                                   |
| Node.js 24.18.0        | Complete local gate passes                                   |
| MCP transport          | stdio inventory verified as 44 tools, 5 resources, 4 prompts |
| macOS on Apple silicon | Development and local verification environment               |
| Linux and Windows      | No public release claim yet                                  |
| npm artifact           | Packed, clean-installed, and inspected locally; unpublished  |
| MCPB artifact          | Deterministic unsigned bundle verified locally; unpublished  |

The package declares Node.js `>=22.0.0`. That engine range is an acceptance
floor, not evidence that every later major has completed the release matrix.
The supported release lines for v0.1.0 are Node.js 22 and 24.

## n8n Community Edition

The v0.1.0 floor candidate is n8n Community Edition 2.30.5, with 2.30.7 as the
current comparison target. The compiled public 44-tool candidate passed fresh,
disposable lifecycles on both versions with synthetic fixtures, API-key
revocation, resource cleanup, enforced candidate-process egress isolation, and
zero container or network residue. The project remains pre-release and
unsupported until the remaining release gates close.

The server uses supported Public API routes and `/healthz`. It does not rely on
browser cookies, interactive `/rest` routes, paid project transfers, arbitrary
workflow execution, or runtime node-catalog downloads.

`n8n_credentials_list` is supported only from n8n 2.30.5 onward. Project
selectors are intentionally absent because v0.1.0 does not present paid project
capabilities as Community features. Other tools may also depend on endpoint
availability and the permissions assigned to the API key; an HTTP 403 does not
by itself mean the endpoint is absent.

## Deliberate exclusions

v0.1.0 does not include:

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
[Clients](clients.md) for the current pre-release boundary.

## How compatibility will be accepted

The release gate requires, for each n8n target version:

1. a fresh disposable Community Edition instance with synthetic data;
2. the exact packaged runtime, not an untracked local variant;
3. positive and denial-path MCP calls for every tool;
4. proof of exact request method, path, query, and body for sensitive tools;
5. cleanup evidence proving no test container, key, or fixture remains;
6. immutable reports tied to the exact source revision and artifact digest.

The local npm and unsigned MCPB candidates already pass clean installation,
inventory parity, license/notice, SBOM generation, and checksum/reproducibility
checks. Signature verification plus client-specific install, upgrade, rollback,
and uninstall evidence on every claimed operating system remain release gates.

[Back to the documentation map](README.md)
