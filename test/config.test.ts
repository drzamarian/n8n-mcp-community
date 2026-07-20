import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigurationError,
  readN8nConnection,
  readStartupConfig,
  type ConfigurationReason,
} from "../src/config.js";

function expectConfigurationFailure(
  run: () => unknown,
  reason: ConfigurationReason,
  setting: string,
): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.equal(error.code, "configuration_error");
    assert.equal(error.reason, reason);
    assert.equal(error.setting, setting);
    return true;
  });
}

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

test("connection parsing rejects an API key that is an illegal HTTP header value", () => {
  const startup = readStartupConfig({});
  const maliciousKey = "secret\nkey-π";
  assert.throws(
    () =>
      readN8nConnection(startup, {
        N8N_API_URL: "https://n8n.example.test",
        N8N_API_KEY: maliciousKey,
      }),
    (error: unknown) =>
      error instanceof ConfigurationError &&
      !error.message.includes("secret") &&
      !error.message.includes(maliciousKey),
  );
  assert.equal(
    readN8nConnection(startup, {
      N8N_API_URL: "https://n8n.example.test",
      N8N_API_KEY: "eyJhbGciOiJIUzI1NiJ9.header-value.signature_-",
    }).apiKey,
    "eyJhbGciOiJIUzI1NiJ9.header-value.signature_-",
  );
});

test("every configuration rule failure emits a distinct reason code and names one setting", () => {
  const startup = readStartupConfig({});
  const url = "https://n8n.example.test";
  const key = "placeholder";

  // Startup rules.
  expectConfigurationFailure(
    () => readStartupConfig({ N8N_MCP_MODE: "admin" }),
    "mode_invalid",
    "N8N_MCP_MODE",
  );
  expectConfigurationFailure(
    () => readStartupConfig({ N8N_ALLOW_INSECURE_HTTP: "true" }),
    "insecure_http_flag_invalid",
    "N8N_ALLOW_INSECURE_HTTP",
  );

  // N8N_API_URL missing: unset, empty, and whitespace-only all name the URL setting.
  for (const value of [undefined, "", "   "]) {
    expectConfigurationFailure(
      () => readN8nConnection(startup, { N8N_API_URL: value, N8N_API_KEY: key }),
      "api_url_missing",
      "N8N_API_URL",
    );
  }

  // N8N_API_KEY missing: unset and whitespace-only both name the key setting.
  for (const value of [undefined, "   "]) {
    expectConfigurationFailure(
      () => readN8nConnection(startup, { N8N_API_URL: url, N8N_API_KEY: value }),
      "api_key_missing",
      "N8N_API_KEY",
    );
  }

  // N8N_API_KEY present but illegal as an HTTP header value.
  expectConfigurationFailure(
    () => readN8nConnection(startup, { N8N_API_URL: url, N8N_API_KEY: "abc\ndef" }),
    "api_key_invalid",
    "N8N_API_KEY",
  );

  // N8N_API_URL shape and transport rules.
  expectConfigurationFailure(
    () => readN8nConnection(startup, { N8N_API_URL: "not an absolute URL", N8N_API_KEY: key }),
    "api_url_invalid",
    "N8N_API_URL",
  );
  expectConfigurationFailure(
    () => readN8nConnection(startup, { N8N_API_URL: "ftp://n8n.example.test", N8N_API_KEY: key }),
    "api_url_scheme_unsupported",
    "N8N_API_URL",
  );
  expectConfigurationFailure(
    () =>
      readN8nConnection(startup, {
        N8N_API_URL: "https://name:password@n8n.example.test",
        N8N_API_KEY: key,
      }),
    "api_url_embedded_credentials",
    "N8N_API_URL",
  );
  for (const value of [`${url}?token=value`, `${url}#fragment`]) {
    expectConfigurationFailure(
      () => readN8nConnection(startup, { N8N_API_URL: value, N8N_API_KEY: key }),
      "api_url_query_or_fragment",
      "N8N_API_URL",
    );
  }
  expectConfigurationFailure(
    () => readN8nConnection(startup, { N8N_API_URL: "http://n8n.example.test", N8N_API_KEY: key }),
    "api_url_insecure_http",
    "N8N_API_URL",
  );
});
