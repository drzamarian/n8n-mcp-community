import assert from "node:assert/strict";
import test from "node:test";
import { IntrospectCollectionError } from "../src/introspect/collector.js";
import type { ReadBudget } from "../src/introspect/contracts.js";
import { createN8nReadClient } from "../src/introspect/http-client.js";

const API_KEY = ["api", "key", "canary"].join("-");

function budget(overrides: Partial<ReadBudget> = {}): ReadBudget {
  return {
    maxBytes: 1_024,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function fetchStub(
  implementation: (input: URL, init: RequestInit) => Promise<Response>,
): typeof fetch {
  return implementation as unknown as typeof fetch;
}

test("the reader sends a GET with encoded query and returns exact JSON bytes", async () => {
  let observedUrl = "";
  let observedKey = "";
  let beforeRequests = 0;
  const body = JSON.stringify({ ok: true });
  const client = createN8nReadClient({
    baseUrl: "https://n8n.example.test",
    apiKey: API_KEY,
    beforeRequest: () => {
      beforeRequests += 1;
    },
    fetchImplementation: fetchStub(async (input, init) => {
      observedUrl = input.toString();
      observedKey = new Headers(init.headers).get("X-N8N-API-KEY") ?? "";
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }),
  });

  const result = await client.get(
    "/executions",
    { cursor: "a+b/c", includeData: "false" },
    budget(),
  );
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.bytes, Buffer.byteLength(body));
  assert.equal(beforeRequests, 1);
  assert.equal(observedKey, API_KEY);
  assert.equal(
    observedUrl,
    "https://n8n.example.test/api/v1/executions?cursor=a%2Bb%2Fc&includeData=false",
  );
});

test("the reader preserves safe percent encoding and rejects traversal before fetch", async () => {
  let observedUrl = "";
  let fetchCalls = 0;
  const client = createN8nReadClient({
    baseUrl: "https://n8n.example.test/base",
    apiKey: API_KEY,
    fetchImplementation: fetchStub(async (input) => {
      fetchCalls += 1;
      observedUrl = input.toString();
      return new Response("{}", { status: 200 });
    }),
  });

  await client.get("/users/member%40example.test", {}, budget());
  assert.equal(observedUrl, "https://n8n.example.test/base/api/v1/users/member%40example.test");
  for (const endpoint of [
    "/workflows/%2e%2e/executions",
    "/workflows/%252e%252e/executions",
    "/workflows/%2fexecutions",
    "/workflows/%ZZ",
  ]) {
    await assert.rejects(
      client.get(endpoint, {}, budget()),
      (error: unknown) =>
        error instanceof IntrospectCollectionError && error.code === "invalid_path",
      endpoint,
    );
  }
  assert.equal(fetchCalls, 1);
});

test("an excessive Content-Length is rejected before body consumption", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = createN8nReadClient({
    baseUrl: "https://n8n.example.test",
    apiKey: API_KEY,
    fetchImplementation: fetchStub(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-length": "1025" },
        }),
    ),
  });

  await assert.rejects(
    client.get("/workflows/workflow-1", {}, budget()),
    (error: unknown) =>
      error instanceof IntrospectCollectionError && error.code === "response_too_large",
  );
  assert.equal(cancelled, true);
});

test("a chunked response is canceled as soon as it crosses the byte limit", async () => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(6).fill(65));
      if (pulls > 3) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = createN8nReadClient({
    baseUrl: "https://n8n.example.test",
    apiKey: API_KEY,
    fetchImplementation: fetchStub(async () => new Response(stream, { status: 200 })),
  });

  await assert.rejects(
    client.get("/workflows/workflow-1", {}, budget({ maxBytes: 10 })),
    (error: unknown) =>
      error instanceof IntrospectCollectionError && error.code === "response_too_large",
  );
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);
});

test("invalid UTF-8 and invalid JSON fail with stable error codes", async () => {
  const invalidUtf8 = createN8nReadClient({
    baseUrl: "https://n8n.example.test",
    apiKey: API_KEY,
    fetchImplementation: fetchStub(
      async () => new Response(new Uint8Array([0xc3, 0x28]), { status: 200 }),
    ),
  });
  await assert.rejects(
    invalidUtf8.get("/workflows/workflow-1", {}, budget()),
    (error: unknown) => error instanceof IntrospectCollectionError && error.code === "invalid_json",
  );

  const invalidJson = createN8nReadClient({
    baseUrl: "https://n8n.example.test",
    apiKey: API_KEY,
    fetchImplementation: fetchStub(async () => new Response("not-json", { status: 200 })),
  });
  await assert.rejects(
    invalidJson.get("/workflows/workflow-1", {}, budget()),
    (error: unknown) => error instanceof IntrospectCollectionError && error.code === "invalid_json",
  );
});

test("HTTP error bodies are bounded and never exposed, including API-key echoes", async () => {
  let cancelled = false;
  const body = `${API_KEY}${"x".repeat(20_000)}`;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = createN8nReadClient({
    baseUrl: "https://n8n.example.test",
    apiKey: API_KEY,
    fetchImplementation: fetchStub(async () => new Response(stream, { status: 502 })),
  });

  await assert.rejects(client.get("/workflows/workflow-1", {}, budget()), (error: unknown) => {
    assert.ok(error instanceof IntrospectCollectionError);
    assert.equal(error.code, "upstream_http_error");
    assert.equal(error.status, 502);
    assert.equal(error.message.includes(API_KEY), false);
    assert.equal(error.message.includes("x".repeat(100)), false);
    return true;
  });
  assert.equal(cancelled, true);
});

test("invalid request timeouts make zero fetch calls", async () => {
  let fetchCalls = 0;
  const client = createN8nReadClient({
    baseUrl: "https://n8n.example.test",
    apiKey: API_KEY,
    fetchImplementation: fetchStub(async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }),
  });
  await assert.rejects(
    client.get("/workflows/workflow-1", {}, budget({ timeoutMs: 0 })),
    (error: unknown) =>
      error instanceof IntrospectCollectionError && error.code === "deadline_exceeded",
  );
  assert.equal(fetchCalls, 0);
});

test("request timeouts abort the fetch and return a stable deadline error", async () => {
  const client = createN8nReadClient({
    baseUrl: "https://n8n.example.test",
    apiKey: API_KEY,
    fetchImplementation: fetchStub(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("raw timeout detail");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    ),
  });
  await assert.rejects(
    client.get("/workflows/workflow-1", {}, budget({ timeoutMs: 5 })),
    (error: unknown) => {
      assert.ok(error instanceof IntrospectCollectionError);
      assert.equal(error.code, "deadline_exceeded");
      assert.equal(error.message.includes("raw timeout detail"), false);
      return true;
    },
  );
});

test("redirect failures are sanitized and never retried", async () => {
  let fetchCalls = 0;
  const client = createN8nReadClient({
    baseUrl: "https://n8n.example.test",
    apiKey: API_KEY,
    fetchImplementation: fetchStub(async (_input, init) => {
      fetchCalls += 1;
      assert.equal(init.redirect, "error");
      throw new TypeError(`redirect to https://attacker.test/${API_KEY}`);
    }),
  });
  await assert.rejects(client.get("/workflows/workflow-1", {}, budget()), (error: unknown) => {
    assert.ok(error instanceof IntrospectCollectionError);
    assert.equal(error.code, "upstream_http_error");
    assert.equal(error.message.includes(API_KEY), false);
    assert.equal(error.message.includes("attacker.test"), false);
    return true;
  });
  assert.equal(fetchCalls, 1);
});
