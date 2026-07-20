import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { buildDoctorReport, probeFloorCompatibility } from "../src/doctor.js";
import { N8nClient } from "../src/n8n/client.js";

const ENTRY = resolve("dist/index.js");

const probeConfig = {
  apiUrl: new URL("https://n8n.example.test"),
  apiKey: "synthetic-doctor-key",
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

// Resolve a mock fetch call to the requested Public API path (query stripped) so a
// per-endpoint status map can drive the floor probe deterministically and offline.
function requestedPath(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const request = input instanceof Request ? input : new Request(input, init);
  return new URL(request.url).pathname;
}

function run(args: readonly string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
    timeout: 5_000,
  });
}

test("help and version are bounded offline commands", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(help.stderr, "");

  const version = run(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^0\.1\.0\s*$/);
  assert.equal(version.stderr, "");
});

test("doctor validates configuration without exposing connection values", () => {
  const apiKey = "DOCTOR-KEY-MUST-NOT-APPEAR";
  const host = "private-n8n.example.test";
  const result = run(["doctor"], {
    N8N_API_URL: `https://${host}`,
    N8N_API_KEY: apiKey,
    N8N_MCP_MODE: "read-only",
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout) as unknown;
  assert.deepEqual(output, {
    status: "pass",
    networkAccess: false,
    node: { major: Number(process.versions.node.split(".")[0]), supported: true },
    configuration: {
      mode: "read-only",
      apiUrlConfigured: true,
      apiKeyConfigured: true,
      transport: "https",
      insecureHttpExplicitlyAllowed: false,
    },
  });
  assert(!result.stdout.includes(apiKey));
  assert(!result.stdout.includes(host));
  assert.equal(result.stderr, "");
});

test("doctor and unknown arguments fail with fixed non-secret errors", () => {
  const doctor = run(["doctor"]);
  assert.equal(doctor.status, 1);
  assert.equal(doctor.stdout, "");
  assert.deepEqual(JSON.parse(doctor.stderr.trim()) as unknown, {
    event: "startup_failed",
    code: "configuration_error",
    reason: "api_url_missing",
    setting: "N8N_API_URL",
  });

  // A different failing rule names a different setting and reason, so the documented
  // "correct only the named setting" remediation is actionable.
  const badFlag = run(["doctor"], { N8N_ALLOW_INSECURE_HTTP: "true" });
  assert.equal(badFlag.status, 1);
  assert.equal(badFlag.stdout, "");
  assert.deepEqual(JSON.parse(badFlag.stderr.trim()) as unknown, {
    event: "startup_failed",
    code: "configuration_error",
    reason: "insecure_http_flag_invalid",
    setting: "N8N_ALLOW_INSECURE_HTTP",
  });

  const unknown = run(["--unknown"]);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stderr.trim(), '{"event":"startup_failed","code":"startup_error"}');
  assert.equal(unknown.stdout, "");
});

test("doctor reports a non-pass status for an injected unsupported Node line", () => {
  const report = buildDoctorReport(
    { mode: "read-only", allowInsecureHttp: false },
    {
      apiUrl: new URL("https://n8n.example.test"),
      apiKey: "synthetic-doctor-key",
    },
    "20.19.0",
  );
  assert.equal(report.status, "fail");
  assert.deepEqual(report.node, { major: 20, supported: false });
});

test("doctor floor probe reports floor_compatible when marker endpoints respond", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    async () => {
      const report = await probeFloorCompatibility(new N8nClient(probeConfig));
      assert.equal(report.diagnosis, "floor_compatible");
      assert.equal(report.remoteVersionDetected, false);
      assert.equal(report.documentedFloor, "n8n Community 2.30.5");
      assert.deepEqual(report.endpoints, [
        { endpoint: "GET /workflows", availability: "available" },
        { endpoint: "GET /credentials", availability: "available" },
      ]);
    },
  );
});

test("doctor floor probe reports below_floor_indicators without fabricating a version", async () => {
  await withFetch(
    async (input, init) => {
      const status = requestedPath(input, init).endsWith("/credentials") ? 404 : 200;
      return new Response(JSON.stringify({ data: [] }), { status });
    },
    async () => {
      const report = await probeFloorCompatibility(new N8nClient(probeConfig));
      assert.equal(report.diagnosis, "below_floor_indicators");
      assert.equal(report.remoteVersionDetected, false);
      assert.equal(report.documentedFloor, "n8n Community 2.30.5");
      assert.deepEqual(report.endpoints, [
        { endpoint: "GET /workflows", availability: "available" },
        { endpoint: "GET /credentials", availability: "not_found" },
      ]);
      // The Public API exposes no version, so the probe must never claim or fabricate one:
      // the only version token in the report is the documented floor constant.
      const serialized = JSON.stringify(report);
      assert.equal(serialized.match(/\d+\.\d+\.\d+/gu)?.join(",") ?? "", "2.30.5");
      for (const key of ["version", "detectedVersion", "instanceVersion", "remoteVersion"]) {
        assert(!Object.prototype.hasOwnProperty.call(report, key));
      }
    },
  );
});

