import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import AjvModule from "ajv";
import { createServer } from "../src/server.js";
import { NODE_DOCUMENTATION } from "../src/content/node-docs.js";
import { isOfficialN8nDocumentationUrl } from "../src/content/official-urls.js";
import { PROMPT_NAMES } from "../src/prompts.js";
import { RESOURCE_URIS } from "../src/resources.js";
import {
  genericToolOutputContract,
  TOOL_OUTPUT_CONTRACT_NAMES,
} from "../src/tools/output-contracts.js";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "../src/tools/registry.js";

const EXPECTED_TOOLS = [
  "n8n_workflows_list",
  "n8n_workflows_get",
  "n8n_workflows_create",
  "n8n_workflows_update",
  "n8n_update_node",
  "n8n_workflows_delete",
  "n8n_workflows_activate",
  "n8n_workflows_deactivate",
  "n8n_workflows_get_version",
  "n8n_workflows_get_tags",
  "n8n_workflows_update_tags",
  "n8n_workflows_archive",
  "n8n_workflows_unarchive",
  "n8n_workflows_diff",
  "n8n_executions_list",
  "n8n_executions_get",
  "n8n_executions_delete",
  "n8n_executions_retry",
  "n8n_executions_stop",
  "n8n_credentials_create",
  "n8n_credentials_delete",
  "n8n_credentials_schema",
  "n8n_credentials_list",
  "n8n_credentials_get",
  "n8n_credentials_update",
  "n8n_credentials_test",
  "n8n_credentials_usage",
  "n8n_tags_list",
  "n8n_tags_get",
  "n8n_tags_create",
  "n8n_tags_update",
  "n8n_tags_delete",
  "n8n_users_list",
  "n8n_users_get",
  "n8n_users_create",
  "n8n_users_delete",
  "n8n_health",
  "n8n_insights_summary",
  "n8n_audit_generate",
  "n8n_search_workflows",
  "n8n_get_node_docs",
  "n8n_list_node_types",
  "n8n_introspect",
  "n8n_community_packages_list",
] as const;

type ToolName = (typeof EXPECTED_TOOLS)[number];
type ToolOperation = "read-only" | "write" | "unsafe";

const EXPECTED_TOOL_OPERATIONS: Readonly<Record<ToolName, ToolOperation>> = {
  n8n_workflows_list: "read-only",
  n8n_workflows_get: "read-only",
  n8n_workflows_create: "write",
  n8n_workflows_update: "write",
  n8n_update_node: "write",
  n8n_workflows_delete: "unsafe",
  n8n_workflows_activate: "unsafe",
  n8n_workflows_deactivate: "unsafe",
  n8n_workflows_get_version: "read-only",
  n8n_workflows_get_tags: "read-only",
  n8n_workflows_update_tags: "write",
  n8n_workflows_archive: "unsafe",
  n8n_workflows_unarchive: "unsafe",
  n8n_workflows_diff: "read-only",
  n8n_executions_list: "read-only",
  n8n_executions_get: "read-only",
  n8n_executions_delete: "unsafe",
  n8n_executions_retry: "unsafe",
  n8n_executions_stop: "unsafe",
  n8n_credentials_create: "write",
  n8n_credentials_delete: "unsafe",
  n8n_credentials_schema: "read-only",
  n8n_credentials_list: "read-only",
  n8n_credentials_get: "read-only",
  n8n_credentials_update: "write",
  n8n_credentials_test: "unsafe",
  n8n_credentials_usage: "read-only",
  n8n_tags_list: "read-only",
  n8n_tags_get: "read-only",
  n8n_tags_create: "write",
  n8n_tags_update: "write",
  n8n_tags_delete: "unsafe",
  n8n_users_list: "read-only",
  n8n_users_get: "read-only",
  n8n_users_create: "unsafe",
  n8n_users_delete: "unsafe",
  n8n_health: "read-only",
  n8n_insights_summary: "read-only",
  n8n_audit_generate: "unsafe",
  n8n_search_workflows: "read-only",
  n8n_get_node_docs: "read-only",
  n8n_list_node_types: "read-only",
  n8n_introspect: "read-only",
  n8n_community_packages_list: "read-only",
};

const NON_DESTRUCTIVE_MUTATIONS = new Map<ToolName, "write" | "unsafe">([
  ["n8n_workflows_create", "write"],
  ["n8n_credentials_create", "write"],
  ["n8n_tags_create", "write"],
  ["n8n_users_create", "unsafe"],
  ["n8n_audit_generate", "unsafe"],
]);

