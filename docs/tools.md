# Tool reference

This is the normative user-facing reference for all 44 tools in
n8n MCP Community. Examples use synthetic identifiers and show the outer MCP
result envelope in abbreviated form.

## Shared conventions

- **Modes:** read-only tools work in every mode; write tools require `write` or
  `unsafe`; unsafe tools require `unsafe` plus the exact documented confirmation.
- **Annotations:** `RO` is `readOnlyHint`, `D` is `destructiveHint`, `I` is
  `idempotentHint`, and `OW` is `openWorldHint`.
- **Identifiers:** unless noted otherwise, IDs contain 1–128 ASCII letters,
  digits, underscores, or hyphens.
- **Pagination:** cursors contain 1–2,048 characters and no control characters;
  page limits are integers from 1 through 100.
- **Output:** every successful generic value is sanitized and wrapped as
  `{ "data": ..., "redacted": boolean, "untrusted": true }`; text and
  structured MCP content carry the same value. The final serialized result is
  limited to 256 KiB. When a successful write or unsafe operation produces a
  result above that cap, the tool reports a truncated success summary
  (`truncated: true`, `outcome: "success"`, and bounded identity fields)
  instead of an error, because the mutation has already been applied;
  read-only tools keep the over-cap error. `n8n_introspect` applies the shared sanitizer and returns
  its declared diagnostic schema directly, with one concise summary block and
  one exact JSON fallback; its dedicated reducer and combined-output budget are
  documented below.
- **HTTP:** Public API paths are relative to `/api/v1`; `/healthz` is the only
  root path. Requests are same-origin, redirect-free, time-bounded, and limited
  to 2 MiB in each direction.
- **Upstream content remains untrusted.** Redaction and schema validation reduce
  exposure; they do not authorize execution or make returned text authoritative.

## n8n_workflows_list

Lists one Public API page of workflows. Use it for discovery before selecting a
stable workflow ID.

- **Policy and endpoint:** read-only; `GET /workflows`; annotations
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to list workflows; read-only mode is sufficient.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. It lists only workflows visible to the key and intentionally has no paid-project selector.
- **Inputs:** `active?: boolean`; `tags?: string` (up to 512 characters);
  `name?: string` (1–128);
  `excludePinnedData?: boolean` (default `true`); `limit?: 1..100` (default
  `100`); `cursor?: cursor`.
- **Returns:** projected workflows and `nextCursor`. Pin and static data values
  are never returned. When `excludePinnedData=true`, both presence fields are
  `"not_requested"`; when false, they are exact booleans derived from the
  returned workflow.
- **Failures and privacy:** invalid pagination fails before the request. Node
  parameters are useful workflow content and may still be sensitive; request the
  narrowest page and treat every string as untrusted.
- **Example:** `{ "active": true, "limit": 20 }` →
  `{ "data": { "data": [{ "id": "wf_1", "name": "Orders" }], "nextCursor": null }, "redacted": false, "untrusted": true }`.

## n8n_workflows_get

Reads one current workflow by stable ID for inspection or as the basis of a
reviewed edit.

- **Policy and endpoint:** read-only; `GET /workflows/{workflowId}`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to read the selected workflow; read-only mode is sufficient.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Pin and static values remain withheld even when the endpoint returns them.
- **Inputs:** required `workflowId`; `excludePinnedData?: boolean` defaults to
  `true`.
- **Returns:** ID, version, name, description, state, nodes, connections,
  settings, and pin/static presence flags. Pin and static values are withheld.
  Presence is `"not_requested"` when the upstream request excluded those data,
  and otherwise an exact boolean derived from the response.
- **Failures and privacy:** malformed IDs fail locally; missing workflows and
  malformed upstream schemas return sanitized errors. Workflow parameters can
  contain URLs, expressions, or code and must be reviewed as untrusted data.
- **Example:** `{ "workflowId": "wf_1" }` →
  `{ "data": { "id": "wf_1", "name": "Orders", "sensitiveWorkflowData": { "pinDataReturned": false, "staticDataReturned": false } }, "redacted": false, "untrusted": true }`.

## n8n_workflows_create

Creates a workflow from a complete validated workflow definition.

- **Policy and endpoint:** write; `POST /workflows`;
  `RO=false, D=true, I=false, OW=true`. Requires mode `write` or `unsafe`.
- **Requirements:** Requires mode `write` or `unsafe` and API-key permission to create workflows.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Creation targets the caller's Community workspace and does not accept paid-project assignment.
- **Inputs:** required `name` (1–128), `nodes` (1–1,000), and `connections`
  object; optional `description` (up to 16,384), `settings` object (default
  `{}`), `nodeGroups` (up to 1,000 safe JSON values), `staticData` (object,
  `null`, or string up to 1 MiB), and `pinData` (object or `null`).
  Each node requires `name`, `type`, positive `typeVersion`, two-number
  `position`, and JSON `parameters`; node `id`, `credentials`, and `disabled`
  are optional.
- **Returns:** the created workflow projection without pin/static values.
- **Failures and privacy:** unsafe JSON depth, complexity, or prototype keys are
  rejected before network. Never place literal secrets in node parameters; use
  n8n credentials.
- **Example:** `{ "name": "Orders", "nodes": [{ "name": "Webhook", "type": "n8n-nodes-base.webhook", "typeVersion": 2, "position": [0, 0], "parameters": {} }], "connections": {}, "settings": {} }` →
  `{ "data": { "id": "wf_1", "name": "Orders" }, "redacted": false, "untrusted": true }`.

## n8n_workflows_update

Updates selected top-level fields while preserving writable fields omitted by
the caller.

- **Policy and endpoint:** write; two `GET /workflows/{workflowId}` version
  checks, then `PUT /workflows/{workflowId}` only if both checks match;
  `RO=false, D=true, I=false, OW=true`. Requires mode `write` or `unsafe`.
- **Requirements:** Requires mode `write` or `unsafe` plus API-key read and update permission for the workflow.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. The Community Public API exposes full PUT rather than atomic patch semantics.
- **Inputs:** required `workflowId` and `expectedVersionId`, plus at least one
  of `name` (1–128),
  `description` (up to 16,384), `nodes` (up to 1,000), `connections`,
  `settings`, `pinData` (object or `null`), `staticData` (object, `null`, or
  string up to 1 MiB), or `nodeGroups` (up to 1,000 safe JSON values).
- **Returns:** the updated workflow projection. Omitted writable fields are
  copied from the validated immediate second read; pin/static values remain
  hidden.
