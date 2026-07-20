import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OFFICIAL_N8N_DOCUMENTATION_URLS } from "../src/content/official-urls.js";
import { createServer } from "../src/server.js";
import { TOOL_DEFINITIONS } from "../src/tools/registry.js";

const ORIGIN = "https://n8n.example.test";
const OUTPUT_CANARY = "UNIT-CANARY-MUST-NOT-LEAK";

const node = {
  id: "node_1",
  name: "Webhook",
  type: "n8n-nodes-base.webhook",
  typeVersion: 2,
  position: [0, 0],
  parameters: { path: "orders", apiKey: OUTPUT_CANARY },
  credentials: { api: { id: "cred_1", name: "credential label" } },
};

const workflow = {
  id: "wf_1",
  versionId: "v2",
  name: "Order workflow",
  description: "Preserve this description",
  active: false,
  isArchived: false,
  nodes: [node],
  connections: {},
  settings: { executionOrder: "v1" },
  pinData: { Webhook: [{ json: { privateValue: OUTPUT_CANARY } }] },
  staticData: "opaque-static-data",
  nodeGroups: [{ name: "Ingress", nodeIds: ["node_1"] }],
};

const historicalWorkflow = {
  workflowId: "wf_1",
  versionId: "v1",
  name: null,
  nodes: [{ ...node, name: "Previous webhook", parameters: { path: "old-orders" } }],
  connections: {},
  authors: [],
};

interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly body: unknown | null;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function objectBody(value: unknown | null): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function plainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function createMockFetch(requests: CapturedRequest[]): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const rawBody = await request.clone().text();
    const body: unknown | null = rawBody === "" ? null : JSON.parse(rawBody);
    requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });
    assert.equal(url.origin, ORIGIN);
    assert.equal(request.headers.get("X-N8N-API-KEY"), "not-a-real-key");

    const path = url.pathname;
    const method = request.method;
    if (path === "/healthz") return json({ status: "ok" });
    if (path === "/api/v1/workflows" && method === "GET") {
      return json({ data: [workflow], nextCursor: null });
    }
    if (path === "/api/v1/workflows" && method === "POST") {
      return json({ ...workflow, ...objectBody(body) });
    }
    if (path === "/api/v1/workflows/wf_1/v1" && method === "GET") {
      return json(historicalWorkflow);
    }
    if (path === "/api/v1/workflows/wf_1" && method === "GET") return json(workflow);
    if (path === "/api/v1/workflows/wf_1" && method === "PUT") {
      return json({ ...workflow, ...objectBody(body), id: "wf_1", versionId: "v3" });
    }
    if (path === "/api/v1/workflows/wf_1" && method === "DELETE") return json({ id: "wf_1" });
    if (/^\/api\/v1\/workflows\/wf_1\/(?:activate|deactivate|archive|unarchive)$/.test(path)) {
      return json({
        ...workflow,
        active: path.endsWith("activate"),
        isArchived: path.endsWith("archive"),
      });
    }
    if (path === "/api/v1/workflows/wf_1/tags" && method === "GET") {
      return json([
        {
          id: "tag_1",
          name: "production",
          createdAt: "2026-07-17T12:00:00.000Z",
          updatedAt: "2026-07-17T12:00:01.000Z",
        },
      ]);
    }
    if (path === "/api/v1/workflows/wf_1/tags" && method === "PUT") {
      return json([{ id: "tag_1", name: "production" }]);
    }

    if (path === "/api/v1/executions" && method === "GET") {
      return json({
        data: [
          {
            id: "exec_1",
            status: "error",
            mode: "webhook",
            workflowId: "wf_1",
            startedAt: "2026-07-17T12:00:00.000Z",
            stoppedAt: "2026-07-17T12:00:01.000Z",
            data: { arbitrarySensitiveField: OUTPUT_CANARY },
          },
        ],
        nextCursor: null,
      });
    }
    if (path === "/api/v1/executions/exec_1" && method === "GET") {
      return json({
        id: "exec_1",
        status: "error",
        workflowId: "wf_1",
        data: { arbitrarySensitiveField: OUTPUT_CANARY },
      });
    }
    if (path === "/api/v1/executions/exec_1" && method === "DELETE") {
      return json({ id: "exec_1" });
    }
    if (path === "/api/v1/executions/exec_1/retry" && method === "POST") {
      return json({ id: "exec_2", status: "new", workflowId: "wf_1" });
    }
    if (path === "/api/v1/executions/exec_1/stop" && method === "POST") {
      return json({ status: "canceled", stoppedAt: "2026-07-17T12:00:02.000Z", mode: "webhook" });
    }

    if (path === "/api/v1/credentials/schema/n8nApi" && method === "GET") {
      return json({
        fields: [{ name: "apiKey", type: "string" }],
        properties: {
          apiKey: { type: "string", default: OUTPUT_CANARY },
          account: { type: "string" },
        },
      });
    }
    if (path === "/api/v1/credentials" && method === "GET") {
      return json({
        data: [{ id: "cred_1", name: "n8n API", type: "n8nApi" }],
        nextCursor: null,
      });
    }
    if (path === "/api/v1/credentials" && method === "POST") {
      return json({
        id: "cred_1",
        name: "n8n API",
        type: "n8nApi",
        data: { apiKey: OUTPUT_CANARY },
      });
    }
    if (path === "/api/v1/credentials/cred_1" && method === "GET") {
      return json({
        id: "cred_1",
        name: "n8n API",
        type: "n8nApi",
        data: { apiKey: OUTPUT_CANARY },
      });
    }
    if (path === "/api/v1/credentials/cred_1" && method === "PATCH") {
      return json({
        id: "cred_1",
        name: "Updated credential",
        type: "n8nApi",
        data: { apiKey: OUTPUT_CANARY },
      });
    }
    if (path === "/api/v1/credentials/cred_1" && method === "DELETE") {
      return json({ name: "deleted", data: { apiKey: OUTPUT_CANARY } });
    }
    if (path === "/api/v1/credentials/cred_1/test" && method === "POST") {
      return json({ status: "OK", message: "Connection succeeded" });
    }

    if (path === "/api/v1/tags" && method === "GET") {
      return json({
        data: [
          {
            id: "tag_1",
            name: "production",
            createdAt: "2026-07-17T12:00:00.000Z",
            updatedAt: "2026-07-17T12:00:01.000Z",
          },
        ],
        nextCursor: null,
      });
    }
    if (path === "/api/v1/tags" && method === "POST") {
      return json({ id: "tag_1", name: "production" });
    }
    if (path === "/api/v1/tags/tag_1" && method === "GET") {
      return json({ id: "tag_1", name: "production" });
    }
    if (path === "/api/v1/tags/tag_1" && method === "PUT") {
      return json({ id: "tag_1", name: "updated" });
    }
    if (path === "/api/v1/tags/tag_1" && method === "DELETE") return json({ id: "tag_1" });

    if (path === "/api/v1/users" && method === "GET") {
      return json({
        data: [
          {
            id: "user_1",
            email: "member@example.test",
            role: "global:member",
            isPending: false,
            createdAt: "2026-07-17T12:00:00.000Z",
            updatedAt: "2026-07-17T12:00:01.000Z",
          },
        ],
        nextCursor: null,
      });
    }
    if (path === "/api/v1/users" && method === "POST") {
      return json(
        [
          {
            user: {
              id: "user_2",
              email: "member@example.test",
              role: "global:member",
              emailSent: true,
            },
            error: "",
          },
        ],
        201,
      );
    }
    if (path === "/api/v1/users/user_1" && method === "GET") {
      return json({
        id: "user_1",
        email: "member@example.test",
        role: "global:member",
        isPending: false,
        createdAt: "2026-07-17T12:00:00.000Z",
        updatedAt: "2026-07-17T12:00:01.000Z",
      });
    }
    if (path === "/api/v1/users/user_1" && method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    if (path === "/api/v1/insights/summary") {
      return json({ total: {}, failed: {}, failureRate: {}, timeSaved: {}, averageRunTime: {} });
    }
    if (path === "/api/v1/audit" && method === "POST") return json({ risk: [] });
    if (path === "/api/v1/community-packages" && method === "GET") {
      return json([
        {
          packageName: "n8n-nodes-example",
          installedVersion: "1.0.0",
          authorEmail: "author@example.test",
        },
      ]);
    }
    return json({ message: "No fixture" }, 404);
  };
}

const CALLS: Readonly<Record<string, Record<string, unknown>>> = {
  n8n_workflows_list: {},
  n8n_workflows_get: { workflowId: "wf_1" },
  n8n_workflows_create: {
    name: "Created",
    description: "Created through MCP",
    nodes: [node],
    connections: {},
    settings: { executionOrder: "v1" },
    nodeGroups: [{ name: "Ingress", nodeIds: ["node_1"] }],
    staticData: "created-static-data",
    pinData: { Webhook: [{ json: { privateValue: OUTPUT_CANARY } }] },
  },
  n8n_workflows_update: { workflowId: "wf_1", expectedVersionId: "v2", name: "Updated" },
  n8n_update_node: {
    workflowId: "wf_1",
    nodeId: "node_1",
    path: "parameters.path",
    value: "new-orders",
    expectedVersionId: "v2",
    acknowledgeNonAtomicRisk: true,
  },
  n8n_workflows_delete: { workflowId: "wf_1", confirmation: "DELETE wf_1" },
  n8n_workflows_activate: { workflowId: "wf_1", confirmation: "ACTIVATE wf_1" },
  n8n_workflows_deactivate: { workflowId: "wf_1", confirmation: "DEACTIVATE wf_1" },
  n8n_workflows_get_version: { workflowId: "wf_1", versionId: "v1" },
  n8n_workflows_get_tags: { workflowId: "wf_1" },
  n8n_workflows_update_tags: { workflowId: "wf_1", tagIds: ["tag_1"] },
  n8n_workflows_archive: { workflowId: "wf_1", confirmation: "ARCHIVE wf_1" },
  n8n_workflows_unarchive: { workflowId: "wf_1", confirmation: "UNARCHIVE wf_1" },
  n8n_workflows_diff: { workflowId: "wf_1", fromVersionId: "v1" },
  n8n_executions_list: { includeData: true },
  n8n_executions_get: { executionId: "exec_1", includeData: true },
  n8n_executions_delete: { executionId: "exec_1", confirmation: "DELETE exec_1" },
  n8n_executions_retry: { executionId: "exec_1", confirmation: "RETRY exec_1" },
  n8n_executions_stop: { executionId: "exec_1", confirmation: "STOP exec_1" },
  n8n_credentials_create: {
    name: "n8n API",
    type: "n8nApi",
    data: { apiKey: OUTPUT_CANARY },
    isResolvable: true,
  },
  n8n_credentials_delete: { credentialId: "cred_1", confirmation: "DELETE cred_1" },
  n8n_credentials_schema: { credentialType: "n8nApi" },
  n8n_credentials_list: {},
  n8n_credentials_get: { credentialId: "cred_1" },
  n8n_credentials_update: {
    credentialId: "cred_1",
    name: "Updated credential",
    isGlobal: false,
    isResolvable: true,
    isPartialData: false,
  },
  n8n_credentials_test: { credentialId: "cred_1", confirmation: "TEST cred_1" },
  n8n_credentials_usage: { credentialId: "cred_1" },
  n8n_tags_list: {},
  n8n_tags_get: { tagId: "tag_1" },
  n8n_tags_create: { name: "production" },
  n8n_tags_update: { tagId: "tag_1", name: "updated" },
  n8n_tags_delete: { tagId: "tag_1", confirmation: "DELETE tag_1" },
  n8n_users_list: {},
  n8n_users_get: { userIdOrEmail: "user_1" },
  n8n_users_create: { email: "member@example.test", confirmation: "INVITE member@example.test" },
  n8n_users_delete: { userId: "user_1", confirmation: "DELETE user_1" },
  n8n_health: {},
  n8n_insights_summary: {
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-17T23:59:59.000Z",
  },
  n8n_audit_generate: {
    categories: ["credentials", "nodes"],
    daysAbandonedWorkflow: 30,
    confirmation: "GENERATE AUDIT",
  },
  n8n_search_workflows: { query: "order", searchIn: ["name"] },
  n8n_get_node_docs: { node: "webhook" },
  n8n_list_node_types: { maxPages: 1 },
  n8n_introspect: { workflowId: "wf_1", profile: "quick" },
  n8n_community_packages_list: {},
};