const DESCRIPTION_PARAMETER_SEMANTICS: Readonly<Record<ToolName, RegExp>> = {
  n8n_workflows_list:
    /Omit cursor for page one.*active, tags, and name are combined upstream.*keep those filters and excludePinnedData unchanged.*nextCursor/i,
  n8n_workflows_get:
    /workflowId is the stable ID.*not a workflow name or version ID.*excludePinnedData changes only.*pinDataPresent\/staticDataPresent flags.*whether true or false/i,
  n8n_workflows_create:
    /name, nodes, and connections define a new record.*complete graph.*omitting settings uses an empty object.*Optional .* forwarded only when supplied/i,
  n8n_workflows_update:
    /workflowId selects the current record.*expectedVersionId from its latest read.*at least one writable field.*Omitted fields are preserved.*replaces that whole field/i,
  n8n_update_node:
    /workflowId selects the current workflow, nodeId selects exactly one node.*path selects the mutable field.*expectedVersionId.*acknowledgeNonAtomicRisk=true/i,
  n8n_workflows_delete:
    /workflowId must be the current stable ID.*name or version ID is not accepted/i,
  n8n_workflows_activate:
    /does not execute it now.*workflowId must be the current stable ID.*not a name or version ID/i,
  n8n_workflows_deactivate:
    /without deleting saved data or stopping runs already in progress.*workflowId must be the current stable ID.*not a name or version ID/i,
  n8n_workflows_get_version:
    /workflowId is the stable workflow ID; versionId is .* separate retained-version ID.*Do not swap them/i,
  n8n_workflows_get_tags:
    /workflowId selects the workflow.*not a tag ID.*does not list unassigned tags/i,
  n8n_workflows_update_tags:
    /workflowId selects the workflow.*tagIds item must be a stable tag ID.*tag names are not accepted.*\[\] clears all tags/i,
  n8n_workflows_archive:
    /workflowId must be the current stable ID.*not a name or version ID.*availability change can disrupt callers/i,
  n8n_workflows_unarchive:
    /without activating its triggers.*workflowId must identify the archived workflow itself.*not a name or version ID/i,
  n8n_workflows_diff:
    /workflowId selects the workflow; fromVersionId is the retained baseline.*toVersionId is a different retained target.*Omit toVersionId.*ignoreLayout=true/i,
  n8n_executions_list: /status and workflowId filter upstream.*includeData only reports/i,
  n8n_executions_get:
    /executionId is the execution record ID.*not its workflowId.*includeData=true.*withholds every node input and output/i,
  n8n_executions_delete:
    /executionId must be the execution record ID.*workflow ID is not accepted/i,
  n8n_executions_retry:
    /has retry data and did not finish successfully.*rejects queued\/new executions and successful finished executions.*loadWorkflow=true.*false uses the original execution snapshot/i,
  n8n_executions_stop:
    /stoppable execution: new, unknown, waiting, or running.*executionId must be its record ID.*not a workflow ID.*rejects an execution that is already terminal.*successful response.*canceled maps to stopped.*terminal status maps to already_finished.*unclear body maps to unknown.*HTTP 200 alone never proves cancellation/i,
  n8n_credentials_create:
    /call n8n_credentials_schema with the planned type, then build data.*name is only the stored label.*isResolvable is forwarded only when supplied/i,
  n8n_credentials_delete:
    /credentialId must be the stable ID.*name or type is not accepted.*Scan all n8n_credentials_usage pages first/i,
  n8n_credentials_schema:
    /credentialType is the public type name.*not a stored credential ID, name, or secret.*which keys belong in data/i,
  n8n_credentials_list:
    /Omit cursor for page one.*pass nextCursor back unchanged.*limit sizes only that request.*never auto-paginates/i,
  n8n_credentials_get: /credentialId is the stable ID.*not its name, type, or secret data/i,
  n8n_credentials_update:
    /credentialId selects the record.*omit fields to keep them and supply at least one change.*If type changes, data is also required.*isPartialData=false replaces.*true requests a partial merge/i,
  n8n_credentials_test:
    /external service, which receives and may log the attempt.*credentialId is the stable ID.*inline credential data, names, and types are not accepted/i,
  n8n_credentials_usage:
    /credentialId is the stable ID.*keep credentialId, active, and limit unchanged.*Unresolved legacy references.*nextCursor is null/i,
  n8n_tags_list:
    /Omit cursor for page one.*pass nextCursor back unchanged.*limit sizes only the current page/i,
  n8n_tags_get: /tagId is the stable tag identity.*tag name or workflow ID is not accepted/i,
  n8n_tags_create:
    /name is the literal display label, not a tag ID or workflow assignment.*must already be trimmed.*never assigns the tag/i,
  n8n_tags_update:
    /tagId is the stable selector.*name is the complete new display label, not another ID/i,
  n8n_tags_delete: /tagId must be the stable ID.*tag name or workflow ID is not accepted/i,
  n8n_users_list: /includeRole=true only asks n8n for roles.*cursor resumes.*never auto-paginates/i,
  n8n_users_get:
    /userIdOrEmail routes ID-shaped input to ID lookup.*exact percent-encoded email lookup.*partial email matching is not used.*includeRole=true/i,
  n8n_users_create:
    /email is the future account login.*role is a global account role, not project membership.*omission selects global:member.*owner invitations are rejected/i,
  n8n_users_delete:
    /userId must be the stable ID.*email address is not accepted.*no transfer target.*ownership handling remains entirely with n8n/i,
  n8n_health:
    /accepts no arguments and requires the configured n8n URL and API key.*remote plaintext HTTP also requires N8N_ALLOW_INSECURE_HTTP=1/i,
  n8n_insights_summary:
    /startDate and endDate are inclusive.*startDate <= endDate.*omitting both requests n8n's default range/i,
  n8n_audit_generate:
    /Omit categories to use n8n's complete default.*supply the exact risk areas.*daysAbandonedWorkflow is independent.*changes only/i,
  n8n_search_workflows:
    /query is matched locally only in the fields named by searchIn.*active filters upstream first.*keep query, searchIn, active, and limit unchanged/i,
  n8n_get_node_docs:
    /node is an exact local key.*not an arbitrary n8n node-type string.*no n8n URL, API key, network, or elevated mode/i,
  n8n_list_node_types:
    /Omit cursor to start at page one.*maxPages limits.*active and limit apply to every page.*keep them unchanged.*starting at page one and reaching the end.*30 seconds or 20,000 nodes/i,
  n8n_introspect:
    /quick uses 24h\/20 and caps maxExecutions at 25.*deep uses 168h\/50.*includeSanitizedLabels=false/i,
  n8n_community_packages_list:
    /accepts no arguments, filters, cursor, or limit.*keeps at most 100.*exact omissions/i,
};

