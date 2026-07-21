# MCP client configuration

The server uses standard MCP over stdio. No client-specific support claim is
made until the published npm and MCPB artifacts complete an end-to-end client
matrix.

## Generic source configuration

Most local MCP clients accept a server name, command, arguments, and environment
mapping. The equivalent source configuration is:

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

Use an absolute path. Build first with `npm ci && npm run build`, place secrets
only in the client's environment or secret UI, and restart the client after any
configuration change. The exact file location and outer JSON shape belong to
the client and may differ from this generic fragment.

## Exact-version npx configuration

The portable configuration runs the reviewed published version explicitly:

```json
{
  "mcpServers": {
    "n8n-community": {
      "command": "npx",
      "args": ["--yes", "n8n-mcp-community@0.1.1"],
      "env": {
        "N8N_API_URL": "https://n8n.example.com",
        "N8N_API_KEY": "replace-with-a-dedicated-api-key",
        "N8N_MCP_MODE": "read-only"
      }
    }
  }
}
```

Verify the published provenance attestation before first use. Do not replace
the exact version with `@latest`; explicit pins make review, rollback, and
incident response deterministic.

On Windows, a client that cannot launch `npx` directly may use:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "--yes", "n8n-mcp-community@0.1.1"]
}
```

This Windows form is not yet release-tested.

## MCPB path

Compatible clients may be able to install the signed MCPB without editing JSON.
The bundle contains the same compiled server and requests the same four
settings documented in [Configuration](configuration.md). It does not contain
an API key or instance URL.

The project will publish client-specific MCPB instructions only after testing
installation, signature and checksum inspection, configuration, exact inventory
readback, a synthetic tool call, upgrade, rollback, and removal. An MCPB is not
updated by Homebrew.

## Post-connection verification

For every client:

1. Confirm exactly 44 tools, 5 resources, and 4 prompts.
2. Read `n8n://usage-guide` before the first write.
3. Call `n8n_health`, then a bounded `n8n_workflows_list`.
4. Confirm writes are denied in the default read-only mode.
5. Check the client's own logs and retention policy before handling sensitive
   n8n metadata.

If the client shows a different inventory, verify the executable path or exact
package version and restart it. See [Troubleshooting](troubleshooting.md).

[Back to the documentation map](README.md)