- **Failures and privacy:** an empty update or either version mismatch fails
  before the PUT. Duplicate node names or defined IDs are rejected. This remains
  a full Public API PUT, not an atomic patch, so a small race window exists after
  the second read. Every submitted writable field must match the response; any
  mismatch fails explicitly and warns that the mutation may already have been
  applied. `meta` is intentionally excluded because the official 2.30.7 Public
  API schema marks it read-only. Prefer `n8n_update_node` for one-node changes.
- **Example:** `{ "workflowId": "wf_1", "expectedVersionId": "v7", "description": "Routes validated orders" }` →
  `{ "data": { "id": "wf_1", "description": "Routes validated orders" }, "redacted": false, "untrusted": true }`.

## n8n_update_node

Changes one validated path on one node while preserving sibling nodes and
workflow-level writable data.

- **Policy and endpoint:** write; two `GET /workflows/{workflowId}` checks,
  followed by one `PUT /workflows/{workflowId}` only if both versions match;
  `RO=false, D=true, I=false, OW=true`. Requires mode `write` or `unsafe`.
- **Requirements:** Requires mode `write` or `unsafe` plus API-key read and update permission for the workflow.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Community has no atomic node PATCH or compare-and-swap, so the documented residual race remains.
- **Inputs:** required `workflowId`, `nodeId`, `path` (1–512), safe JSON
  non-omittable `value`, `expectedVersionId`, and literal
  `acknowledgeNonAtomicRisk: true`. Allowed path roots are `parameters`,
  `position`, `disabled`, retry/error controls, notes, and output/execute flags.
  Node-name changes require a reviewed full workflow update because connections
  are keyed by node name.
  Prototype segments, immutable roots, non-canonical indexes, indexes above
  1,000, and position paths other than `position.0` or `position.1` are rejected.
- **Returns:** workflow/version/node/path metadata, `updated: true`,
  `atomic: false`, and an explicit residual-risk statement.
- **Failures and privacy:** a missing node, version mismatch, unsafe path, or a
  value that violates the targeted field's type contract fails before the PUT.
  Each root is bounded: booleans for `disabled` and the retry/error/output flags,
  a two-number tuple for `position`, non-negative integers for `maxTries` and
  `waitBetweenTries`, a bounded string for `notes`, the known n8n enum for
  `onError`, and safe JSON for `parameters`; the complete mutated node is
  re-validated against the node schema before any request. An instance that omits
  workflow `versionId` fails at the pre-write read with a
  `version_identity_unsupported` error naming the below-floor cause rather than a
  false concurrent-change diagnosis. Duplicate target IDs fail instead of
  selecting one ambiguously. The PUT response must contain exactly one target
  node with the requested value. n8n has no atomic compare-and-swap, so a small
  time-of-check/time-of-use window remains. A pin/static mismatch is detectable
  only in the response after the PUT; the server returns an error that says the
  workflow may already have changed and must be inspected immediately. It
  cannot roll back that upstream mutation.
- **Example:** `{ "workflowId": "wf_1", "nodeId": "node_1", "path": "parameters.path", "value": "orders-v2", "expectedVersionId": "v7", "acknowledgeNonAtomicRisk": true }` →
  `{ "data": { "workflowId": "wf_1", "nodeId": "node_1", "updated": true, "atomic": false }, "redacted": false, "untrusted": true }`.

## n8n_workflows_delete

Permanently deletes one workflow.

- **Policy and endpoint:** unsafe; `DELETE /workflows/{workflowId}`;
  `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact target-bound confirmation, and API-key permission to delete the workflow.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. No transfer or recovery capability is implied after deletion.
- **Inputs:** required `workflowId` and `confirmation`, which must exactly equal
  `DELETE <workflowId>`.
- **Returns:** the input-bound workflow ID and `deleted: true`; it does not trust
  an upstream response body to establish identity.
- **Failures and privacy:** any mode other than `unsafe`, any confirmation
  mismatch, or malformed ID produces zero requests. Deletion is irreversible
  through this server.
- **Example:** `{ "workflowId": "wf_1", "confirmation": "DELETE wf_1" }` →
  `{ "data": { "workflowId": "wf_1", "deleted": true }, "redacted": false, "untrusted": true }`.

## n8n_workflows_activate

Activates one workflow so its production triggers may begin receiving events.

- **Policy and endpoint:** unsafe; `POST /workflows/{workflowId}/activate`;
  `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact target-bound confirmation, and API-key permission to activate the workflow.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Activation can enable real triggers; the server does not execute workflows directly.
- **Inputs:** required `workflowId`; `confirmation` must equal
  `ACTIVATE <workflowId>`.
- **Returns:** allowlisted workflow metadata such as ID, active state, and
  version when supplied by n8n.
- **Failures and privacy:** denied mode/confirmation issues zero requests.
  Activation can cause external side effects later when triggers fire; review
  credentials, trigger exposure, and workflow behavior first.
- **Example:** `{ "workflowId": "wf_1", "confirmation": "ACTIVATE wf_1" }` →
  `{ "data": { "id": "wf_1", "active": true }, "redacted": false, "untrusted": true }`.

## n8n_workflows_deactivate

Deactivates one workflow's production triggers.