const DESCRIPTION_AUTHORIZATION_SEMANTICS: Readonly<Record<ToolName, RegExp>> = {
  n8n_workflows_list: /Requires workflow-list permission/i,
  n8n_workflows_get: /Requires permission to read the target/i,
  n8n_workflows_create: /Requires write or unsafe mode plus create permission/i,
  n8n_workflows_update: /Requires write\/unsafe mode plus read and update permission/i,
  n8n_update_node: /Requires write\/unsafe mode plus read and update permission/i,
  n8n_workflows_delete: /Requires unsafe mode plus delete permission/i,
  n8n_workflows_activate: /Requires unsafe mode plus activation permission/i,
  n8n_workflows_deactivate: /Requires unsafe mode plus deactivation permission/i,
  n8n_workflows_get_version: /Requires history-read permission/i,
  n8n_workflows_get_tags: /Requires assignment-read permission/i,
  n8n_workflows_update_tags: /Requires write\/unsafe mode plus assignment permission/i,
  n8n_workflows_archive: /Requires unsafe mode plus archive permission/i,
  n8n_workflows_unarchive: /Requires unsafe mode plus unarchive permission/i,
  n8n_workflows_diff: /Requires workflow\/history read permission/i,
  n8n_executions_list: /Requires execution-list permission/i,
  n8n_executions_get: /Requires execution-read permission/i,
  n8n_executions_delete: /Requires unsafe mode plus execution-delete permission/i,
  n8n_executions_retry: /Requires unsafe mode and retry permission/i,
  n8n_executions_stop: /Requires unsafe mode and stop permission/i,
  n8n_credentials_create: /Requires write\/unsafe mode plus create permission/i,
  n8n_credentials_delete: /Requires unsafe mode plus credential-delete permission/i,
  n8n_credentials_schema: /Requires schema-read permission/i,
  n8n_credentials_list: /Requires credential-list permission/i,
  n8n_credentials_get: /Requires credential-read permission/i,
  n8n_credentials_update: /Requires write\/unsafe mode plus update permission/i,
  n8n_credentials_test: /Requires unsafe mode plus test permission/i,
  n8n_credentials_usage: /Requires workflow-list permission/i,
  n8n_tags_list: /Requires tag-list permission/i,
  n8n_tags_get: /Requires tag-read permission/i,
  n8n_tags_create: /Requires write\/unsafe mode plus create permission/i,
  n8n_tags_update: /Requires write\/unsafe mode plus tag-update permission/i,
  n8n_tags_delete: /Requires unsafe mode plus tag-delete permission/i,
  n8n_users_list: /Requires user-list permission/i,
  n8n_users_get: /Requires user-read permission/i,
  n8n_users_create: /Requires unsafe mode plus invite permission/i,
  n8n_users_delete: /Requires unsafe mode plus user-delete permission/i,
  n8n_health:
    /requires the configured n8n URL and API key; remote plaintext HTTP also requires N8N_ALLOW_INSECURE_HTTP=1/i,
  n8n_insights_summary: /Requires insights-read permission/i,
  n8n_audit_generate: /Requires unsafe mode and owner-authorized API access/i,
  n8n_search_workflows: /Requires workflow-list permission/i,
  n8n_get_node_docs: /Requires no n8n URL, API key, network, or elevated mode/i,
  n8n_list_node_types: /Requires workflow-list permission/i,
  n8n_introspect: /Requires workflow\/execution read permission/i,
  n8n_community_packages_list: /Requires package-list permission/i,
};

const DESCRIPTION_RETURN_SEMANTICS: Readonly<Record<ToolName, RegExp>> = {
  n8n_workflows_list: /returns projected workflows and nextCursor, never pin\/static values/i,
  n8n_workflows_get: /returns structure, state, settings, and presence flags/i,
  n8n_workflows_create: /returns the validated projection without pin\/static values/i,
  n8n_workflows_update: /returns the confirmed projection/i,
  n8n_update_node: /returns the changed path and residual race risk/i,
  n8n_workflows_delete: /returns the request-bound workflowId with deleted=true/i,
  n8n_workflows_activate: /returns target-validated active state metadata/i,
  n8n_workflows_deactivate: /returns target-validated inactive state metadata/i,
  n8n_workflows_get_version: /returns validated nodes and connections subject to retention/i,
  n8n_workflows_get_tags: /returns validated tag metadata/i,
  n8n_workflows_update_tags: /returns n8n's validated replacement/i,
  n8n_workflows_archive: /returns target-validated metadata with isArchived=true/i,
  n8n_workflows_unarchive: /returns target-validated metadata with isArchived=false/i,
  n8n_workflows_diff: /returns coverage, counts, and a byte-bounded prefix of up to 200 changes/i,
  n8n_executions_list: /returns metadata and nextCursor/i,
  n8n_executions_get: /returns identity, status, timing, retry fields, and value-free dataPolicy/i,
  n8n_executions_delete: /returns the request-bound executionId with deleted=true/i,
  n8n_executions_retry: /returns metadata without payload values/i,
  n8n_executions_stop: /returns the mapped state/i,
  n8n_credentials_create: /returns metadata only/i,
  n8n_credentials_delete: /returns the request-bound credentialId with deleted=true/i,
  n8n_credentials_schema: /returns the validated upstream field contract/i,
  n8n_credentials_list: /returns metadata and nextCursor, never stored values/i,
  n8n_credentials_get: /returns validated identity, type, flags, and timestamps/i,
  n8n_credentials_update: /returns metadata without secret values/i,
  n8n_credentials_test:
    /returns only the target-bound OK\/Error outcome and withholds the upstream diagnostic message/i,
  n8n_credentials_usage: /returns bounded workflow\/node matches and omission counts/i,
  n8n_tags_list: /returns validated metadata and nextCursor/i,
  n8n_tags_get: /returns validated ID, name, and optional timestamps/i,
  n8n_tags_create: /returns validated metadata/i,
  n8n_tags_update: /returns validated metadata/i,
  n8n_tags_delete: /returns the request-bound tagId with deleted=true/i,
  n8n_users_list: /returns redaction-protected metadata and nextCursor/i,
  n8n_users_get: /returns redaction-protected identity and account state without mutation/i,
  n8n_users_create: /returns delivery state but never the acceptance URL/i,
  n8n_users_delete:
    /returns the request-bound userId with deleted=true and provides no rollback claim/i,
  n8n_health: /Returns ok=true and the successful status, never the upstream body/i,
  n8n_insights_summary: /returns totals, failures, rates, time saved, and runtime aggregates/i,
  n8n_audit_generate: /returns a sanitized but untrusted report without changing configuration/i,
  n8n_search_workflows: /returns at most 50 value-free matches and explicit scan state/i,
  n8n_get_node_docs:
    /Returns source\/fetched provenance, canonical type, title, summary, guidance, and official URL/i,
  n8n_list_node_types: /returns counts and exact coverage, capped at 30 seconds or 20,000 nodes/i,
  n8n_introspect: /returns findings and coverage/i,
  n8n_community_packages_list: /returns untrusted metadata with author emails redacted/i,
};

