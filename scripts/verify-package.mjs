import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verifyArtifactReviewForPackageState } from "./artifact-review.mjs";
import { isForbiddenPublicPath } from "./public-boundary-policy.mjs";

const root = process.cwd();
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "n8n-mcp-community-npm-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const artifactBaseline = JSON.parse(
  await readFile(path.join(root, "release", "artifact-baseline.json"), "utf8"),
);
const sourceManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

async function digest(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function run(command, args, cwd = root, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, npm_config_loglevel: "silent" };
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const reason = result.error?.code === "ETIMEDOUT" ? "timed out" : "failed";
    throw new Error(`${command} ${args.join(" ")} ${reason}.`);
  }
  return result.stdout.trim();
}

function hasExactInstalledIdentity(installedManifest, expectedManifest, artifact) {
  return (
    installedManifest.name === expectedManifest.name &&
    installedManifest.version === artifact.version &&
    installedManifest.private === expectedManifest.private
  );
}

async function verifyPublicManifestRoundTrip() {
  const packageRoot = path.join(temporaryRoot, "public-state-package");
  const installRoot = path.join(temporaryRoot, "public-state-install");
  const cacheRoot = path.join(temporaryRoot, "public-state-cache");
  const isolatedCacheEnvironment = {
    npm_config_cache: cacheRoot,
    NPM_CONFIG_CACHE: cacheRoot,
  };
  await Promise.all([mkdir(packageRoot), mkdir(installRoot), mkdir(cacheRoot)]);
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "public-state-roundtrip", version: "1.2.3-rc.1", private: false })}\n`,
  );
  const packed = JSON.parse(
    run(
      npmCommand,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot],
      packageRoot,
      isolatedCacheEnvironment,
    ),
  );
  const candidate = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  if (!candidate?.filename)
    throw new Error("Public-state package round-trip produced no artifact.");
  await writeFile(
    path.join(installRoot, "package.json"),
    `${JSON.stringify({ name: "public-state-installer", version: "1.0.0", private: true })}\n`,
  );
  run(
    npmCommand,
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(temporaryRoot, candidate.filename),
    ],
    installRoot,
    isolatedCacheEnvironment,
  );
  const installedManifest = JSON.parse(
    await readFile(
      path.join(installRoot, "node_modules", "public-state-roundtrip", "package.json"),
      "utf8",
    ),
  );
  if (
    !hasExactInstalledIdentity(
      installedManifest,
      { name: "public-state-roundtrip", private: false },
      { version: "1.2.3-rc.1" },
    )
  ) {
    throw new Error("npm did not preserve explicit private:false through pack and install.");
  }
}

if (
  !hasExactInstalledIdentity(
    { name: "example", version: "1.0.0", private: true },
    { name: "example", private: true },
    { version: "1.0.0" },
  ) ||
  !hasExactInstalledIdentity(
    { name: "example", version: "1.0.0", private: false },
    { name: "example", private: false },
    { version: "1.0.0" },
  ) ||
  hasExactInstalledIdentity(
    { name: "example", version: "1.0.0", private: true },
    { name: "example", private: false },
    { version: "1.0.0" },
  ) ||
  hasExactInstalledIdentity(
    { name: "example", version: "1.0.0", private: false },
    { name: "example", private: true },
    { version: "1.0.0" },
  )
) {
  throw new Error("Installed-package identity policy self-test failed.");
}

await verifyPublicManifestRoundTrip();
await verifyArtifactReviewForPackageState(root, sourceManifest.private);

try {
  const packed = JSON.parse(
    run(npmCommand, ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot]),
  );
  const candidates = Array.isArray(packed) ? packed : Object.values(packed);
  const artifact = candidates[0];
  const paths = Array.isArray(artifact?.files)
    ? artifact.files.map((entry) => entry.path).sort()
    : [];
  const forbidden = paths.filter((file) => isForbiddenPublicPath(file));
  const bundled = Array.isArray(artifact?.bundled) ? artifact.bundled : [];
  const failures = [];
  if (candidates.length !== 1) failures.push(`expected one artifact, found ${candidates.length}`);
  if (paths.length === 0) failures.push("artifact file list is empty");
  if (forbidden.length > 0) failures.push(`forbidden files: ${forbidden.join(", ")}`);
  if (
    artifactBaseline.schemaVersion !== 1 ||
    artifactBaseline.packageVersion !== artifact.version ||
    artifactBaseline.npm.fileCount !== paths.length ||
    JSON.stringify(artifactBaseline.npm.files) !== JSON.stringify(paths)
  ) {
    failures.push("npm artifact differs from the exact reviewed file manifest");
  }
  if (bundled.length > 0) failures.push(`bundled dependencies: ${bundled.join(", ")}`);
  if (failures.length > 0) throw new Error(failures.join("\n"));

  const tarball = path.join(temporaryRoot, artifact.filename);
  if ((await digest(tarball)) !== artifactBaseline.npm.sha256) {
    throw new Error("npm artifact digest differs from the reviewed baseline.");
  }
  await writeFile(
    path.join(temporaryRoot, "package.json"),
    `${JSON.stringify({ name: "artifact-verifier", version: "1.0.0", private: true })}\n`,
  );
  await writeFile(
    path.join(temporaryRoot, "package-lock.json"),
    `${JSON.stringify({ name: "artifact-verifier", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "artifact-verifier", version: "1.0.0" } } })}\n`,
  );
  run(
    npmCommand,
    ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    temporaryRoot,
  );

  const installed = path.join(temporaryRoot, "node_modules", "n8n-mcp-community");
  const entry = path.join(installed, "dist", "index.js");
  const installedManifest = JSON.parse(
    await readFile(path.join(installed, "package.json"), "utf8"),
  );
  const installedLock = JSON.parse(
    await readFile(path.join(temporaryRoot, "package-lock.json"), "utf8"),
  );
  const installedPackagePaths = Object.entries(installedLock.packages ?? {}).filter(
    ([directory]) => directory !== "",
  );
  if (
    installedPackagePaths.length !== 94 ||
    installedPackagePaths.some(([, entry]) => entry?.dev === true)
  ) {
    throw new Error("Installed npm artifact differs from the production dependency inventory.");
  }
  if (!hasExactInstalledIdentity(installedManifest, sourceManifest, artifact)) {
    throw new Error("Installed npm artifact identity differs from the release candidate.");
  }
  if (run(process.execPath, [entry, "--version"], temporaryRoot) !== artifact.version) {
    throw new Error("Installed npm artifact returned the wrong CLI version.");
  }
  if (
    run(npxCommand, ["--no-install", "n8n-mcp-community", "--version"], temporaryRoot) !==
    artifact.version
  ) {
    throw new Error("Installed npm artifact failed the npx binary smoke test.");
  }
  if (!run(process.execPath, [entry, "--help"], temporaryRoot).includes("Usage:")) {
    throw new Error("Installed npm artifact did not return bounded CLI help.");
  }
  const doctor = run(process.execPath, [entry, "doctor"], temporaryRoot, {
    N8N_API_URL: "https://n8n.example.test",
    N8N_API_KEY: "TEMPORARY-ARTIFACT-VERIFIER-KEY",
    N8N_MCP_MODE: "read-only",
  });
  const doctorResult = JSON.parse(doctor);
  if (doctorResult.status !== "pass" || doctorResult.networkAccess !== false) {
    throw new Error("Installed npm artifact doctor did not pass offline.");
  }
  if (doctor.includes("TEMPORARY-ARTIFACT-VERIFIER-KEY") || doctor.includes("example.test")) {
    throw new Error("Installed npm artifact doctor exposed connection data.");
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: temporaryRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "npm-artifact-verifier", version: "1.0.0" });
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
    throw new Error(`Installed npm artifact inventory mismatch: ${JSON.stringify(inventory)}`);
  }

  console.log(
    JSON.stringify(
      {
        name: artifact.name,
        version: artifact.version,
        private: installedManifest.private === true,
        files: paths.length,
        bundledDependencies: bundled.length,
        sizeBytes: artifact.size,
        unpackedSizeBytes: artifact.unpackedSize,
        ...inventory,
        productionPackagePaths: installedPackagePaths.length,
        cleanInstall: true,
        npxSmoke: true,
        status: "pass",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
