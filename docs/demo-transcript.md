# Synthetic demo transcript

This transcript accompanies the animated README demo. It contains no real n8n
host, API key, workflow identifier, or workflow data. The visual compresses a
standards-based MCP client interaction into a short terminal-style sequence; it
does not claim that the client narration is a project CLI command.

```text
$ npx --yes n8n-mcp-community@0.1.1 --version
0.1.1

MCP client initialized n8n-community
44 tools | 5 resources | 4 prompts
mode: read-only | external AI: none

MCP client -> n8n_introspect
{"workflowId":"wf_synthetic_1","profile":"quick"}

schema 1.0.0 | engine 2.0.0 | status: complete
findings: 0 critical | 0 high | 0 medium | 0 low | 0 info
```

The version command is the published exact-version installation route for
v0.1.1. The initialization and tool call lines represent MCP protocol
events, not shell commands. The Introspect output is the documented empty
finding example: the real direct structured result also includes coverage, rule
outcomes, and limitations. Its fields remain untrusted n8n-derived diagnostics
and pass through the shared sanitizer before emission, as described in the
[tool reference](tools.md#n8n_introspect).

[Back to the documentation map](README.md)