type GlamaV020Score = 4.7 | 4.8 | 4.9 | 5.0;

// Independent transcription of Walter's complete Glama report. Keeping every score makes a
// same-size class swap observable instead of deriving the 40/4 split from its own expectation.
const GLAMA_V020_SCORE_BY_TOOL: Readonly<Record<ToolName, GlamaV020Score>> = {
  n8n_workflows_list: 4.7,
  n8n_workflows_get: 4.7,
  n8n_workflows_create: 4.9,
  n8n_workflows_update: 4.9,
  n8n_update_node: 4.9,
  n8n_workflows_delete: 4.7,
  n8n_workflows_activate: 4.7,
  n8n_workflows_deactivate: 4.7,
  n8n_workflows_get_version: 4.7,
  n8n_workflows_get_tags: 4.7,
  n8n_workflows_update_tags: 4.7,
  n8n_workflows_archive: 4.7,
  n8n_workflows_unarchive: 4.7,
  n8n_workflows_diff: 4.9,
  n8n_executions_list: 5.0,
  n8n_executions_get: 4.7,
  n8n_executions_delete: 4.7,
  n8n_executions_retry: 4.8,
  n8n_executions_stop: 4.7,
  n8n_credentials_create: 4.9,
  n8n_credentials_delete: 4.7,
  n8n_credentials_schema: 4.9,
  n8n_credentials_list: 4.9,
  n8n_credentials_get: 4.9,
  n8n_credentials_update: 4.9,
  n8n_credentials_test: 4.7,
  n8n_credentials_usage: 4.9,
  n8n_tags_list: 4.7,
  n8n_tags_get: 4.9,
  n8n_tags_create: 4.7,
  n8n_tags_update: 4.7,
  n8n_tags_delete: 4.7,
  n8n_users_list: 5.0,
  n8n_users_get: 4.9,
  n8n_users_create: 4.9,
  n8n_users_delete: 4.9,
  n8n_health: 4.9,
  n8n_insights_summary: 5.0,
  n8n_audit_generate: 4.9,
  n8n_search_workflows: 4.9,
  n8n_get_node_docs: 4.7,
  n8n_list_node_types: 4.9,
  n8n_introspect: 5.0,
  n8n_community_packages_list: 4.9,
};

const EXPECTED_GLAMA_V020_ALREADY_FIVE: readonly ToolName[] = [
  "n8n_executions_list",
  "n8n_insights_summary",
  "n8n_introspect",
  "n8n_users_list",
];

function glamaV020PartitionViolations(
  scores: Readonly<Record<ToolName, GlamaV020Score>>,
): string[] {
  const violations: string[] = [];
  if (Object.keys(scores).sort().join("\n") !== [...EXPECTED_TOOLS].sort().join("\n")) {
    violations.push("report inventory");
  }
  const actualFive = EXPECTED_TOOLS.filter((name) => scores[name] === 5.0).sort();
  if (actualFive.join("\n") !== [...EXPECTED_GLAMA_V020_ALREADY_FIVE].sort().join("\n")) {
    violations.push("5.0 membership");
  }
  const counts = new Map<GlamaV020Score, number>([
    [4.7, 0],
    [4.8, 0],
    [4.9, 0],
    [5.0, 0],
  ]);
  for (const score of Object.values(scores)) counts.set(score, (counts.get(score) ?? 0) + 1);
  if (
    counts.get(4.7) !== 20 ||
    counts.get(4.8) !== 1 ||
    counts.get(4.9) !== 19 ||
    counts.get(5.0) !== 4
  ) {
    violations.push("score counts");
  }
  return violations;
}

// Walter's complete Glama v0.2.0 report scored these four definitions at 5.0.
// Every other member of EXPECTED_TOOLS is part of the parameter-semantics remediation class.
// The remediation class derives from the 44-row score fixture; the 5.0 class is an independent
// literal, and the partition test cross-checks them.
const GLAMA_V020_ALREADY_FIVE = new Set<ToolName>(EXPECTED_GLAMA_V020_ALREADY_FIVE);
const GLAMA_V020_PARAMETER_REMEDIATION = EXPECTED_TOOLS.filter(
  (name) => GLAMA_V020_SCORE_BY_TOOL[name] < 5.0,
);

interface ToolDefinitionMatrixObservation {
  readonly operation: string;
  readonly destructiveHint: boolean | undefined;
  readonly description: string;
}

