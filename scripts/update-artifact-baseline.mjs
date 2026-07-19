import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "n8n-artifact-baseline-"));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed.`);
  return result.stdout.trim();
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
  run(npmCommand, ["run", "build"]);
  const packed = JSON.parse(
    run(npmCommand, ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot]),
  );
  const candidates = Array.isArray(packed) ? packed : Object.values(packed);
  if (candidates.length !== 1) throw new Error("Expected one npm artifact.");
  const npmArtifact = candidates[0];
  const npmFiles = npmArtifact.files.map((entry) => entry.path).sort();
  const npmTarball = path.join(temporaryRoot, npmArtifact.filename);

  run(process.execPath, [path.join(root, "scripts", "build-mcpb.mjs")]);
  const mcpbFile = path.join(root, "dist", `n8n-mcp-community-${packageJson.version}.mcpb`);
  const unpacked = path.join(temporaryRoot, "mcpb");
  run(path.join(root, "node_modules", ".bin", "mcpb"), ["unpack", mcpbFile, unpacked]);
  const mcpbFiles = await filesUnder(unpacked);
  const runtimeFiles = mcpbFiles
    .filter((file) => file.startsWith("server/dist/"))
    .map((file) => file.slice("server/dist/".length));
  const projectFiles = mcpbFiles.filter((file) => !file.startsWith("server/node_modules/"));

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
      status: "updated",
    }),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
