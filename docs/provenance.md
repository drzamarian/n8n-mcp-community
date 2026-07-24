# Provenance

This project treats source origin, dependency licensing, and artifact contents
as release gates rather than informal assumptions.

## Maintainer declaration

Walter Zamarian Jr. is the creator, project owner, and maintainer of n8n MCP
Community. He has declared that the contributed implementation originates from
work created under his direction and that he is authorized to publish the
project source under the MIT License.

AI-assisted development was used as an implementation and review tool under the
maintainer's direction. Candidate changes are still subject to human approval,
tests, provenance review, and independent audits. AI assistance does not grant
the project rights to third-party source and is not treated as evidence of
license compatibility.

## Clean public implementation

The public candidate is a reviewed clean implementation of the approved MCP
contract. Private operational files, credentials, generated audit evidence,
fixtures derived from real systems, and machine-specific state are excluded
from Git and release artifacts.

Official n8n Public API descriptions and observed synthetic Community Edition
behavior are used as factual compatibility references. The project does not
copy or redistribute n8n's `n8n-nodes-base` catalog, source, credentials,
workflow templates, or paid-only implementation. Offline node guidance is a
small original allowlist maintained in this repository.

## Project license

Project-authored source and documentation are offered under the
[MIT License](../LICENSE). The license does not relicense n8n, the Model Context
Protocol SDK, npm dependencies, trademarks, user workflows, or any other
third-party material.

“n8n” is used only to identify compatibility. This project is not affiliated
with, endorsed by, or sponsored by n8n GmbH.

## Dependency controls

Runtime dependencies are exact-pinned in `package-lock.json`; development tools
are also exact-pinned. `npm ci` is the required installation path for review and
CI.

`npm run licenses:check` examines every installed lockfile package path and
fails on:

- a license outside the explicit allowlist;
- missing package integrity;
- missing license metadata;
- a package that declares a license or notice file but omits it.

The current source candidate covers 224 installed package paths representing
222 unique components: 93 runtime paths and 131 development paths. After two
explicit permissive-alternative selections, the effective licenses are 184 MIT,
15 ISC, 13 Apache-2.0, 7 BSD-2-Clause, 4 BSD-3-Clause, and 1
BlueOak-1.0.0, with no missing integrity, license, or documented notice. Six
exact-pinned development-only packages use the reviewed missing-file exception,
and two development-only packages use exact-pinned alternative-license
selections described in [third-party notices](../THIRD_PARTY_NOTICES.md). These
counts must be regenerated after any lockfile change.

PyYAML 6.0.3 was used as local audit tooling to parse official OpenAPI material
and compare endpoint schemas. It is not imported by the TypeScript runtime or
included as an npm dependency.

Static analysis is reproducible rather than policy-by-alias: CI checks out the
public `semgrep/semgrep-rules` repository at commit
`e5b5a42ec061854378c11e0d01f19250b52bc2e9`, selects its JavaScript and
TypeScript security rules in deterministic order, adds its JavaScript audit
rules, and runs them with an exact digest-pinned Semgrep image. Both the rules
checkout and its credentials are excluded from the project index and release
artifacts.

## SBOM and reproducibility

Generate the release runtime CycloneDX SBOM from the committed lockfile with:

```bash
npm run sbom > sbom.cdx.json
```

This runtime-only SBOM contains 75 unique production components for the shared
npm/MCPB runtime graph. Maintainers may separately generate the complete
222-component development graph with `npm run sbom:full`; it is audit evidence,
not the release artifact SBOM. Every release candidate must carry a runtime
SBOM for the npm package and MCPB, plus SHA-256 checksums and signatures tied to
the exact Git revision; availability is established only by the corresponding
published-release readbacks.
The package and MCPB must be reconstructed from a clean checkout and match the
documented inventory.

## Artifact boundary

The public-boundary gate requires a non-shallow Git checkout. It checks both the
current index and every path in the complete ancestry reachable from `HEAD` and
all locally available refs. Deleting a private SDD, private-development receipt,
environment file, local agent file, key, or release artifact therefore does not
make that reachable history safe. CI fetches complete ancestry for its checked-out
ref before running the gate. A public artifact-review receipt is allowed only in
a `private: false` release candidate and remains subject to the authenticated
receipt gate.

The npm `files` allowlist admits compiled JavaScript and selected public
documentation only. It excludes TypeScript sources, tests, SDDs, local rule
files, audit evidence, `.env`, machine memory, package caches, and generated
catalogs. MCPB contents must be inspected independently and preserve required
third-party license and notice obligations.

The gate creates and installs the actual npm tarball; a dry run is not treated as
artifact evidence. The final tarball and MCPB must pass clean install, inventory,
secret, malware, vulnerability, license, SBOM, checksum, signature, upgrade,
rollback, and uninstall gates before publication.

## Release ordering and recovery

The dispatch first builds an unsigned, reviewable npm/MCPB/SBOM/checksum set
with read-only repository permissions. Walter downloads that exact candidate,
signs it outside GitHub in the approved maintainer-controlled environment, and
uploads only the signed MCPB to a draft release for the exact annotated tag. No
MCPB private key, signing secret, or signing operation enters GitHub Actions.

Publication is a separate environment-protected job. It requires exact tag
confirmation, a public npm manifest, Walter's approved SHA-256 for the signed
bundle, an active signing policy committed with the release candidate, and the
existing draft release handoff. The policy pins the signing-certificate
fingerprint and exact trust-anchor/intermediate PEM digests; none is supplied as
free-form workflow input. The job verifies the CMS signature, pinned chain,
code-signing purpose, embedded certificate inventory, signed bundle digest, and
byte-for-byte identity between the signed payload and the reviewed unsigned
candidate before it publishes anything. A self-signed certificate is not
accepted. Only that job receives `id-token: write` and `contents: write`.

npm, the MCP Registry, and GitHub Releases are separate services, so publication
is not atomic. The gated order is external MCPB signing and draft-asset handoff,
workflow verification, npm trusted publishing, MCP Registry OIDC publication,
then completion of the existing GitHub draft release. If a step fails after npm
accepts the immutable version, stop: do not retag, overwrite, or blindly rerun
the full workflow. Verify the exact npm artifact and every completed external
state first, then use a separately reviewed continuation for only the missing
services. The release remains incomplete until all three services and the
attached checksums read back the intended version.

## Reporting a provenance concern

Use the private process in [SECURITY.md](../SECURITY.md) when disclosure could
expose sensitive source or credentials. For a non-sensitive attribution or
license concern, open an issue identifying the exact file, revision, and basis
for the claim. Do not attach proprietary source to a public issue.

[Back to the documentation map](README.md)