// Matrix scope: the final MCP tools/list definition surface and the local policy class that
// governs each registered handler. Tool/annotation semantics come from the official MCP 2025-06-18
// specification: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
// This matrix does not claim to prove n8n endpoint behavior. Request/response effects are owned by
// the positive and adversarial tool-contract suites; Community-version truth is owned by the
// disposable 2.30.5/2.30.7 compatibility gate. Copy quality beyond the enumerated semantic facts is
// frozen by the normalized tools/list digest and remains a human/auditor judgment. A future Glama
// score is also external evidence; this matrix proves the reviewed contract, not the platform's score.
// Retry eligibility is bound to n8n 2.30.7's official ExecutionService.retry implementation:
// https://github.com/n8n-io/n8n/blob/n8n%402.30.7/packages/cli/src/executions/execution.service.ts
// Stop eligibility is bound to the same official service: new, unknown, waiting, and running are
// stoppable; already-terminal targets are rejected before a successful response.
function toolDefinitionMatrixViolations(
  name: ToolName,
  observation: ToolDefinitionMatrixObservation,
): string[] {
  const violations: string[] = [];
  const expectedOperation = EXPECTED_TOOL_OPERATIONS[name];
  const expectedDestructiveHint =
    expectedOperation !== "read-only" && !NON_DESTRUCTIVE_MUTATIONS.has(name);

  if (observation.operation !== expectedOperation) violations.push("operation");
  if (observation.destructiveHint !== expectedDestructiveHint) {
    violations.push("destructiveHint");
  }
  if (!DESCRIPTION_PARAMETER_SEMANTICS[name].test(observation.description)) {
    violations.push("tool-specific parameter semantics");
  }
  if (!DESCRIPTION_AUTHORIZATION_SEMANTICS[name].test(observation.description)) {
    violations.push("authorization or configuration boundary");
  }
  if (!DESCRIPTION_RETURN_SEMANTICS[name].test(observation.description)) {
    violations.push("return semantics");
  }

  return violations;
}

const APPROVED_TOOL_METADATA_SHA256 =
  "83cf07fff5a9651ecd5ea8a750367256f53b0d478af7a93187f11518b516acfc";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function toolMetadataSha256(tools: readonly { readonly name: string }[]): string {
  const normalized = canonicalize(
    [...tools].sort((left, right) => left.name.localeCompare(right.name, "en-US")),
  );
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function connectedClient() {
  const server = createServer({ mode: "read-only", allowInsecureHttp: false });
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("the offline MCP inventory is exactly 44 tools, five resources, and four prompts", async () => {
  const { client, server } = await connectedClient();
  try {
    const [tools, resources, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listPrompts(),
    ]);
    assert.deepEqual(TOOL_NAMES, EXPECTED_TOOLS);
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      EXPECTED_TOOLS,
    );
    assert.deepEqual(
      resources.resources.map((resource) => resource.uri),
      RESOURCE_URIS,
    );
    assert.deepEqual(
      prompts.prompts.map((prompt) => prompt.name),
      PROMPT_NAMES,
    );
    assert.equal(tools.tools.length, 44);
    assert.equal(resources.resources.length, 5);
    assert.equal(prompts.prompts.length, 4);
  } finally {
    await client.close();
    await server.close();
  }
});

