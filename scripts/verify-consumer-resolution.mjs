import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveNpmCli, runPortableCommandSync } from "./portable-cli.mjs";

const root = process.cwd();
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "n8n-mcp-consumer-"));
const consumerRoot = path.join(temporaryRoot, "consumer");
const npmCli = resolveNpmCli("npm");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const expectedAdvisory = "https://github.com/advisories/GHSA-frvp-7c67-39w9";
const reviewedBackportVersion = "1.19.15";
const expectedSdkVersion = manifest.dependencies?.["@modelcontextprotocol/sdk"];
if (typeof expectedSdkVersion !== "string") {
  throw new Error("The candidate must pin @modelcontextprotocol/sdk.");
}

function npmEnvironment() {
  const env = { ...process.env, npm_config_loglevel: "silent" };
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  return env;
}

function runNpm(args, cwd = root) {
  return runPortableCommandSync(npmCli.command, [...npmCli.argumentPrefix, ...args], {
    cwd,
    env: npmEnvironment(),
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    label: "Consumer-resolution npm subprocess",
  });
}

function auditConsumer() {
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
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `Consumer audit must exit 0 or 1; received ${String(result.status)}. Investigate UPSTREAM-SDK-001 before changing this gate.`,
    );
  }
  try {
    return { audit: JSON.parse(String(result.stdout)), exitStatus: result.status };
  } catch {
    throw new Error("Consumer audit did not return valid JSON.");
  }
}

function classifyConsumerAudit(exitStatus, audit) {
  const vulnerabilityNames = Object.keys(audit.vulnerabilities ?? {}).sort();
  const totals = audit.metadata?.vulnerabilities;
  const expectedTotals =
    totals?.info === 0 && totals?.low === 0 && totals?.high === 0 && totals?.critical === 0;
  if (exitStatus === 0) {
    if (
      vulnerabilityNames.length !== 0 ||
      !expectedTotals ||
      totals?.moderate !== 0 ||
      totals?.total !== 0
    ) {
      throw new Error("The clean real-consumer audit contains inconsistent vulnerability data.");
    }
    return {
      advisoryRegistryStatus: "clear",
      residualStatus: "reviewed_backport_observed_release_closure_pending",
      status: "pass_with_reviewed_upstream_backport",
    };
  }
  if (
    exitStatus !== 1 ||
    JSON.stringify(vulnerabilityNames) !==
      JSON.stringify(["@hono/node-server", "@modelcontextprotocol/sdk", manifest.name].sort()) ||
    !expectedTotals ||
    totals?.total !== 3 ||
    totals?.moderate !== 3
  ) {
    throw new Error("The real-consumer audit differs from the one tracked upstream residual.");
  }
  const hono = audit.vulnerabilities?.["@hono/node-server"];
  const sdk = audit.vulnerabilities?.["@modelcontextprotocol/sdk"];
  const candidate = audit.vulnerabilities?.[manifest.name];
  const honoAdvisories = hono?.via;
  if (
    !Array.isArray(honoAdvisories) ||
    honoAdvisories.length !== 1 ||
    honoAdvisories[0]?.url !== expectedAdvisory ||
    honoAdvisories[0]?.range !== "<2.0.5" ||
    hono?.name !== "@hono/node-server" ||
    hono?.severity !== "moderate" ||
    hono?.isDirect !== false ||
    hono?.range !== "<2.0.5" ||
    JSON.stringify(hono?.effects) !== JSON.stringify(["@modelcontextprotocol/sdk"]) ||
    JSON.stringify(hono?.nodes) !== JSON.stringify(["node_modules/@hono/node-server"]) ||
    hono?.fixAvailable !== false ||
    sdk?.name !== "@modelcontextprotocol/sdk" ||
    sdk?.severity !== "moderate" ||
    sdk?.isDirect !== false ||
    sdk?.range !== ">=1.25.0" ||
    JSON.stringify(sdk?.via) !== JSON.stringify(["@hono/node-server"]) ||
    JSON.stringify(sdk?.effects) !== JSON.stringify([manifest.name]) ||
    JSON.stringify(sdk?.nodes) !== JSON.stringify(["node_modules/@modelcontextprotocol/sdk"]) ||
    sdk?.fixAvailable !== false ||
    candidate?.name !== manifest.name ||
    candidate?.severity !== "moderate" ||
    candidate?.isDirect !== true ||
    candidate?.range !== "*" ||
    JSON.stringify(candidate?.via) !== JSON.stringify(["@modelcontextprotocol/sdk"]) ||
    JSON.stringify(candidate?.effects) !== JSON.stringify([]) ||
    JSON.stringify(candidate?.nodes) !== JSON.stringify([`node_modules/${manifest.name}`]) ||
    candidate?.fixAvailable !== false
  ) {
    throw new Error(
      "The real-consumer audit no longer matches the reviewed GHSA dependency chain exactly.",
    );
  }
  return {
    advisoryRegistryStatus: "present",
    residualStatus: "advisory_present_not_reachable_in_stdio_design",
    status: "pass_with_tracked_upstream_advisory",
  };
}

const residualFixture = {
  vulnerabilities: {
    "@hono/node-server": {
      name: "@hono/node-server",
      severity: "moderate",
      isDirect: false,
      via: [{ url: expectedAdvisory, range: "<2.0.5" }],
      effects: ["@modelcontextprotocol/sdk"],
      range: "<2.0.5",
      nodes: ["node_modules/@hono/node-server"],
      fixAvailable: false,
    },
    "@modelcontextprotocol/sdk": {
      name: "@modelcontextprotocol/sdk",
      severity: "moderate",
      isDirect: false,
      via: ["@hono/node-server"],
      effects: [manifest.name],
      range: ">=1.25.0",
      nodes: ["node_modules/@modelcontextprotocol/sdk"],
      fixAvailable: false,
    },
    [manifest.name]: {
      name: manifest.name,
      severity: "moderate",
      isDirect: true,
      via: ["@modelcontextprotocol/sdk"],
      effects: [],
      range: "*",
      nodes: [`node_modules/${manifest.name}`],
      fixAvailable: false,
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 3, high: 0, critical: 0, total: 3 },
  },
};
const cleanFixture = {
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
  },
};
if (
  classifyConsumerAudit(1, residualFixture).advisoryRegistryStatus !== "present" ||
  classifyConsumerAudit(0, cleanFixture).advisoryRegistryStatus !== "clear"
) {
  throw new Error("Consumer audit transition policy self-test failed.");
}
const driftFixture = structuredClone(residualFixture);
driftFixture.vulnerabilities["@modelcontextprotocol/sdk"].via = ["unexpected-advisory"];
let driftRejected = false;
try {
  classifyConsumerAudit(1, driftFixture);
} catch {
  driftRejected = true;
}
if (!driftRejected) {
  throw new Error("Consumer audit dependency-chain drift self-test failed.");
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
    honoVersion !== reviewedBackportVersion
  ) {
    throw new Error(
      `The reviewed consumer dependency chain changed: candidate=${String(candidateDependency?.version)}, SDK=${String(sdkDependency?.version)}, Hono=${String(honoVersion)}. Investigate UPSTREAM-SDK-001 before changing this gate.`,
    );
  }

  const { audit, exitStatus } = auditConsumer();
  const auditState = classifyConsumerAudit(exitStatus, audit);

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
        advisory: expectedAdvisory,
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
