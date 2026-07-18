import { createHash, X509Certificate } from "node:crypto";
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  verifyReleaseWorkflow,
  verifyReleaseWorkflowTamperCases,
} from "./release-workflow-policy.mjs";
import { PUBLIC_CERTIFICATE_NAMES } from "./public-boundary-policy.mjs";

const root = process.cwd();
const SHA256 = /^[0-9a-f]{64}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} has unsupported fields.`);
  }
}

function safeCertificatePath(policyDirectory, relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.length > 256 ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(relativePath) ||
    !relativePath.endsWith(".pem")
  ) {
    fail("Signing-policy certificate path is unsafe.");
  }
  const resolved = path.resolve(policyDirectory, relativePath);
  const relative = path.relative(policyDirectory, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("Signing-policy certificate path escapes the policy directory.");
  }
  return resolved;
}

async function verifyCertificateEntry(policyDirectory, entry, label, expectedPath) {
  exactKeys(entry, ["path", "pemSha256"], label);
  if (entry.path !== expectedPath) fail(`${label} must use the fixed repository path.`);
  if (!SHA256.test(entry.pemSha256)) fail(`${label} has an invalid PEM digest.`);
  const certificatePath = safeCertificatePath(policyDirectory, entry.path);
  await access(certificatePath);
  const certificateStat = await lstat(certificatePath);
  if (!certificateStat.isFile() || certificateStat.isSymbolicLink()) {
    fail(`${label} must be a regular repository file, not a symbolic link.`);
  }
  const pem = await readFile(certificatePath);
  if (sha256(pem) !== entry.pemSha256) fail(`${label} PEM digest mismatch.`);
  const blocks = pem
    .toString("utf8")
    .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (blocks?.length !== 1) fail(`${label} must contain exactly one certificate.`);
  const certificate = new X509Certificate(blocks[0]);
  if (!certificate.ca) fail(`${label} must be a CA certificate.`);
}

const [packageJson, policy, releaseWorkflow] = await Promise.all([
  readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "release", "mcpb-signing-policy.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8"),
]);

exactKeys(
  policy,
  ["schemaVersion", "status", "signingCertificateSha256", "trustAnchor", "intermediates"],
  "MCPB signing policy",
);
if (policy.schemaVersion !== 1 || !Array.isArray(policy.intermediates)) {
  fail("MCPB signing policy has an unsupported structure.");
}
if (packageJson.private === true) {
  if (
    policy.status !== "unconfigured" ||
    policy.signingCertificateSha256 !== null ||
    policy.trustAnchor !== null ||
    policy.intermediates.length !== 0
  ) {
    fail("A private pre-release package must keep MCPB signing identity unconfigured.");
  }
} else {
  if (policy.status !== "active" || !SHA256.test(policy.signingCertificateSha256 ?? "")) {
    fail("A publishable package requires an active repository-pinned MCPB signing identity.");
  }
  if (policy.intermediates.length > 4) fail("MCPB signing policy has too many intermediates.");
  const policyDirectory = path.join(root, "release");
  await verifyCertificateEntry(
    policyDirectory,
    policy.trustAnchor,
    "Trust anchor",
    PUBLIC_CERTIFICATE_NAMES.trustAnchor,
  );
  await Promise.all(
    policy.intermediates.map((entry, index) =>
      verifyCertificateEntry(
        policyDirectory,
        entry,
        `Intermediate ${index + 1}`,
        PUBLIC_CERTIFICATE_NAMES.intermediates[index],
      ),
    ),
  );
}

const releaseWorkflowReport = verifyReleaseWorkflow(releaseWorkflow);
const structuralTamperCasesBlocked = verifyReleaseWorkflowTamperCases(releaseWorkflow);

console.log(
  JSON.stringify(
    {
      packagePrivate: packageJson.private === true,
      signingPolicy: policy.status,
      pinnedReleaseRunners: releaseWorkflowReport.pinnedReleaseRunners,
      pinnedNodeJobs: releaseWorkflowReport.pinnedNodeJobs,
      signedVerifierRemovalBlocked: releaseWorkflowReport.signedVerifierRemovalBlocked,
      structuralTamperCasesBlocked,
      status: "pass",
    },
    null,
    2,
  ),
);
