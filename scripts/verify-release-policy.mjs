import { createHash, X509Certificate } from "node:crypto";
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseAllDocuments } from "yaml";
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

const [packageJson, policy, releaseWorkflow, ciWorkflow] = await Promise.all([
  readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "release", "mcpb-signing-policy.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8"),
  readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8"),
]);

function parseWorkflow(source, label) {
  const documents = parseAllDocuments(source, { uniqueKeys: true });
  if (documents.length !== 1 || documents[0].errors.length > 0) {
    fail(`${label} must contain exactly one valid YAML document with unique keys.`);
  }
  const value = documents[0].toJSON();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function verifyForkPullRequestBoundary(source) {
  const workflow = parseWorkflow(source, "CI workflow");
  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    fail("CI workflow jobs must be an object.");
  }
  const secretGuard = "github.event_name != 'pull_request'";
  const contributorGuard = "github.event_name == 'pull_request'";
  let secretStepCount = 0;
  for (const [jobName, jobValue] of Object.entries(jobs)) {
    if (!jobValue || typeof jobValue !== "object" || Array.isArray(jobValue)) continue;
    const steps = jobValue.steps;
    if (!Array.isArray(steps)) continue;
    for (const stepValue of steps) {
      if (!stepValue || typeof stepValue !== "object" || Array.isArray(stepValue)) continue;
      if (JSON.stringify(stepValue).includes("N8N_MCP_APPROVAL_KEY")) {
        secretStepCount += 1;
        if (stepValue.if !== secretGuard) {
          fail(`${jobName} exposes an artifact-approval secret reference to pull requests.`);
        }
      }
    }
  }
  if (secretStepCount !== 2) {
    fail("CI must contain exactly two trusted-only artifact-approval steps.");
  }
  const verifySteps = jobs.verify?.steps;
  const packedSteps = jobs["packed-smoke"]?.steps;
  const hasExactStep = (steps, name, guard, run) =>
    Array.isArray(steps) &&
    steps.some(
      (step) =>
        step?.name === name &&
        step.if === guard &&
        step.run === run &&
        !JSON.stringify(step).includes("N8N_MCP_APPROVAL_KEY"),
    );
  if (
    !hasExactStep(
      verifySteps,
      "Run the keyless contributor verification gate",
      contributorGuard,
      "npm run verify:contributor",
    ) ||
    !hasExactStep(
      packedSteps,
      "Build, install, and inspect the npm artifact without maintainer approval",
      contributorGuard,
      "npm run check:package:contributor",
    )
  ) {
    fail("Fork pull requests must retain both exact keyless contributor gates.");
  }
  return { secretStepCount, contributorSteps: 2 };
}

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
const forkPullRequestBoundary = verifyForkPullRequestBoundary(ciWorkflow);

console.log(
  JSON.stringify(
    {
      packagePrivate: packageJson.private === true,
      signingPolicy: policy.status,
      pinnedReleaseRunners: releaseWorkflowReport.pinnedReleaseRunners,
      pinnedNodeJobs: releaseWorkflowReport.pinnedNodeJobs,
      signedVerifierRemovalBlocked: releaseWorkflowReport.signedVerifierRemovalBlocked,
      structuralTamperCasesBlocked,
      forkPullRequestBoundary,
      status: "pass",
    },
    null,
    2,
  ),
);
