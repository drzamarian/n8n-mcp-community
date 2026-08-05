# MCP client setup

The server uses MCP over stdio.

## Recommended global npm setup

Install once:

```bash
npm install --global n8n-mcp-community@latest
```

Add this to your MCP client:

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

Restart the client.

## npx setup

Do not want a global install? Use:

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

On Windows, use `cmd`:

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

If a desktop client cannot find a global command, run
`command -v n8n-mcp-community` on macOS/Linux or
`where n8n-mcp-community` on Windows and use the returned full path. Recheck it
after changing Node versions when you use nvm, fnm, or Volta.

## MCPB setup for Claude Desktop

1. Download the `.mcpb` from the
   [latest release](https://github.com/drzamarian/n8n-mcp-community/releases/latest).
2. Open **Settings → Extensions → Advanced settings → Install Extension…**.
3. Pick the file and enter your n8n URL, API key, and mode.

The MCPB contains no API key or n8n URL. See
[Installation](installation.md#signed-mcpb) for checksum steps.

## Source setup

Contributors can run the built file:

```json
{
  "mcpServers": {
    "n8n-community": {
      "command": "node",
      "args": ["/absolute/path/to/n8n-mcp-community/dist/index.js"],
      "env": {
        "N8N_API_URL": "https://n8n.example.com",
        "N8N_API_KEY": "replace-with-a-dedicated-api-key",
        "N8N_MCP_MODE": "read-only"
      }
    }
  }
}
```

Run `npm ci && npm run verify:contributor` first. Use the full file path.

## Check the connection

1. Confirm 44 tools, 5 resources, and 4 prompts.
2. Call `n8n_health`.
3. Call `n8n_workflows_list` with a small limit.
4. Confirm that write tools fail in `read-only` mode.

If the counts are wrong, check the command and restart the client. See
[Troubleshooting](troubleshooting.md).

[Back to the documentation map](README.md)