- **Policy and endpoint:** unsafe; `POST /workflows/{workflowId}/deactivate`;
  `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact target-bound confirmation, and API-key permission to deactivate the workflow.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Deactivation does not cancel work already running.
- **Inputs:** required `workflowId`; `confirmation` must equal
  `DEACTIVATE <workflowId>`.
- **Returns:** allowlisted workflow metadata.
- **Failures and privacy:** denied mode/confirmation issues zero requests.
  Deactivation does not delete saved workflow or execution data and may not stop
  work that is already running.
- **Example:** `{ "workflowId": "wf_1", "confirmation": "DEACTIVATE wf_1" }` →
  `{ "data": { "id": "wf_1", "active": false }, "redacted": false, "untrusted": true }`.

## n8n_workflows_get_version

Retrieves one retained historical workflow snapshot.

- **Policy and endpoint:** read-only;
  `GET /workflows/{workflowId}/{versionId}`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to read the workflow's retained history.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Availability depends on Community history retention, and historical settings/pin/static fields are unavailable.
- **Inputs:** required `workflowId` and `versionId`.
- **Returns:** validated historical workflow ID/version, optional name, nodes,
  and connections. The historical API does not expose settings, pin data, or
  static data.
- **Failures and privacy:** malformed selectors fail locally. A 404 from the
  version-history endpoint returns a stable `version_history_unavailable` error
  that states both possible causes without asserting which one applies: the
  endpoint requires the supported floor (n8n Community 2.30.5 or newer) and may
  be absent below it, or the requested version was pruned or never retained under
  history retention. Historical node parameters can contain sensitive content and
  remain untrusted.
- **Example:** `{ "workflowId": "wf_1", "versionId": "v6" }` →
  `{ "data": { "workflowId": "wf_1", "versionId": "v6", "nodes": [], "connections": {} }, "redacted": false, "untrusted": true }`.

## n8n_workflows_get_tags

Lists the tags currently assigned to one workflow.

- **Policy and endpoint:** read-only; `GET /workflows/{workflowId}/tags`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to read the workflow and its tag assignment.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. It uses workflow tags only and does not depend on folders or projects.
- **Inputs:** required `workflowId`.
- **Returns:** a bounded `data` prefix of at most 100 validated tag records,
  `totalCount`, `truncated`, and the exact `omittedCount`.
- **Failures and privacy:** invalid IDs fail before network; missing workflows or
  malformed tag responses return sanitized errors. Tag names are untrusted
  instance content.
- **Example:** `{ "workflowId": "wf_1" }` →
  `{ "data": { "data": [{ "id": "tag_1", "name": "production" }], "totalCount": 1, "truncated": false, "omittedCount": 0 }, "redacted": false, "untrusted": true }`.

## n8n_workflows_update_tags

Replaces the complete tag assignment for one workflow.

- **Policy and endpoint:** write; `PUT /workflows/{workflowId}/tags`;
  `RO=false, D=true, I=false, OW=true`. Requires mode `write` or `unsafe`.
- **Requirements:** Requires mode `write` or `unsafe` and API-key permission to replace workflow tag assignments.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. The operation replaces the full assignment; it is not a merge endpoint.
- **Inputs:** required `workflowId` and `tagIds`, an array of at most 100 valid
  identifiers. An empty array clears all assignments.
- **Returns:** the validated tag assignment returned by n8n.
- **Failures and privacy:** malformed IDs and oversized arrays fail before
  network. This replaces rather than merges assignments; list current tags first
  when preservation matters.
- **Example:** `{ "workflowId": "wf_1", "tagIds": ["tag_1", "tag_2"] }` →
  `{ "data": [{ "id": "tag_1" }, { "id": "tag_2" }], "redacted": false, "untrusted": true }`.

## n8n_workflows_archive

Archives one workflow without deleting it.

- **Policy and endpoint:** unsafe; `POST /workflows/{workflowId}/archive`;
  `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact target-bound confirmation, and API-key permission to archive the workflow.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Archive support is independent of paid project transfer features.
- **Inputs:** required `workflowId`; `confirmation` must equal
  `ARCHIVE <workflowId>`.
- **Returns:** allowlisted workflow state metadata.
- **Failures and privacy:** denied mode/confirmation issues zero requests.
  Archiving changes workflow availability and should be treated as a disruptive
  lifecycle operation even though it is reversible.
- **Example:** `{ "workflowId": "wf_1", "confirmation": "ARCHIVE wf_1" }` →
  `{ "data": { "id": "wf_1", "isArchived": true }, "redacted": false, "untrusted": true }`.

## n8n_workflows_unarchive

Restores one archived workflow.

- **Policy and endpoint:** unsafe; `POST /workflows/{workflowId}/unarchive`;
  `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact target-bound confirmation, and API-key permission to unarchive the workflow.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Restoring archive state does not activate the workflow.
- **Inputs:** required `workflowId`; `confirmation` must equal
  `UNARCHIVE <workflowId>`.
- **Returns:** allowlisted workflow state metadata.
- **Failures and privacy:** denied mode/confirmation issues zero requests.
  Unarchiving does not imply activation; inspect returned state before taking a
  separate activation action.
- **Example:** `{ "workflowId": "wf_1", "confirmation": "UNARCHIVE wf_1" }` →
  `{ "data": { "id": "wf_1", "isArchived": false }, "redacted": false, "untrusted": true }`.

## n8n_workflows_diff

Computes a deterministic, value-free semantic comparison between a retained
version and either another retained version or the current workflow.

- **Policy and endpoint:** read-only; at most two GETs to
  `GET /workflows/{workflowId}/{versionId}` and optionally
  `GET /workflows/{workflowId}?excludePinnedData=true`;
  `RO=true, D=false, I=true, OW=true`. The current-workflow read for a
  diff-to-current excludes pinned data, which the comparison never inspects.
- **Requirements:** Requires API-key permission to read the current workflow and retained versions; comparison itself is local and read-only.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Missing/pruned history is a capability limitation, and historical settings/pin/static data are never fabricated.
- **Inputs:** required `workflowId` and `fromVersionId`; optional
  `toVersionId` (default current); `ignoreLayout?: boolean` defaults to `true`.
  Two explicit selectors must differ.
- **Returns:** counts and up to 200 ordered changes for workflow-name changes,
  node add/remove/modify, and connections. Modified-node output names changed
  fields, not their values. Absent and explicit `false` are treated as the same
  value for default-false execution flags. Numeric retry settings remain
  conservative: omitted versus explicit `maxTries` or `waitBetweenTries` is
  reported because the Public API does not publish a version-stable default.
  Coverage reports whether the name was available in
  both snapshots and explicitly marks description, settings, pin data, static
  data, and node groups as unavailable from the historical API.
- **Failures and privacy:** snapshots with missing/duplicate stable node IDs,
  mismatched workflow IDs, unsafe size, or invalid selectors fail safely. A 404
  from a version-history read returns a stable `version_history_unavailable`
  error that states both possible causes without asserting which one applies:
  the endpoint requires the supported floor (n8n Community 2.30.5 or newer) and
  may be absent below it, or the requested version was pruned or never retained
  under history retention. No raw parameters, expressions, code, URLs, headers,
  credentials, or snapshot hash is returned.
- **Example:** `{ "workflowId": "wf_1", "fromVersionId": "v6" }` →
  `{ "data": { "summary": { "nodesModified": 1 }, "changes": [{ "kind": "node_modified", "nodeId": "node_1", "fields": ["parameters"] }], "comparisonCoverage": { "settings": "unavailable_historical_api" } }, "redacted": false, "untrusted": true }`.

## n8n_executions_list

Lists one page of execution metadata without returning raw workflow payload
values.

- **Policy and endpoint:** read-only; `GET /executions`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to list executions; read-only mode is sufficient.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Project filtering is intentionally absent, and raw execution values are never returned.
- **Inputs:** `includeData?: boolean` (default `false`); `status?` is one of
  `new`, `running`, `success`, `unknown`, `error`, `canceled`, `crashed`, or
  `waiting`; `workflowId?`, `limit?: 1..100` (default `100`), and
  `cursor?`.
- **Returns:** execution IDs, status, mode, workflow ID, timestamps, retry
  metadata, a value-free `dataPolicy`, and `nextCursor`.
- **Failures and privacy:** the request always sends
  `redactExecutionData=true`. If `includeData=true`, the result reports only
  whether upstream data was present; values are never returned.
- **Example:** `{ "status": "error", "includeData": true, "limit": 20 }` →
  `{ "data": { "data": [{ "id": "exec_1", "status": "error", "dataPolicy": { "requested": true, "rawValuesReturned": false } }], "nextCursor": null }, "redacted": false, "untrusted": true }`.

## n8n_executions_get

Reads metadata for one saved execution with an optional data-presence check.

- **Policy and endpoint:** read-only; `GET /executions/{executionId}`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to read the selected execution.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. The Community response is reduced to metadata and value-presence information.
- **Inputs:** required `executionId` (valid string ID or non-negative integer);
  `includeData?: boolean` defaults to `false`.
- **Returns:** allowlisted execution metadata and `dataPolicy`.
- **Failures and privacy:** the upstream query always forces
  `redactExecutionData=true`. Raw node inputs, outputs, binary data, errors, and
  run data are never returned by this tool.
- **Example:** `{ "executionId": "exec_1", "includeData": true }` →
  `{ "data": { "id": "exec_1", "status": "error", "dataPolicy": { "upstreamDataPresent": true, "rawValuesReturned": false } }, "redacted": false, "untrusted": true }`.

## n8n_executions_delete

Permanently deletes one saved execution.

- **Policy and endpoint:** unsafe; `DELETE /executions/{executionId}`;
  `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact target-bound confirmation, and API-key permission to delete execution data.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Deletion is permanent through this server and does not reverse external workflow effects.