test("Community-only schemas reject paid project selectors", () => {
  for (const name of [
    "n8n_workflows_list",
    "n8n_workflows_create",
    "n8n_executions_list",
    "n8n_credentials_create",
    "n8n_users_list",
    "n8n_insights_summary",
  ]) {
    const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    assert(definition, `Missing tool definition ${name}`);
    assert.throws(
      () => definition.validateInput({ ...CALLS[name], projectId: "project_1" }),
      `${name} must reject the paid project selector`,
    );
  }
});

test("the Introspect registration exactly matches its approved public contract", () => {
  const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === "n8n_introspect");
  assert(definition);
  assert.equal(definition.title, "Inspect n8n workflow");
  assert.equal(
    definition.description,
    "Inspect one workflow and a bounded sample of its saved executions; return deterministic findings and factual metrics; do not execute the workflow or replace the instance security audit.",
  );
});

test("registered Introspect preserves trusted finding metadata end to end", async () => {
  const cases = [
    {
      ruleId: "CONTRACT_WEBHOOK_RESPONSE_MISSING",
      documentationUrl: OFFICIAL_N8N_DOCUMENTATION_URLS.webhook,
      nodes: [
        {
          ...node,
          parameters: { path: "orders", responseMode: "responseNode" },
        },
      ],
      connections: {},
    },
    {
      ruleId: "GRAPH_CYCLE_WITHOUT_KNOWN_CONTROL",
      documentationUrl: OFFICIAL_N8N_DOCUMENTATION_URLS.splitInBatches,
      nodes: [
        {
          id: "node_a",
          name: "Node A",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: "node_b",
          name: "Node B",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [200, 0],
          parameters: {},
        },
      ],
      connections: {
        "Node A": { main: [[{ node: "Node B", type: "main", index: 0 }]] },
        "Node B": { main: [[{ node: "Node A", type: "main", index: 0 }]] },
      },
    },
  ] as const;

  for (const fixture of cases) {
    await withConnectedClient(
      async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/workflows/wf_1") {
          return json({
            ...workflow,
            nodes: fixture.nodes,
            connections: fixture.connections,
            pinData: undefined,
          });
        }
        if (url.pathname === "/api/v1/executions") {
          return json({ data: [], nextCursor: null });
        }
        return json({ message: "No fixture" }, 404);
      },
      async (client) => {
        const result = await client.callTool({
          name: "n8n_introspect",
          arguments: { workflowId: "wf_1", profile: "quick" },
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        const structured = objectBody(result.structuredContent ?? null);
        assert(Array.isArray(structured.findings));
        const findings = structured.findings as unknown[];
        const finding = findings.find(
          (candidate): candidate is Record<string, unknown> =>
            candidate !== null &&
            typeof candidate === "object" &&
            !Array.isArray(candidate) &&
            (candidate as Record<string, unknown>).ruleId === fixture.ruleId,
        );
        assert(finding, fixture.ruleId);
        assert.equal(finding.documentationUrl, fixture.documentationUrl);
      },
    );
  }
});

test("registered Introspect preserves distinct literal-secret finding IDs", async () => {
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/workflows/wf_1") {
        return json({
          ...workflow,
          nodes: [
            {
              id: "node_a",
              name: "Node A",
              type: "n8n-nodes-base.noOp",
              typeVersion: 1,
              position: [0, 0],
              parameters: { apiKey: "literal-one" },
            },
            {
              id: "node_b",
              name: "Node B",
              type: "n8n-nodes-base.noOp",
              typeVersion: 1,
              position: [200, 0],
              parameters: { password: "literal-two" },
            },
          ],
          connections: {},
          pinData: undefined,
        });
      }
      if (url.pathname === "/api/v1/executions") {
        return json({ data: [], nextCursor: null });
      }
      return json({ message: "No fixture" }, 404);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_introspect",
        arguments: { workflowId: "wf_1", profile: "quick" },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const structured = objectBody(result.structuredContent ?? null);
      assert(Array.isArray(structured.findings));
      const findings = structured.findings as unknown[];
      const ids = findings
        .filter(
          (candidate): candidate is Record<string, unknown> =>
            candidate !== null &&
            typeof candidate === "object" &&
            !Array.isArray(candidate) &&
            (candidate as Record<string, unknown>).ruleId === "PRIVACY_LITERAL_SECRET",
        )
        .map((finding) => finding.id);
      assert.deepEqual(ids, ["PRIVACY_LITERAL_SECRET:node-1", "PRIVACY_LITERAL_SECRET:node-2"]);
    },
  );
});

test("registered Introspect preserves a long workflow finding identity", async () => {
  const workflowId = "w".repeat(48);
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === `/api/v1/workflows/${workflowId}`) {
        return json({
          ...workflow,
          id: workflowId,
          active: true,
          triggerCount: 0,
          nodes: [{ ...node, type: "n8n-nodes-base.noOp", parameters: {} }],
          connections: {},
          pinData: undefined,
        });
      }
      if (url.pathname === "/api/v1/executions") {
        return json({ data: [], nextCursor: null });
      }
      return json({ message: "No fixture" }, 404);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_introspect",
        arguments: { workflowId, profile: "quick" },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const structured = objectBody(result.structuredContent ?? null);
      assert(Array.isArray(structured.findings));
      const finding = (structured.findings as unknown[]).find(
        (candidate): candidate is Record<string, unknown> =>
          candidate !== null &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          (candidate as Record<string, unknown>).ruleId === "WORKFLOW_ACTIVE_WITHOUT_TRIGGER",
      );
      assert(finding);
      assert.equal(finding.id, `WORKFLOW_ACTIVE_WITHOUT_TRIGGER:${workflowId}`);
      const affectedEntity = objectBody(finding.affectedEntity ?? null);
      assert.equal(affectedEntity.key, workflowId);
      const reportedWorkflow = objectBody(structured.workflow ?? null);
      assert.equal(reportedWorkflow.id, workflowId);
    },
  );
});

test("registered Introspect preserves a hashed workflow finding identity", async () => {
  const workflowId = "w".repeat(121);
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === `/api/v1/workflows/${workflowId}`) {
        return json({
          ...workflow,
          id: workflowId,
          nodes: [
            {
              id: "node_a",
              name: "Node A",
              type: "n8n-nodes-base.noOp",
              typeVersion: 1,
              position: [0, 0],
              parameters: {},
            },
            {
              id: "node_b",
              name: "Node B",
              type: "n8n-nodes-base.noOp",
              typeVersion: 1,
              position: [200, 0],
              parameters: {},
            },
          ],
          connections: {
            "Node A": { main: [[{ node: "Node B", type: "main", index: 0 }]] },
            "Node B": { main: [[{ node: "Node A", type: "main", index: 0 }]] },
          },
          pinData: undefined,
        });
      }
      if (url.pathname === "/api/v1/executions") {
        return json({ data: [], nextCursor: null });
      }
      return json({ message: "No fixture" }, 404);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_introspect",
        arguments: { workflowId, profile: "quick" },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const structured = objectBody(result.structuredContent ?? null);
      assert(Array.isArray(structured.findings));
      const finding = (structured.findings as unknown[]).find(
        (candidate): candidate is Record<string, unknown> =>
          candidate !== null &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          (candidate as Record<string, unknown>).ruleId === "GRAPH_CYCLE_WITHOUT_KNOWN_CONTROL",
      );
      assert(finding);
      const affectedEntity = objectBody(finding.affectedEntity ?? null);
      const entityKey = affectedEntity.key;
      const ruleId = finding.ruleId;
      assert(typeof entityKey === "string");
      assert(typeof ruleId === "string");
      assert.equal(entityKey.length, 128);
      assert.match(entityKey, /^[A-Za-z0-9_-]{128}$/);
      assert.equal(finding.id, `${ruleId}:${entityKey}`);
      assert.doesNotMatch(JSON.stringify(finding), /\[TOKEN\]/);
    },
  );
});

test("nine read-only tools reject malformed input before any upstream request", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(createMockFetch(requests), async (client) => {
    const invalidCalls: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["n8n_workflows_get", { workflowId: "../workflow" }],
      ["n8n_workflows_get_tags", { workflowId: "../workflow" }],
      ["n8n_executions_get", { executionId: "../execution" }],
      ["n8n_credentials_get", { credentialId: "../credential" }],
      ["n8n_tags_get", { tagId: "../tag" }],
      ["n8n_users_get", { userIdOrEmail: "not a valid lookup" }],
      ["n8n_health", { unexpected: true }],
      ["n8n_get_node_docs", { node: "unknown" }],
      ["n8n_community_packages_list", { unexpected: true }],
    ];
    for (const [name, arguments_] of invalidCalls) {
      const result = await client.callTool({ name, arguments: arguments_ });
      assert.equal(result.isError, true, `${name} should reject malformed input`);
      const serialized = JSON.stringify(result);
      assert.match(serialized, /MCP error -32602/);
      assert.equal(serialized.includes("../"), false);
    }
    assert.equal(requests.length, 0);
  });
});

test("introspect rejects a local input-rule violation as invalid_input, not an upstream mismatch", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(createMockFetch(requests), async (client) => {
    // The quick profile caps executions at 25; the SDK per-field schema admits maxExecutions
    // up to 100, so this cross-field rule is enforced locally in the handler before any request.
    const result = await client.callTool({
      name: "n8n_introspect",
      arguments: { workflowId: "wf_1", profile: "quick", maxExecutions: 50 },
    });
    assert.equal(result.isError, true);
    const serialized = JSON.stringify(result);
    assert.match(serialized, /invalid_input/);
    assert.equal(serialized.includes("upstream_shape_mismatch"), false);
    assert.equal(requests.length, 0);
  });
});

