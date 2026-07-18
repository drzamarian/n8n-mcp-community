import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "full" && mode !== "production") {
  throw new Error("Audit mode must be either full or production.");
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const auditConfig = fileURLToPath(new URL("npm-audit.npmrc", import.meta.url));
const args = ["audit", "--audit-level=low"];
if (mode === "production") {
  args.push("--omit=dev");
}
const childEnvironment = { ...process.env };
for (const key of Object.keys(childEnvironment)) {
  if (key.toLowerCase() === "npm_config_allow_scripts") {
    delete childEnvironment[key];
  }
}

const result = spawnSync(npmCommand, args, {
  cwd: process.cwd(),
  env: {
    ...childEnvironment,
    npm_config_userconfig: path.resolve(auditConfig),
  },
  stdio: "inherit",
  timeout: 120_000,
});

if (result.error) {
  throw new Error("npm audit could not be completed within its safety boundary.", {
    cause: result.error,
  });
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
