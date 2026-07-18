import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  allowedPublicCertificatePaths,
  isForbiddenPublicPath,
  PUBLIC_CERTIFICATE_NAMES,
} from "./public-boundary-policy.mjs";

const root = process.cwd();
const ARTIFACT_REVIEW_RECEIPT_PATH = "release/artifact-baseline-review.json";
const FIXED_PUBLIC_CERTIFICATE_PATHS = new Set([
  `release/${PUBLIC_CERTIFICATE_NAMES.trustAnchor}`,
  ...PUBLIC_CERTIFICATE_NAMES.intermediates.map((name) => `release/${name}`),
]);
const HISTORY_GIT_OPTIONS = Object.freeze({
  timeout: 60_000,
  maxBuffer: 64 * 1024 * 1024,
});

function runGit(args, errorMessage, options = {}, repositoryRoot = root) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) throw new Error(errorMessage);
  return result;
}

function historyEvidence(repositoryRoot) {
  const shallowState = runGit(
    ["rev-parse", "--is-shallow-repository"],
    "Could not determine whether complete Git ancestry is available.",
    { ...HISTORY_GIT_OPTIONS, encoding: "utf8" },
    repositoryRoot,
  ).stdout.trim();
  if (shallowState !== "false") {
    throw new Error(
      "Public-boundary verification requires complete ancestry for HEAD and all locally available refs.",
    );
  }

  const historyOutput = runGit(
    ["log", "HEAD", "--all", "--format=", "--name-only", "-z", "--no-renames", "--root", "-m"],
    "Could not enumerate paths from reachable Git ancestry.",
    { ...HISTORY_GIT_OPTIONS, encoding: "buffer" },
    repositoryRoot,
  ).stdout;
  if (!Buffer.isBuffer(historyOutput)) {
    throw new Error("Git history path output was not binary-safe.");
  }
  const files = [...new Set(historyOutput.toString("utf8").split("\0").filter(Boolean))];
  const commitCount = Number.parseInt(
    runGit(
      ["rev-list", "HEAD", "--all", "--count"],
      "Could not count reachable public Git commits.",
      { ...HISTORY_GIT_OPTIONS, encoding: "utf8" },
      repositoryRoot,
    ).stdout.trim(),
    10,
  );
  if (!Number.isSafeInteger(commitCount) || commitCount < 1) {
    throw new Error("Public Git history commit count is invalid.");
  }
  const referenceCount = runGit(
    ["for-each-ref", "--format=%(refname)"],
    "Could not count locally available Git refs.",
    { ...HISTORY_GIT_OPTIONS, encoding: "utf8" },
    repositoryRoot,
  )
    .stdout.split("\n")
    .filter(Boolean).length;
  return { commitCount, files, referenceCount };
}

function isForbiddenCandidatePath(file, allowedCertificates, packagePrivate) {
  return (
    isForbiddenPublicPath(file, allowedCertificates) ||
    (packagePrivate === true && file === ARTIFACT_REVIEW_RECEIPT_PATH)
  );
}

function isForbiddenHistoricalPath(file, packagePrivate) {
  return isForbiddenCandidatePath(file, FIXED_PUBLIC_CERTIFICATE_PATHS, packagePrivate);
}

