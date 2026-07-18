# Changelog

All notable changes to this project will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/).

## [Unreleased]

No changes have been assigned beyond the first unpublished release candidate.

## [0.1.0] - Unpublished candidate

### Added

- Secure stdio MCP runtime with exactly 44 tools, five resources, and four prompts.
- Three operation modes with exact confirmations for unsafe calls.
- Deterministic local Introspect engine v2 with 23 diagnostic rules.
- Strict Node 22/24 test, build, dependency-license, and package gates.
- Native-English public documentation and complete tool reference.
- Embedded synthetic terminal demonstration with a packaged transcript and an
  automated orphan-asset documentation gate.

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

No public version has been released.

[Unreleased]: #unreleased
[0.1.0]: #010---unpublished-candidate
