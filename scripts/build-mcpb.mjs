import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { zipSync } from "fflate";

const root = process.cwd();
const dist = path.join(root, "dist");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "n8n-mcp-community-mcpb-"));
const stage = path.join(temporaryRoot, "bundle");
const server = path.join(stage, "server");
const officialOutput = path.join(temporaryRoot, "official.mcpb");
const canonicalStage = path.join(temporaryRoot, "canonical");
const manifestSource = path.join(root, "mcpb", "manifest.json");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const output = path.join(dist, `n8n-mcp-community-${packageJson.version}.mcpb`);

function run(command, args, cwd = root) {
  const env = { ...process.env, npm_config_loglevel: "error" };
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function normalizeTimes(directory) {
  const fixed = new Date("2000-01-01T00:00:00.000Z");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await normalizeTimes(target);
    if (!entry.isSymbolicLink()) await utimes(target, fixed, fixed);
  }
  await utimes(directory, fixed, fixed);
}

async function filesUnder(directory, prefix = "") {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error("MCPB staging cannot contain symbolic links.");
    }
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await filesUnder(path.join(directory, entry.name), relative)));
    } else {
      output.push(relative);
    }
  }
  return output.sort();
}

async function writeCanonicalZip(directory, target) {
  const entries = {};
  for (const relative of await filesUnder(directory)) {
    const file = path.join(directory, relative);
    entries[relative] = [await readFile(file), { os: 3, attrs: 0o100644 << 16 }];
  }
  const archive = zipSync(entries, {
    level: 9,
    mtime: new Date("2000-01-01T00:00:00.000Z"),
  });
  await writeFile(target, archive);
  return Object.keys(entries).length;
}

try {
  await rm(output, { force: true });
  await mkdir(server, { recursive: true });
  await cp(dist, path.join(server, "dist"), { recursive: true });
  await cp(manifestSource, path.join(stage, "manifest.json"));
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    await cp(path.join(root, file), path.join(stage, file));
  }
  await cp(path.join(root, "package.json"), path.join(server, "package.json"));
  await cp(path.join(root, "package-lock.json"), path.join(server, "package-lock.json"));

  run(
    "npm",
    ["ci", "--offline", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    server,
  );
  await rm(path.join(server, "node_modules", ".bin"), { recursive: true, force: true });
  await rm(path.join(server, "node_modules", ".package-lock.json"), { force: true });
  await rm(path.join(server, "package-lock.json"), { force: true });
  await writeFile(
    path.join(server, "package.json"),
    `${JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        private: true,
        type: "module",
        license: packageJson.license,
        dependencies: packageJson.dependencies,
        allowScripts: {},
      },
      null,
      2,
    )}\n`,
  );

  run(path.join(root, "node_modules", ".bin", "mcpb"), ["validate", manifestSource]);
  await normalizeTimes(stage);
  run(path.join(root, "node_modules", ".bin", "mcpb"), ["pack", stage, officialOutput]);
  run(path.join(root, "node_modules", ".bin", "mcpb"), ["unpack", officialOutput, canonicalStage]);
  const files = await writeCanonicalZip(canonicalStage, output);
  run(path.join(root, "node_modules", ".bin", "mcpb"), ["info", output]);
  const artifact = await stat(output);
  console.log(
    JSON.stringify(
      {
        manifestVersion: "0.4",
        version: packageJson.version,
        output: path.relative(root, output),
        bytes: artifact.size,
        files,
        reproducibility: "not_checked",
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