function selfTestHistoryBoundary() {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "n8n-public-history-test-"));
  const repositoryRoot = path.join(temporaryRoot, "repository");
  const shallowRoot = path.join(temporaryRoot, "shallow");
  try {
    mkdirSync(repositoryRoot);
    runGit(
      ["init", "--quiet", "--initial-branch=dev"],
      "History self-test init failed.",
      {},
      repositoryRoot,
    );
    runGit(
      ["config", "user.name", "Boundary Self-Test"],
      "History self-test identity failed.",
      {},
      repositoryRoot,
    );
    runGit(
      ["config", "user.email", "boundary-self-test@example.invalid"],
      "History self-test identity failed.",
      {},
      repositoryRoot,
    );
    writeFileSync(path.join(repositoryRoot, "README.md"), "public\n", "utf8");
    runGit(["add", "README.md"], "History self-test add failed.", {}, repositoryRoot);
    runGit(
      ["commit", "--quiet", "-m", "public root"],
      "History self-test commit failed.",
      {},
      repositoryRoot,
    );
    mkdirSync(path.join(repositoryRoot, "sdds"));
    mkdirSync(path.join(repositoryRoot, "release"));
    writeFileSync(path.join(repositoryRoot, "sdds", "private.md"), "private\n", "utf8");
    writeFileSync(
      path.join(repositoryRoot, ARTIFACT_REVIEW_RECEIPT_PATH),
      '{"privateDevelopmentReceipt":true}\n',
      "utf8",
    );
    runGit(
      ["add", "sdds/private.md", ARTIFACT_REVIEW_RECEIPT_PATH],
      "History self-test add failed.",
      {},
      repositoryRoot,
    );
    runGit(
      ["commit", "--quiet", "-m", "private path"],
      "History self-test commit failed.",
      {},
      repositoryRoot,
    );
    rmSync(path.join(repositoryRoot, "sdds"), { recursive: true, force: true });
    rmSync(path.join(repositoryRoot, "release"), { recursive: true, force: true });
    runGit(["add", "--all"], "History self-test removal failed.", {}, repositoryRoot);
    runGit(
      ["commit", "--quiet", "-m", "delete private path"],
      "History self-test commit failed.",
      {},
      repositoryRoot,
    );

    const evidence = historyEvidence(repositoryRoot);
    if (
      evidence.commitCount !== 3 ||
      !evidence.files.includes("sdds/private.md") ||
      !evidence.files.includes(ARTIFACT_REVIEW_RECEIPT_PATH) ||
      !evidence.files.some((file) => isForbiddenHistoricalPath(file, true))
    ) {
      throw new Error("Deleted private-path history self-test failed.");
    }

    runGit(
      ["clone", "--quiet", "--no-local", "--depth", "1", repositoryRoot, shallowRoot],
      "Shallow-history self-test clone failed.",
      {},
      temporaryRoot,
    );
    let shallowRejected = false;
    try {
      historyEvidence(shallowRoot);
    } catch (error) {
      shallowRejected =
        error instanceof Error &&
        error.message ===
          "Public-boundary verification requires complete ancestry for HEAD and all locally available refs.";
    }
    if (!shallowRejected) throw new Error("Shallow-history self-test failed.");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const tracked = spawnSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "buffer",
  timeout: 10_000,
  maxBuffer: 4 * 1024 * 1024,
});
if (tracked.status !== 0 || !Buffer.isBuffer(tracked.stdout)) {
  throw new Error("Could not enumerate the Git public index.");
}
const files = tracked.stdout.toString("utf8").split("\0").filter(Boolean);
const signingPolicy = JSON.parse(
  readFileSync(path.join(root, "release", "mcpb-signing-policy.json"), "utf8"),
);
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const allowedCertificates = allowedPublicCertificatePaths(signingPolicy, packageJson.private);
const forbidden = files.filter((file) =>
  isForbiddenCandidatePath(file, allowedCertificates, packageJson.private),
);
if (forbidden.length > 0) {
  throw new Error(`Private paths entered the public Git index: ${forbidden.join(", ")}`);
}

const publicHistory = historyEvidence(root);
const historicalFiles = publicHistory.files;
const forbiddenHistory = historicalFiles.filter((file) =>
  isForbiddenHistoricalPath(file, packageJson.private),
);
if (forbiddenHistory.length > 0) {
  throw new Error(
    `Private paths entered the publishable Git history: ${forbiddenHistory.join(", ")}`,
  );
}

const ignoredSamples = [
  "AGENTS.md",
  "ARCHITECT.md",
  "CLAUDE.md",
  "GEMINI.md",
  "MEMORY.md",
  "SOUL.md",
  ".agents/state.json",
  ".audit/evidence.txt",
  ".claude/settings.json",
  ".codex/state.json",
  ".env",
  ".envrc",
  ".env.local",
  ".npmrc",
  ".opencode/state.json",
  ".secrets/token",
  ".semgrep-rules/javascript/rule.yml",
  "sdd/private.md",
  "sdds/private.md",
  "release-artifacts/package.tgz",
  "signed-handoff/package.mcpb",
  "package.tgz",
  "package.mcpb",
  "maintainer.key",
  "maintainer.p8",
  "maintainer.ppk",
  "maintainer.asc",
  "maintainer.gpg",
  "nested/AGENTS.md",
  "nested/MEMORY.md",
  "nested/.agents/state.json",
  "nested/.audit/evidence.txt",
  "nested/.env.local",
  "nested/.envrc",
  "nested/.npmrc",
  "nested/.semgrep-rules/rule.yml",
  "nested/sdds/private.md",
  "nested/.netrc",
  "nested/.pypirc",
  "nested/.ssh/id_ecdsa",
  "sbom.cdx.json",
  "nested/release-artifacts/package.tgz",
  "nested/signed-handoff/package.mcpb",
  "nested/sbom.cdx.json",
  "maintainer.pem",
  "release/rogue.pem",
  "signing.jks",
  "signing.keystore",
  "signing.p12",
  "signing.pfx",
  "id_dsa",
  "id_ecdsa",
];
for (const sample of ignoredSamples) {
  const check = spawnSync("git", ["check-ignore", "--no-index", "--quiet", sample], {
    cwd: root,
    timeout: 5_000,
  });
  if (check.status !== 0) throw new Error(`.gitignore does not exclude private sample: ${sample}`);
}

