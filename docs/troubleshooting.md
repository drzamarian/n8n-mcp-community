# Troubleshooting

Start with the smallest safe diagnostic. Do not paste real connection values,
workflow payloads, execution payloads, cookies, or credentials into an issue.

## The server does not start

Run the offline CLI from the same environment the client uses:

```bash
node dist/index.js --version
node dist/index.js --help
node dist/index.js doctor
```

If `dist/index.js` is missing, run `npm ci && npm run build`. If `doctor` fails,
check the four variables in [Configuration](configuration.md). On a configuration
failure the CLI writes one fixed JSON line to stderr — for example
`{"event":"startup_failed","code":"configuration_error","reason":"api_url_scheme_unsupported","setting":"N8N_API_URL"}` —
that names the offending setting and the exact rule that failed. It never echoes
the URL or key.

An `Unknown command or option` failure means the client added an unsupported
argument. The stdio server takes no arguments; all connection settings are
environment variables.

### Configuration failure reason codes

Startup and `doctor` emit the same `configuration_error` line with a stable,
secret-free `reason` and the `setting` to correct. Fix only the named setting.

| Reason                         | Setting                   | Meaning                                                                |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------- |
| `mode_invalid`                 | `N8N_MCP_MODE`            | Not exactly `read-only`, `write`, or `unsafe`                          |
| `insecure_http_flag_invalid`   | `N8N_ALLOW_INSECURE_HTTP` | Not exactly `0` or `1`                                                 |
| `api_url_missing`              | `N8N_API_URL`             | Empty, whitespace-only, or unset                                       |
| `api_key_missing`              | `N8N_API_KEY`             | Empty, whitespace-only, or unset                                       |
| `api_key_invalid`              | `N8N_API_KEY`             | Contains characters illegal in an HTTP header value                    |
| `api_url_invalid`              | `N8N_API_URL`             | Not a valid absolute URL                                               |
| `api_url_scheme_unsupported`   | `N8N_API_URL`             | Scheme is not HTTP or HTTPS                                            |
| `api_url_embedded_credentials` | `N8N_API_URL`             | Contains a username or password                                        |
| `api_url_query_or_fragment`    | `N8N_API_URL`             | Contains a query string or fragment                                    |
| `api_url_insecure_http`        | `N8N_API_URL`             | Plain HTTP for a non-loopback host without `N8N_ALLOW_INSECURE_HTTP=1` |

## The client shows no server or the wrong tool count

- Use an absolute executable path for a source checkout.
- Confirm the client launches Node.js 22 or 24.
- Restart the client after configuration changes.
- Check `node dist/index.js --version` from that exact checkout.
- Remove stale duplicate MCP entries.
- Confirm exactly 44 tools, 5 resources, and 4 prompts.

Inventory registration is offline. Missing n8n credentials do not explain a
missing tool list; they affect connected calls only.

## Fixed error codes

Tool errors include a correlation ID. The server does not return upstream error
bodies.

| Code                      | Meaning                                                            | Safe next step                                                                              |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `configuration_error`     | URL, key, mode, or HTTP policy is missing or invalid               | Run `doctor`; correct only the named setting                                                |
| `operation_denied`        | The current mode or exact confirmation does not authorize the call | Review the tool contract; elevate mode only if intended                                     |
| `invalid_path`            | A generated Public API path failed local validation                | Record the tool and sanitized input shape; report if reproducible                           |
| `origin_mismatch`         | A generated URL did not retain the configured origin               | Stop and report privately                                                                   |
| `request_too_large`       | The JSON request exceeded 2 MiB                                    | Narrow the operation or reduce workflow size                                                |
| `response_too_large`      | The response exceeded 2 MiB                                        | Use filters or smaller pages; avoid repeating the same broad call                           |
| `request_failed`          | No valid n8n response arrived before failure or timeout            | Check DNS, TLS, proxy, reachability, and n8n availability                                   |
| `redirect_rejected`       | n8n or its proxy returned a redirect                               | Configure the final canonical base URL; do not bypass the control                           |
| `upstream_error`          | n8n returned a non-success HTTP status                             | Check API-key scope and n8n logs using the correlation time                                 |
| `invalid_json`            | n8n returned empty-invalid, non-UTF-8, or malformed JSON           | Inspect the proxy and n8n response without sharing sensitive bodies                         |
| `upstream_shape_mismatch` | The n8n response did not match the supported API schema            | Most often the instance is below the documented 2.30.5 floor or a proxy altered the payload |
| `tool_error`              | A local invariant or tool-specific check failed                    | Read the sanitized message and the tool's failure contract                                  |

Input-schema failures may be represented by the MCP client before the handler
runs. They should make zero upstream requests.