- **Inputs:** required `executionId`; `confirmation` must equal
  `DELETE <executionId>`.
- **Returns:** the validated input ID and `deleted: true`.
- **Failures and privacy:** denied mode/confirmation issues zero requests. This
  removes saved execution history and cannot be undone through the server.
- **Example:** `{ "executionId": "exec_1", "confirmation": "DELETE exec_1" }` →
  `{ "data": { "executionId": "exec_1", "deleted": true }, "redacted": false, "untrusted": true }`.

## n8n_executions_retry

Asks n8n to retry one eligible saved execution.

- **Policy and endpoint:** unsafe; `POST /executions/{executionId}/retry`;
  `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact target-bound confirmation, and API-key permission to retry the execution.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Retry eligibility depends on execution state and may repeat external side effects.
- **Inputs:** required `executionId`; `loadWorkflow?: boolean` defaults to
  `true`; `confirmation` must equal `RETRY <executionId>`.
- **Returns:** allowlisted metadata for the new or retried execution, with raw
  values omitted.
- **Failures and privacy:** a retry can repeat external side effects from the
  workflow. Denied mode/confirmation issues zero requests; n8n decides whether
  the saved execution is eligible.
- **Example:** `{ "executionId": "exec_1", "loadWorkflow": true, "confirmation": "RETRY exec_1" }` →
  `{ "data": { "id": "exec_2", "status": "new", "dataPolicy": { "rawValuesReturned": false } }, "redacted": false, "untrusted": true }`.

## n8n_executions_stop

Stops one currently running execution.

- **Policy and endpoint:** unsafe; `POST /executions/{executionId}/stop`;
  `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact target-bound confirmation, and API-key permission to stop the execution.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Only currently stoppable executions succeed; completed external effects are not rolled back.
- **Inputs:** required `executionId`; `confirmation` must equal
  `STOP <executionId>`.
- **Returns:** the validated input ID, a `stopped` boolean derived from the
  validated upstream `status`/`finished` body fields (n8n answers HTTP 200 even
  for executions that already finished, so HTTP success alone never asserts a
  stop), a `state` of `stopped`, `already_finished`, or `unknown`, passthrough
  `finished` when present, and allowlisted upstream status/timestamp when
  present. Identity never depends on the upstream body.
- **Failures and privacy:** denied mode/confirmation issues zero requests. n8n
  may reject a terminal, missing, or non-stoppable execution; stopping may leave
  external side effects already performed by earlier nodes.
- **Example:** `{ "executionId": "exec_1", "confirmation": "STOP exec_1" }` →
  `{ "data": { "executionId": "exec_1", "stopped": true, "status": "canceled" }, "redacted": false, "untrusted": true }`.

## n8n_credentials_create

Creates a credential while preventing credential values from entering MCP
output or security logs.

- **Policy and endpoint:** write; `POST /credentials`;
  `RO=false, D=true, I=false, OW=true`. Requires mode `write` or `unsafe`.
- **Requirements:** Requires mode `write` or `unsafe` and API-key permission to create the requested credential type.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Paid-project placement is intentionally absent, and credential values are output-prohibited.
- **Inputs:** required `name` (1–128), `type` (1–128 ASCII letters, digits,
  `_`, `.`, or `-`), and `data` (safe JSON object); optional
  `isResolvable?: boolean`.
- **Returns:** validated metadata only: ID, name, type, timestamps, managed/global
  flags, and resolvability.
- **Failures and privacy:** use `n8n_credentials_schema` first. Prototype keys or
  excessive JSON complexity fail before network. Secret values are accepted as
  input only for the upstream request and are never echoed.
- **Example:** `{ "name": "Service account", "type": "httpHeaderAuth", "data": { "name": "Authorization", "value": "replace-in-client" } }` →
  `{ "data": { "id": "cred_1", "name": "Service account", "type": "httpHeaderAuth" }, "redacted": false, "untrusted": true }`.

## n8n_credentials_delete

Permanently deletes one stored credential.

