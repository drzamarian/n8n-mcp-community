import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

const ORIGIN = "https://n8n.example.test";
const API_KEY = "not-a-real-key";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function objectBody(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function structuredData(result: unknown): Record<string, unknown> {
  const structured = objectBody(objectBody(result ?? null).structuredContent ?? null);
  return objectBody(structured.data ?? null);
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
  process.env.N8N_API_KEY = API_KEY;
  console.error = () => undefined;
  const server = createServer({ mode: "unsafe", allowInsecureHttp: false });
  const client = new Client({ name: "tool-remediation-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
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

test("FABLE-R2-P2-06: credential usage tolerates name-only and null references while matching real ids", async () => {
  const page = {
    data: [
      {
        id: "wf_resolved",
        name: "Resolved usage",
        active: true,
        nodes: [
          {
            id: "node_resolved",
            name: "Postgres",
            type: "n8n-nodes-base.postgres",
            credentials: { postgres: { id: "cred_target", name: "Prod Postgres account" } },
          },
        ],
      },
      {
        id: "wf_name_only",
        name: "Name-only reference",
        active: false,
        nodes: [
          {
            id: "node_name_only",
            name: "Legacy Postgres",
            type: "n8n-nodes-base.postgres",
            credentials: { postgres: { id: null, name: "Legacy Postgres account" } },
          },
        ],
      },
      {
        id: "wf_null_reference",
        name: "Null reference",
        active: false,
        nodes: [
          {
            id: "node_null",
            name: "Broken reference",
            type: "n8n-nodes-base.httpRequest",
            credentials: { httpHeaderAuth: null },
          },
        ],
      },
      {
        id: "wf_legacy_string",
        name: "Legacy string reference",
        active: false,
        nodes: [
          {
            id: "node_legacy",
            name: "Legacy string",
            type: "n8n-nodes-base.httpRequest",
            credentials: { httpHeaderAuth: "Legacy account name" },
          },
        ],
      },
      {
        id: "wf_other",
        name: "Different credential",
        active: false,
        nodes: [
          {
            id: "node_other",
            name: "Other",
            type: "n8n-nodes-base.postgres",
            credentials: { postgres: { id: "cred_other", name: "Other account" } },
          },
        ],
      },
    ],
    nextCursor: null,
  };

  await withConnectedClient(
    async () => json(page),
    async (client) => {
      const result = await client.callTool({
        name: "n8n_credentials_usage",
        arguments: { credentialId: "cred_target" },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const data = structuredData(result);
      assert.equal(data.workflowsExamined, 5);
      assert.equal(data.matchingWorkflowCount, 1);
      assert.equal(data.referencesScanned, 5);
      assert.equal(data.referencesUnresolved, 3);
      const workflows = data.workflows;
      assert(Array.isArray(workflows));
      assert.equal(workflows.length, 1);
      assert.equal(objectBody(workflows[0]).workflowId, "wf_resolved");
      // Credential names are never leaked into the value-free result.
      assert(!JSON.stringify(result).includes("Legacy Postgres account"));
    },
  );
});

test("FABLE-R2-P2-07: an over-cap mutation result reports success with a truthful truncation summary", async () => {
  const blob = "alpha beta gamma delta ".repeat(1_200);
  const oversizedWorkflow = {
    id: "wf_big",
    versionId: "v9",
    name: "Oversized created workflow",
    active: false,
    isArchived: false,
    nodes: Array.from({ length: 20 }, (_, index) => ({
      id: `node_${index}`,
      name: `Node ${index}`,
      type: "n8n-nodes-base.noOp",
      typeVersion: 1,
      position: [index * 10, 0],
      parameters: { blob },
    })),
    connections: {},
    settings: {},
  };

  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/workflows" && request.method === "POST") {
        return json(oversizedWorkflow);
      }
      return json({ message: "No fixture" }, 404);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_workflows_create",
        arguments: {
          name: "Create oversized",
          nodes: [
            {
              id: "seed",
              name: "Seed",
              type: "n8n-nodes-base.noOp",
              typeVersion: 1,
              position: [0, 0],
              parameters: {},
            },
          ],
          connections: {},
        },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result).slice(0, 500));
      const data = structuredData(result);
      assert.equal(data.truncated, true);
      assert.equal(data.outcome, "success");
      const identity = objectBody(data.identity ?? null);
      assert.equal(identity.id, "wf_big");
      assert.equal(identity.name, "Oversized created workflow");
    },
  );
});

test("FABLE-R2-P3-06: execution stop derives a truthful state from the upstream body", async () => {
  const cases = [
    {
      upstream: { status: "canceled", finished: true, stoppedAt: "2026-07-20T00:00:00.000Z" },
      stopped: true,
      state: "stopped",
    },
    {
      upstream: { status: "success", finished: true, stoppedAt: null },
      stopped: false,
      state: "already_finished",
    },
    {
      upstream: { status: "running", finished: false },
      stopped: false,
      state: "unknown",
    },
  ] as const;

  for (const testCase of cases) {
    await withConnectedClient(
      async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/executions/exec_1/stop" && request.method === "POST") {
          return json(testCase.upstream);
        }
        return json({ message: "No fixture" }, 404);
      },
      async (client) => {
        const result = await client.callTool({
          name: "n8n_executions_stop",
          arguments: { executionId: "exec_1", confirmation: "STOP exec_1" },
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        const data = structuredData(result);
        assert.equal(data.stopped, testCase.stopped);
        assert.equal(data.state, testCase.state);
      },
    );
  }
});

test("FABLE-R2-P3-07: credential test truncates an over-cap message instead of discarding the outcome", async () => {
  const longMessage = "Upstream authentication diagnostic detail. ".repeat(40);
  assert(longMessage.length > 512);

  await withConnectedClient(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/credentials/cred_1/test" && request.method === "POST") {
        return json({ status: "Error", message: longMessage });
      }
      return json({ message: "No fixture" }, 404);
    },
    async (client) => {
      const result = await client.callTool({
        name: "n8n_credentials_test",
        arguments: { credentialId: "cred_1", confirmation: "TEST cred_1" },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result).slice(0, 500));
      const data = structuredData(result);
      assert.equal(data.status, "Error");
      assert.equal(data.truncated, true);
      assert(typeof data.message === "string");
      assert(data.message.length <= 512);
    },
  );
});

test("FABLE-R2-P3-19: a shape-drifted upstream response maps to upstream_shape_mismatch without Zod internals", async () => {
  await withConnectedClient(
    // An older or proxy-modified n8n returns a bare array instead of the { data, nextCursor } envelope.
    async () => json([{ id: "cred_1", name: "n8n API", type: "n8nApi" }]),
    async (client) => {
      const result = await client.callTool({
        name: "n8n_credentials_list",
        arguments: {},
      });
      assert.equal(result.isError, true);
      const serialized = JSON.stringify(result);
      assert(serialized.includes("upstream_shape_mismatch"));
      assert(serialized.includes("n8n_credentials_list"));
      for (const zodInternal of ["invalid_type", "ZodError", "issues", "received", "expected"]) {
        assert.equal(
          serialized.includes(zodInternal),
          false,
          `emitted error leaked Zod internal: ${zodInternal}`,
        );
      }
    },
  );
});