test("read-only tools reject malformed upstream data or prove no untrusted body exists", async () => {
  const responseCases: ReadonlyArray<readonly [string, Record<string, unknown>, unknown]> = [
    ["n8n_workflows_get", { workflowId: "wf_1" }, { ...workflow, nodes: "invalid" }],
    ["n8n_workflows_get_tags", { workflowId: "wf_1" }, { data: [] }],
    ["n8n_executions_get", { executionId: "exec_1" }, { id: {}, status: 1 }],
    [
      "n8n_credentials_get",
      { credentialId: "cred_1" },
      { id: "cred_1", name: "", type: "httpHeaderAuth" },
    ],
    ["n8n_tags_get", { tagId: "tag_1" }, { id: "tag_1", name: "tag", extra: true }],
    ["n8n_users_get", { userIdOrEmail: "user_1" }, { id: {} }],
    ["n8n_community_packages_list", {}, [{ packageName: 42 }]],
  ];
  for (const [name, arguments_, payload] of responseCases) {
    let requests = 0;
    await withConnectedClient(
      async () => {
        requests += 1;
        return json(payload);
      },
      async (client) => {
        const result = await client.callTool({ name, arguments: arguments_ });
        assert.equal(result.isError, true, `${name} should reject malformed upstream data`);
        assert.match(JSON.stringify(result), /upstream_shape_mismatch/);
      },
    );
    assert.equal(requests, 1);
  }

  let healthRequests = 0;
  await withConnectedClient(
    async () => {
      healthRequests += 1;
      return new Response(null, { status: 204 });
    },
    async (client) => {
      const result = await client.callTool({ name: "n8n_health", arguments: {} });
      assert.equal(result.isError, undefined);
      const envelope = objectBody(result.structuredContent ?? null);
      assert.deepEqual(plainJson(envelope.data), { ok: true, status: 204 });
    },
  );
  assert.equal(healthRequests, 1, "health validates transport status, not an untrusted body");

  let offlineRequests = 0;
  await withConnectedClient(
    async () => {
      offlineRequests += 1;
      throw new Error("The offline documentation tool attempted a request.");
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_get_node_docs",
        arguments: { node: "webhook" },
      });
      assert.equal(result.isError, undefined);
    },
  );
  assert.equal(offlineRequests, 0);
});

test("hostile upstream errors remain fixed and secret-free through the MCP tool surface", async () => {
  const hostile = `${OUTPUT_CANARY} Basic dXNlcjpzZWNyZXQ= api_key=hostile-secret`;
  await withConnectedClient(
    async () => new Response(hostile, { status: 500 }),
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_get",
        arguments: { workflowId: "wf_1" },
      });
      const serialized = JSON.stringify(result);
      assert.equal(result.isError, true);
      assert.match(serialized, /upstream_error/);
      assert.equal(serialized.includes(OUTPUT_CANARY), false);
      assert.equal(serialized.includes("hostile-secret"), false);
      assert.equal(serialized.includes("dXNlcjpzZWNyZXQ"), false);
      assert.equal(serialized.includes("not-a-real-key"), false);
    },
  );
});

test("workflow output redacts realistic query and authorization secrets end to end", async () => {
  const googleKey = ["AI", "za", "SyD1234567890", "AbCdEfGhIjKlMnOpQrStUv"].join("");
  const stripeKey = ["sk", "_live_", "51H8x2kJ9mQ0", "123456789LpAbCdEf"].join("");
  const shortSecret = "Q".repeat(32);
  const payload = {
    ...workflow,
    nodes: [
      {
        ...node,
        parameters: {
          url: `https://api.example.test/v1?key=${googleKey}`,
          stripe: stripeKey,
          encoded: JSON.stringify({ api_key: shortSecret }),
          password: `pwd=${shortSecret}`,
          authorization: `Basic:${Buffer.from(`user:${shortSecret}`).toString("base64")}`,
        },
      },
    ],
  };
  await withConnectedClient(
    async () => json(payload),
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_get",
        arguments: { workflowId: "wf_1" },
      });
      const serialized = JSON.stringify(result);
      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as { redacted?: unknown }).redacted, true);
      for (const prohibited of [googleKey, stripeKey, shortSecret, "AbCdEfGhIjKlMnOpQrStUv"]) {
        assert.equal(serialized.includes(prohibited), false);
      }
    },
  );
});

test("collection tools reject paginated overflow and truncate unpaginated arrays explicitly", async () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, unknown]> = [
    [
      "n8n_workflows_get_tags",
      { workflowId: "wf_1" },
      Array.from({ length: 101 }, (_, index) => ({ id: `tag_${index}`, name: "tag" })),
    ],
    [
      "n8n_tags_list",
      {},
      {
        data: Array.from({ length: 101 }, (_, index) => ({ id: `tag_${index}`, name: "tag" })),
        nextCursor: null,
      },
    ],
    [
      "n8n_users_list",
      {},
      {
        data: Array.from({ length: 101 }, (_, index) => ({ id: `user_${index}` })),
        nextCursor: null,
      },
    ],
    [
      "n8n_credentials_list",
      {},
      {
        data: Array.from({ length: 101 }, (_, index) => ({
          id: `cred_${index}`,
          name: "Credential",
          type: "httpHeaderAuth",
        })),
        nextCursor: null,
      },
    ],
    [
      "n8n_community_packages_list",
      {},
      Array.from({ length: 101 }, (_, index) => ({ packageName: `package-${index}` })),
    ],
  ];
  for (const [name, arguments_, payload] of cases) {
    await withConnectedClient(
      async () => json(payload),
      async (client) => {
        const result = await client.callTool({ name, arguments: arguments_ });
        if (name === "n8n_workflows_get_tags" || name === "n8n_community_packages_list") {
          assert.equal(result.isError, undefined, `${name} should retain a bounded prefix`);
          const structured = objectBody(result.structuredContent ?? null);
          const data = objectBody(structured.data ?? null);
          assert.equal(data.totalCount, 101);
          assert.equal(data.truncated, true);
          assert.equal(data.omittedCount, 1);
          assert(Array.isArray(data.data));
          assert.equal(data.data.length, 100);
        } else {
          assert.equal(result.isError, true, `${name} should reject paginated overflow`);
          assert.match(JSON.stringify(result), /upstream_shape_mismatch/);
        }
      },
    );
  }
});

test("workflow update fails closed on pathologically deep upstream data without a PUT", async () => {
  // A trusted-but-deeply-nested server response must not reach structuredClone/canonicalize and
  // overflow the stack; it fails closed with a bounded error and issues zero writes.
  let deep: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < 400; i += 1) deep = { nested: deep };
  const deepWorkflow = { ...workflow, settings: deep };
  const requests: CapturedRequest[] = [];
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        body: null,
      });
      if (request.method === "GET" && url.pathname === "/api/v1/workflows/wf_1") {
        return json(deepWorkflow);
      }
      throw new Error(`unexpected request ${request.method} ${url.pathname}`);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_update",
        arguments: { workflowId: "wf_1", expectedVersionId: "v2", name: "Renamed" },
      });
      assert.equal(result.isError, true);
      const serialized = JSON.stringify(result);
      assert.match(serialized, /nested more deeply than the safe processing limit/);
      assert.equal(serialized.includes("upstream_shape_mismatch"), false);
      assert.equal(
        requests.some((entry) => entry.method === "PUT"),
        false,
      );
    },
  );
});

test("workflow update tolerates n8n returning pinData:null when the source omitted pinned data", async () => {
  // The pre-write GET omits pinData/staticData (undefined); n8n's PUT response reports that
  // absent data as null. Both mean "no data", so a successful update must not trip the
  // sensitive-data preservation alarm.
  const sourceWorkflow = {
    id: "wf_1",
    versionId: "v2",
    name: "Order workflow",
    active: false,
    isArchived: false,
    nodes: [node],
    connections: {},
    settings: { executionOrder: "v1" },
  };
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const rawBody = await request.clone().text();
      const body = rawBody === "" ? null : (JSON.parse(rawBody) as unknown);
      if (url.pathname === "/api/v1/workflows/wf_1" && request.method === "GET") {
        return json(sourceWorkflow);
      }
      if (url.pathname === "/api/v1/workflows/wf_1" && request.method === "PUT") {
        return json({
          ...sourceWorkflow,
          ...objectBody(body),
          id: "wf_1",
          versionId: "v3",
          pinData: null,
          staticData: null,
        });
      }
      return json({ message: "No fixture" }, 404);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_update",
        arguments: { workflowId: "wf_1", expectedVersionId: "v2", name: "Renamed" },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
    },
  );
});

test("workflow update still fails closed when n8n adds pinned data the source did not carry", async () => {
  // Control: undefined -> actual data is a real, silent data change and must still throw the
  // sensitive-data preservation alarm, proving the nullish normalization did not over-relax.
  const sourceWorkflow = {
    id: "wf_1",
    versionId: "v2",
    name: "Order workflow",
    active: false,
    isArchived: false,
    nodes: [node],
    connections: {},
    settings: { executionOrder: "v1" },
  };
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const rawBody = await request.clone().text();
      const body = rawBody === "" ? null : (JSON.parse(rawBody) as unknown);
      if (url.pathname === "/api/v1/workflows/wf_1" && request.method === "GET") {
        return json(sourceWorkflow);
      }
      if (url.pathname === "/api/v1/workflows/wf_1" && request.method === "PUT") {
        return json({
          ...sourceWorkflow,
          ...objectBody(body),
          id: "wf_1",
          versionId: "v3",
          pinData: { Webhook: [{ json: { injected: OUTPUT_CANARY } }] },
        });
      }
      return json({ message: "No fixture" }, 404);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_update",
        arguments: { workflowId: "wf_1", expectedVersionId: "v2", name: "Renamed" },
      });
      assert.equal(result.isError, true);
      const serialized = JSON.stringify(result);
      assert.match(serialized, /did not preserve pinned or static workflow data/);
      assert.equal(serialized.includes(OUTPUT_CANARY), false);
    },
  );
});