- **Policy and endpoint:** unsafe; `DELETE /credentials/{credentialId}`;
  `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact target-bound confirmation, and API-key permission to delete the credential.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Deletion can break referencing workflows and has no transfer fallback.
- **Inputs:** required `credentialId`; `confirmation` must equal
  `DELETE <credentialId>`.
- **Returns:** the validated input ID and `deleted: true`. Any upstream object is
  discarded because n8n does not consistently echo the deleted ID.
- **Failures and privacy:** denied mode/confirmation issues zero requests.
  Deletion can break workflows that reference the credential; inspect usage
  first with `n8n_credentials_usage`.
- **Example:** `{ "credentialId": "cred_1", "confirmation": "DELETE cred_1" }` →
  `{ "data": { "credentialId": "cred_1", "deleted": true }, "redacted": false, "untrusted": true }`.

## n8n_credentials_schema

Reads the Public API credential schema for one credential type.

- **Policy and endpoint:** read-only;
  `GET /credentials/schema/{credentialType}`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to inspect the requested public credential schema.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Only credential types exposed by the instance's Public API are available.
- **Inputs:** required `credentialType`, containing 1–128 ASCII letters, digits,
  `_`, or `-`.
- **Returns:** the validated schema object supplied by n8n. It describes fields;
  it does not return stored credential values.
- **Failures and privacy:** invalid type names fail locally; unsupported types or
  malformed schemas return sanitized errors. Schema labels remain untrusted
  instance content.
- **Example:** `{ "credentialType": "httpHeaderAuth" }` →
  `{ "data": { "fields": [{ "name": "name", "type": "string" }] }, "redacted": false, "untrusted": true }`.

## n8n_credentials_list

Lists one page of public credential metadata. This project supports the endpoint
from its tested n8n Community Edition 2.30.5 floor onward.

- **Policy and endpoint:** read-only; `GET /credentials`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to list credential metadata.
- **Community Edition:** Supported from Community 2.30.5 and verified on 2.30.5 and 2.30.7. Values are never returned, and older versions are outside the support floor.
- **Inputs:** `limit?: 1..100` defaults to `100`; `cursor?: cursor`.
- **Returns:** metadata records and `nextCursor`; credential data is rejected by
  the metadata schema and never returned.
- **Failures and privacy:** older or incompatible n8n versions fail with a
  sanitized upstream status. Names and types are metadata, not secrets, but can
  still reveal system purpose; paginate narrowly.
- **Example:** `{ "limit": 20 }` →
  `{ "data": { "data": [{ "id": "cred_1", "name": "Service account", "type": "httpHeaderAuth" }], "nextCursor": null }, "redacted": false, "untrusted": true }`.

## n8n_credentials_get

Reads the public metadata for one credential.

- **Policy and endpoint:** read-only; `GET /credentials/{credentialId}`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to read credential metadata by ID.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Secret fields and project metadata are stripped from the stable output.
- **Inputs:** required `credentialId`.
- **Returns:** the same allowlisted metadata shape as credential listing.
- **Failures and privacy:** malformed IDs fail before network. Secret-bearing
  fields in an upstream response are stripped by the strict metadata projection
  and shared sanitizer.
- **Example:** `{ "credentialId": "cred_1" }` →
  `{ "data": { "id": "cred_1", "name": "Service account", "type": "httpHeaderAuth" }, "redacted": false, "untrusted": true }`.

## n8n_credentials_update

Updates selected credential metadata or values without returning secret
material.

- **Policy and endpoint:** write; `PATCH /credentials/{credentialId}`;
  `RO=false, D=true, I=false, OW=true`. Requires mode `write` or `unsafe`.
- **Requirements:** Requires mode `write` or `unsafe` and API-key permission to update the selected credential metadata or data.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Availability of individual fields depends on the credential type; values remain output-prohibited.
- **Inputs:** required `credentialId` plus at least one of `name` (1–128),
  `type` (validated type name), `data` (safe JSON object), `isGlobal`, or
  `isResolvable`; `isPartialData?: boolean` defaults to `false`. Changing
  `type` also requires replacement `data`.
- **Returns:** allowlisted credential metadata only.
- **Failures and privacy:** an empty update, type change without data, unsafe
  JSON, or denied mode fails before the PATCH. Never repeat credential values in
  prompts, logs, issue reports, or prose.
- **Example:** `{ "credentialId": "cred_1", "name": "Rotated service account", "data": { "value": "replace-in-client" }, "isPartialData": true }` →
  `{ "data": { "id": "cred_1", "name": "Rotated service account", "type": "httpHeaderAuth" }, "redacted": false, "untrusted": true }`.

## n8n_credentials_test

Tests one stored credential through n8n.

- **Policy and endpoint:** unsafe and open-world;
  `POST /credentials/{credentialId}/test`;
  `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact target-bound confirmation, API-key permission to test the credential, and authorization for any resulting outbound contact.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Success depends on the credential type and its external service; no credential value is returned.
- **Inputs:** required `credentialId`; `confirmation` must equal
  `TEST <credentialId>`.
- **Returns:** the input ID plus an allowlisted status and optional bounded
  message. Over-long upstream status or message text is truncated to the
  bounded caps (64 and 512 characters) with `truncated: true` rather than
  rejected, so the completed test outcome is always preserved.
- **Failures and privacy:** this call may contact the credential's external
  service and cause observable authentication traffic. Denied mode or
  confirmation issues zero requests; returned messages are sanitized.
- **Example:** `{ "credentialId": "cred_1", "confirmation": "TEST cred_1" }` →
  `{ "data": { "credentialId": "cred_1", "status": "OK", "message": "Connection succeeded" }, "redacted": false, "untrusted": true }`.

## n8n_credentials_usage

Finds exact references to one credential ID in one bounded workflow-list page.

- **Policy and endpoint:** read-only local analysis over exactly one
  `GET /workflows?excludePinnedData=true` page;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires workflow-list permission only; it deliberately does not request the credential record or credential-read permission.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Coverage is page-bounded. Name-only, `id: null`, and legacy-string credential references are tolerated: they are skipped for ID matching and counted as unresolved instead of aborting the scan.
- **Inputs:** required `credentialId`; optional `cursor`, `active`, and
  `limit?: 1..100` (default `50`).
- **Returns:** examined count, exact matching workflow count, up to 200 total
  node details with at most 20 per workflow, `nextCursor`, `scanComplete`,
  explicit truncation counts, and value-free coverage counts
  `referencesScanned` and `referencesUnresolved`.
- **Failures and privacy:** it never calls a credential endpoint or performs
  per-workflow fan-out. It returns workflow/node identity and type, never
  credential names, values, configuration, or workflow bodies. Continue with
  `nextCursor` until `scanComplete=true` for an instance-wide conclusion. An
  empty or otherwise invalid upstream cursor fails instead of returning a value
  that cannot be submitted to the next call.