test("all 44 tools publish conservative annotations from the typed registry", async () => {
  const { client, server } = await connectedClient();
  try {
    const listed = await client.listTools();
    for (const definition of TOOL_DEFINITIONS) {
      const tool = listed.tools.find((candidate) => candidate.name === definition.name);
      assert(tool, `Missing listed tool ${definition.name}`);
      assert.equal(tool.annotations?.readOnlyHint, definition.operation === "read-only");
      assert.equal(tool.annotations?.destructiveHint, definition.annotations.destructiveHint);
      assert.equal(
        tool.annotations?.destructiveHint,
        definition.operation !== "read-only" &&
          !NON_DESTRUCTIVE_MUTATIONS.has(definition.name as (typeof EXPECTED_TOOLS)[number]),
      );
      assert.equal(tool.annotations?.idempotentHint, definition.annotations.idempotentHint);
      assert.equal(tool.annotations?.openWorldHint, definition.annotations.openWorldHint);
      assert.deepEqual(tool.execution, { taskSupport: "forbidden" });
      assert(tool.inputSchema);
      assert(tool.outputSchema);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("additive creates and the broad audit publish non-destructive hints without weakening policy", () => {
  for (const [name, expectedOperation] of NON_DESTRUCTIVE_MUTATIONS) {
    const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    assert(definition, `Missing typed definition for ${name}`);
    assert.equal(definition.operation, expectedOperation, `${name} changed its policy class`);
    assert.equal(definition.annotations.readOnlyHint, false);
    assert.equal(definition.annotations.destructiveHint, false);
    assert.match(
      definition.description,
      name === "n8n_audit_generate" ? /non-destructive/i : /additive write/i,
      `${name} does not explain why destructiveHint is false`,
    );
  }
});

test("the complete 44-row definition matrix matches the final MCP surface bidirectionally", async () => {
  const matrixNames = Object.keys(EXPECTED_TOOL_OPERATIONS).sort();
  const semanticNames = Object.keys(DESCRIPTION_PARAMETER_SEMANTICS).sort();
  const authorizationNames = Object.keys(DESCRIPTION_AUTHORIZATION_SEMANTICS).sort();
  const returnNames = Object.keys(DESCRIPTION_RETURN_SEMANTICS).sort();
  const expectedNames = [...EXPECTED_TOOLS].sort();
  assert.deepEqual(matrixNames, expectedNames);
  assert.deepEqual(semanticNames, expectedNames);
  assert.deepEqual(authorizationNames, expectedNames);
  assert.deepEqual(returnNames, expectedNames);
  assert.deepEqual(
    new Set(Object.values(EXPECTED_TOOL_OPERATIONS)),
    new Set<ToolOperation>(["read-only", "write", "unsafe"]),
  );

  const { client, server } = await connectedClient();
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expectedNames);

    for (const name of EXPECTED_TOOLS) {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
      const published = listed.tools.find((candidate) => candidate.name === name);
      assert(definition, `Missing typed definition for ${name}`);
      assert(published, `Missing published definition for ${name}`);
      assert.deepEqual(
        toolDefinitionMatrixViolations(name, {
          operation: definition.operation,
          destructiveHint: published.annotations?.destructiveHint,
          description: published.description ?? "",
        }),
        [],
        `${name} violates the reviewed definition matrix`,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("the Glama v0.2.0 score report partitions all 44 definitions into 40 fixes and four retained 5.0 tools", () => {
  assert.deepEqual(glamaV020PartitionViolations(GLAMA_V020_SCORE_BY_TOOL), []);
  assert.equal(GLAMA_V020_PARAMETER_REMEDIATION.length, 40);
  assert.equal(GLAMA_V020_ALREADY_FIVE.size, 4);
  assert.deepEqual(
    [...GLAMA_V020_PARAMETER_REMEDIATION, ...GLAMA_V020_ALREADY_FIVE].sort(),
    [...EXPECTED_TOOLS].sort(),
  );

  const swappedScores = {
    ...GLAMA_V020_SCORE_BY_TOOL,
    n8n_users_get: 5.0,
    n8n_users_list: 4.9,
  } as const;
  assert(
    glamaV020PartitionViolations(swappedScores).includes("5.0 membership"),
    "a same-size 5.0/remediation class swap escaped the report fixture",
  );
});

test("every definition-matrix invariant rejects a controlled synthetic mutation", () => {
  for (const name of EXPECTED_TOOLS) {
    const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    assert(definition, `Missing typed definition for ${name}`);
    const expectedOperation = EXPECTED_TOOL_OPERATIONS[name];
    const expectedDestructiveHint =
      expectedOperation !== "read-only" && !NON_DESTRUCTIVE_MUTATIONS.has(name);
    const validObservation: ToolDefinitionMatrixObservation = {
      operation: expectedOperation,
      destructiveHint: expectedDestructiveHint,
      description: definition.description,
    };
    assert.deepEqual(toolDefinitionMatrixViolations(name, validObservation), []);

    const alternateOperation: ToolOperation =
      expectedOperation === "read-only" ? "write" : "read-only";
    assert(
      toolDefinitionMatrixViolations(name, {
        ...validObservation,
        operation: alternateOperation,
      }).includes("operation"),
      `${name} matrix did not reject an operation mutation`,
    );
    assert(
      toolDefinitionMatrixViolations(name, {
        ...validObservation,
        destructiveHint: !expectedDestructiveHint,
      }).includes("destructiveHint"),
      `${name} matrix did not reject an annotation mutation`,
    );

    const semanticMatch = definition.description.match(DESCRIPTION_PARAMETER_SEMANTICS[name]);
    assert(semanticMatch?.[0], `${name} has no tool-specific semantic match to mutate`);
    assert(
      toolDefinitionMatrixViolations(name, {
        ...validObservation,
        description: definition.description.replace(
          semanticMatch[0],
          "[removed tool-specific semantics]",
        ),
      }).includes("tool-specific parameter semantics"),
      `${name} matrix did not reject removal of its reviewed interaction`,
    );
    const authorizationMatch = definition.description.match(
      DESCRIPTION_AUTHORIZATION_SEMANTICS[name],
    );
    assert(authorizationMatch?.[0], `${name} has no authorization/configuration match to mutate`);
    assert(
      toolDefinitionMatrixViolations(name, {
        ...validObservation,
        description: definition.description.replace(
          authorizationMatch[0],
          "Requires the wrong mode and permission",
        ),
      }).includes("authorization or configuration boundary"),
      `${name} matrix did not reject an authorization/configuration inversion`,
    );

    const returnMatch = definition.description.match(DESCRIPTION_RETURN_SEMANTICS[name]);
    assert(returnMatch?.[0], `${name} has no return match to mutate`);
    assert(
      toolDefinitionMatrixViolations(name, {
        ...validObservation,
        description: definition.description.replace(returnMatch[0], "returns deleted=false"),
      }).includes("return semantics"),
      `${name} matrix did not reject a return-value inversion`,
    );
  }

  const expectSemanticInversion = (
    name: ToolName,
    from: string,
    to: string,
    expectedViolation: string,
  ): void => {
    const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    assert(definition, `Missing typed definition for ${name}`);
    assert(definition.description.includes(from), `${name} lacks the fact selected for inversion`);
    assert(
      toolDefinitionMatrixViolations(name, {
        operation: definition.operation,
        destructiveHint: definition.annotations.destructiveHint,
        description: definition.description.replace(from, to),
      }).includes(expectedViolation),
      `${name} matrix accepted the controlled inversion: ${from} -> ${to}`,
    );
  };

  expectSemanticInversion(
    "n8n_credentials_delete",
    "Requires unsafe mode",
    "Requires read-only mode",
    "authorization or configuration boundary",
  );
  expectSemanticInversion(
    "n8n_credentials_delete",
    "deleted=true",
    "deleted=false",
    "return semantics",
  );
  expectSemanticInversion(
    "n8n_credentials_delete",
    "Scan all n8n_credentials_usage pages first",
    "Skip all n8n_credentials_usage pages first",
    "tool-specific parameter semantics",
  );
  expectSemanticInversion(
    "n8n_credentials_update",
    "supply at least one change",
    "supply no changes",
    "tool-specific parameter semantics",
  );
  expectSemanticInversion(
    "n8n_workflows_archive",
    "isArchived=true",
    "isArchived=false",
    "return semantics",
  );
  expectSemanticInversion(
    "n8n_workflows_unarchive",
    "isArchived=false",
    "isArchived=true",
    "return semantics",
  );
});

test("all 44 tools publish complete agent-facing descriptions for tools and top-level fields", async () => {
  const { client, server } = await connectedClient();
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 44);
    for (const tool of listed.tools) {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === tool.name);
      assert(definition, `Missing typed definition for ${tool.name}`);
      assert(
        tool.description && tool.description.trim().length >= 100,
        `${tool.name} needs concise purpose, usage guidance, and return semantics`,
      );
      assert(
        tool.description.length <= 600,
        `${tool.name} description is too long for routine tool selection`,
      );
      assert.match(tool.description, /\breturns?\b/i, `${tool.name} omits return semantics`);
      const namesASibling = listed.tools.some(
        (candidate) =>
          candidate.name !== tool.name && tool.description?.includes(candidate.name) === true,
      );
      assert(namesASibling, `${tool.name} does not distinguish itself from a named sibling tool`);
      for (const [schemaName, schema] of [
        ["inputSchema", tool.inputSchema],
        ["outputSchema", tool.outputSchema],
      ] as const) {
        assert(schema, `${tool.name} lacks ${schemaName}`);
        const properties = schema.properties as
          Record<string, { readonly description?: unknown }> | undefined;
        for (const [fieldName, field] of Object.entries(properties ?? {})) {
          const description = field.description;
          assert.equal(
            typeof description,
            "string",
            `${tool.name} ${schemaName}.${fieldName} lacks a description`,
          );
          assert(typeof description === "string");
          assert(
            description.trim().length >= 12,
            `${tool.name} ${schemaName}.${fieldName} description is not meaningful`,
          );
        }
      }
      const genericData = (
        tool.outputSchema?.properties as
          Record<string, { readonly description?: unknown }> | undefined
      )?.data;
      if (tool.name === "n8n_introspect") {
        assert.equal(genericData, undefined, "Introspect must keep its direct result schema");
      } else {
        assert.equal(
          genericData?.description,
          definition.outputDataDescription,
          `${tool.name} must publish its exact typed data contract`,
        );
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("all 43 enveloped tools publish and enforce tool-specific structural data contracts", async () => {
  const { client, server } = await connectedClient();
  try {
    const listed = await client.listTools();
    const envelopedNames = EXPECTED_TOOLS.filter((name) => name !== "n8n_introspect").sort();
    assert.deepEqual(TOOL_OUTPUT_CONTRACT_NAMES, envelopedNames);
    const ajv = new AjvModule.default({ allErrors: true, strict: false });
    for (const tool of listed.tools) {
      if (tool.name === "n8n_introspect") continue;
      assert(tool.outputSchema, `${tool.name} lacks an output schema`);
      const dataSchema = (
        tool.outputSchema.properties as Record<string, Record<string, unknown>> | undefined
      )?.data;
      assert(dataSchema, `${tool.name} lacks an output data schema`);
      assert(
        ["type", "anyOf", "oneOf", "allOf"].some((keyword) => Object.hasOwn(dataSchema, keyword)),
        `${tool.name} still publishes unconstrained data`,
      );
      const validate = ajv.compile(tool.outputSchema);
      assert.equal(
        validate({ data: null, redacted: false, untrusted: true }),
        false,
        `${tool.name} accepts a structurally invalid null data result`,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("mutation fallbacks are server-only and accept only fixed bounded identity fields", async () => {
  const { client, server } = await connectedClient();
  try {
    const listed = await client.listTools();
    const fallback = {
      truncated: true,
      outcome: "success",
      detail: "Server-generated bounded mutation summary.",
      identity: {},
    };
    for (const definition of TOOL_DEFINITIONS.filter(
      (candidate) => candidate.operation !== "read-only",
    )) {
      const contract = genericToolOutputContract(
        definition.name,
        definition.operation,
        definition.outputDataDescription,
      );
      assert.equal(
        contract.primaryDataSchema.safeParse(fallback).success,
        false,
        `${definition.name} accepts the server-only fallback as raw handler data`,
      );
    }

    const workflowUpdate = listed.tools.find(
      (candidate) => candidate.name === "n8n_workflows_update",
    );
    assert(workflowUpdate?.outputSchema);
    const validate = new AjvModule.default({ allErrors: true, strict: false }).compile(
      workflowUpdate.outputSchema,
    );
    assert.equal(
      validate({
        data: {
          ...fallback,
          identity: { ["x".repeat(300_000)]: "unbounded" },
        },
        redacted: false,
        untrusted: true,
      }),
      false,
      "the public fallback schema accepts an arbitrary oversized identity key",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("the exact normalized tools/list metadata matches the approved semantic contract", async () => {
  const { client, server } = await connectedClient();
  try {
    const listed = await client.listTools();
    const actual = toolMetadataSha256(listed.tools);
    assert.equal(
      actual,
      APPROVED_TOOL_METADATA_SHA256,
      `tools/list metadata changed; review the semantic diff and approve this SHA-256: ${actual}`,
    );

    const mutatedExecutionContract = listed.tools.map((tool, index) =>
      index === 0 ? { ...tool, execution: { taskSupport: "required" as const } } : tool,
    );
    assert.notEqual(
      toolMetadataSha256(mutatedExecutionContract),
      actual,
      "execution.taskSupport changed without changing the full-surface digest",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("reviewed tool descriptions name the exact fields their handlers return", async () => {
  const { client, server } = await connectedClient();
  try {
    const listed = await client.listTools();
    const workflowDiff = listed.tools.find((tool) => tool.name === "n8n_workflows_diff");
    const nodeDocs = listed.tools.find((tool) => tool.name === "n8n_get_node_docs");
    assert(workflowDiff?.outputSchema);
    assert(nodeDocs?.description);
    const diffData = (
      workflowDiff.outputSchema.properties as
        Record<string, { readonly description?: string }> | undefined
    )?.data;
    assert.match(diffData?.description ?? "", /\bcomparisonCoverage\b/);
    assert.match(diffData?.description ?? "", /\bomittedDetails\b/);
    assert.doesNotMatch(diffData?.description ?? "", /\bcomparedFields\b|\bomittedChangeCount\b/);
    assert.match(nodeDocs.description, /\btitle\b.*\bsummary\b.*\bguidance\b.*\bofficial URL\b/);
    assert.doesNotMatch(nodeDocs.description, /\bstructure\b|\bparameters\b/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("workflow schemas use Codex-compatible homogeneous position arrays", async () => {
  const { client, server } = await connectedClient();
  try {
    const listed = await client.listTools();
    for (const name of ["n8n_workflows_create", "n8n_workflows_update"]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert(tool, `Missing listed tool ${name}`);
      const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
      const nodeItems = properties.nodes?.items as
        { readonly properties?: Record<string, Record<string, unknown>> } | undefined;
      const position = nodeItems?.properties?.position;
      assert.equal(position?.type, "array");
      assert.equal(position?.minItems, 2);
      assert.equal(position?.maxItems, 2);
      assert.equal(Array.isArray(position?.items), false);
      assert.equal((position?.items as { readonly type?: unknown } | undefined)?.type, "number");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("every published tool schema is fully inline, with no $ref, for clients without $ref support", async () => {
  const { client, server } = await connectedClient();
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 44);
    for (const tool of listed.tools) {
      for (const [kind, schema] of [
        ["inputSchema", tool.inputSchema],
        ["outputSchema", tool.outputSchema],
      ] as const) {
        assert(schema, `${tool.name} lacks ${kind}`);
        const stack: unknown[] = [schema];
        while (stack.length > 0) {
          const current = stack.pop();
          if (current === null || typeof current !== "object") continue;
          assert(
            !Object.hasOwn(current, "$ref"),
            `${tool.name} ${kind} contains a "$ref"; reuse of one Zod instance within a tool makes the SDK emit refs some clients cannot resolve`,
          );
          stack.push(...Object.values(current as Record<string, unknown>));
        }
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("unsafe mode is the sole server-side gate and publishes no confirmation input", async () => {
  const { client, server } = await connectedClient();
  try {
    const listed = await client.listTools();
    const unsafeDefinitions = TOOL_DEFINITIONS.filter(
      (definition) => definition.operation === "unsafe",
    );
    assert.equal(unsafeDefinitions.length, 14, "expected exactly 14 unsafe tools");
    for (const definition of unsafeDefinitions) {
      const tool = listed.tools.find((candidate) => candidate.name === definition.name);
      assert(tool, `Missing listed tool ${definition.name}`);
      const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
      assert.equal(
        Object.hasOwn(properties ?? {}, "confirmation"),
        false,
        `${definition.name} still publishes a redundant confirmation input`,
      );
      assert.equal(
        (tool.inputSchema.required as readonly string[] | undefined)?.includes("confirmation") ??
          false,
        false,
        `${definition.name} still requires a redundant confirmation input`,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("every static resource is readable and every prompt is retrievable offline", async () => {
  const { client, server } = await connectedClient();
  try {
    for (const uri of RESOURCE_URIS) {
      const result = await client.readResource({ uri });
      assert.equal(result.contents.length, 1);
      assert.equal(result.contents[0]?.uri, uri);
    }
    const args: Readonly<Record<string, Record<string, string>>> = {
      "create-workflow": { objective: "Receive and validate an order webhook" },
      "debug-workflow": { workflowId: "workflow_1" },
      "optimize-workflow": { workflowId: "workflow_1" },
      "manage-credentials": { objective: "Create an API credential safely" },
    };
    for (const name of PROMPT_NAMES) {
      const result = await client.getPrompt({ name, arguments: args[name] });
      assert(result.messages.length > 0);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("offline node-documentation tools and resources preserve each official URL", async () => {
  const { client, server } = await connectedClient();
  try {
    for (const key of ["webhook", "code", "http-request", "if"] as const) {
      const document = NODE_DOCUMENTATION[key];
      assert.equal(isOfficialN8nDocumentationUrl(document.officialUrl), true);
      const tool = await client.callTool({ name: "n8n_get_node_docs", arguments: { node: key } });
      assert.equal(tool.isError, undefined);
      assert(tool.structuredContent && typeof tool.structuredContent === "object");
      const data = (tool.structuredContent as { data?: unknown }).data;
      assert(data && typeof data === "object" && !Array.isArray(data));
      assert.equal((data as { officialUrl?: unknown }).officialUrl, document.officialUrl);

      const resource = await client.readResource({ uri: `n8n://node-docs/${key}` });
      const content: unknown = resource.contents[0];
      assert(content && typeof content === "object" && !Array.isArray(content));
      const text = (content as Record<string, unknown>).text;
      assert(typeof text === "string");
      assert(text.endsWith(`Official documentation: ${document.officialUrl}`));
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("the compiled entry point negotiates and lists the exact inventory over real stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [".test-dist/src/index.js"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-contract-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const [tools, resources, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listPrompts(),
    ]);
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      EXPECTED_TOOLS,
    );
    assert.deepEqual(
      resources.resources.map((resource) => resource.uri),
      RESOURCE_URIS,
    );
    assert.deepEqual(
      prompts.prompts.map((prompt) => prompt.name),
      PROMPT_NAMES,
    );
  } finally {
    await client.close();
  }
});