async function connect(mode: "read-only" | "unsafe") {
  const server = createServer({ mode, allowInsecureHttp: false });
  const client = new Client({ name: "tool-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

async function withConnectedClient(
  mockFetch: typeof fetch,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.N8N_API_URL;
  const originalKey = process.env.N8N_API_KEY;
  const originalLog = console.error;
  globalThis.fetch = mockFetch;
  process.env.N8N_API_URL = ORIGIN;
  process.env.N8N_API_KEY = "not-a-real-key";
  console.error = () => undefined;
  const { client, server } = await connect("unsafe");
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    console.error = originalLog;
    if (originalUrl === undefined) delete process.env.N8N_API_URL;
    else process.env.N8N_API_URL = originalUrl;
    if (originalKey === undefined) delete process.env.N8N_API_KEY;
    else process.env.N8N_API_KEY = originalKey;
  }
}

test("all 44 tools complete their positive MCP contract against a bounded Public API fixture", async () => {
  const requests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.N8N_API_URL;
  const originalKey = process.env.N8N_API_KEY;
  const originalLog = console.error;
  const securityLogs: string[] = [];
  const results = new Map<string, unknown>();
  globalThis.fetch = createMockFetch(requests);
  process.env.N8N_API_URL = ORIGIN;
  process.env.N8N_API_KEY = "not-a-real-key";
  console.error = (...values: unknown[]) => securityLogs.push(values.map(String).join(" "));
  const { client, server } = await connect("unsafe");
  try {
    for (const definition of TOOL_DEFINITIONS) {
      const args = CALLS[definition.name];
      assert(args, `Missing positive fixture for ${definition.name}`);
      const result = await client.callTool({ name: definition.name, arguments: args });
      assert.equal(
        result.isError,
        undefined,
        `${definition.name} failed: ${JSON.stringify(result)}`,
      );
      const structured = result.structuredContent;
      assert(structured && typeof structured === "object");
      const structuredRecord = objectBody(structured);
      if (definition.name === "n8n_introspect") {
        assert.equal(structuredRecord.schemaVersion, "1.0.0");
        assert.equal(structuredRecord.engineVersion, "2.0.0");
        const content = result.content;
        assert(Array.isArray(content));
        assert.equal(content.length, 2);
        const summaryBlock = objectBody(content[0] ?? null);
        const jsonBlock = objectBody(content[1] ?? null);
        assert.equal(summaryBlock.type, "text");
        assert.equal(jsonBlock.type, "text");
        assert(typeof summaryBlock.text === "string");
        assert(typeof jsonBlock.text === "string");
        assert.match(summaryBlock.text, /^n8n workflow Introspect (?:complete|partial):/);
        assert.deepEqual(JSON.parse(jsonBlock.text) as unknown, structuredRecord);
        results.set(definition.name, structuredRecord);
      } else {
        assert("data" in structuredRecord);
        results.set(definition.name, structuredRecord.data);
      }
      const serialized = JSON.stringify(result);
      assert(!serialized.includes(OUTPUT_CANARY), `${definition.name} leaked a canary`);
      assert(!serialized.includes("not-a-real-key"), `${definition.name} leaked the API key`);
    }
    assert.equal(
      requests.some((request) => request.pathname.startsWith("/rest/")),
      false,
    );
    assert.equal(
      requests.some((request) => request.pathname.includes("nodes.json")),
      false,
    );
    assert.equal(
      requests.every(
        (request) => request.pathname === "/healthz" || request.pathname.startsWith("/api/v1/"),
      ),
      true,
    );
    assert.equal(
      securityLogs.every(
        (line) => !line.includes(OUTPUT_CANARY) && !line.includes("not-a-real-key"),
      ),
      true,
    );

    const executionList = requests.find(
      (request) => request.pathname === "/api/v1/executions" && request.method === "GET",
    );
    assert(executionList);
    assert.equal(new URLSearchParams(executionList.search).get("includeData"), "true");
    assert.equal(new URLSearchParams(executionList.search).get("redactExecutionData"), "true");
    const executionGet = requests.find(
      (request) => request.pathname === "/api/v1/executions/exec_1" && request.method === "GET",
    );
    assert(executionGet);
    assert.equal(new URLSearchParams(executionGet.search).get("includeData"), "true");
    assert.equal(new URLSearchParams(executionGet.search).get("redactExecutionData"), "true");

    const audit = requests.find(
      (request) => request.pathname === "/api/v1/audit" && request.method === "POST",
    );
    assert(audit);
    const auditDefinition = TOOL_DEFINITIONS.find(
      (definition) => definition.name === "n8n_audit_generate",
    );
    assert.equal(auditDefinition?.operation, "unsafe");
    assert.equal(auditDefinition.annotations.readOnlyHint, false);
    assert.equal(auditDefinition.annotations.destructiveHint, true);
    assert.deepEqual(audit.body, {
      additionalOptions: {
        categories: ["credentials", "nodes"],
        daysAbandonedWorkflow: 30,
      },
    });
    const insights = requests.find((request) => request.pathname === "/api/v1/insights/summary");
    assert(insights);
    const insightsQuery = new URLSearchParams(insights.search);
    assert.equal(insightsQuery.get("startDate"), "2026-07-01T00:00:00.000Z");
    assert.equal(insightsQuery.get("endDate"), "2026-07-17T23:59:59.000Z");
    assert.equal(insightsQuery.has("projectId"), false);

    const userDelete = requests.find(
      (request) => request.pathname === "/api/v1/users/user_1" && request.method === "DELETE",
    );
    assert(userDelete);
    assert.equal(userDelete.search, "");
    assert.equal(userDelete.body, null);

    const workflowCreate = requests.find(
      (request) => request.pathname === "/api/v1/workflows" && request.method === "POST",
    );
    assert(workflowCreate);
    assert.deepEqual(workflowCreate.body, CALLS.n8n_workflows_create);
    const workflowUpdate = requests.find(
      (request) =>
        request.pathname === "/api/v1/workflows/wf_1" &&
        request.method === "PUT" &&
        typeof request.body === "object" &&
        request.body !== null &&
        "name" in request.body &&
        request.body.name === "Updated",
    );
    assert(workflowUpdate);
    assert.deepEqual(workflowUpdate.body, {
      name: "Updated",
      description: workflow.description,
      nodes: workflow.nodes,
      connections: workflow.connections,
      settings: workflow.settings,
      pinData: workflow.pinData,
      staticData: workflow.staticData,
      nodeGroups: workflow.nodeGroups,
    });
    const nodeUpdate = requests.find(
      (request) =>
        request.pathname === "/api/v1/workflows/wf_1" &&
        request.method === "PUT" &&
        typeof request.body === "object" &&
        request.body !== null &&
        "name" in request.body &&
        request.body.name === workflow.name,
    );
    assert(nodeUpdate);
    assert.deepEqual(nodeUpdate.body, {
      name: workflow.name,
      description: workflow.description,
      nodes: [{ ...node, parameters: { ...node.parameters, path: "new-orders" } }],
      connections: workflow.connections,
      settings: workflow.settings,
      pinData: workflow.pinData,
      staticData: workflow.staticData,
      nodeGroups: workflow.nodeGroups,
    });

    const credentialCreate = requests.find(
      (request) => request.pathname === "/api/v1/credentials" && request.method === "POST",
    );
    assert(credentialCreate);
    assert.deepEqual(credentialCreate.body, CALLS.n8n_credentials_create);
    const credentialUpdate = requests.find(
      (request) => request.pathname === "/api/v1/credentials/cred_1" && request.method === "PATCH",
    );
    assert(credentialUpdate);
    assert.deepEqual(credentialUpdate.body, {
      name: "Updated credential",
      isGlobal: false,
      isResolvable: true,
      isPartialData: false,
    });

    assert.deepEqual(plainJson(results.get("n8n_executions_stop")), {
      executionId: "exec_1",
      stopped: true,
      state: "stopped",
      status: "canceled",
      stoppedAt: "2026-07-17T12:00:02.000Z",
    });
    assert.deepEqual(plainJson(results.get("n8n_credentials_delete")), {
      credentialId: "cred_1",
      deleted: true,
    });
    assert.deepEqual(plainJson(results.get("n8n_users_delete")), {
      userId: "user_1",
      deleted: true,
    });

    const diff = results.get("n8n_workflows_diff");
    assert(diff && typeof diff === "object" && "comparisonCoverage" in diff);
    assert.deepEqual(plainJson(diff.comparisonCoverage), {
      name: "unavailable_in_snapshot",
      nodes: "compared",
      connections: "compared",
      description: "unavailable_historical_api",
      settings: "unavailable_historical_api",
      pinData: "unavailable_historical_api",
      staticData: "unavailable_historical_api",
      nodeGroups: "unavailable_historical_api",
    });
    assert.equal(
      requests.filter(
        (request) =>
          request.pathname === "/api/v1/workflows/wf_1/v1" ||
          (request.pathname === "/api/v1/workflows/wf_1" && request.method === "GET"),
      ).length >= 2,
      true,
    );
    const historical = results.get("n8n_workflows_get_version");
    assert(historical && typeof historical === "object" && !Array.isArray(historical));
    assert.equal(Object.hasOwn(historical, "name"), false);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    console.error = originalLog;
    if (originalUrl === undefined) delete process.env.N8N_API_URL;
    else process.env.N8N_API_URL = originalUrl;
    if (originalKey === undefined) delete process.env.N8N_API_KEY;
    else process.env.N8N_API_KEY = originalKey;
  }
});

test("workflow responses normalize a null description to an omitted optional field", async () => {
  const requests: CapturedRequest[] = [];
  const baseFetch = createMockFetch(requests);
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/workflows" && request.method === "POST") {
        requests.push({
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          body: JSON.parse(await request.clone().text()) as unknown,
        });
        return json({ ...workflow, name: "Created without description", description: null });
      }
      return baseFetch(request);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_create",
        arguments: {
          name: "Created without description",
          nodes: [node],
          connections: {},
          settings: { executionOrder: "v1" },
        },
      });
      assert.equal(result.isError, undefined);
      const structured = result.structuredContent;
      assert(structured && typeof structured === "object" && "data" in structured);
      const data = objectBody(structured.data ?? null);
      assert.equal(Object.hasOwn(data, "description"), false);
    },
  );
});

test("read-only mode denies every write and unsafe tool before any network request", async () => {
  const requests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.N8N_API_URL;
  const originalKey = process.env.N8N_API_KEY;
  const originalLog = console.error;
  globalThis.fetch = createMockFetch(requests);
  process.env.N8N_API_URL = ORIGIN;
  process.env.N8N_API_KEY = "not-a-real-key";
  console.error = () => undefined;
  const { client, server } = await connect("read-only");
  try {
    for (const definition of TOOL_DEFINITIONS.filter((tool) => tool.operation !== "read-only")) {
      const result = await client.callTool({
        name: definition.name,
        arguments: CALLS[definition.name],
      });
      assert.equal(result.isError, true, `${definition.name} should be denied`);
    }
    assert.equal(requests.length, 0);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    console.error = originalLog;
    if (originalUrl === undefined) delete process.env.N8N_API_URL;
    else process.env.N8N_API_URL = originalUrl;
    if (originalKey === undefined) delete process.env.N8N_API_KEY;
    else process.env.N8N_API_KEY = originalKey;
  }
});

test("adversarial node paths and identical diff selectors fail before any request", async () => {
  const requests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.N8N_API_URL;
  const originalKey = process.env.N8N_API_KEY;
  const originalLog = console.error;
  globalThis.fetch = createMockFetch(requests);
  process.env.N8N_API_URL = ORIGIN;
  process.env.N8N_API_KEY = "not-a-real-key";
  console.error = () => undefined;
  const { client, server } = await connect("unsafe");
  try {
    for (const path of [
      "parameters.__proto__.polluted",
      "parameters.constructor.polluted",
      "parameters.items.1001",
      "parameters.items.01",
      "position.2",
      "id",
      "name",
    ]) {
      const nodeResult = await client.callTool({
        name: "n8n_update_node",
        arguments: { ...CALLS.n8n_update_node, path },
      });
      assert.equal(nodeResult.isError, true, `${path} should be rejected`);
    }
    const nodeUpdateCall = CALLS.n8n_update_node;
    assert(nodeUpdateCall);
    const nodeUpdateWithoutValue = { ...nodeUpdateCall };
    delete nodeUpdateWithoutValue.value;
    const missingValue = await client.callTool({
      name: "n8n_update_node",
      arguments: nodeUpdateWithoutValue,
    });
    assert.equal(missingValue.isError, true);
    for (const credentialType of [".", ".."] as const) {
      const invalidCredentialType = await client.callTool({
        name: "n8n_credentials_schema",
        arguments: { credentialType },
      });
      assert.equal(invalidCredentialType.isError, true);
    }
    const diffResult = await client.callTool({
      name: "n8n_workflows_diff",
      arguments: { workflowId: "wf_1", fromVersionId: "v1", toVersionId: "v1" },
    });
    assert.equal(diffResult.isError, true);
    const emptyUpdateResult = await client.callTool({
      name: "n8n_workflows_update",
      arguments: { workflowId: "wf_1" },
    });
    assert.equal(emptyUpdateResult.isError, true);
    const emptyCredentialUpdate = await client.callTool({
      name: "n8n_credentials_update",
      arguments: { credentialId: "cred_1" },
    });
    assert.equal(emptyCredentialUpdate.isError, true);
    const incompleteCredentialTypeChange = await client.callTool({
      name: "n8n_credentials_update",
      arguments: { credentialId: "cred_1", type: "httpHeaderAuth" },
    });
    assert.equal(incompleteCredentialTypeChange.isError, true);
    const reversedInsightsWindow = await client.callTool({
      name: "n8n_insights_summary",
      arguments: {
        startDate: "2026-07-18T00:00:00.000Z",
        endDate: "2026-07-17T00:00:00.000Z",
      },
    });
    assert.equal(reversedInsightsWindow.isError, true);
    assert.equal(requests.length, 0);
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    console.error = originalLog;
    if (originalUrl === undefined) delete process.env.N8N_API_URL;
    else process.env.N8N_API_URL = originalUrl;
    if (originalKey === undefined) delete process.env.N8N_API_KEY;
    else process.env.N8N_API_KEY = originalKey;
  }
});

