import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationError, readN8nConnection, readStartupConfig } from "../src/config.js";

test("startup is offline-first and defaults to read-only", () => {
  assert.deepEqual(readStartupConfig({}), { mode: "read-only", allowInsecureHttp: false });
});

test("startup rejects ambiguous mode and boolean values", () => {
  assert.deepEqual(readStartupConfig({ N8N_MCP_MODE: "write", N8N_ALLOW_INSECURE_HTTP: "1" }), {
    mode: "write",
    allowInsecureHttp: true,
  });
  assert.deepEqual(readStartupConfig({ N8N_MCP_MODE: "unsafe", N8N_ALLOW_INSECURE_HTTP: "0" }), {
    mode: "unsafe",
    allowInsecureHttp: false,
  });
  assert.throws(() => readStartupConfig({ N8N_MCP_MODE: "admin" }), ConfigurationError);
  assert.throws(() => readStartupConfig({ N8N_ALLOW_INSECURE_HTTP: "true" }), ConfigurationError);
});

test("connection parsing enforces credentials, URL shape, and transport policy", () => {
  const startup = readStartupConfig({});
  assert.throws(() => readN8nConnection(startup, {}), ConfigurationError);
  assert.throws(
    () => readN8nConnection(startup, { N8N_API_URL: "https://n8n.example.test" }),
    ConfigurationError,
  );
  assert.throws(
    () =>
      readN8nConnection(startup, {
        N8N_API_URL: "not an absolute URL",
        N8N_API_KEY: "placeholder",
      }),
    ConfigurationError,
  );
  assert.throws(
    () =>
      readN8nConnection(startup, {
        N8N_API_URL: "ftp://n8n.example.test",
        N8N_API_KEY: "placeholder",
      }),
    ConfigurationError,
  );
  assert.throws(
    () =>
      readN8nConnection(startup, {
        N8N_API_URL: "http://n8n.example.test",
        N8N_API_KEY: "placeholder",
      }),
    ConfigurationError,
  );
  assert.throws(
    () =>
      readN8nConnection(startup, {
        N8N_API_URL: "https://n8n.example.test#fragment",
        N8N_API_KEY: "placeholder",
      }),
    ConfigurationError,
  );
  assert.equal(
    readN8nConnection(startup, {
      N8N_API_URL: "http://localhost:5678",
      N8N_API_KEY: " placeholder ",
    }).apiKey,
    "placeholder",
  );
  assert.throws(
    () =>
      readN8nConnection(startup, {
        N8N_API_URL: "https://name:password@n8n.example.test",
        N8N_API_KEY: "placeholder",
      }),
    ConfigurationError,
  );
  assert.throws(
    () =>
      readN8nConnection(startup, {
        N8N_API_URL: "https://n8n.example.test?token=value",
        N8N_API_KEY: "placeholder",
      }),
    ConfigurationError,
  );
  assert.equal(
    readN8nConnection(startup, {
      N8N_API_URL: "http://127.0.0.1:5678/",
      N8N_API_KEY: "placeholder",
    }).apiUrl.href,
    "http://127.0.0.1:5678/",
  );
  assert.equal(
    readN8nConnection(startup, {
      N8N_API_URL: "https://n8n.example.test/base/",
      N8N_API_KEY: "placeholder",
    }).apiUrl.href,
    "https://n8n.example.test/base",
  );
  assert.equal(
    readN8nConnection(readStartupConfig({ N8N_ALLOW_INSECURE_HTTP: "1" }), {
      N8N_API_URL: "http://n8n.example.test",
      N8N_API_KEY: "placeholder",
    }).apiUrl.href,
    "http://n8n.example.test/",
  );
  assert.equal(
    readN8nConnection(startup, {
      N8N_API_URL: "http://[::1]:5678",
      N8N_API_KEY: "placeholder",
    }).apiUrl.href,
    "http://[::1]:5678/",
  );
});
