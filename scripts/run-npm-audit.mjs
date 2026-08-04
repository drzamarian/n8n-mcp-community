import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  assertNoProjectNpmConfig,
  npmAuditEnvironment,
  verifyNpmAuditEnvironmentPolicySelfTest,
} from "./npm-audit-environment.mjs";
import { resolveNpmCli } from "./portable-cli.mjs";

const mode = process.argv[2];
if (mode !== "full" && mode !== "production") {
  throw new Error("Audit mode must be either full or production.");
}

const npmCli = resolveNpmCli("npm");
const args = ["audit", "--audit-level=low"];
if (mode === "production") {
  args.push("--omit=dev");
}
verifyNpmAuditEnvironmentPolicySelfTest();
assertNoProjectNpmConfig(process.cwd());

const result = spawnSync(npmCli.command, [...npmCli.argumentPrefix, ...args], {
  cwd: process.cwd(),
  env: npmAuditEnvironment(),
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