test("workflow writes reject duplicate node identities before mutation", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(createMockFetch(requests), async (client) => {
    const duplicateNames = [node, { ...node, id: "node_2" }];
    const duplicateIds = [node, { ...node, name: "Second node" }];
    for (const nodes of [duplicateNames, duplicateIds]) {
      const createResult = await client.callTool({
        name: "n8n_workflows_create",
        arguments: { name: "Invalid graph", nodes, connections: {} },
      });
      assert.equal(createResult.isError, true);
      const updateResult = await client.callTool({
        name: "n8n_workflows_update",
        arguments: {
          workflowId: "wf_1",
          expectedVersionId: "v2",
          nodes,
        },
      });
      assert.equal(updateResult.isError, true);
    }
    assert.equal(requests.length, 0);
  });

  const upstreamRequests: CapturedRequest[] = [];
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      upstreamRequests.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        body: null,
      });
      return json({ ...workflow, nodes: [node, { ...node, id: "node_2" }] });
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_update",
        arguments: { workflowId: "wf_1", expectedVersionId: "v2", name: "Updated" },
      });
      assert.equal(result.isError, true);
      assert.deepEqual(
        upstreamRequests.map(({ method }) => method),
        ["GET"],
      );
    },
  );
});

test("workflow writes reject connection graphs that do not match final node names", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(createMockFetch(requests), async (client) => {
    const staleConnections = {
      Webhook: { main: [[{ node: "Webhook", type: "main", index: 0 }]] },
    };
    const createResult = await client.callTool({
      name: "n8n_workflows_create",
      arguments: {
        name: "Invalid graph",
        nodes: [{ ...node, name: "Renamed" }],
        connections: staleConnections,
      },
    });
    assert.equal(createResult.isError, true);
    assert.equal(requests.length, 0);

    const updateResult = await client.callTool({
      name: "n8n_workflows_update",
      arguments: {
        workflowId: "wf_1",
        expectedVersionId: "v2",
        nodes: [{ ...node, name: "Renamed" }],
        connections: staleConnections,
      },
    });
    assert.equal(updateResult.isError, true);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET", "GET"],
    );
  });
});

test("a valid connection source named node survives create, full update, and surgical update", async () => {
  const source = { ...node, id: "source_node", name: "node" };
  const target = {
    ...node,
    id: "target_node",
    name: "Target",
    position: [200, 0],
    parameters: { value: 1 },
  };
  const connections = {
    node: { main: [[{ node: "Target", type: "main", index: 0 }]] },
  };
  let current = {
    id: "wf_node",
    versionId: "v1",
    name: "Named node graph",
    active: false,
    isArchived: false,
    nodes: [source, target],
    connections,
    settings: {},
  };
  const requests: CapturedRequest[] = [];
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const rawBody = await request.clone().text();
      const body = rawBody === "" ? null : objectBody(JSON.parse(rawBody));
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });
      if (request.method === "POST") {
        current = { ...current, ...body, id: "wf_node", versionId: "v1" };
        return json(current);
      }
      if (request.method === "GET") return json(current);
      assert.equal(request.method, "PUT");
      current = {
        ...current,
        ...body,
        id: "wf_node",
        versionId: current.versionId === "v1" ? "v2" : "v3",
      };
      return json(current);
    },
    async (client) => {
      const created = await client.callTool({
        name: "n8n_workflows_create",
        arguments: { name: current.name, nodes: current.nodes, connections },
      });
      assert.equal(created.isError, undefined);

      const updated = await client.callTool({
        name: "n8n_workflows_update",
        arguments: {
          workflowId: "wf_node",
          expectedVersionId: "v1",
          description: "Still valid",
        },
      });
      assert.equal(updated.isError, undefined);

      const surgical = await client.callTool({
        name: "n8n_update_node",
        arguments: {
          workflowId: "wf_node",
          nodeId: "target_node",
          path: "parameters.value",
          value: 2,
          expectedVersionId: "v2",
          acknowledgeNonAtomicRisk: true,
        },
      });
      assert.equal(surgical.isError, undefined);
    },
  );
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["POST", "GET", "GET", "PUT", "GET", "GET", "PUT"],
  );
});

test("workflow typeVersion and connection shapes fail closed before any request", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(createMockFetch(requests), async (client) => {
    for (const typeVersion of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1e308,
    ]) {
      const result = await client.callTool({
        name: "n8n_workflows_create",
        arguments: {
          name: "Invalid type version",
          nodes: [{ ...node, typeVersion }],
          connections: {},
        },
      });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /MCP error -32602/);
    }
    const malformedConnections = await client.callTool({
      name: "n8n_workflows_create",
      arguments: {
        name: "Malformed connections",
        nodes: [node],
        connections: { Webhook: "hello" },
      },
    });
    assert.equal(malformedConnections.isError, true);
    assert.match(JSON.stringify(malformedConnections), /MCP error -32602/);
    assert.equal(requests.length, 0);
  });
});

test("workflow sensitive-data presence is tri-state when exclusion was requested", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(createMockFetch(requests), async (client) => {
    const excluded = await client.callTool({
      name: "n8n_workflows_get",
      arguments: { workflowId: "wf_1" },
    });
    const included = await client.callTool({
      name: "n8n_workflows_get",
      arguments: { workflowId: "wf_1", excludePinnedData: false },
    });
    const excludedData = objectBody(objectBody(excluded.structuredContent ?? null).data);
    const includedData = objectBody(objectBody(included.structuredContent ?? null).data);
    assert.deepEqual(plainJson(excludedData.sensitiveWorkflowData), {
      pinDataPresent: "not_requested",
      pinDataReturned: false,
      staticDataPresent: "not_requested",
      staticDataReturned: false,
    });
    assert.deepEqual(plainJson(includedData.sensitiveWorkflowData), {
      pinDataPresent: true,
      pinDataReturned: false,
      staticDataPresent: true,
      staticDataReturned: false,
    });
    assert.equal(new URLSearchParams(requests[0]?.search).get("excludePinnedData"), "true");
    assert.equal(new URLSearchParams(requests[1]?.search).get("excludePinnedData"), "false");
  });
});

test("tag names enforce the live 1-24 character bound before upstream requests", async () => {
  const requests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.N8N_API_URL;
  const originalKey = process.env.N8N_API_KEY;
  const originalLog = console.error;
  globalThis.fetch = createMockFetch(requests);
  process.env.N8N_API_URL = ORIGIN;
  process.env.N8N_API_KEY = "not-a-real-key";
  console.error = () => undefined;
  const { client, server } = await connect("unsafe");
  try {
    for (const name of ["a", "a".repeat(24)]) {
      const result = await client.callTool({
        name: "n8n_tags_create",
        arguments: { name },
      });
      assert.equal(result.isError, undefined, `${name.length}-character tag should pass`);
    }
    const requestsBeforeInvalidInput = requests.length;
    const invalid = await client.callTool({
      name: "n8n_tags_create",
      arguments: { name: "a".repeat(25) },
    });
    assert.equal(invalid.isError, true);
    assert.equal(requests.length, requestsBeforeInvalidInput);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    console.error = originalLog;
    if (originalUrl === undefined) delete process.env.N8N_API_URL;
    else process.env.N8N_API_URL = originalUrl;
    if (originalKey === undefined) delete process.env.N8N_API_KEY;
    else process.env.N8N_API_KEY = originalKey;
  }
});

test("workflow diff uses exactly two bounded reads and returns value-free coverage", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(createMockFetch(requests), async (client) => {
    const result = await client.callTool({
      name: "n8n_workflows_diff",
      arguments: CALLS.n8n_workflows_diff,
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      requests.map(({ method, pathname }) => ({ method, pathname })),
      [
        { method: "GET", pathname: "/api/v1/workflows/wf_1/v1" },
        { method: "GET", pathname: "/api/v1/workflows/wf_1" },
      ],
    );
    const serialized = JSON.stringify(result);
    assert(!serialized.includes(OUTPUT_CANARY));
    assert(serialized.includes("unavailable_historical_api"));
  });
});

test("credential usage performs one workflow-page request without credential fan-out", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(createMockFetch(requests), async (client) => {
    const result = await client.callTool({
      name: "n8n_credentials_usage",
      arguments: CALLS.n8n_credentials_usage,
    });
    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "GET");
    assert.equal(requests[0]?.pathname, "/api/v1/workflows");
    assert.equal(
      requests.some((request) => request.pathname.includes("/credentials")),
      false,
    );
    assert(!JSON.stringify(result).includes(OUTPUT_CANARY));
  });
});

test("node update detects a version change before PUT and fails without partial mutation", async () => {
  const requests: CapturedRequest[] = [];
  let workflowReads = 0;
  const conflictFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      body: null,
    });
    assert.equal(url.origin, ORIGIN);
    assert.equal(request.headers.get("X-N8N-API-KEY"), "not-a-real-key");
    assert.equal(url.pathname, "/api/v1/workflows/wf_1");
    assert.equal(request.method, "GET");
    workflowReads += 1;
    return json({ ...workflow, versionId: workflowReads === 1 ? "v2" : "v3" });
  };

  await withConnectedClient(conflictFetch, async (client) => {
    const result = await client.callTool({
      name: "n8n_update_node",
      arguments: CALLS.n8n_update_node,
    });
    assert.equal(result.isError, true);
    assert.equal(requests.length, 2);
    assert.equal(
      requests.every((request) => request.method === "GET"),
      true,
    );
  });
});

test("node update reports that mutation may have occurred when post-write preservation fails", async () => {
  const requests: CapturedRequest[] = [];
  const preservationFailureFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const rawBody = await request.clone().text();
    requests.push({
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      body: rawBody === "" ? null : (JSON.parse(rawBody) as unknown),
    });
    assert.equal(url.origin, ORIGIN);
    assert.equal(request.headers.get("X-N8N-API-KEY"), "not-a-real-key");
    assert.equal(url.pathname, "/api/v1/workflows/wf_1");
    if (request.method === "GET") return json(workflow);
    assert.equal(request.method, "PUT");
    return json({
      ...workflow,
      ...objectBody(requests.at(-1)?.body ?? null),
      versionId: "v3",
      pinData: null,
    });
  };

  await withConnectedClient(preservationFailureFetch, async (client) => {
    const result = await client.callTool({
      name: "n8n_update_node",
      arguments: CALLS.n8n_update_node,
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /may already have been applied/i);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET", "GET", "PUT"],
    );
  });
});

test("workflow update rejects concurrent versions before PUT", async () => {
  const requests: CapturedRequest[] = [];
  let reads = 0;
  const concurrentFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      body: null,
    });
    assert.equal(url.pathname, "/api/v1/workflows/wf_1");
    assert.equal(request.method, "GET");
    reads += 1;
    return json({ ...workflow, versionId: reads === 1 ? "v2" : "v3" });
  };

  await withConnectedClient(concurrentFetch, async (client) => {
    const result = await client.callTool({
      name: "n8n_workflows_update",
      arguments: { workflowId: "wf_1", expectedVersionId: "v2", name: "Updated" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET", "GET"],
    );
  });
});

test("workflow update reports when any submitted writable field did not land", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const rawBody = await request.clone().text();
      requests.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        body: rawBody === "" ? null : (JSON.parse(rawBody) as unknown),
      });
      if (request.method === "GET") return json(workflow);
      return json({ ...workflow, versionId: "v3" });
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_update",
        arguments: { workflowId: "wf_1", expectedVersionId: "v2", name: "Not landed" },
      });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /submitted name value/i);
      assert.match(JSON.stringify(result), /may already have been applied/i);
      assert.deepEqual(
        requests.map(({ method }) => method),
        ["GET", "GET", "PUT"],
      );
    },
  );
});