- **Example:** `{ "credentialId": "cred_1", "limit": 50 }` →
  `{ "data": { "credentialId": "cred_1", "matchingWorkflowCount": 1, "workflows": [{ "workflowId": "wf_1", "nodes": [{ "nodeId": "node_1" }] }], "scanComplete": true }, "redacted": false, "untrusted": true }`.

## n8n_tags_list

Lists one page of workflow tags.

- **Policy and endpoint:** read-only; `GET /tags`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to list workflow tags.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. It covers workflow tags, not folders, projects, or execution annotations.
- **Inputs:** `limit?: 1..100` defaults to `100`; `cursor?: cursor`.
- **Returns:** validated tag IDs, names, optional creation/update timestamps, and
  `nextCursor`.
- **Failures and privacy:** invalid pagination fails locally. Tag names are
  untrusted metadata and may describe internal systems.
- **Example:** `{ "limit": 20 }` →
  `{ "data": { "data": [{ "id": "tag_1", "name": "production" }], "nextCursor": null }, "redacted": false, "untrusted": true }`.

## n8n_tags_get

Reads one workflow tag by ID.

- **Policy and endpoint:** read-only; `GET /tags/{tagId}`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to read the selected workflow tag.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Missing tags return an upstream not-found error rather than a fabricated record.
- **Inputs:** required `tagId`.
- **Returns:** validated tag ID, name, and optional creation/update timestamps.
- **Failures and privacy:** malformed IDs fail before network; missing tags and
  malformed responses return sanitized errors.
- **Example:** `{ "tagId": "tag_1" }` →
  `{ "data": { "id": "tag_1", "name": "production" }, "redacted": false, "untrusted": true }`.

## n8n_tags_create

Creates a workflow tag.

- **Policy and endpoint:** write; `POST /tags`;
  `RO=false, D=true, I=false, OW=true`. Requires mode `write` or `unsafe`.
- **Requirements:** Requires mode `write` or `unsafe` and API-key permission to create workflow tags.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7 with the live Community 1–24 character name bound.
- **Inputs:** required `name`, 1–24 characters, trimmed, with no control
  characters. The 24-character limit reflects live n8n behavior that is stricter
  than the historical OpenAPI schema.
- **Returns:** validated tag ID, name, and optional creation/update timestamps.
- **Failures and privacy:** 25-character names and invalid whitespace/control
  characters fail before network. A duplicate name may be rejected by n8n.
- **Example:** `{ "name": "production" }` →
  `{ "data": { "id": "tag_1", "name": "production" }, "redacted": false, "untrusted": true }`.

## n8n_tags_update

Renames one workflow tag.

- **Policy and endpoint:** write; `PUT /tags/{tagId}`;
  `RO=false, D=true, I=false, OW=true`. Requires mode `write` or `unsafe`.
- **Requirements:** Requires mode `write` or `unsafe` and API-key permission to rename workflow tags.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7 with the live Community 1–24 character name bound.
- **Inputs:** required `tagId` and `name`, using the same trimmed 1–24 character
  bound as tag creation.
- **Returns:** the updated validated tag, including optional creation/update
  timestamps.
- **Failures and privacy:** invalid names/IDs fail before network; missing tags
  or duplicate names return sanitized upstream errors.
- **Example:** `{ "tagId": "tag_1", "name": "critical" }` →
  `{ "data": { "id": "tag_1", "name": "critical" }, "redacted": false, "untrusted": true }`.

## n8n_tags_delete

Permanently deletes one workflow tag.

- **Policy and endpoint:** unsafe; `DELETE /tags/{tagId}`;
  `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact target-bound confirmation, and API-key permission to delete workflow tags.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Deletion can remove the tag from multiple workflows and is not reversible here.
- **Inputs:** required `tagId`; `confirmation` must equal `DELETE <tagId>`.
- **Returns:** the validated input ID and `deleted: true`.
- **Failures and privacy:** denied mode/confirmation issues zero requests.
  Deletion may remove the tag from multiple workflows and is not reversible
  through this server.
- **Example:** `{ "tagId": "tag_1", "confirmation": "DELETE tag_1" }` →
  `{ "data": { "tagId": "tag_1", "deleted": true }, "redacted": false, "untrusted": true }`.

## n8n_users_list

Lists one page of users visible to the configured API key.

- **Policy and endpoint:** read-only; `GET /users`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to list users and, when requested, their roles.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Project membership filtering is intentionally absent; visibility follows the key's instance-level permissions.
- **Inputs:** `includeRole?: boolean` defaults to `true`; `limit?: 1..100`
  defaults to `100`; `cursor?`.
- **Returns:** validated user IDs and optional email, name, role, disabled or
  pending status, creation/update timestamps, and `nextCursor`.
- **Failures and privacy:** user data is personal information. Email, phone, and
  other recognized patterns are redacted by the shared output policy, so fields
  may contain placeholders rather than original values.
- **Example:** `{ "includeRole": true, "limit": 20 }` →
  `{ "data": { "data": [{ "id": "user_1", "email": "[EMAIL]", "role": "global:member" }], "nextCursor": null }, "redacted": true, "untrusted": true }`.

## n8n_users_get

Reads one user by stable ID or exact email address.

- **Policy and endpoint:** read-only; `GET /users/{id-or-email}`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to read a user by ID or exact email.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Returned personal fields remain subject to shared redaction.
- **Inputs:** required `userIdOrEmail`, either a valid identifier or email up to
  254 characters; `includeRole?: boolean` defaults to `true`.
- **Returns:** one validated user record with optional identity, role, status,
  and creation/update metadata. Recognized personal values may be redacted in
  the MCP result.
- **Failures and privacy:** invalid lookups fail locally; the email selector is
  percent-encoded as one path segment. Avoid broad disclosure of returned user
  metadata.
- **Example:** `{ "userIdOrEmail": "member@example.test" }` →
  `{ "data": { "id": "user_1", "email": "[EMAIL]", "role": "global:member" }, "redacted": true, "untrusted": true }`.

## n8n_users_create

Invites one non-owner user.

- **Policy and endpoint:** unsafe; `POST /users`;
  `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact email-bound confirmation, and API-key permission to invite users with the selected global role.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. It invites a global member/admin only and does not manage paid project membership.
- **Inputs:** required `email` (valid email up to 254);
  `role?: "global:member" | "global:admin"` defaults to `global:member`;
  `confirmation` must equal `INVITE <email>`.
