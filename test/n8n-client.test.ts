import assert from "node:assert/strict";
import test from "node:test";
import { N8nApiError, N8nClient } from "../src/n8n/client.js";

const config = {
  apiUrl: new URL("https://n8n.example.test/base"),
  apiKey: "not-a-real-key",
};

async function withFetch(implementation: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("the main client binds API-key requests to the configured origin and encoded query", async () => {
  await withFetch(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      assert.equal(request.url, "https://n8n.example.test/base/api/v1/workflows?name=a+b");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("X-N8N-API-KEY"), "not-a-real-key");
      assert.equal(request.redirect, "manual");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
    async () => {
      const value = await new N8nClient(config).request({
        path: "/workflows",
        query: { name: "a b" },
      });
      assert.deepEqual(value, { data: [] });
    },
  );
});

test("the main client preserves a safely encoded email path segment inside the API root", async () => {
  await withFetch(
    async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      assert.equal(request.url, "https://n8n.example.test/base/api/v1/users/member%40example.test");
      return new Response(JSON.stringify({ id: "user_1" }), { status: 200 });
    },
    async () => {
      const value = await new N8nClient(config).request({
        path: "/users/member%40example.test",
      });
      assert.deepEqual(value, { id: "user_1" });
    },
  );
});

test("the main client rejects invalid paths before fetch", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return new Response();
    },
    async () => {
      for (const path of [
        "/workflows/../rest/settings",
        "/workflows/%2e%2e/rest/settings",
        "/workflows/%252e%252e/rest/settings",
        "/workflows/%2frest/settings",
        "/users/%ZZ",
      ]) {
        await assert.rejects(
          () => new N8nClient(config).request({ path }),
          (error: unknown) => error instanceof N8nApiError && error.code === "invalid_path",
          path,
        );
      }
      assert.equal(calls, 0);
    },
  );
});

test("the main client never echoes an illegal API-key header value in errors", async () => {
  const maliciousKey = "secret\nkey-π";
  const hostileConfig = { apiUrl: new URL("https://n8n.example.test/base"), apiKey: maliciousKey };
  let fetchCalled = false;
  await withFetch(
    async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
    async () => {
      await assert.rejects(
        () => new N8nClient(hostileConfig).request({ path: "/workflows" }),
        (error: unknown) =>
          error instanceof N8nApiError &&
          error.code === "request_failed" &&
          !error.message.includes("secret") &&
          !error.message.includes("key-π") &&
          !error.message.includes(maliciousKey),
      );
    },
  );
  assert.equal(fetchCalled, false);
});

test("a floor-marker 404 attaches version-floor guidance to the upstream error", async () => {
  for (const path of [
    "/credentials",
    "/credentials/abc",
    "/insights/summary",
    "/community-packages",
  ]) {
    await withFetch(
      async () => new Response("{}", { status: 404 }),
      async () => {
        await assert.rejects(
          () => new N8nClient(config).request({ path }),
          (error: unknown) =>
            error instanceof N8nApiError &&
            error.code === "upstream_error" &&
            error.status === 404 &&
            error.message.startsWith("The n8n API returned HTTP 404.") &&
            error.message.includes("n8n Community 2.30.5"),
          path,
        );
      },
    );
  }
});

test("a non-marker 404 carries no version-floor guidance and keeps the bare upstream message", async () => {
  // `/workflows` sub-paths are excluded on purpose: they exist below the floor and the
  // version-history 404 is already mapped by the workflow tools, so no floor guidance here.
  for (const path of [
    "/workflows",
    "/workflows/wf_1",
    "/workflows/wf_1/v6",
    "/tags",
    "/executions",
  ]) {
    await withFetch(
      async () => new Response("{}", { status: 404 }),
      async () => {
        await assert.rejects(
          () => new N8nClient(config).request({ path }),
          (error: unknown) =>
            error instanceof N8nApiError &&
            error.code === "upstream_error" &&
            error.status === 404 &&
            error.message === "The n8n API returned HTTP 404." &&
            !error.message.includes("2.30.5"),
          path,
        );
      },
    );
  }
});

test("redirects, oversized declarations, invalid JSON, and upstream bodies fail safely", async () => {
  const fixtures = [
    new Response(null, { status: 302, headers: { location: "https://evil.example.test" } }),
    new Response("{}", { status: 200, headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
    new Response("not json", { status: 200 }),
    new Response("not-a-real-key UNIT-CANARY", { status: 500 }),
  ];
  const codes = ["redirect_rejected", "response_too_large", "invalid_json", "upstream_error"];
  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index];
    const expected = codes[index];
    assert(fixture);
    assert(expected);
    await withFetch(
      async () => fixture,
      async () => {
        await assert.rejects(
          () => new N8nClient(config).request({ path: "/workflows" }),
          (error: unknown) =>
            error instanceof N8nApiError &&
            error.code === expected &&
            !error.message.includes("not-a-real-key") &&
            !error.message.includes("UNIT-CANARY"),
        );
      },
    );
  }
});