test("full and surgical workflow updates report active or archive state drift after PUT", async () => {
  for (const name of ["n8n_workflows_update", "n8n_update_node"] as const) {
    const requests: CapturedRequest[] = [];
    await withConnectedClient(
      async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        const rawBody = await request.clone().text();
        const body: unknown | null = rawBody === "" ? null : JSON.parse(rawBody);
        requests.push({
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          body,
        });
        if (request.method === "GET") return json(workflow);
        return json({
          ...workflow,
          ...objectBody(body),
          id: "wf_1",
          versionId: "v3",
          active: true,
          isArchived: true,
        });
      },
      async (client) => {
        const result = await client.callTool({
          name,
          arguments: CALLS[name],
        });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /may already have been applied/i);
        assert.deepEqual(
          requests.map(({ method }) => method),
          ["GET", "GET", "PUT"],
        );
      },
    );
  }
});

test("credential schemas retain sensitive property names but redact defaults", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(createMockFetch(requests), async (client) => {
    const result = await client.callTool({
      name: "n8n_credentials_schema",
      arguments: { credentialType: "n8nApi" },
    });
    assert.equal(result.isError, undefined);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(OUTPUT_CANARY), false);
    const structured = objectBody(result.structuredContent ?? null);
    const wrapper = objectBody(structured.data ?? null);
    const properties = objectBody(wrapper.properties ?? null);
    assert(Object.hasOwn(properties, "apiKey"));
    assert(Object.hasOwn(properties, "account"));
  });
});

test("historical workflow reads reject mismatched response identity", async () => {
  for (const mismatch of [
    { ...historicalWorkflow, workflowId: "wf_other" },
    { ...historicalWorkflow, versionId: "v_other" },
  ]) {
    await withConnectedClient(
      async () => json(mismatch),
      async (client) => {
        const result = await client.callTool({
          name: "n8n_workflows_get_version",
          arguments: CALLS.n8n_workflows_get_version,
        });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /different workflow version identity/i);
      },
    );
  }
});

test("user email lookups encode every valid selector as one safe path segment", async () => {
  for (const [email, expectedPath] of [
    ["o'brien@example.com", "/api/v1/users/o%27brien%40example.com"],
    ["a+b@example.com", "/api/v1/users/a%2Bb%40example.com"],
  ] as const) {
    let observedPath = "";
    await withConnectedClient(
      async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        observedPath = new URL(request.url).pathname;
        return json({ id: "user_1", email });
      },
      async (client) => {
        const result = await client.callTool({
          name: "n8n_users_get",
          arguments: { userIdOrEmail: email },
        });
        assert.equal(result.isError, undefined);
      },
    );
    assert.equal(observedPath, expectedPath);
  }
});

test("workflow diffs reject mismatched retained snapshot version identity", async () => {
  for (const mismatchedSelector of ["v1", "v2"] as const) {
    let requests = 0;
    await withConnectedClient(
      async (input, init) => {
        requests += 1;
        const request = input instanceof Request ? input : new Request(input, init);
        const requestedVersion = new URL(request.url).pathname.endsWith("/v1") ? "v1" : "v2";
        return json({
          ...historicalWorkflow,
          versionId: requestedVersion === mismatchedSelector ? "v_other" : requestedVersion,
        });
      },
      async (client) => {
        const result = await client.callTool({
          name: "n8n_workflows_diff",
          arguments: { workflowId: "wf_1", fromVersionId: "v1", toVersionId: "v2" },
        });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /different workflow version identity/i);
      },
    );
    assert.equal(requests, mismatchedSelector === "v1" ? 1 : 2);
  }
});

test("workflow update preserves same-version state from its immediate pre-write read", async () => {
  const requests: CapturedRequest[] = [];
  const latestPinData = { Webhook: [{ json: { runtimeState: "latest" } }] };
  const latestStaticData = "latest-runtime-static-data";
  let reads = 0;
  const sameVersionRuntimeChangeFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const rawBody = await request.clone().text();
    const body: unknown | null = rawBody === "" ? null : JSON.parse(rawBody);
    requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });
    assert.equal(url.pathname, "/api/v1/workflows/wf_1");
    if (request.method === "GET") {
      reads += 1;
      return json(
        reads === 1
          ? workflow
          : { ...workflow, pinData: latestPinData, staticData: latestStaticData },
      );
    }
    assert.equal(request.method, "PUT");
    const submitted = objectBody(body);
    assert.deepEqual(submitted.pinData, latestPinData);
    assert.equal(submitted.staticData, latestStaticData);
    return json({ ...workflow, ...submitted, versionId: "v3" });
  };

  await withConnectedClient(sameVersionRuntimeChangeFetch, async (client) => {
    const result = await client.callTool({
      name: "n8n_workflows_update",
      arguments: { workflowId: "wf_1", expectedVersionId: "v2", name: "Updated" },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET", "GET", "PUT"],
    );
  });
});

test("workflow update reports a post-write pin or static data preservation failure", async () => {
  const requests: CapturedRequest[] = [];
  const preservationFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const rawBody = await request.clone().text();
    const body: unknown | null = rawBody === "" ? null : JSON.parse(rawBody);
    requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });
    assert.equal(url.pathname, "/api/v1/workflows/wf_1");
    if (request.method === "GET") return json(workflow);
    assert.equal(request.method, "PUT");
    return json({
      ...workflow,
      ...objectBody(body),
      versionId: "v3",
      staticData: null,
    });
  };

  await withConnectedClient(preservationFetch, async (client) => {
    const result = await client.callTool({
      name: "n8n_workflows_update",
      arguments: {
        workflowId: "wf_1",
        expectedVersionId: "v2",
        description: "Updated description",
      },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /may already have been applied/i);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET", "GET", "PUT"],
    );
  });
});

test("workflow update validates an intentional pin and static data replacement", async () => {
  const replacementPinData = { Webhook: [{ json: { synthetic: true } }] };
  const replacementStaticData = "replacement-static-data";
  const requests: CapturedRequest[] = [];
  const replacementFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const rawBody = await request.clone().text();
    const body: unknown | null = rawBody === "" ? null : JSON.parse(rawBody);
    requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });
    if (request.method === "GET") return json(workflow);
    return json({ ...workflow, ...objectBody(body), versionId: "v3" });
  };

  await withConnectedClient(replacementFetch, async (client) => {
    const result = await client.callTool({
      name: "n8n_workflows_update",
      arguments: {
        workflowId: "wf_1",
        expectedVersionId: "v2",
        pinData: replacementPinData,
        staticData: replacementStaticData,
      },
    });
    assert.equal(result.isError, undefined);
    const put = requests.find((request) => request.method === "PUT");
    assert(put);
    const body = objectBody(put.body);
    assert.deepEqual(body.pinData, replacementPinData);
    assert.equal(body.staticData, replacementStaticData);
  });
});

test("node update preserves sibling nodes and confirms the requested value landed", async () => {
  const siblingNode = {
    id: "node_2",
    name: "Sibling",
    type: "n8n-nodes-base.noOp",
    typeVersion: 1,
    position: [200, 0],
    parameters: { untouched: true },
  };
  const multiNodeWorkflow = { ...workflow, nodes: [node, siblingNode] };
  const requests: CapturedRequest[] = [];
  const multiNodeFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const rawBody = await request.clone().text();
    const body: unknown | null = rawBody === "" ? null : JSON.parse(rawBody);
    requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });
    assert.equal(url.pathname, "/api/v1/workflows/wf_1");
    if (request.method === "GET") return json(multiNodeWorkflow);
    assert.equal(request.method, "PUT");
    return json({ ...multiNodeWorkflow, ...objectBody(body), versionId: "v3" });
  };

  await withConnectedClient(multiNodeFetch, async (client) => {
    const result = await client.callTool({
      name: "n8n_update_node",
      arguments: CALLS.n8n_update_node,
    });
    assert.equal(result.isError, undefined);
    const put = requests.find((request) => request.method === "PUT");
    assert(put);
    const putBody = objectBody(put.body);
    assert.deepEqual(putBody.nodes, [
      { ...node, parameters: { ...node.parameters, path: "new-orders" } },
      siblingNode,
    ]);
  });
});

test("node update preserves same-version state from its immediate pre-write read", async () => {
  const latestPinData = { Webhook: [{ json: { runtimeState: "latest-node-update" } }] };
  const latestStaticData = "latest-node-runtime-static-data";
  const requests: CapturedRequest[] = [];
  let reads = 0;
  const sameVersionRuntimeChangeFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const rawBody = await request.clone().text();
    const body: unknown | null = rawBody === "" ? null : JSON.parse(rawBody);
    requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });
    assert.equal(url.pathname, "/api/v1/workflows/wf_1");
    if (request.method === "GET") {
      reads += 1;
      return json(
        reads === 1
          ? workflow
          : { ...workflow, pinData: latestPinData, staticData: latestStaticData },
      );
    }
    assert.equal(request.method, "PUT");
    const submitted = objectBody(body);
    assert.deepEqual(submitted.pinData, latestPinData);
    assert.equal(submitted.staticData, latestStaticData);
    return json({ ...workflow, ...submitted, versionId: "v3" });
  };

  await withConnectedClient(sameVersionRuntimeChangeFetch, async (client) => {
    const result = await client.callTool({
      name: "n8n_update_node",
      arguments: CALLS.n8n_update_node,
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET", "GET", "PUT"],
    );
  });
});

test("node update rejects duplicate IDs and a response that did not apply the value", async () => {
  const duplicateRequests: CapturedRequest[] = [];
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      duplicateRequests.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        body: null,
      });
      return json({ ...workflow, nodes: [node, { ...node, name: "Duplicate" }] });
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_update_node",
        arguments: CALLS.n8n_update_node,
      });
      assert.equal(result.isError, true);
      assert.deepEqual(
        duplicateRequests.map(({ method }) => method),
        ["GET"],
      );
    },
  );

  const landingRequests: CapturedRequest[] = [];
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const rawBody = await request.clone().text();
      landingRequests.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        body: rawBody === "" ? null : (JSON.parse(rawBody) as unknown),
      });
      if (request.method === "GET") return json(workflow);
      return json({ ...workflow, versionId: "v3" });
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_update_node",
        arguments: CALLS.n8n_update_node,
      });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /not confirm/i);
      assert.deepEqual(
        landingRequests.map(({ method }) => method),
        ["GET", "GET", "PUT"],
      );
    },
  );
});

