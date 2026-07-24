# Installation and upgrades

## Availability

| Method              | Availability evidence                                         | Intended use                                       |
| ------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| Source checkout     | The reviewed local checkout                                   | Contributors and release review                    |
| Exact-version `npx` | The exact version visible on npm with provenance              | Portable configuration across MCP clients          |
| Signed MCPB         | The matching signed asset in the latest GitHub release        | Easiest installation in compatible desktop clients |
| Homebrew            | Not available; Homebrew does not update standalone MCPB files | No formula is currently maintained                 |

The source, npm package, and MCPB expose the same 44-tool runtime. Configure
only an exact published version; never configure an unpublished version as
though it were available.

## Source installation

Clone or copy the repository to a trusted local directory, then run:

```bash
npm ci
npm run verify:contributor
node dist/index.js --version
```

Configure the client to run `node` with the absolute path to `dist/index.js`, as
shown in [Getting started](getting-started.md). Do not add `sudo`, a shell
wrapper, or command-line secrets.

To update a source checkout after reviewing the incoming changes:

```bash
git fetch --all --tags
git switch dev
git pull --ff-only
npm ci
npm run verify:contributor
```

Use a release tag rather than `dev` after public releases begin.

## Exact-version npx

Confirm that npm, GitHub Releases, and the MCP Registry agree on one version,
then replace `<VERIFIED_VERSION>` below with that exact value:

```json
{
  "mcpServers": {
    "n8n-community": {
      "command": "npx",
      "args": ["--yes", "n8n-mcp-community@<VERIFIED_VERSION>"],
      "env": {
        "N8N_API_URL": "https://n8n.example.com",
        "N8N_API_KEY": "replace-with-a-dedicated-api-key",
        "N8N_MCP_MODE": "read-only"
      }
    }
  }
}
```

`read-only` in this example is a safe starting default, not a limitation of
the server: `N8N_MCP_MODE=write` enables workflow and node authoring, and
`N8N_MCP_MODE=unsafe` enables the complete 44-tool surface with exact
per-call confirmations for destructive operations.

Verify the selected version's provenance attestation on the npm package page or
with `npm audit signatures` before first use. Windows clients that do
not launch `npx` directly may use
`"command": "cmd"` with
`"args": ["/c", "npx", "--yes", "n8n-mcp-community@<VERIFIED_VERSION>"]`.

Do not use `@latest`. An exact version makes upgrades deliberate, reviewable,
and reversible. To upgrade, replace the version only after reading the
changelog and verifying the release checksums and signatures. To roll back,
restore the last known-good exact version and restart the MCP client.

`npx` may download the pinned package on first use. Normal npm cache behavior
applies; this project does not add a second updater.

## Signed MCPB

The signed MCPB for a released version appears as a
[latest-release asset](https://github.com/drzamarian/n8n-mcp-community/releases/latest)
together with `SHA256SUMS` and an SBOM. The manifest declares Linux, macOS, and
Windows because the bundle contains the same portable Node.js stdio server on
each platform; the release does not claim client compatibility on an operating
system until installation, upgrade, rollback, and removal have passed there.
MCPB is intended to be the simplest path for non-developers: inspect the
signature and checksum, open the bundle in a compatible client, supply
connection settings through that client's secret configuration UI, and confirm
the 44-tool inventory.

An MCPB is not a Homebrew package. Homebrew cannot update it unless a separate
formula is created, and no formula is currently maintained. MCPB updates will be
explicit signed release downloads or a compatible client's verified update
flow; the exact process will be documented only after it is tested end to end.

## Verify any installation

The runtime offers three offline commands:

```bash
n8n-mcp-community --help
n8n-mcp-community --version
n8n-mcp-community doctor
```

For a source checkout, replace `n8n-mcp-community` with `node dist/index.js`.
`doctor` requires the connection variables but performs no network request and
does not display their values.

After starting the server through a client, verify the exact 44 tools, 5
resources, and 4 prompts. A different count means the installation is stale,
incomplete, or not this project.

## Remove an installation

- Source checkout: remove the local directory after preserving any changes you
  intentionally made. Connection values live in the MCP client, not the repo.
- Exact-version `npx`: remove the MCP client entry. Clearing the npm cache is
  optional and affects other npm packages.
- MCPB: use the compatible client's removal flow, then remove its stored n8n
  connection settings.

Rotating the dedicated n8n API key is recommended whenever an installation is
retired, a device is lost, or secret exposure is suspected.

[Back to the documentation map](README.md)