const publicCertificateSamples = [...FIXED_PUBLIC_CERTIFICATE_PATHS];
for (const sample of publicCertificateSamples) {
  const check = spawnSync("git", ["check-ignore", "--no-index", "--quiet", sample], {
    cwd: root,
    timeout: 5_000,
  });
  if (check.status !== 1) {
    throw new Error(`.gitignore does not expose the fixed public-certificate slot: ${sample}`);
  }
}

const syntheticActivePolicy = {
  status: "active",
  trustAnchor: { path: PUBLIC_CERTIFICATE_NAMES.trustAnchor },
  intermediates: [{ path: PUBLIC_CERTIFICATE_NAMES.intermediates[0] }],
};
const syntheticUnconfiguredPolicy = { status: "unconfigured" };
function rejectsCertificatePolicy(policy, packagePrivate) {
  try {
    allowedPublicCertificatePaths(policy, packagePrivate);
    return false;
  } catch {
    return true;
  }
}
const syntheticAllowed = allowedPublicCertificatePaths(syntheticActivePolicy, false);
if (
  !rejectsCertificatePolicy(syntheticUnconfiguredPolicy, false) ||
  !rejectsCertificatePolicy(syntheticActivePolicy, true) ||
  !rejectsCertificatePolicy(syntheticActivePolicy, undefined) ||
  !isForbiddenCandidatePath(ARTIFACT_REVIEW_RECEIPT_PATH, new Set(), true) ||
  isForbiddenCandidatePath(ARTIFACT_REVIEW_RECEIPT_PATH, syntheticAllowed, false) ||
  isForbiddenHistoricalPath(`release/${PUBLIC_CERTIFICATE_NAMES.trustAnchor}`, true) ||
  !isForbiddenPublicPath(".envrc") ||
  !isForbiddenPublicPath("nested/.environment") ||
  isForbiddenPublicPath(".env.example") ||
  !isForbiddenPublicPath("nested/.env.example") ||
  !isForbiddenPublicPath("artifact.tgz") ||
  !isForbiddenPublicPath("nested/artifact.mcpb") ||
  isForbiddenPublicPath(`release/${PUBLIC_CERTIFICATE_NAMES.trustAnchor}`, syntheticAllowed) ||
  isForbiddenPublicPath(`release/${PUBLIC_CERTIFICATE_NAMES.intermediates[0]}`, syntheticAllowed) ||
  !isForbiddenPublicPath(
    `release/${PUBLIC_CERTIFICATE_NAMES.intermediates[1]}`,
    syntheticAllowed,
  ) ||
  !isForbiddenPublicPath("release/rogue.pem", syntheticAllowed) ||
  !isForbiddenPublicPath("release/private.key", syntheticAllowed) ||
  !isForbiddenPublicPath("release/private.p8", syntheticAllowed) ||
  !isForbiddenPublicPath("release/private.ppk", syntheticAllowed) ||
  !isForbiddenPublicPath("release/private.asc", syntheticAllowed) ||
  !isForbiddenPublicPath("release/private.gpg", syntheticAllowed)
) {
  throw new Error("Public-boundary policy self-test failed.");
}
selfTestHistoryBoundary();

console.log(
  JSON.stringify(
    {
      trackedFiles: files.length,
      prohibitedTrackedFiles: 0,
      historyCommits: publicHistory.commitCount,
      locallyAvailableRefs: publicHistory.referenceCount,
      historicalPaths: historicalFiles.length,
      prohibitedHistoricalPaths: 0,
      completeReachableAncestry: true,
      historyScope: "HEAD and all locally available refs",
      historyPolicySelfTest: true,
      ignoredPrivateSamples: ignoredSamples.length,
      publicCertificateSlots: publicCertificateSamples.length,
      publicEnvironmentTemplate: files.includes(".env.example"),
      status: "pass",
    },
    null,
    2,
  ),
);