test("workflow diff reports value-free metadata and multi-node changes without empty credential noise", async () => {
  const fromCanary = "FROM-DIFF-VALUE-MUST-NOT-LEAK";
  const toCanary = "TO-DIFF-VALUE-MUST-NOT-LEAK";
  const from = {
    workflowId: "wf_1",
    versionId: "v1",
    name: "Before rename",
    nodes: [
      { ...node, id: "node_a", name: "A", parameters: {}, credentials: undefined },
      { ...node, id: "node_b", name: "B", parameters: { secret: fromCanary } },
      { ...node, id: "node_c", name: "C", parameters: {} },
    ],
    connections: {},
  };
  const to = {
    workflowId: "wf_1",
    versionId: "v2",
    name: "After rename",
    nodes: [
      {
        ...node,
        id: "node_a",
        name: "A",
        position: [400, 500],
        parameters: {},
        credentials: {},
      },
      { ...node, id: "node_b", name: "B", parameters: { secret: toCanary } },
      { ...node, id: "node_d", name: "D", parameters: {} },
    ],
    connections: { B: { main: [[{ node: "D", type: "main", index: 0 }]] } },
  };
  const requests: CapturedRequest[] = [];

  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        body: null,
      });
      if (url.pathname.endsWith("/v1")) return json(from);
      if (url.pathname.endsWith("/v2")) return json(to);
      return json({ message: "Unexpected path" }, 404);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_diff",
        arguments: { workflowId: "wf_1", fromVersionId: "v1", toVersionId: "v2" },
      });
      assert.equal(result.isError, undefined);
      const structured = result.structuredContent;
      assert(structured && typeof structured === "object" && "data" in structured);
      const data = objectBody(structured.data ?? null);
      assert.deepEqual(plainJson(data.summary), {
        workflowNameChanged: true,
        nodesAdded: 1,
        nodesRemoved: 1,
        nodesModified: 1,
        connectionsChanged: true,
        totalChanges: 5,
      });
      assert.deepEqual(plainJson(data.comparisonCoverage), {
        name: "compared",
        nodes: "compared",
        connections: "compared",
        description: "unavailable_historical_api",
        settings: "unavailable_historical_api",
        pinData: "unavailable_historical_api",
        staticData: "unavailable_historical_api",
        nodeGroups: "unavailable_historical_api",
      });
      const serialized = JSON.stringify(result);
      assert(!serialized.includes(fromCanary));
      assert(!serialized.includes(toCanary));
      assert(!serialized.includes("credentialReferences"));
      assert(serialized.includes("workflow_name_changed"));
      assert.deepEqual(
        requests.map(({ pathname }) => pathname),
        ["/api/v1/workflows/wf_1/v1", "/api/v1/workflows/wf_1/v2"],
      );
    },
  );
});

test("workflow diff reports every mutable execution-behavior node field", async () => {
  const before = {
    ...historicalWorkflow,
    versionId: "v1",
    nodes: [{ ...node, parameters: {} }],
  };
  const after = {
    ...historicalWorkflow,
    versionId: "v2",
    nodes: [
      {
        ...node,
        parameters: {},
        onError: "continueRegularOutput",
        retryOnFail: true,
        maxTries: 5,
        waitBetweenTries: 2_000,
        continueOnFail: true,
        notes: "Operational note",
        notesInFlow: true,
        alwaysOutputData: true,
        executeOnce: true,
      },
    ],
  };

  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return json(new URL(request.url).pathname.endsWith("/v1") ? before : after);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_diff",
        arguments: { workflowId: "wf_1", fromVersionId: "v1", toVersionId: "v2" },
      });
      assert.equal(result.isError, undefined);
      const structured = result.structuredContent;
      assert(structured && typeof structured === "object" && "data" in structured);
      const data = objectBody(structured.data ?? null);
      const changes = data.changes;
      assert(Array.isArray(changes));
      const change = (changes as unknown[]).find(
        (candidate) => objectBody(candidate).kind === "node_modified",
      );
      assert(change);
      assert.deepEqual(objectBody(change).fields, [
        "retryOnFail",
        "maxTries",
        "waitBetweenTries",
        "continueOnFail",
        "onError",
        "notes",
        "notesInFlow",
        "alwaysOutputData",
        "executeOnce",
      ]);
      assert.deepEqual(plainJson(data.summary), {
        workflowNameChanged: null,
        nodesAdded: 0,
        nodesRemoved: 0,
        nodesModified: 1,
        connectionsChanged: false,
        totalChanges: 1,
      });
    },
  );
});

test("workflow diff normalizes absent and explicit false execution booleans", async () => {
  const before = {
    ...historicalWorkflow,
    versionId: "v1",
    nodes: [{ ...node, parameters: {} }],
  };
  const after = {
    ...historicalWorkflow,
    versionId: "v2",
    nodes: [
      {
        ...node,
        parameters: {},
        disabled: false,
        retryOnFail: false,
        continueOnFail: false,
        notesInFlow: false,
        alwaysOutputData: false,
        executeOnce: false,
      },
    ],
  };

  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return json(new URL(request.url).pathname.endsWith("/v1") ? before : after);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_diff",
        arguments: { workflowId: "wf_1", fromVersionId: "v1", toVersionId: "v2" },
      });
      assert.equal(result.isError, undefined);
      const structured = result.structuredContent;
      assert(structured && typeof structured === "object" && "data" in structured);
      const data = objectBody(structured.data ?? null);
      assert.deepEqual(plainJson(data.changes), []);
      assert.deepEqual(plainJson(data.summary), {
        workflowNameChanged: null,
        nodesAdded: 0,
        nodesRemoved: 0,
        nodesModified: 0,
        connectionsChanged: false,
        totalChanges: 0,
      });
    },
  );
});

test("workflow diff conservatively reports omitted versus explicit numeric retry settings", async () => {
  const before = {
    ...historicalWorkflow,
    versionId: "v1",
    nodes: [{ ...node, parameters: {}, retryOnFail: true }],
  };
  const after = {
    ...historicalWorkflow,
    versionId: "v2",
    nodes: [
      {
        ...node,
        parameters: {},
        retryOnFail: true,
        maxTries: 3,
        waitBetweenTries: 1_000,
      },
    ],
  };

  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return json(new URL(request.url).pathname.endsWith("/v1") ? before : after);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_diff",
        arguments: { workflowId: "wf_1", fromVersionId: "v1", toVersionId: "v2" },
      });
      assert.equal(result.isError, undefined);
      const structured = result.structuredContent;
      assert(structured && typeof structured === "object" && "data" in structured);
      const data = objectBody(structured.data ?? null);
      const changes = data.changes;
      assert(Array.isArray(changes));
      const change = (changes as unknown[]).find(
        (candidate) => objectBody(candidate).kind === "node_modified",
      );
      assert(change);
      assert.deepEqual(objectBody(change).fields, ["maxTries", "waitBetweenTries"]);
    },
  );
});

test("user invitation preserves the real delivery outcome without returning the bearer link", async () => {
  await withConnectedClient(
    async () =>
      json(
        [
          {
            user: {
              id: "user_2",
              email: "member@example.test",
              emailSent: false,
              inviteAcceptUrl: "https://n8n.example.test/signup?token=one-time-invite-capability",
            },
            error: "",
          },
        ],
        201,
      ),
    async (client) => {
      const result = await client.callTool({
        name: "n8n_users_create",
        arguments: CALLS.n8n_users_create,
      });
      assert.equal(result.isError, undefined);
      const structured = result.structuredContent;
      assert(structured && typeof structured === "object" && "data" in structured);
      const data = plainJson(structured.data);
      assert.deepEqual(data, {
        userCreated: true,
        invited: true,
        userId: "user_2",
        email: "[EMAIL]",
        requestedRole: "global:member",
        roleConfirmedByResponse: false,
        emailSent: false,
        delivery: "manual_link_available_in_n8n",
        inviteAcceptUrlReturned: false,
      });
      assert(!JSON.stringify(result).includes("member@example.test"));
      assert(!JSON.stringify(result).includes("one-time-invite-capability"));
    },
  );
});

test("user invitation accepts n8n's lowercase normalization of a mixed-case email", async () => {
  const requestedEmail = "Member@Example.Test";
  await withConnectedClient(
    async () =>
      json(
        [
          {
            user: {
              id: "user_2",
              email: requestedEmail.toLowerCase(),
              emailSent: true,
            },
            error: "",
          },
        ],
        201,
      ),
    async (client) => {
      const result = await client.callTool({
        name: "n8n_users_create",
        arguments: {
          email: requestedEmail,
          role: "global:member",
          confirmation: `INVITE ${requestedEmail}`,
        },
      });
      assert.equal(result.isError, undefined);
      const serialized = JSON.stringify(result);
      assert(!serialized.includes(requestedEmail));
      assert(!serialized.includes(requestedEmail.toLowerCase()));
      assert.match(serialized, /"userCreated":true/);
      assert.match(serialized, /"delivery":"email_sent"/);
    },
  );
});

test("user invitation rejects empty and per-item failure responses instead of fabricating success", async () => {
  for (const response of [
    [],
    [
      {
        user: {
          id: "user_2",
          email: "member@example.test",
          role: "global:member",
          emailSent: false,
        },
        error: "The invitation email could not be sent.",
      },
    ],
    [
      {
        user: {
          id: "user_2",
          email: "member@example.test",
          role: "global:admin",
          emailSent: true,
        },
        error: "",
      },
    ],
  ]) {
    await withConnectedClient(
      async () => json(response, 201),
      async (client) => {
        const result = await client.callTool({
          name: "n8n_users_create",
          arguments: CALLS.n8n_users_create,
        });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /did not confirm the requested invitation/i);
        assert(!JSON.stringify(result).includes("could not be sent"));
      },
    );
  }
});

test("credential usage enforces exact IDs, pagination privacy, and both detail caps", async () => {
  const matchingWorkflows = Array.from({ length: 11 }, (_, workflowIndex) => ({
    id: `wf_${workflowIndex}`,
    name: `Workflow ${workflowIndex}`,
    active: workflowIndex % 2 === 0,
    nodes: Array.from({ length: 25 }, (_, nodeIndex) => ({
      id: `node_${workflowIndex}_${nodeIndex}`,
      name: `Node ${workflowIndex}-${nodeIndex}`,
      type: "n8n-nodes-base.httpRequest",
      credentials: { header: { id: "cred_1", name: "MUST-NOT-BE-RETURNED" } },
    })),
  }));
  const exactMismatch = {
    id: "wf_exact_mismatch",
    name: "Exact mismatch",
    active: false,
    nodes: [
      {
        id: "node_exact_mismatch",
        name: "Different credential",
        type: "n8n-nodes-base.httpRequest",
        credentials: { header: { id: "cred_10" } },
      },
    ],
  };
  const requests: CapturedRequest[] = [];

  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        body: null,
      });
      return json({ data: [...matchingWorkflows, exactMismatch], nextCursor: "next-page" });
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_credentials_usage",
        arguments: { credentialId: "cred_1", cursor: "start-page", limit: 50, active: false },
      });
      assert.equal(result.isError, undefined);
      const structured = result.structuredContent;
      assert(structured && typeof structured === "object" && "data" in structured);
      const data = objectBody(structured.data ?? null);
      assert.equal(data.workflowsExamined, 12);
      assert.equal(data.matchingWorkflowCount, 11);
      assert.equal(data.nextCursor, "next-page");
      assert.equal(data.scanComplete, false);
      assert.equal(data.truncated, true);
      assert.equal(data.omittedNodeDetails, 75);
      const returnedWorkflows = data.workflows;
      assert(Array.isArray(returnedWorkflows));
      let retainedDetails = 0;
      for (const item of returnedWorkflows as unknown[]) {
        const returnedWorkflow = objectBody(item);
        assert(Array.isArray(returnedWorkflow.nodes));
        assert(returnedWorkflow.nodes.length <= 20);
        retainedDetails += returnedWorkflow.nodes.length;
      }
      assert.equal(retainedDetails, 200);
      assert(!JSON.stringify(result).includes("MUST-NOT-BE-RETURNED"));
      assert.equal(requests.length, 1);
      const query = new URLSearchParams(requests[0]?.search);
      assert.equal(query.get("cursor"), "start-page");
      assert.equal(query.get("limit"), "50");
      assert.equal(query.get("active"), "false");
      assert.equal(query.get("excludePinnedData"), "true");
    },
  );
});

