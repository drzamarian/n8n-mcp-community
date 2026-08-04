import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertNoProjectNpmConfig,
  npmAuditEnvironment,
  verifyNpmAuditEnvironmentPolicySelfTest,
} from "./npm-audit-environment.mjs";
import { resolveNpmCli, runPortableCommandSync } from "./portable-cli.mjs";

const root = process.cwd();
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "n8n-mcp-consumer-"));
const consumerRoot = path.join(temporaryRoot, "consumer");
const npmCli = resolveNpmCli("npm");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const expectedSdkVersion = manifest.dependencies?.["@modelcontextprotocol/sdk"];
if (typeof expectedSdkVersion !== "string") {
  throw new Error("The candidate must pin @modelcontextprotocol/sdk.");
}

function npmEnvironment() {
  return { ...npmAuditEnvironment(), npm_config_loglevel: "silent" };
}

verifyNpmAuditEnvironmentPolicySelfTest();

function runNpm(args, cwd = root) {
  assertNoProjectNpmConfig(cwd);
  return runPortableCommandSync(npmCli.command, [...npmCli.argumentPrefix, ...args], {
    cwd,
    env: npmEnvironment(),
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    label: "Consumer-resolution npm subprocess",
  });
}

function auditConsumer() {
  assertNoProjectNpmConfig(consumerRoot);
  const result = spawnSync(
    npmCli.command,
    [...npmCli.argumentPrefix, "audit", "--omit=dev", "--json"],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      env: npmEnvironment(),
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error("Consumer audit exceeded its 120-second deadline.");
  }
  if (result.error?.code === "ENOBUFS") {
    throw new Error("Consumer audit exceeded its 16 MiB output bound.");
  }
  if (result.error) throw new Error("Consumer audit could not be launched.");
  if (result.status !== 0) {
    throw new Error(
      `The real-consumer production audit must be clean; received exit ${String(result.status)}.`,
    );
  }
  try {
    return { audit: JSON.parse(String(result.stdout)), exitStatus: result.status };
  } catch {
    throw new Error("Consumer audit did not return valid JSON.");
  }
}

function isPatchedHono2(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major === 2 && (minor > 0 || patch >= 5);
}

function assertCleanConsumerAudit(exitStatus, audit) {
  const vulnerabilityNames = Object.keys(audit.vulnerabilities ?? {}).sort();
  const totals = audit.metadata?.vulnerabilities;
  if (
    exitStatus !== 0 ||
    vulnerabilityNames.length !== 0 ||
    totals?.info !== 0 ||
    totals?.low !== 0 ||
    totals?.moderate !== 0 ||
    totals?.high !== 0 ||
    totals?.critical !== 0 ||
    totals?.total !== 0
  ) {
    throw new Error("The real-consumer audit is not unambiguously clean.");
  }
  return {
    advisoryRegistryStatus: "clear",
    residualStatus: "upstream_range_fixed_candidate_clean",
    status: "pass_clean_consumer",
  };
}

const cleanFixture = {
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
  },
};
function rejectsConsumerAudit(exitStatus, audit) {
  try {
    assertCleanConsumerAudit(exitStatus, audit);
    return false;
  } catch {
    return true;
  }
}
const namedVulnerabilityFixture = structuredClone(cleanFixture);
namedVulnerabilityFixture.vulnerabilities.synthetic = { severity: "high" };
const nonzeroTotalFixture = structuredClone(cleanFixture);
nonzeroTotalFixture.metadata.vulnerabilities.total = 1;
if (
  !isPatchedHono2("2.0.5") ||
  !isPatchedHono2("2.1.0") ||
  isPatchedHono2("2.0.4") ||
  isPatchedHono2("1.19.17") ||
  isPatchedHono2("3.0.0") ||
  isPatchedHono2(undefined) ||
  isPatchedHono2("") ||
  isPatchedHono2("2.0") ||
  isPatchedHono2("2.0.5-rc.1") ||
  assertCleanConsumerAudit(0, cleanFixture).advisoryRegistryStatus !== "clear" ||
  !rejectsConsumerAudit(1, cleanFixture) ||
  !rejectsConsumerAudit(0, namedVulnerabilityFixture) ||
  !rejectsConsumerAudit(0, nonzeroTotalFixture) ||
  !rejectsConsumerAudit(0, {})
) {
  throw new Error("Consumer audit transition policy self-test failed.");
}

try {
  await mkdir(consumerRoot);
  const packed = JSON.parse(
    runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot]),
  );
  const artifact = (Array.isArray(packed) ? packed : Object.values(packed))[0];
  if (!artifact?.filename) throw new Error("Consumer verification produced no npm artifact.");
  const tarball = path.join(temporaryRoot, artifact.filename);
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify({
      name: "n8n-mcp-community-consumer-verifier",
      version: "1.0.0",
      private: true,
      dependencies: { [manifest.name]: `file:${tarball}` },
    })}\n`,
  );
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumerRoot);

  const installedManifest = JSON.parse(
    await readFile(path.join(consumerRoot, "node_modules", manifest.name, "package.json"), "utf8"),
  );
  const consumerManifest = JSON.parse(
    await readFile(path.join(consumerRoot, "package.json"), "utf8"),
  );
  if (installedManifest.version !== manifest.version || consumerManifest.overrides !== undefined) {
    throw new Error(
      "The disposable consumer did not install the exact candidate without overrides.",
    );
  }

  const dependencyTree = JSON.parse(runNpm(["ls", "@hono/node-server", "--json"], consumerRoot));
  const candidateDependency = dependencyTree.dependencies?.[manifest.name];
  const sdkDependency = candidateDependency?.dependencies?.["@modelcontextprotocol/sdk"];
  const honoVersion = sdkDependency?.dependencies?.["@hono/node-server"]?.version;
  if (
    candidateDependency?.version !== manifest.version ||
    sdkDependency?.version !== expectedSdkVersion ||
    !isPatchedHono2(honoVersion)
  ) {
    throw new Error(
      `The reviewed consumer dependency chain changed: candidate=${String(candidateDependency?.version)}, SDK=${String(sdkDependency?.version)}, Hono=${String(honoVersion)}.`,
    );
  }

  const { audit, exitStatus } = auditConsumer();
  const auditState = assertCleanConsumerAudit(exitStatus, audit);

  const entry = path.join(consumerRoot, "node_modules", manifest.name, "dist", "index.js");
  const version = runPortableCommandSync(process.execPath, [entry, "--version"], {
    cwd: consumerRoot,
    timeout: 30_000,
    label: "Real-consumer CLI smoke",
  });
  if (version !== manifest.version)
    throw new Error("Real-consumer CLI returned the wrong version.");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: consumerRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "real-consumer-verifier", version: "1.0.0" });
  let inventory;
  try {
    await client.connect(transport);
    const [tools, resources, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listPrompts(),
    ]);
    inventory = {
      tools: tools.tools.length,
      resources: resources.resources.length,
      prompts: prompts.prompts.length,
    };
  } finally {
    await client.close();
  }
  if (inventory.tools !== 44 || inventory.resources !== 5 || inventory.prompts !== 4) {
    throw new Error(`Real-consumer inventory mismatch: ${JSON.stringify(inventory)}`);
  }

  console.log(
    JSON.stringify(
      {
        candidateVersion: manifest.version,
        consumerRootOverrides: false,
        installedHonoVersion: honoVersion,
        ...auditState,
        ...inventory,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