- **Returns:** the confirmed user ID and email; `userCreated: true`; the
  requested role and whether n8n explicitly echoed that role in its response;
  whether n8n sent the invitation email; `invited: true` only when email was
  sent or n8n generated a manual acceptance link; and a bounded `delivery` status of
  `email_sent`, `manual_link_available_in_n8n`, or `not_delivered`. The
  capability-bearing acceptance URL is never returned through MCP.
- **Failures and privacy:** this sends an invitation and may trigger external
  email. Owner creation is not exposed. An empty, mismatched, or per-user error
  response fails closed with retry guidance because n8n may already have
  created a pending user. When manual delivery is required, retrieve the link
  from a trusted n8n interface and deliver it out of band. Denied
  mode/confirmation issues zero requests; verify the address and
  least-privilege role before confirming.
- **Example:** `{ "email": "member@example.test", "role": "global:member", "confirmation": "INVITE member@example.test" }` →
  `{ "data": { "userCreated": true, "invited": true, "userId": "user_2", "email": "[EMAIL]", "requestedRole": "global:member", "roleConfirmedByResponse": false, "emailSent": true, "delivery": "email_sent", "inviteAcceptUrlReturned": false }, "redacted": true, "untrusted": true }`.

## n8n_users_delete

Deletes one API-eligible user by stable ID.

- **Policy and endpoint:** unsafe; `DELETE /users/{userId}` with no query or
  body; `RO=false, D=true, I=false, OW=true`.
- **Requirements:** Requires mode `unsafe`, exact target-bound confirmation, and API-key permission to delete the selected non-owner user.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Unsupported ownership-transfer behavior is deliberately absent.
- **Inputs:** required `userId`; `confirmation` must equal `DELETE <userId>`.
- **Returns:** the validated input ID and `deleted: true`; HTTP 204 with no body
  is accepted.
- **Failures and privacy:** the supported Public API contract exposes no
  `transferId`, so this tool makes no ownership-transfer claim. n8n controls
  eligibility and ownership handling. Denied mode/confirmation issues zero
  requests.
- **Example:** `{ "userId": "user_1", "confirmation": "DELETE user_1" }` →
  `{ "data": { "userId": "user_1", "deleted": true }, "redacted": false, "untrusted": true }`.

## n8n_health

Performs a short same-origin health check against the configured n8n instance.

- **Policy and endpoint:** read-only; `GET /healthz` outside the Public API
  prefix with a 10-second timeout; `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires valid connected configuration because the shared HTTP boundary supplies the API key, even though `/healthz` itself is a root health route.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. It proves HTTP reachability only, not workflow, queue, or credential health.
- **Inputs:** none. Connected configuration still requires `N8N_API_URL` and
  `N8N_API_KEY` because the shared client owns the request boundary.
- **Returns:** `ok: true` and the successful HTTP status.
- **Failures and privacy:** invalid configuration, DNS/TLS/connectivity failure,
  redirect, timeout, oversize, or non-success status returns a fixed sanitized
  error without the upstream body or API key.
- **Example:** `{}` →
  `{ "data": { "ok": true, "status": 200 }, "redacted": false, "untrusted": true }`.

## n8n_insights_summary

Reads n8n's official insights summary, optionally constrained by date.

- **Policy and endpoint:** read-only; `GET /insights/summary`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission for instance insights; read-only mode is sufficient.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Date filters are supported, paid-project filtering is absent, and unavailable insight data stays an explicit error.
- **Inputs:** optional `startDate` and `endDate` as offset-aware ISO 8601
  datetimes. When both dates are supplied, `startDate` must not be later than
  `endDate`.
- **Returns:** validated `total`, `failed`, `failureRate`, `timeSaved`, and
  `averageRunTime` records, with additional upstream fields allowed but
  sanitized.
- **Failures and privacy:** invalid ordering fails before network. Unsupported
  versions, unavailable insight data, or permission failures remain explicit
  sanitized upstream errors; the server does not fabricate zero metrics.
- **Example:** `{ "startDate": "2026-07-01T00:00:00Z", "endDate": "2026-07-31T23:59:59Z" }` →
  `{ "data": { "total": {}, "failed": {}, "failureRate": {}, "timeSaved": {}, "averageRunTime": {} }, "redacted": false, "untrusted": true }`.

## n8n_audit_generate

Requests n8n's instance security audit. Although the endpoint is intended to
generate a report, it uses POST and can perform broad instance inspection, so
this server applies the conservative unsafe policy.

- **Policy and endpoint:** unsafe; `POST /audit`;
  `RO=false, D=true, I=false, OW=true`. Requires mode `unsafe` and exact
  confirmation `GENERATE AUDIT`.
- **Requirements:** Requires mode `unsafe`, exact `GENERATE AUDIT` confirmation, and API-key permission to generate the instance audit.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. The POST report endpoint is conservatively marked destructive; category support still depends on n8n.
- **Inputs:** optional `categories`, an array of at most five selections
  from `credentials`, `database`, `nodes`, `filesystem`, and `instance`;
  optional `daysAbandonedWorkflow` integer from 1 through 3,650; required
  `confirmation` must equal `GENERATE AUDIT`. Options are sent under the
  official `additionalOptions` request property.
- **Returns:** the bounded audit report object supplied by n8n.
- **Failures and privacy:** instance-wide audit output can reveal sensitive
  security posture and remains untrusted. Unsupported categories, permissions,
  versions, or malformed reports return sanitized errors.
- **Example:** `{ "categories": ["credentials", "nodes"], "daysAbandonedWorkflow": 30, "confirmation": "GENERATE AUDIT" }` →
  `{ "data": { "risk": [] }, "redacted": false, "untrusted": true }`.

## n8n_search_workflows

Searches one bounded workflow page locally by workflow name, node type, or tag
name.

- **Policy and endpoint:** read-only local filter over one
  `GET /workflows?excludePinnedData=true`; `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires workflow-list permission; the bounded substring filter itself runs locally in read-only mode.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. It searches one page at a time and is not an instance-wide index.
- **Inputs:** required trimmed `query` (2–128); `searchIn` is a 1–3 element
  array drawn from `name`, `nodes`, and `tags` (default `["name"]`); optional
  `active`, `cursor`, and `limit?: 1..100` (default `100`).
- **Returns:** the query, workflows examined, up to 50 matching workflow
  identity/state records with their matched scopes, pagination coverage, and
  a truncation flag that is true only when more than 50 matches exist.
