# Configuration

The runtime reads exactly four environment variables. It does not read `.env`
files itself and accepts no secrets as command-line arguments.

| Variable                  | Required            | Default     | Contract                                                               |
| ------------------------- | ------------------- | ----------- | ---------------------------------------------------------------------- |
| `N8N_API_URL`             | For connected tools | None        | Absolute HTTP(S) base URL; no embedded credentials, query, or fragment |
| `N8N_API_KEY`             | For connected tools | None        | Dedicated n8n Public API key                                           |
| `N8N_MCP_MODE`            | No                  | `read-only` | Exactly `read-only`, `write`, or `unsafe`                              |
| `N8N_ALLOW_INSECURE_HTTP` | No                  | `0`         | Exactly `0` or `1`; permits non-loopback plaintext HTTP when `1`       |

The MCP server starts offline. `N8N_API_URL` and `N8N_API_KEY` are validated
only when a connected tool is called or when `doctor` is run. Inventory,
resources, prompts, `--help`, and `--version` do not need them.

## Connection URL

Use the externally reachable base URL for the intended n8n instance:

```text
https://n8n.example.com
```

A trailing slash is normalized. Do not add `/api/v1`; the server adds that path
for Public API requests. A reverse-proxy path prefix is preserved. URLs with a
username, password, query string, or fragment are rejected.

HTTPS is required for non-loopback hosts by default. Plain HTTP is accepted for
`localhost`, `127.0.0.1`, and `::1` to support local disposable environments.
Setting `N8N_ALLOW_INSECURE_HTTP=1` for another host accepts the risks of sending
the API key and n8n data without transport encryption.

## API key

Create a dedicated Public API key for this MCP server. Give it only the n8n
permissions needed for the tools you intend to use, and store it in the MCP
client's secret or environment configuration. Never commit it, paste it into an
issue, pass it in `args`, or place it in the base URL.

The server sends the key only as `X-N8N-API-KEY` to the configured origin.
Redirects are rejected. The server cannot make an over-privileged key safe, so
upstream least privilege remains essential.

## Operation modes

| Mode        | Read-only tools | Write tools |                             Unsafe tools |
| ----------- | --------------: | ----------: | ---------------------------------------: |
| `read-only` |         Allowed |      Denied |                                   Denied |
| `write`     |         Allowed |     Allowed |                                   Denied |
| `unsafe`    |         Allowed |     Allowed | Allowed with exact per-call confirmation |

Unsafe tools delete, retry, stop, activate, deactivate, archive, unarchive,
invite, or otherwise perform an operation requiring explicit acknowledgement.
Their `confirmation` input must exactly match the phrase documented for that
tool. A mode or confirmation denial occurs before any n8n request.

Prefer a permanent read-only client entry. Create a separate temporary write or
unsafe entry only when required, then remove or downgrade it after the task.

## Client-owned environment

The MCP client launches the stdio process and therefore controls its effective
environment. Values supplied in the client entry take precedence according to
that client and operating system; this project does not merge configuration
files. Restart the client after changing settings.

The repository includes `.env.example` only as a field reference. The runtime
does not auto-load `.env`, and `.env` is ignored by Git.

## Offline validation

Run:

```bash
N8N_API_URL="https://n8n.example.com" \
N8N_API_KEY="replace-with-a-dedicated-api-key" \
N8N_MCP_MODE="read-only" \
node dist/index.js doctor
```

A pass confirms syntax, Node major-version acceptance, mode, and transport
policy without revealing the URL or key and without contacting n8n. Use
`n8n_health` through an MCP client to test live reachability separately.

[Back to the documentation map](README.md)