test("doctor floor probe reports inconclusive when the control endpoint is unreachable", async () => {
  await withFetch(
    async () => new Response("{}", { status: 404 }),
    async () => {
      const report = await probeFloorCompatibility(new N8nClient(probeConfig));
      assert.equal(report.diagnosis, "inconclusive");
      assert.equal(report.remoteVersionDetected, false);
      assert.deepEqual(report.endpoints, [
        { endpoint: "GET /workflows", availability: "not_found" },
        { endpoint: "GET /credentials", availability: "not_found" },
      ]);
    },
  );
});

test("doctor floor probe reports inconclusive when a marker fails with a non-404 status", async () => {
  await withFetch(
    async (input, init) => {
      const status = requestedPath(input, init).endsWith("/credentials") ? 403 : 200;
      return new Response(JSON.stringify({ data: [] }), { status });
    },
    async () => {
      const report = await probeFloorCompatibility(new N8nClient(probeConfig));
      assert.equal(report.diagnosis, "inconclusive");
      assert.equal(report.remoteVersionDetected, false);
      assert.deepEqual(report.endpoints, [
        { endpoint: "GET /workflows", availability: "available" },
        { endpoint: "GET /credentials", availability: "error" },
      ]);
    },
  );
});

test("doctor probe mode adds a compatibility diagnosis while the default stays offline", () => {
  const probe = run(["doctor"], {
    N8N_API_URL: "https://private-n8n.example.test",
    N8N_API_KEY: "DOCTOR-PROBE-KEY-MUST-NOT-APPEAR",
    N8N_MCP_MODE: "read-only",
    N8N_MCP_DOCTOR_PROBE: "1",
  });
  assert.equal(probe.status, 0);
  const output = JSON.parse(probe.stdout) as {
    networkAccess: boolean;
    compatibility?: { diagnosis: string; remoteVersionDetected: boolean };
  };
  assert.equal(output.networkAccess, true);
  assert.equal(output.compatibility?.diagnosis, "inconclusive");
  assert.equal(output.compatibility?.remoteVersionDetected, false);
  assert(!probe.stdout.includes("DOCTOR-PROBE-KEY-MUST-NOT-APPEAR"));

  const offline = run(["doctor"], {
    N8N_API_URL: "https://private-n8n.example.test",
    N8N_API_KEY: "DOCTOR-PROBE-KEY-MUST-NOT-APPEAR",
    N8N_MCP_MODE: "read-only",
  });
  assert.equal(offline.status, 0);
  const offlineOutput = JSON.parse(offline.stdout) as Record<string, unknown>;
  assert.equal(offlineOutput["networkAccess"], false);
  assert.equal("compatibility" in offlineOutput, false);
});

test("a broken stdout pipe mid-session ends with one controlled stderr line, not a raw stack", async () => {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH },
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  // Swallow parent-side stream errors so destroying stdout cannot crash the test.
  child.stdout.on("error", () => {});
  child.stdin.on("error", () => {});

  const send = (message: unknown): void => {
    if (child.stdin.writable && !child.stdin.destroyed) {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        // The child may already be gone; the exit assertions cover the outcome.
      }
    }
  };

  const exited = new Promise<number>((resolveExit) => {
    child.once("exit", (code) => resolveExit(code ?? -1));
  });
  const guard = setTimeout(() => child.kill("SIGKILL"), 4_000);

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "epipe-regression", version: "0.0.0" },
      },
    });

    // Wait for the initialize response (proving the server writes to stdout) or a
    // short ceiling, then break the pipe and force another response write.
    await new Promise<void>((resolveReady) => {
      const timer = setTimeout(resolveReady, 1_500);
      child.stdout.once("data", () => {
        clearTimeout(timer);
        resolveReady();
      });
    });

    child.stdout.destroy();
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const code = await exited;
    assert.equal(code, 0);
    assert.equal(stderr.trim(), '{"event":"transport_closed"}');
    assert.doesNotMatch(stderr, /StdioServerTransport/);
    assert.doesNotMatch(stderr, /Unhandled 'error' event/);
  } finally {
    clearTimeout(guard);
    if (!child.killed) child.kill("SIGKILL");
  }
});
