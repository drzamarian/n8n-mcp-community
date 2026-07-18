# Maintainer release handoff

Publication is deliberately split so the MCPB signing key never enters GitHub,
GitHub Actions, npm, or the package. This procedure is inactive until Walter has
approved the public signing identity, certificate chain, and key-custody controls.
The tracked `release/mcpb-signing-policy.json` therefore remains explicitly
`unconfigured` and blocks publication.

The current pre-release verifier deliberately requires `package.private: true`.
After Walter explicitly authorizes publication, a separately reviewed release
transition must set `private: false`, activate the signing policy with the exact
leaf fingerprint and public trust-chain PEM digests, and contain those public
PEM files on the same commit that will receive the annotated release tag. No
candidate tag created while the private invariant is active can be reused as a
release tag.

The only permitted public certificate paths are
`release/mcpb-trust-anchor.pem` and the sequential
`release/mcpb-intermediate-1.pem` through
`release/mcpb-intermediate-4.pem` slots named by the active policy. CA
certificates are public verification material, not signing secrets. Arbitrary
PEMs, private keys, certificate-store exports, and unused certificate slots
remain forbidden by the Git-index boundary gate.

## Stage 1: freeze the public release candidate

Private development candidates do not require a human artifact receipt. Their
normal gates still verify exact manifests, byte-reproducible artifacts, clean
installation, security scans, and source/package boundaries after every change.

Require the receipt only after all source audits are complete and the reviewed
release transition sets `package.private` to `false`, activates the signing
policy, and adds its public certificate chain. At that point, run
`npm run artifacts:baseline`, inspect every manifest/count/digest change, and
have the reviewer run `npm run artifacts:approve` from Walter's
repository-pinned local account and an interactive terminal. The command
displays the baseline diff and requires both exact digests before it writes a
receipt that binds the baseline to the public source tree. It cannot
self-approve in CI and does not regenerate the baseline.

For a publishable candidate, `npm run verify`, `check:package`, and `check:mcpb`
fail if the receipt is absent or stale. Commit the baseline, receipt, active
signing policy, public certificate chain, and final source together. Any later
source change requires a new release review; ordinary private development does
not.

1. Create the exact annotated version tag from that approved public commit.
2. Dispatch the release workflow from that tag with `publish` disabled.
3. Review the retained `release-candidate-<tag>` artifact. It contains the npm
   tarball, deterministic unsigned MCPB, Registry metadata, SBOM, and unsigned
   checksums produced from the same checkout.
4. Record the workflow run, tag commit, artifact digest, and review approval.

The workflow fails if its selected Git ref, input tag, package version, tag
object, commit, or artifact inventory differs. An ordinary branch dispatch is
not accepted as a release candidate.

## Stage 2: sign outside GitHub

1. Move the reviewed unsigned MCPB into the dedicated maintainer-controlled
   signing environment.
2. Sign that exact file with the Walter-approved identity. The certificate must
   chain to the root and intermediates pinned in the release commit; self-signed
   certificates are not accepted.
3. Verify the signed bundle locally with `scripts/verify-signed-mcpb.mjs` and
   calculate its SHA-256 digest. Confirm the embedded certificate fingerprint
   against the committed signing policy.
4. Remove temporary bundle copies and signing-session material according to the
   approved custody procedure. Never upload a private key, key backup, signing
   secret, or certificate-store export.

## Stage 3: draft-asset handoff

1. Manually create a **draft** GitHub Release for the exact existing annotated
   tag. Do not publish the draft.
2. Upload only the externally signed
   `n8n-mcp-community-<version>.mcpb` handoff asset.
3. Have Walter approve the signed asset SHA-256 out of band. Certificate identity
   comes only from the separately reviewed release commit.
4. Dispatch the workflow again from the same tag with `publish` enabled, the
   exact `PUBLISH <tag>` confirmation, and the approved signed-asset hash.

Before any publication, the protected job downloads the current unsigned
candidate and the draft asset, requires the repository-pinned policy to be
active, verifies the detached CMS signature and exact pinned certificate chain,
checks the approved asset hash, and proves that removing the canonical signature
block yields bytes identical to the reviewed unsigned MCPB. The verifier's
cryptographic self-test creates an ephemeral root/leaf chain and proves valid,
wrong-digest, wrong-identity, wrong-root, changed-payload, corrupted-signature,
wrong-purpose, non-fixed-certificate-path, and unconfigured-policy paths.

## Stage 4: controlled publication

After the protected environment approval, the workflow publishes the exact npm
tarball through trusted publishing, submits the pinned `server.json` to the MCP
Registry through GitHub OIDC, uploads the final checksums and remaining assets,
and converts the existing draft into the public GitHub Release. No job receives
an MCPB private key.

These services are not transactional. If a failure occurs after npm accepts the
immutable version, stop. Read back every completed external state and use a
separately reviewed continuation for only the missing service; do not retag,
overwrite, or blindly rerun the full publication job.

[Back to the documentation map](README.md)
