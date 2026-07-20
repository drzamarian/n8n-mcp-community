import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { NODE_DOCUMENTATION } from "../src/content/node-docs.js";
import { isOfficialN8nDocumentationUrl } from "../src/content/official-urls.js";
import { PROMPT_NAMES } from "../src/prompts.js";
import { RESOURCE_URIS } from "../src/resources.js";
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
      assert.equal(tool.annotations?.destructiveHint, definition.operation !== "read-only");
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

test("every confirming tool documents its exact confirmation phrase, derived without drift", async () => {
  const { client, server } = await connectedClient();
  try {
    const listed = await client.listTools();
    let confirmingTools = 0;
    for (const definition of TOOL_DEFINITIONS) {
      if (definition.confirmationPhrase === undefined) continue;
      confirmingTools += 1;
      const tool = listed.tools.find((candidate) => candidate.name === definition.name);
      assert(tool, `Missing listed tool ${definition.name}`);
      const field = (
        tool.inputSchema.properties as Record<string, { description?: string }> | undefined
      )?.confirmation;
      assert(field?.description, `${definition.name} confirmation field lacks a description`);
      // Discoverable: the exact required phrase template is present in the schema the client sees.
      assert(
        field.description.includes(definition.confirmationPhrase),
        `${definition.name} confirmation description "${field.description}" omits phrase "${definition.confirmationPhrase}"`,
      );
      // Never a trivial retry: the guard promises not to echo the phrase back on mismatch.
      assert.match(field.description, /without echoing the expected phrase/);
    }
    assert.equal(confirmingTools, 14, "expected exactly 14 confirmation-guarded tools");
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