test("paginated workflow analyses reject an empty upstream cursor", async () => {
  await withConnectedClient(
    async () => json({ data: [], nextCursor: "" }),
    async (client) => {
      for (const call of [
        { name: "n8n_workflows_list", arguments: {} },
        { name: "n8n_executions_list", arguments: {} },
        { name: "n8n_credentials_list", arguments: {} },
        { name: "n8n_credentials_usage", arguments: { credentialId: "cred_1" } },
        { name: "n8n_tags_list", arguments: {} },
        { name: "n8n_users_list", arguments: {} },
        { name: "n8n_search_workflows", arguments: { query: "order" } },
        { name: "n8n_list_node_types", arguments: { maxPages: 1 } },
      ]) {
        const result = await client.callTool(call);
        assert.equal(result.isError, true, `${call.name} should reject an empty cursor`);
      }
    },
  );
});

test("node-type inventory is deterministic, bounded, and explicit about scan coverage", async () => {
  const observedTypes = Array.from(
    { length: 501 },
    (_, index) => `community.type-${String(500 - index).padStart(3, "0")}`,
  );
  await withConnectedClient(
    async () =>
      json({
        data: [
          {
            id: "wf_types",
            nodes: observedTypes.map((type) => ({ type })),
          },
        ],
        nextCursor: null,
      }),
    async (client) => {
      const result = await client.callTool({
        name: "n8n_list_node_types",
        arguments: { maxPages: 1 },
      });
      assert.equal(result.isError, undefined);
      const envelope = objectBody(result.structuredContent ?? null);
      const data = objectBody(envelope.data ?? null);
      const types = data.types;
      assert(Array.isArray(types));
      assert.equal(types.length, 500);
      assert.equal(objectBody(types[0]).type, "community.type-000");
      assert.equal(objectBody(types.at(-1)).type, "community.type-499");
      assert.equal(data.scope, "observed_workflows");
      assert.equal(
        data.availabilityStatement,
        "Types not observed in this bounded scan have unknown availability.",
      );
      assert.equal(data.pagesScanned, 1);
      assert.equal(data.workflowsScanned, 1);
      assert.equal(data.nodesScanned, 501);
      assert.equal(data.startedAtBeginning, true);
      assert.equal(data.reachedEnd, true);
      assert.equal(data.nextCursor, null);
      assert.equal(data.resultComplete, false);
      assert.equal(data.truncated, true);
      assert.equal(data.omittedTypeCount, 1);
    },
  );
});

test("workflow search truncates only when more than 50 matches exist", async () => {
  let call = 0;
  await withConnectedClient(
    async () => {
      call += 1;
      const count = call === 1 ? 50 : 51;
      return json({
        data: Array.from({ length: count }, (_, index) => ({
          id: `wf_${call}_${index}`,
          name: `Order workflow ${index}`,
          active: false,
          nodes: [],
        })),
        nextCursor: null,
      });
    },
    async (client) => {
      const exact = await client.callTool({
        name: "n8n_search_workflows",
        arguments: { query: "order" },
      });
      assert.equal(exact.isError, undefined);
      const exactStructured = exact.structuredContent;
      assert(exactStructured && typeof exactStructured === "object" && "data" in exactStructured);
      const exactData = objectBody(exactStructured.data ?? null);
      assert.equal(exactData.truncated, false);
      assert(Array.isArray(exactData.matches));
      assert.equal(exactData.matches.length, 50);

      const over = await client.callTool({
        name: "n8n_search_workflows",
        arguments: { query: "order" },
      });
      assert.equal(over.isError, undefined);
      const overStructured = over.structuredContent;
      assert(overStructured && typeof overStructured === "object" && "data" in overStructured);
      const overData = objectBody(overStructured.data ?? null);
      assert.equal(overData.truncated, true);
      assert(Array.isArray(overData.matches));
      assert.equal(overData.matches.length, 50);
    },
  );
});

test("node update rejects field-type-contract violations before issuing any write", async () => {
  const invalidValues: ReadonlyArray<readonly [string, unknown]> = [
    ["disabled", "yes"],
    ["maxTries", "many"],
    ["waitBetweenTries", -5],
    ["onError", "explode"],
    ["notesInFlow", 1],
    ["position.0", "left"],
  ];
  for (const [path, value] of invalidValues) {
    const requests: CapturedRequest[] = [];
    await withConnectedClient(
      async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        const rawBody = await request.clone().text();
        requests.push({
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          body: rawBody === "" ? null : (JSON.parse(rawBody) as unknown),
        });
        return json(workflow);
      },
      async (client) => {
        const result = await client.callTool({
          name: "n8n_update_node",
          arguments: { ...CALLS.n8n_update_node, path, value },
        });
        assert.equal(result.isError, true, `${path}=${JSON.stringify(value)} must be rejected`);
      },
    );
    assert.equal(
      requests.filter((request) => request.method !== "GET").length,
      0,
      `${path} must issue zero write requests`,
    );
  }
});

test("node update applies a valid typed field value and confirms it landed", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const rawBody = await request.clone().text();
      const body: unknown | null = rawBody === "" ? null : JSON.parse(rawBody);
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });
      if (request.method === "GET") return json(workflow);
      return json({ ...workflow, ...objectBody(body), versionId: "v3" });
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_update_node",
        arguments: { ...CALLS.n8n_update_node, path: "onError", value: "stopWorkflow" },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const put = requests.find((request) => request.method === "PUT");
      assert(put);
      const nodes = objectBody(put.body).nodes;
      assert(Array.isArray(nodes));
      assert.equal(objectBody(nodes[0]).onError, "stopWorkflow");
    },
  );
});

test("workflow rename succeeds despite prototype-like keys and deep upstream node data", async () => {
  let deep: Record<string, unknown> = { leaf: "deep-value" };
  for (let level = 0; level < 25; level += 1) deep = { nested: deep };
  const constructorValue = { note: "prototype-like key preserved from upstream" };
  const adversarialNode = {
    ...node,
    parameters: { constructor: constructorValue, deep },
  };
  const adversarialWorkflow = { ...workflow, nodes: [adversarialNode] };
  const requests: CapturedRequest[] = [];
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const rawBody = await request.clone().text();
      const body: unknown | null = rawBody === "" ? null : JSON.parse(rawBody);
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });
      if (request.method === "GET") return json(adversarialWorkflow);
      return json({ ...adversarialWorkflow, ...objectBody(body), versionId: "v3" });
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_update",
        arguments: { workflowId: "wf_1", expectedVersionId: "v2", name: "Renamed" },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const put = requests.find((request) => request.method === "PUT");
      assert(put);
      const putBody = objectBody(put.body);
      assert.equal(putBody.name, "Renamed");
      const nodes = putBody.nodes;
      assert(Array.isArray(nodes));
      const params = objectBody(objectBody(nodes[0]).parameters);
      assert.deepEqual(params["constructor"], constructorValue);
      assert.deepEqual(params["deep"], deep);
    },
  );
});

test("workflow writes still reject caller-supplied prototype keys before any request", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(createMockFetch(requests), async (client) => {
    const callerCases = [
      {
        name: "n8n_update_node",
        arguments: {
          ...CALLS.n8n_update_node,
          path: "parameters.injected",
          value: { constructor: { polluted: true } },
        },
      },
      {
        name: "n8n_workflows_update",
        arguments: {
          workflowId: "wf_1",
          expectedVersionId: "v2",
          pinData: { constructor: { polluted: true } },
        },
      },
    ];
    for (const call of callerCases) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true, `${call.name} must reject caller prototype keys`);
    }
    assert.equal(requests.length, 0);
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  });
});

test("node update rejects an out-of-bounds array index without fabricating sparse nulls", async () => {
  const rulesNode = { ...node, parameters: { rules: ["only"] } };
  const rulesWorkflow = { ...workflow, nodes: [rulesNode] };
  const rejectRequests: CapturedRequest[] = [];
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const rawBody = await request.clone().text();
      rejectRequests.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        body: rawBody === "" ? null : (JSON.parse(rawBody) as unknown),
      });
      return json(rulesWorkflow);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_update_node",
        arguments: { ...CALLS.n8n_update_node, path: "parameters.rules.5", value: "X" },
      });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /array index beyond/i);
    },
  );
  assert.equal(rejectRequests.filter((request) => request.method === "PUT").length, 0);
  assert.equal(
    rejectRequests.every((request) => request.method === "GET"),
    true,
  );

  const applyRequests: CapturedRequest[] = [];
  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const rawBody = await request.clone().text();
      const body: unknown | null = rawBody === "" ? null : JSON.parse(rawBody);
      applyRequests.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        body,
      });
      if (request.method === "GET") return json(rulesWorkflow);
      return json({ ...rulesWorkflow, ...objectBody(body), versionId: "v3" });
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_update_node",
        arguments: { ...CALLS.n8n_update_node, path: "parameters.rules.0", value: "replaced" },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const put = applyRequests.find((request) => request.method === "PUT");
      assert(put);
      const nodes = objectBody(put.body).nodes;
      assert(Array.isArray(nodes));
      assert.deepEqual(objectBody(objectBody(nodes[0]).parameters).rules, ["replaced"]);
    },
  );
});

test("workflow diff to current requests the current workflow without pinned data", async () => {
  const requests: CapturedRequest[] = [];
  await withConnectedClient(createMockFetch(requests), async (client) => {
    const result = await client.callTool({
      name: "n8n_workflows_diff",
      arguments: { workflowId: "wf_1", fromVersionId: "v1" },
    });
    assert.equal(result.isError, undefined);
    const currentRead = requests.find(
      (request) => request.pathname === "/api/v1/workflows/wf_1" && request.method === "GET",
    );
    assert(currentRead);
    assert.equal(new URLSearchParams(currentRead.search).get("excludePinnedData"), "true");
    const versionRead = requests.find(
      (request) => request.pathname === "/api/v1/workflows/wf_1/v1",
    );
    assert(versionRead);
    assert.equal(new URLSearchParams(versionRead.search).has("excludePinnedData"), false);
  });
});

test("workflow updates fail with an explicit unsupported-version error when versionId is absent", async () => {
  for (const call of [
    {
      name: "n8n_workflows_update",
      arguments: { workflowId: "wf_1", expectedVersionId: "v2", name: "Renamed" },
    },
    { name: "n8n_update_node", arguments: CALLS.n8n_update_node },
  ]) {
    const requests: CapturedRequest[] = [];
    await withConnectedClient(
      async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        requests.push({
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          body: null,
        });
        return json({ ...workflow, versionId: undefined });
      },
      async (client) => {
        const result = await client.callTool(call);
        assert.equal(result.isError, true);
        const serialized = JSON.stringify(result);
        assert.match(serialized, /version_identity_unsupported/);
        assert.match(serialized, /2\.30\.5/);
        assert.doesNotMatch(serialized, /version changed/i);
      },
    );
    assert.equal(
      requests.every((request) => request.method === "GET"),
      true,
      `${call.name} must issue no write request`,
    );
    assert.equal(requests.filter((request) => request.method === "PUT").length, 0);
  }
});

test("version-history 404 distinguishes below-floor absence from pruned retention", async () => {
  for (const call of [
    { name: "n8n_workflows_get_version", arguments: CALLS.n8n_workflows_get_version },
    { name: "n8n_workflows_diff", arguments: { workflowId: "wf_1", fromVersionId: "v1" } },
  ]) {
    await withConnectedClient(
      async () => json({ message: "Not Found" }, 404),
      async (client) => {
        const result = await client.callTool(call);
        assert.equal(result.isError, true);
        const serialized = JSON.stringify(result);
        assert.match(serialized, /version_history_unavailable/);
        assert.match(serialized, /2\.30\.5/);
        assert.match(serialized, /prune|retention/i);
      },
    );
  }
});
