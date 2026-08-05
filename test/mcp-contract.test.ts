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
  n8n_workflows_list: /cursor resumes .* never auto-paginates/i,
  n8n_workflows_get: /excludePinnedData controls only .* presence reporting/i,
  n8n_workflows_create: /nodes and connections must describe one complete consistent graph/i,
  n8n_workflows_update:
    /expectedVersionId must match both pre-write reads.*supplied nodes .* replace/i,
  n8n_update_node: /path selects the mutable root whose contract validates value/i,
  n8n_workflows_delete: /no rollback or transfer/i,
  n8n_workflows_activate:
    /production triggers can accept future events.*does not execute it immediately/i,
  n8n_workflows_deactivate: /without deleting saved data or stopping executions already running/i,
  n8n_workflows_get_version: /Both returned IDs must match the selectors.*ambiguous 404/i,
  n8n_workflows_get_tags: /endpoint has no cursor.*at most 100.*exact omissions/i,
  n8n_workflows_update_tags: /tagIds is the entire desired set.*empty array clears all tags/i,
  n8n_workflows_archive: /availability change can disrupt callers/i,
  n8n_workflows_unarchive: /without activating its triggers.*active state is not inferred/i,
  n8n_workflows_diff: /Omitting toVersionId selects current.*ignoreLayout=true suppresses/i,
  n8n_executions_list: /status and workflowId filter upstream.*includeData only reports/i,
  n8n_executions_get: /includeData changes only.*never returns node inputs or outputs/i,
  n8n_executions_delete: /no recovery or rollback/i,
  n8n_executions_retry:
    /loadWorkflow=true uses the currently saved workflow.*false uses the original execution snapshot/i,
  n8n_executions_stop: /successful HTTP response alone does not prove cancellation/i,
  n8n_credentials_create: /type selects the schema .* isResolvable is sent only when supplied/i,
  n8n_credentials_delete: /usage across all pages first.*no secret or rollback/i,
  n8n_credentials_schema: /credentialType is a route selector, not a stored credential ID/i,
  n8n_credentials_list:
    /cursor resumes a prior page.*limit bounds that single request.*never auto-paginates/i,
  n8n_credentials_get: /credentialId identifies stored metadata only/i,
  n8n_credentials_update:
    /isPartialData=false treats data as replacement.*true requests a partial merge/i,
  n8n_credentials_test:
    /external service, which receives and may log the attempt.*network contact is unwanted/i,
  n8n_credentials_usage:
    /active filters upstream.*unresolved legacy references.*nextCursor is null/i,
  n8n_tags_list: /cursor resumes the prior page.*continue nextCursor until null/i,
  n8n_tags_get: /tagId identifies the reusable tag itself, not a workflow assignment/i,
  n8n_tags_create:
    /name must already be trimmed.*duplicate-name handling.*never changes any workflow assignment/i,
  n8n_tags_update: /tagId selects the existing record and name is its complete replacement/i,
  n8n_tags_delete: /remove that label from multiple workflows.*no rollback/i,
  n8n_users_list: /includeRole=true only asks n8n for roles.*cursor resumes.*never auto-paginates/i,
  n8n_users_get:
    /userIdOrEmail chooses ID lookup or an exact percent-encoded email lookup.*cannot guarantee role visibility/i,
  n8n_users_create: /role defaults to global:member.*pending user exists/i,
  n8n_users_delete:
    /userId accepts no transfer target.*ownership handling remains entirely with n8n/i,
  n8n_health:
    /one redirect-free same-origin .* 10-second timeout.*requires configured URL\/key values/i,
  n8n_insights_summary:
    /startDate and endDate are inclusive.*startDate <= endDate.*omitting both requests n8n's default range/i,
  n8n_audit_generate:
    /Omitting categories lets n8n choose its complete default.*daysAbandonedWorkflow changes only/i,
  n8n_search_workflows:
    /searchIn selects local fields after active filters upstream.*cursor and limit select one page/i,
  n8n_get_node_docs:
    /four-value node key.*no n8n URL, API key, network, or elevated mode.*never follows/i,
  n8n_list_node_types:
    /cursor selects the start, maxPages bounds continuation, and active filters upstream.*starting at the first page and reaching the end/i,
  n8n_introspect:
    /quick uses 24h\/20 and caps maxExecutions at 25.*deep uses 168h\/50.*includeSanitizedLabels=false/i,
  n8n_community_packages_list: /zero-input call retains at most 100.*exact total\/omitted counts/i,
};

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
// frozen by the normalized tools/list digest and remains a human/auditor judgment.
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
  if (!/\brequires?\b/i.test(observation.description)) {
    violations.push("authorization or configuration boundary");
  }
  if (!/\breturns?\b/i.test(observation.description)) violations.push("return semantics");

  return violations;
}

const APPROVED_TOOL_METADATA_SHA256 =
  "71b0e4ae040d27e9f15e842ad2552b5523fdd1443f6cd301c1873341389c9652";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
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
  const expectedNames = [...EXPECTED_TOOLS].sort();
  assert.deepEqual(matrixNames, expectedNames);
  assert.deepEqual(semanticNames, expectedNames);
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
    assert(
      toolDefinitionMatrixViolations(name, {
        ...validObservation,
        description: definition.description.replace(/\brequires?\b/giu, "needs"),
      }).includes("authorization or configuration boundary"),
      `${name} matrix did not reject removal of its authorization disclosure`,
    );
    assert(
      toolDefinitionMatrixViolations(name, {
        ...validObservation,
        description: definition.description.replace(/\breturns?\b/giu, "emits"),
      }).includes("return semantics"),
      `${name} matrix did not reject removal of its return disclosure`,
    );
  }
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
    const normalized = canonicalize(
      [...listed.tools]
        .sort((left, right) => left.name.localeCompare(right.name, "en-US"))
        .map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          outputSchema,
          annotations,
        })),
    );
    const actual = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    assert.equal(
      actual,
      APPROVED_TOOL_METADATA_SHA256,
      `tools/list metadata changed; review the semantic diff and approve this SHA-256: ${actual}`,
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
