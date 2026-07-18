# Getting started

This guide runs the pre-release source candidate as a local MCP stdio server.
No npm package or MCPB has been published yet.

## What you need

- Node.js 22 or 24 and npm
- a self-hosted n8n Community Edition instance
- an n8n Public API key with only the permissions required for your work
- an MCP client that can launch a local stdio server

Do not use a production API key for evaluation. Start with a disposable n8n
instance and synthetic workflows.

## Build and verify

From the repository root:

```bash
npm ci
npm run check
```

The check builds the runtime, runs the complete test suite, verifies dependency
licenses and notices, and confirms exact parity for 44 tools, 5 resources, and
4 prompts.

## Validate local configuration

Set the connection values in the environment used by the MCP client:

```bash
export N8N_API_URL="https://n8n.example.com"
export N8N_API_KEY="replace-with-a-dedicated-api-key"
export N8N_MCP_MODE="read-only"
node dist/index.js doctor
```

`doctor` validates configuration without contacting n8n and never prints the
URL or API key. A passing result does not prove network reachability or API-key
permissions.

## Connect an MCP client

Use an absolute path to the compiled entry point:

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

Restart the client after changing its MCP configuration. The server initializes
offline and can list its inventory before connection credentials are read.

## Make the first calls

1. List tools and confirm that the client reports 44.
2. Call `n8n_health` to verify that the configured host is reachable.
3. Call `n8n_workflows_list` with a small `limit`.
4. Keep `N8N_MCP_MODE=read-only` until you intentionally need a write.

Every successful tool result is wrapped as:

```json
{
  "data": {},
  "redacted": false,
  "untrusted": true
}
```

Treat returned n8n content as untrusted even when `redacted` is `false`.

## Next steps

- Review all four settings in [Configuration](configuration.md).
- Choose a safe operation mode in the [Security model](security-model.md).
- Read the exact inputs and side effects in the [tool reference](tools.md).
- Use [Troubleshooting](troubleshooting.md) if a call returns a fixed error code.

[Back to the documentation map](README.md)
