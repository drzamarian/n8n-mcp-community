import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolveNodeEntrypoint, resolveNpmCli, runPortableCommandSync } from "./portable-cli.mjs";
import { canonicalSbomSha256 } from "./verify-release-artifacts.mjs";

const root = process.cwd();
const npmCli = resolveNpmCli("npm");
const mcpbCli = resolveNodeEntrypoint(
  path.join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js"),
  "MCPB",
);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "n8n-artifact-baseline-"));

function run(command, args) {
  return runPortableCommandSync(command, args, {
    cwd: root,
    env: { ...process.env, npm_config_loglevel: "silent" },
    label: "An artifact-baseline subprocess",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
}

function runCli(cli, args) {
  return run(cli.command, [...cli.argumentPrefix, ...args]);
}

async function digest(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function filesUnder(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await filesUnder(path.join(directory, entry.name), relative)));
    } else {
      output.push(relative);
    }
  }
  return output.sort();
}

try {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  runCli(npmCli, ["run", "build"]);
  const packed = JSON.parse(
    runCli(npmCli, ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot]),
  );
  const candidates = Array.isArray(packed) ? packed : Object.values(packed);
  if (candidates.length !== 1) throw new Error("Expected one npm artifact.");
  const npmArtifact = candidates[0];
  const npmFiles = npmArtifact.files.map((entry) => entry.path).sort();
  const npmTarball = path.join(temporaryRoot, npmArtifact.filename);

  run(process.execPath, [path.join(root, "scripts", "build-mcpb.mjs")]);
  const mcpbFile = path.join(root, "dist", `n8n-mcp-community-${packageJson.version}.mcpb`);
  const unpacked = path.join(temporaryRoot, "mcpb");
  runCli(mcpbCli, ["unpack", mcpbFile, unpacked]);
  const mcpbFiles = await filesUnder(unpacked);
  const runtimeFiles = mcpbFiles
    .filter((file) => file.startsWith("server/dist/"))
    .map((file) => file.slice("server/dist/".length));
  const projectFiles = mcpbFiles.filter((file) => !file.startsWith("server/node_modules/"));

  // Anchor the two release artifacts that ship alongside the tgz and mcpb but
  // were previously only self-attested by SHA256SUMS. server.json hashes
  // directly; the SBOM is hashed in canonical form so its run-varying
  // serialNumber and timestamp do not defeat the digest.
  const serverJsonSha256 = createHash("sha256")
    .update(await readFile(path.join(root, "server.json")))
    .digest("hex");
  const sbomCanonicalSha256 = canonicalSbomSha256(
    runCli(npmCli, [
      "sbom",
      "--package-lock-only",
      "--omit=dev",
      "--sbom-format",
      "cyclonedx",
      "--sbom-type",
      "application",
    ]),
  );

  const baseline = {
    schemaVersion: 1,
    packageVersion: packageJson.version,
    npm: {
      sha256: await digest(npmTarball),
      fileCount: npmFiles.length,
      files: npmFiles,
    },
    mcpb: {
      sha256: await digest(mcpbFile),
      totalFileCount: mcpbFiles.length,
      dependencyFileCount: mcpbFiles.length - projectFiles.length,
      runtimeFiles,
      projectFiles,
    },
    release: {
      serverJsonSha256,
      sbomCanonicalSha256,
    },
  };
  await writeFile(
    path.join(root, "release", "artifact-baseline.json"),
    `${JSON.stringify(baseline, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      npmFiles: npmFiles.length,
      mcpbFiles: mcpbFiles.length,
      dependencyFiles: mcpbFiles.length - projectFiles.length,
      runtimeFiles: runtimeFiles.length,
      projectFiles: projectFiles.length,
      serverJsonSha256,
      sbomCanonicalSha256,
      status: "updated",
    }),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
