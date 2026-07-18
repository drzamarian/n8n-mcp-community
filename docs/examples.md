# Tested examples

These examples use synthetic IDs and placeholder hosts. The documentation gate
extracts every marked input and validates it against the compiled tool schema.
They demonstrate request shape only; the release lifecycle separately proves
real behavior against disposable n8n Community Edition instances.

Keep the server in read-only mode unless an example explicitly requires more.

## Read a small workflow page

Required mode: `read-only`, `write`, or `unsafe`.

<!-- tool-input: n8n_workflows_list -->

```json
{
  "limit": 5,
  "excludePinnedData": true
}
```

This returns a bounded workflow projection. Pin and static values remain
withheld even when upstream data is present.

## Analyze one workflow locally

Required mode: `read-only`, `write`, or `unsafe`. The analyzer reads bounded n8n
metadata and runs 23 deterministic local rules. It does not execute the workflow
or call an external AI provider.

<!-- tool-input: n8n_introspect -->

```json
{
  "workflowId": "wf_synthetic_1",
  "profile": "quick"
}
```

Use `deep` only when up to four additional bounded execution-detail reads are
appropriate.

## Change one node property

Warning: this writes the full workflow through n8n's Public API. There is no
atomic compare-and-swap or automatic rollback. Make a current backup, inspect
the expected version, and stop if the result reports a preservation mismatch.

Required mode: `write` or `unsafe`.

<!-- tool-input: n8n_update_node -->

```json
{
  "workflowId": "wf_synthetic_1",
  "nodeId": "node_webhook_1",
  "path": "parameters.path",
  "value": "orders-v2",
  "expectedVersionId": "version_synthetic_7",
  "acknowledgeNonAtomicRisk": true
}
```

The tool performs two version reads and sends no PUT if either version differs
from `expectedVersionId`.

## Stop an execution

Warning: stopping an active execution can interrupt externally visible work and
cannot be undone through this server. Confirm the synthetic target exactly.

Required mode: `unsafe`.

<!-- tool-input: n8n_executions_stop -->

```json
{
  "executionId": "exec_synthetic_1",
  "confirmation": "STOP exec_synthetic_1"
}
```

Missing or mismatched confirmation is denied before any n8n request.

[Back to the documentation map](README.md)
