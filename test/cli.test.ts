import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { buildDoctorReport } from "../src/doctor.js";

const ENTRY = resolve("dist/index.js");

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
  assert.match(doctor.stderr, /"code":"configuration_error"/);
  assert.equal(doctor.stdout, "");

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
