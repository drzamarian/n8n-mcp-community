import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  changelogDescribesPackageState,
  EXPECTED_MCPB_PLATFORMS,
  isSemanticVersion,
  verifyReleaseMetadataPolicySelfTest,
} from "./release-metadata-policy.mjs";

const root = process.cwd();

async function readJson(file) {
  return JSON.parse(await readFile(path.join(root, file), "utf8"));
}

const [packageJson, serverJson, mcpbManifest, changelog] = await Promise.all([
  readJson("package.json"),
  readJson("server.json"),
  readJson("mcpb/manifest.json"),
  readFile(path.join(root, "CHANGELOG.md"), "utf8"),
]);

const registryName = "io.github.drzamarian/n8n-mcp-community";
const repositoryUrl = "https://github.com/drzamarian/n8n-mcp-community";
const expectedEnvironment = [
  ["N8N_API_URL", true, true, undefined],
  ["N8N_API_KEY", true, true, undefined],
  ["N8N_MCP_MODE", false, false, "read-only"],
  ["N8N_ALLOW_INSECURE_HTTP", false, false, "0"],
];

verifyReleaseMetadataPolicySelfTest();
if (
  (packageJson.private !== true && packageJson.private !== false) ||
  packageJson.mcpName !== registryName ||
  !isSemanticVersion(packageJson.version) ||
  packageJson.repository?.url !== `${repositoryUrl}.git` ||
  packageJson.bugs?.url !== `${repositoryUrl}/issues` ||
  packageJson.homepage !== `${repositoryUrl}#readme` ||
  packageJson.packageManager !== "npm@12.0.1"
) {
  throw new Error("package.json release metadata differs from the approved package identity.");
}
if (!changelogDescribesPackageState(packageJson, changelog, repositoryUrl)) {
  throw new Error("CHANGELOG.md does not describe the exact private or publishable package state.");
}
if (
  serverJson.$schema !==
    "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json" ||
  serverJson.name !== registryName ||
  serverJson.version !== packageJson.version ||
  serverJson.repository?.url !== repositoryUrl ||
  serverJson.repository?.source !== "github" ||
  serverJson.packages?.length !== 1
) {
  throw new Error("server.json identity differs from package metadata.");
}
const npmPackage = serverJson.packages[0];
if (
  npmPackage.registryType !== "npm" ||
  npmPackage.registryBaseUrl !== "https://registry.npmjs.org" ||
  npmPackage.identifier !== packageJson.name ||
  npmPackage.version !== packageJson.version ||
  npmPackage.transport?.type !== "stdio"
) {
  throw new Error("server.json npm package metadata differs from the release candidate.");
}
const observedEnvironment = npmPackage.environmentVariables?.map((entry) => [
  entry.name,
  entry.isRequired,
  entry.isSecret,
  entry.default,
]);
if (JSON.stringify(observedEnvironment) !== JSON.stringify(expectedEnvironment)) {
  throw new Error("server.json environment metadata differs from the safe configuration contract.");
}
if (
  mcpbManifest.name !== packageJson.name ||
  mcpbManifest.version !== packageJson.version ||
  mcpbManifest.license !== packageJson.license ||
  mcpbManifest.user_config?.n8nApiUrl?.sensitive !== true ||
  mcpbManifest.user_config?.n8nApiKey?.sensitive !== true ||
  mcpbManifest.user_config?.mode?.default !== "read-only" ||
  mcpbManifest.user_config?.allowInsecureHttp?.default !== "0" ||
  JSON.stringify(mcpbManifest.compatibility?.platforms) !== JSON.stringify(EXPECTED_MCPB_PLATFORMS)
) {
  throw new Error("MCPB metadata differs from package identity or safe defaults.");
}

console.log(
  JSON.stringify(
    {
      package: packageJson.name,
      version: packageJson.version,
      registryName,
      registryPackages: serverJson.packages.length,
      environmentVariables: expectedEnvironment.length,
      private: packageJson.private === true,
      status: "pass",
    },
    null,
    2,
  ),
);