- **Failures and privacy:** this is substring search on one page, not a global
  index. Continue pagination for broader coverage. It never returns workflow
  bodies, pin data, or static data.
- **Example:** `{ "query": "webhook", "searchIn": ["nodes"], "limit": 50 }` →
  `{ "data": { "matches": [{ "workflowId": "wf_1", "matchedIn": ["nodes"] }], "scanComplete": true }, "redacted": false, "untrusted": true }`.

## n8n_get_node_docs

Returns one small immutable offline reference for an allowlisted core node.

- **Policy and endpoint:** read-only and closed-world; no network request;
  `RO=true, D=false, I=true, OW=false`.
- **Requirements:** Requires no n8n URL, API key, network access, or elevated mode because the four references are bundled and immutable.
- **Community Edition:** Community-version independent for its offline content. It is a small allowlist, not complete installed-node documentation.
- **Inputs:** required `node`, one of `webhook`, `code`, `http-request`, or `if`.
- **Returns:** `source: "bundled_offline_reference"`, `fetched: false`, the node
  type, title, concise summary/guidance, and an official documentation URL.
- **Failures and privacy:** unknown nodes fail locally. The tool never follows
  the URL, sends n8n data to a documentation host, or claims the compact
  reference replaces current official documentation.
- **Example:** `{ "node": "webhook" }` →
  `{ "data": { "source": "bundled_offline_reference", "fetched": false, "type": "n8n-nodes-base.webhook" }, "redacted": false, "untrusted": true }`.

## n8n_list_node_types

Inventories exact node-type strings observed in bounded workflow pages visible
to the configured API key.

- **Policy and endpoint:** read-only; up to ten sequential
  `GET /workflows?excludePinnedData=true` pages; no catalog, cookie, package, or
  per-workflow endpoint; `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires workflow-list permission for every scanned page; read-only mode is sufficient.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. Results include only node types observed in accessible workflows, never a complete installed catalog.
- **Inputs:** optional `cursor`; `limit?: 1..100` defaults to `100`;
  `maxPages?: 1..10` defaults to `4`; optional `active` filter.
- **Returns:** at most 500 lexically sorted types with observed node/workflow
  counts, scan counters, starting/ending coverage, `nextCursor`,
  `resultComplete`, and exact truncation fields. The scan has a shared
  30-second deadline and 20,000-node budget.
- **Failures and privacy:** repeated cursors, unsafe type strings, malformed
  workflows, deadline, node budget, or response limits fail explicitly. A type
  absent from the result has **unknown availability**; this is not an installed
  node catalog.
- **Example:** `{ "maxPages": 2, "limit": 100 }` →
  `{ "data": { "scope": "observed_workflows", "types": [{ "type": "n8n-nodes-base.webhook", "observedNodeCount": 2, "observedWorkflowCount": 2 }], "resultComplete": true, "availabilityStatement": "Types not observed in this bounded scan have unknown availability." }, "redacted": false, "untrusted": true }`.

## n8n_introspect

Runs the deterministic local Introspect engine v2 against one saved workflow
and a bounded sample of its execution history. It diagnoses; it does not execute
the workflow or call an AI agent.

- **Policy and endpoint:** read-only local analysis over
  `GET /workflows/{workflowId}?excludePinnedData=true`, bounded `GET /executions`
  pages, and, only in deep mode, up to four selected
  `GET /executions/{executionId}?redactExecutionData=true` reads;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires permission to read the selected workflow and bounded execution metadata; the 23-rule analysis itself is local and read-only.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. It does not execute workflows or call an external model, and partial upstream evidence remains explicit.
- **Inputs:** required `workflowId`; `profile?: "quick" | "deep"` defaults to
  `quick`; `lookbackHours?: 1..720` defaults to 24 quick/168 deep;
  `maxExecutions?: 1..100` defaults to 20 quick/50 deep, with quick capped at
  25; `includeSanitizedLabels?: boolean` defaults to `false`. The history
  window is anchored once to the newest valid timestamp on the first valid
  execution page, so transport latency cannot move the sample boundary.
- **Returns:** schema/engine versions, complete/partial status, opaque workflow
  facts, exact sample coverage, finding and rule-outcome counts, execution
  metrics, bounded findings from 23 immutable rules, per-rule coverage,
  limitations, and guidance. Structured content conforms directly to that
  schema. The two text blocks contain a concise summary and an exact serialized
  copy of the structured result. The summary states the inconclusive-rule and
  limitation counts. Output is deterministically reduced to its fixed structured
  and combined byte caps when necessary.
- **Failures and privacy:** no external model SDK, credential, setting, or call
  path exists. Quick mode is metadata-only. Deep mode requests redacted details
  for at most three recent errors and one slow success, then reduces them to
  structural facts. Labels are omitted by default; pattern-sanitized labels have
  an explicit residual limitation. Invalid timestamps, malformed bounded cursors,
  and incomplete reads fail closed or produce explicit partial evidence according
  to the collection boundary; unsupported certainty is never reported.
- **Example:** `{ "workflowId": "wf_1", "profile": "quick" }` →
  `{ "schemaVersion": "1.0.0", "engineVersion": "2.0.0", "status": "complete", "summary": { "findingCounts": { "critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0 } }, "findings": [] }`.

## n8n_community_packages_list

Lists metadata for installed n8n community-node packages without exposing any
install, update, or delete operation.

- **Policy and endpoint:** read-only; `GET /community-packages`;
  `RO=true, D=false, I=true, OW=true`.
- **Requirements:** Requires connected configuration and API-key permission to read installed community-package metadata.
- **Community Edition:** Verified on Community 2.30.5 and 2.30.7. It is read-only, returns metadata only, and does not install, update, or remove packages.
- **Inputs:** none.
- **Returns:** a bounded `data` prefix of at most 100 records with optional
  `packageName`, `installedVersion`, author, and timestamp fields, plus
  `totalCount`, `truncated`, and the exact `omittedCount`. Author email values
  are redacted by the shared output policy.
- **Failures and privacy:** package metadata is untrusted. The server does not
  run a package manager, download package contents, inspect a generated node
  catalog, or mutate installed community packages.
- **Example:** `{}` →
  `{ "data": { "data": [{ "packageName": "n8n-nodes-example", "installedVersion": "1.0.0", "authorEmail": "[EMAIL]" }], "totalCount": 1, "truncated": false, "omittedCount": 0 }, "redacted": true, "untrusted": true }`.

[Back to the documentation map](README.md)