### Introspect error codes

This dedicated set is mechanically synchronized with the public Introspect
contract. Some codes also appear in the general table because they are shared
with other tools.

<!-- introspect-errors:start -->

| Code                  | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `invalid_input`       | The closed Introspect input schema rejected the request    |
| `invalid_output`      | The result could not fit the fixed safe output contract    |
| `invalid_path`        | A generated bounded-read path failed local validation      |
| `deadline_exceeded`   | The immutable collection deadline ended the scan           |
| `response_too_large`  | A bounded Public API response exceeded its byte budget     |
| `upstream_http_error` | A bounded Public API read returned a non-success status    |
| `invalid_json`        | A bounded Public API response was not valid JSON           |
| `invalid_schema`      | A response did not match the supported Community API shape |

<!-- introspect-errors:end -->

## Health fails but doctor passes

`doctor` performs no network request by default. A default pass proves
configuration syntax, not DNS, TLS, network routing, API-key validity, or n8n
health. Check that `N8N_API_URL` is the reachable base URL and that a reverse
proxy does not redirect `/healthz`. Setting `N8N_MCP_DOCTOR_PROBE=1` adds a
bounded floor-compatibility probe of two single-item reads; see
[Compatibility](compatibility.md) for its `diagnosis` values.

## HTTP is rejected

Plain HTTP is accepted by default only for loopback hosts. Use HTTPS for any
other host. `N8N_ALLOW_INSECURE_HTTP=1` is an explicit acceptance of plaintext
API-key and data exposure; it is not a generic troubleshooting switch.

## A write or unsafe operation is denied

The default mode is `read-only`. Write tools require `write` or `unsafe`.
Unsafe tools require `unsafe` and the exact input-bound confirmation documented
in [the tool reference](tools.md). Restart the MCP client after changing its
environment. Do not keep unsafe mode enabled for convenience.

## `n8n_credentials_list` fails

This tool was verified on n8n Community Edition 2.30.5 and 2.30.7 and requires an API key allowed
to list credential metadata. It never returns credential values. A 403 usually
indicates key scope; a 404 may indicate an older or incompatible n8n version or
proxy path.

## `n8n_list_node_types` looks incomplete

The tool reports types observed in workflows visible to the configured API key.
It is deliberately not an installed-node catalog. Increase `maxPages` within
the documented bound or grant access to the relevant workflows, but do not
interpret absence as proof that a package or type is unavailable.

## Introspect reports partial or inconclusive results

`n8n_introspect` uses a bounded workflow and execution-history sample. Partial
pagination, repeated cursors, oversized facts, missing execution detail, or
unknown node versions can make a rule inconclusive. Use deep mode only when the
extra bounded reads are appropriate. The tool does not execute the workflow or
contact an external model.

Introspect uses the following stable machine-readable limitation codes. A
limitation describes bounded or incomplete evidence; it is not an instruction
to weaken a safety control.

<!-- introspect-limitations:start -->

| Limitation code         | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `deadline_exceeded`     | The immutable collection deadline ended the scan                 |
| `response_too_large`    | A Public API response exceeded its byte budget                   |
| `upstream_http_error`   | A bounded Public API read failed                                 |
| `invalid_json`          | A Public API response was not valid JSON                         |
| `invalid_schema`        | A response did not match the supported Community schema          |
| `repeated_cursor`       | Pagination stopped at a repeated cursor                          |
| `invalid_timestamp`     | Invalid execution timestamps were excluded                       |
| `invalid_execution_id`  | An unsafe execution ID prevented a detail read                   |
| `page_failed`           | A later metadata page could not be collected                     |
| `detail_failed`         | A selected execution detail could not be reduced safely          |
| `ordering_unreliable`   | Execution ordering could not support temporal conclusions        |
| `finding_limit`         | A per-rule occurrence cap omitted additional findings            |
| `output_limit`          | The report was reduced to its fixed output-byte budget           |
| `label_redaction_limit` | Optional labels retain an explicit residual redaction limitation |

<!-- introspect-limitations:end -->

## A node update reports a preservation mismatch

Stop further writes and inspect the workflow immediately. The mismatch is
detected in n8n's response after the full-workflow `PUT`, so the mutation may
already have occurred and this server cannot roll it back. Restore from your
known-good workflow version or backup only after comparing the current state.

## Reporting a reproducible problem

Include the package version or commit, Node.js version, n8n Community Edition
version, tool name, operation mode, fixed error code, correlation ID, and a
minimal synthetic reproduction. Replace all URLs, IDs, names, emails, workflow
content, and keys. Use [SECURITY.md](../SECURITY.md) for any suspected security
boundary failure.

[Back to the documentation map](README.md)
