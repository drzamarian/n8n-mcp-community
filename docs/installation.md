# Installation and upgrades

## Availability

| Method          | Best for                             | Status                 |
| --------------- | ------------------------------------ | ---------------------- |
| Global npm      | Most terminal users                  | Available              |
| `npx @latest`   | Running without a global install     | Available              |
| Signed MCPB     | Claude Desktop                       | Available              |
| Source checkout | Contributors                         | Available              |
| Homebrew        | A future macOS and Linux CLI install | Planned, not available |

All available methods run the same 44 tools. Use `@latest` for the newest
published release. Use an exact version only for an audit or rollback.

## Source installation

This path is for contributors:

```bash
npm ci
npm run verify:contributor
node dist/index.js --version
```

Point your client to the full path of `dist/index.js`. See
[Getting started](getting-started.md).

<details>
<summary>Update a source checkout</summary>

```bash
git pull --ff-only
npm ci
npm run verify:contributor
```

</details>

## Recommended: global npm installation

### 1. Install

```bash
npm install --global n8n-mcp-community@latest
```

### 2. Add the server to your MCP client

```json
{
  "mcpServers": {
    "n8n-community": {
      "command": "n8n-mcp-community",
      "env": {
        "N8N_API_URL": "https://n8n.example.com",
        "N8N_API_KEY": "replace-with-a-dedicated-api-key",
        "N8N_MCP_MODE": "read-only"
      }
    }
  }
}
```

### 3. Restart the client

You should see 44 tools, 5 resources, and 4 prompts.

Use a dedicated API key. Start with `read-only`. Change the mode to `write` for
normal changes or `unsafe` for all tools.

If the client says the command was not found, locate it:

```bash
command -v n8n-mcp-community
```

On Windows, run `where n8n-mcp-community`. Use the returned full path as the
client's `"command"`. Node managers such as nvm, fnm, or Volta can place global
commands in a version-specific folder, so check the path again after changing
Node versions.

Run the install command again to update. To roll back, replace `latest` with a
version, such as `0.1.4`.

### Upgrade from 0.1.x

Your n8n URL, API key, and `N8N_MCP_MODE` values stay the same. Update the
package, then restart the MCP client so it reloads the tool schemas. Version
0.2.0 removed the second confirmation input; unsafe mode alone now unlocks
unsafe tools.

Global npm users do not edit the client entry. If you followed the 0.1.x npx
guide, your client is pinned to `n8n-mcp-community@0.1.4`: replace that argument
with `n8n-mcp-community@latest` or `n8n-mcp-community@0.3.0`. Restart the client,
run the npx version check below, and confirm the 44/5/4 inventory.

If custom code sends raw tool-call JSON, remove the former `confirmation` field
from unsafe calls.

## Alternative: npx without a global installation

Use this command in your client settings:

```json
{
  "mcpServers": {
    "n8n-community": {
      "command": "npx",
      "args": ["--yes", "n8n-mcp-community@latest"],
      "env": {
        "N8N_API_URL": "https://n8n.example.com",
        "N8N_API_KEY": "replace-with-a-dedicated-api-key",
        "N8N_MCP_MODE": "read-only"
      }
    }
  }
}
```

On Windows, use:

```json
{
  "mcpServers": {
    "n8n-community": {
      "command": "cmd",
      "args": ["/c", "npx", "--yes", "n8n-mcp-community@latest"],
      "env": {
        "N8N_API_URL": "https://n8n.example.com",
        "N8N_API_KEY": "replace-with-a-dedicated-api-key",
        "N8N_MCP_MODE": "read-only"
      }
    }
  }
}
```

This Windows form is not yet release-tested.

## Signed MCPB

Claude Desktop can install the MCPB without Node.js or JSON editing.

### Install the MCPB in Claude Desktop

1. Open the [latest GitHub release](https://github.com/drzamarian/n8n-mcp-community/releases/latest).
2. Download `n8n-mcp-community-<VERSION>.mcpb` and `SHA256SUMS`.
3. Check that the file's SHA-256 matches `SHA256SUMS`.
4. Open **Settings → Extensions → Advanced settings → Install Extension…**.
5. Pick the `.mcpb` file.
6. Enter your n8n URL, API key, and mode. Keep insecure HTTP set to `0` unless
   you know you need it.
7. Finish the install. You should see 44 tools, 5 resources, and 4 prompts.

See [Anthropic's MCPB guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

MCPB and Homebrew are separate. A future Homebrew formula will install the CLI;
it will not update the MCPB file.

### Update or roll back the MCPB

Privately distributed MCPB files do not update automatically. To update:

1. Download the new `.mcpb` and `SHA256SUMS` from the exact GitHub release.
2. Verify the checksum, then use **Install Extension…** again and choose the new
   file.
3. Re-enter the same n8n settings if Claude Desktop asks for them, then restart
   Claude Desktop.
4. Confirm the extension details show the intended version and the 44/5/4
   inventory is present.

To roll back:

1. Download the older signed `.mcpb` and `SHA256SUMS` from its exact release,
   such as [v0.1.4](https://github.com/drzamarian/n8n-mcp-community/releases/tag/v0.1.4),
   and verify the checksum.
2. In **Settings → Extensions**, open n8n MCP Community and use Claude
   Desktop's remove or uninstall control.
3. Install the older file with **Advanced settings → Install Extension…**,
   enter the n8n settings again, and restart Claude Desktop.
4. Confirm the older version in the extension details and check the inventory.

A rollback restores the older tool schema and older security fixes. Use it only
while diagnosing a regression, then return to the latest release.

## Verify the installation route you chose

### Global npm

```bash
n8n-mcp-community --help
n8n-mcp-community --version
n8n-mcp-community doctor
```

`doctor` reads the environment of that shell, not the values stored inside the
MCP client. Set `N8N_API_URL` and `N8N_API_KEY` in the shell before running it;
without them, the check correctly fails. It makes no n8n request unless
`N8N_MCP_DOCTOR_PROBE=1` is set.

### npx

```bash
npx --yes n8n-mcp-community@latest --version
```

Then restart the client and confirm 44 tools, 5 resources, and 4 prompts.

### MCPB

MCPB does not install a global terminal command. Confirm the inventory in
Claude Desktop: 44 tools, 5 resources, and 4 prompts.

### Source

```bash
node dist/index.js --version
```

## Check npm provenance

Before first use, open the
[npm package page](https://www.npmjs.com/package/n8n-mcp-community) and check
that its provenance points to the expected GitHub source and release workflow.
The green provenance mark is explained in
[npm's official guide](https://docs.npmjs.com/viewing-package-provenance/).

`npm audit signatures` is useful only inside a project installed with npm and a
lockfile. It is not a verification command for the global, npx, or MCPB routes.

## Remove an installation

- Global npm: remove the client entry, then run
  `npm uninstall --global n8n-mcp-community`.
- `npx`: remove the client entry.
- MCPB: remove the extension in your client.
- Source: remove the checkout after saving any work you need.

Rotate the n8n API key if a device is lost or the key may have leaked.

[Back to the documentation map](README.md)
