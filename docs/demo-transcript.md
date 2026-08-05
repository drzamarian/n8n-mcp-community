# Demo transcript

The README GIF uses fake names and fake data. It shows three steps.

## 1. Install

```text
$ npm install --global n8n-mcp-community@latest
```

When npm finishes, add the server command to your client. Update later with the
same install command.

## 2. Connect

```text
command: "n8n-mcp-community"
mode:    "read-only"

✓ 44 tools · 5 resources · 4 prompts
```

## 3. Inspect

```text
Ask your AI client:
“Check workflow wf_demo for hidden risks.”

Running n8n_introspect
workflow: wf_demo
profile:  quick

✓ 23 deterministic rules
0 workflow runs · 0 external AI calls

MEDIUM · Retry may repeat an HTTP side effect
A POST request retries without an idempotency key.
The same external action may happen twice.

Add an idempotency key or turn off retry.
```

The finding matches the tool's real `NODE_RETRY_SIDE_EFFECT` rule. Introspect
does not run the workflow or call an AI service. Tool results still pass through
your MCP client, so review that client's data policy. The full result also
includes coverage, rule outcomes, and limits. See the
[tool reference](tools.md#n8n_introspect).

[Back to the documentation map](README.md)
