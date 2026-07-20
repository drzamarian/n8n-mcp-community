import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verifyArtifactReviewForPackageState } from "./artifact-review.mjs";
import {
  assertMcpbBaselineFileCounts,
  EXPECTED_MCPB_PLATFORMS,
} from "./release-metadata-policy.mjs";
import { resolveNodeEntrypoint, runPortableCommandSync } from "./portable-cli.mjs";

const root = process.cwd();
const sourceDist = path.join(root, "dist");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const artifactBaseline = JSON.parse(
  await readFile(path.join(root, "release", "artifact-baseline.json"), "utf8"),
);
await verifyArtifactReviewForPackageState(root, packageJson.private);
const bundle = path.join(sourceDist, `n8n-mcp-community-${packageJson.version}.mcpb`);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "n8n-mcp-community-verify-"));
const unpacked = path.join(temporaryRoot, "bundle");
const mcpbCli = resolveNodeEntrypoint(
  path.join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js"),
  "MCPB",
);
const allowedLicenses = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "MIT",
]);
const noticeFile = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;

function run(command, args) {
  return runPortableCommandSync(command, args, {
    cwd: root,
    label: "An MCPB verification subprocess",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
}

function runMcpb(args) {
  return run(mcpbCli.command, [...mcpbCli.argumentPrefix, ...args]);
}

async function filesUnder(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory())
      output.push(...(await filesUnder(path.join(directory, entry.name), relative)));
    else output.push(relative);
  }
  return output.sort();
}

async function digest(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

try {
  run(process.execPath, [path.join(root, "scripts", "verify-signed-mcpb.mjs"), "--self-test"]);
  const firstArtifactHash = await digest(bundle);
  run(process.execPath, [path.join(root, "scripts", "build-mcpb.mjs")]);
  const artifactHash = await digest(bundle);
  const reproducible = firstArtifactHash === artifactHash;
  if (!reproducible) {
    throw new Error("Two consecutive MCPB builds were not byte-identical.");
  }
  runMcpb(["info", bundle]);
  runMcpb(["unpack", bundle, unpacked]);
  runMcpb(["validate", path.join(unpacked, "manifest.json")]);

  const manifest = JSON.parse(await readFile(path.join(unpacked, "manifest.json"), "utf8"));
  if (
    manifest.manifest_version !== "0.4" ||
    manifest.version !== packageJson.version ||
    manifest.server?.entry_point !== "server/dist/index.js" ||
    manifest.user_config?.n8nApiKey?.sensitive !== true ||
    manifest.user_config?.n8nApiUrl?.sensitive !== true ||
    manifest.user_config?.mode?.default !== "read-only" ||
    manifest.user_config?.allowInsecureHttp?.default !== "0" ||
    JSON.stringify(manifest.compatibility?.platforms) !== JSON.stringify(EXPECTED_MCPB_PLATFORMS)
  ) {
    throw new Error("The unpacked MCPB manifest does not preserve the approved security defaults.");
  }

  const sourceFiles = (await filesUnder(sourceDist)).filter((file) => !file.endsWith(".mcpb"));
  const bundledDist = path.join(unpacked, "server", "dist");
  const bundledFiles = await filesUnder(bundledDist);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(bundledFiles)) {
    throw new Error("MCPB dist inventory differs from the npm runtime build.");
  }
  for (const file of sourceFiles) {
    const [sourceHash, bundledHash] = await Promise.all([
      digest(path.join(sourceDist, file)),
      digest(path.join(bundledDist, file)),
    ]);
    if (sourceHash !== bundledHash) throw new Error(`MCPB runtime byte mismatch: ${file}`);
  }

  const allBundleFiles = await filesUnder(unpacked);
  for (const relative of allBundleFiles) {
    const metadata = await lstat(path.join(unpacked, relative));
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o644) {
      throw new Error(`MCPB file mode is not canonical 0644: ${relative}`);
    }
  }
  const projectFiles = allBundleFiles.filter((file) => !file.startsWith("server/node_modules/"));
  if (
    artifactBaseline.schemaVersion !== 1 ||
    artifactBaseline.packageVersion !== packageJson.version ||
    artifactBaseline.mcpb.sha256 !== artifactHash ||
    artifactBaseline.mcpb.totalFileCount !== allBundleFiles.length ||
    JSON.stringify(artifactBaseline.mcpb.runtimeFiles) !== JSON.stringify(sourceFiles) ||
    JSON.stringify(artifactBaseline.mcpb.projectFiles) !== JSON.stringify(projectFiles)
  ) {
    throw new Error("MCPB artifact differs from the exact reviewed manifest and digest.");
  }
  // Recompute and bind the dependency file count (files under server/node_modules/)
  // that the generator records but nothing else verifies, and prove the runtime,
  // dependency, and other-project categories partition the total exactly.
  const runtimeProjectFiles = projectFiles.filter((file) => file.startsWith("server/dist/"));
  const otherProjectFiles = projectFiles.filter((file) => !file.startsWith("server/dist/"));
  const dependencyFileCount = allBundleFiles.length - projectFiles.length;
  assertMcpbBaselineFileCounts(artifactBaseline.mcpb, {
    totalFileCount: allBundleFiles.length,
    dependencyFileCount,
    runtimeFileCount: runtimeProjectFiles.length,
    otherProjectFileCount: otherProjectFiles.length,
  });
  const forbidden = projectFiles.filter((file) =>
    /(?:^|\/)(?:src|test|sdds|\.audit)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:AGENTS|MEMORY|SOUL|ARCHITECT)\.md$/i.test(
      file,
    ),
  );
  if (forbidden.length > 0) throw new Error(`Forbidden MCPB files: ${forbidden.join(", ")}`);

  const packageManifests = allBundleFiles.filter(
    (file) =>
      file.startsWith("server/node_modules/") &&
      /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file),
  );
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const expectedPackageManifests = Object.entries(lock.packages ?? {})
    .filter(([directory, entry]) => directory !== "" && entry?.dev !== true)
    .map(([directory]) => `server/${directory}/package.json`)
    .sort();
  if (JSON.stringify(packageManifests) !== JSON.stringify(expectedPackageManifests)) {
    throw new Error("MCPB dependencies differ from the production lockfile inventory.");
  }
  for (const relative of packageManifests) {
    const directory = path.dirname(path.join(unpacked, relative));
    const packageManifest = JSON.parse(await readFile(path.join(unpacked, relative), "utf8"));
    if (!allowedLicenses.has(packageManifest.license)) {
      throw new Error(`${packageManifest.name} has an unreviewed bundled license.`);
    }
    const names = await readdir(directory);
    if (!names.some((name) => noticeFile.test(name))) {
      throw new Error(`${packageManifest.name} has no bundled license or notice file.`);
    }
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(unpacked, "server", "dist", "index.js")],
    cwd: unpacked,
    stderr: "pipe",
  });
  const client = new Client({ name: "mcpb-verifier", version: "1.0.0" });
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
    throw new Error(`MCPB inventory mismatch: ${JSON.stringify(inventory)}`);
  }

  console.log(
    JSON.stringify(
      {
        ...inventory,
        runtimeFiles: sourceFiles.length,
        dependencyFiles: dependencyFileCount,
        bundledPackagePaths: packageManifests.length,
        forbiddenFiles: forbidden.length,
        sha256: artifactHash,
        reproducible,
        signed: false,
        status: "pass",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
