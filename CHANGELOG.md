# Changelog

All notable changes to this project will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- The transitive `fast-uri` dependency is updated past
  GHSA-v2hh-gcrm-f6hx, and `@hono/node-server` is overridden to the patched
  2.x line for GHSA-frvp-7c67-39w9. The affected HTTP adapter is unused by
  this stdio-only server; the override keeps the dependency audit at zero
  findings and is removable once the MCP SDK adopts the patched major.

## [0.1.1] - 2026-07-21

### Security

- npm publication is now exclusively GitHub OIDC trusted publishing: the
  v0.1.0 first-publish bootstrap token binding was removed from the release
  workflow, and the release policy fails closed on any npm token reference.

### Changed

- Documentation now describes the published state: the README leads with the
  pinned exact-version `npx` quick start, states up front that the safety
  modes are progressive rather than restrictive, and the installation,
  client, compatibility, and FAQ guides replace pre-release "planned"
  wording with the released routes.
- Release-asset links use the stable latest-release URL so documentation
  links remain valid across versions.

## [0.1.0] - 2026-07-20

### Added

- Secure stdio MCP runtime with exactly 44 tools, five resources, and four prompts.
- Three operation modes with exact confirmations for unsafe calls.
- Deterministic local Introspect engine v2 with 23 diagnostic rules.
- Strict Node 22/24 test, build, dependency-license, and package gates.
- Native-English public documentation and complete tool reference.
- Embedded synthetic terminal demonstration with a packaged transcript and an
  automated orphan-asset documentation gate.

- Optional `doctor` floor-compatibility probe behind `N8N_MCP_DOCTOR_PROBE=1`:
  two bounded single-item reads diagnose `floor_compatible`,
  `below_floor_indicators`, or `inconclusive` without claiming a remote version.

### Changed

- Every confirmation-guarded tool now documents its exact required confirmation
  phrase (for example `DELETE <workflowId>`) directly in the `confirmation`
  field description, derived from the tool's own confirmation function so the
  documented and enforced phrases can never drift. The phrase is discoverable in
  the tool schema an MCP client sees, yet is still never echoed back on a
  mismatch, so the deliberate-action guard is preserved.

### Fixed

- Redact URL userinfo credentials, cookie and session values, suffixed secret
  keys, and complete quoted multi-word secrets in strings.
- Reject API keys that are illegal HTTP header values at configuration load and
  keep request-construction failures value-free.
- Validate surgical node updates against per-field type contracts and
  re-validate the mutated node before any write reaches n8n.
- Stop re-validating trusted server round-trip data under caller input rules so
  workflows with large or prototype-keyed upstream data remain updatable.
- Reject out-of-bounds array indexes in update paths instead of fabricating
  sparse null elements.
- Exclude pinned data from workflow-diff and introspect reads, and fail before
  writing when an instance omits workflow version identity.
- Distinguish below-floor endpoint absence from retention pruning in
  version-history errors and add version-floor guidance to floor-marker 404s.
- Tolerate name-only credential references in usage scans and expose value-free
  coverage counts instead of aborting.
- Report over-cap successful mutations as truncated successes, derive
  execution-stop outcomes from the validated upstream body, and preserve
  completed credential-test outcomes by truncating over-long diagnostics.
- Map upstream response-shape mismatches to a stable `upstream_shape_mismatch`
  code without exposing schema internals.
- Emit stable, secret-free configuration reason codes aligned with `doctor`
  guidance, and end broken-stdio sessions with one structured stderr line.
- Count literal secrets in canonical `{name, value}` parameter entries and
  recognize core entry nodes without "trigger" in their type names.
- Authenticate artifact-baseline approval receipts with an operator-held HMAC
  key, bind `server.json` and SBOM digests to the reviewed baseline, verify the
  MCPB dependency file count, and pin gitleaks and npm versions in CI.
- Remove private identifiers from the public-language gate, scan the gate
  itself, and align registry metadata with the HTTP(S) connection contract.

- Report all mutable node execution-behavior fields in value-free workflow
  diffs instead of silently omitting nine supported fields, while normalizing
  absent and explicit `false` default-false flags.
- Validate the real n8n invitation response, report truthful delivery metadata,
  and keep capability-bearing invitation URLs out of MCP output.
- Invoke npm, npx-compatible execution, and MCPB through JavaScript entrypoints
  so package, audit, baseline, and bundle gates remain shell-free and portable
  on Windows and Corepack-managed layouts.
- Encode every valid email selector as one RFC 3986-safe path segment, including
  apostrophe-containing addresses accepted by the public input contract.
- Reject retained workflow snapshots whose returned version identity differs
  from either selector requested by the workflow-diff tool.
- Publish every tool input and output schema fully inline. Reusing one Zod
  instance across two properties of the same tool previously emitted
  intra-schema `$ref` pointers that not every MCP client resolves.

### Security

- Same-origin Public API client with redirect rejection, timeouts, body limits,
  boundary validation, output redaction, and zero-request policy denial.
- Official documentation URLs and validated Introspect identifiers survive
  output sanitization. Untrusted values that merely look similar stay redacted.
- All 23 Introspect rule identifiers come from one closed list. Long workflow
  identifiers receive bounded hash suffixes so distinct findings stay distinct.
- Introspect detects stored non-positive node type versions and keeps partial
  reports within their output budget after synchronizing disclosed findings.
- Git ignores and index checks reject every `.env*` form and transient npm or
  MCPB artifact. Only fixed public CA slots may appear during an active release
  transition.
- Executable metadata gates protect the private-to-public transition. Semgrep
  rules are pinned to an exact commit instead of a mutable remote alias.
- Changelog anchors handle prerelease versions, both release-verification layers
  enforce fixed certificate paths, and a real `private: false` package survives
  pack and install.
- Public certificates must be regular files. CI pins exact runners and Node
  versions for Linux, macOS, and Windows.
- Explicit rejection tests for inconsistent package/signing states, an isolated
  empty-cache public-package round trip, package-derived Markdown scan coverage,
  and a SemVer-constrained unpublished-candidate anchor.
- Artifact receipts are required only for a publishable `private: false`
  candidate. Private development remains fully automated, while an absent or
  stale receipt still blocks the actual release transition.
- Public-boundary verification now rejects shallow checkouts and scans every
  changed path in the complete ancestry reachable from `HEAD` and all locally
  available refs. Deleted SDDs, private-development receipts, local context,
  credentials, keys, and generated release artifacts cannot survive in that
  publishable history; authenticated public release receipts remain supported.

[Unreleased]: https://github.com/drzamarian/n8n-mcp-community/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/drzamarian/n8n-mcp-community/releases/tag/v0.1.1
[0.1.0]: https://github.com/drzamarian/n8n-mcp-community/releases/tag/v0.1.0
