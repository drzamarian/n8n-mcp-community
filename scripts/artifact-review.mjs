import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { trustedSystemEnv } from "./portable-cli.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const APPROVAL_KEY_FILE_ENV = "N8N_MCP_APPROVAL_KEY_FILE";
// The HMAC receipt is only as strong as the operator-held key. Reject weak key
// material below a 256-bit floor so a short, guessable secret cannot mint a
// receipt that verifies.
const MIN_APPROVAL_KEY_BYTES = 32;
const EXCLUDED_PATHS = new Set([
  "release/artifact-baseline.json",
  "release/artifact-baseline-review.json",
]);

function fail(message) {
  throw new Error(message);
}

export async function fileSha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

export async function sourceTreeSha256(root) {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "buffer",
      env: trustedSystemEnv(),
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    fail("Could not enumerate the public artifact-review source tree.");
  }
  const files = result.stdout
    .toString("utf8")
    .split("\0")
    .filter((file) => file !== "" && !EXCLUDED_PATHS.has(file))
    .sort();
  if (files.length === 0) fail("Artifact-review source inventory is empty.");
  const digest = createHash("sha256");
  for (const file of files) {
    const absolute = path.join(root, file);
    const metadata = await lstat(absolute);
    if (!metadata.isFile()) fail(`Artifact-review source is not a regular file: ${file}`);
    digest.update(file, "utf8");
    digest.update("\0");
    digest.update(await readFile(absolute));
    digest.update("\0");
  }
  return { sha256: digest.digest("hex"), fileCount: files.length };
}

export async function expectedArtifactReview(root) {
  const [baselineSha256, sourceTree] = await Promise.all([
    fileSha256(path.join(root, "release", "artifact-baseline.json")),
    sourceTreeSha256(root),
  ]);
  return {
    schemaVersion: 2,
    baselineSha256,
    sourceTreeSha256: sourceTree.sha256,
    sourceFileCount: sourceTree.fileCount,
    reviewProcedure: "inspect-diff-and-type-exact-digests-in-an-authenticated-local-terminal",
  };
}

// The approval evidence is an HMAC over the exact baseline evidence, keyed by
// operator-held secret material that never lives in the repository. A process
// with repo write access but without the key cannot mint a receipt that
// verifies, and the returned digest never discloses the key.
export function approvalEvidenceHmacSha256(material, approval, key) {
  return createHmac("sha256", key)
    .update(
      JSON.stringify({
        material,
        reviewer: approval.reviewer,
        localUsername: approval.localUsername,
        approvalMethod: approval.approvalMethod,
        approvedAt: approval.approvedAt,
      }),
    )
    .digest("hex");
}

// Reads the operator-held approval key from the file named by
// N8N_MCP_APPROVAL_KEY_FILE. The key must live outside the repository so it can
// never be committed. Every failure mode (unset, empty, unreadable, in-repo)
// fails closed with a message that never echoes the key or its path contents.
export async function readApprovalKeyMaterial(root, environment = process.env) {
  const keyFile = environment[APPROVAL_KEY_FILE_ENV];
  if (typeof keyFile !== "string" || keyFile.trim() === "") {
    fail(
      `Set ${APPROVAL_KEY_FILE_ENV} to an operator-held approval key file kept outside the repository.`,
    );
  }
  const resolvedRoot = path.resolve(root);
  const resolvedKey = path.resolve(keyFile);
  const relative = path.relative(resolvedRoot, resolvedKey);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    fail(
      `${APPROVAL_KEY_FILE_ENV} must point outside the repository so the key is never committed.`,
    );
  }
  let key;
  try {
    key = await readFile(resolvedKey);
  } catch {
    fail(`The approval key file named by ${APPROVAL_KEY_FILE_ENV} could not be read.`);
  }
  if (key.length < MIN_APPROVAL_KEY_BYTES) {
    fail(
      `The approval key file named by ${APPROVAL_KEY_FILE_ENV} must contain at least ${MIN_APPROVAL_KEY_BYTES} bytes.`,
    );
  }
  return key;
}

function baselineContentAtCommit(root, commit) {
  const result = spawnSync("git", ["show", `${commit}:release/artifact-baseline.json`], {
    cwd: root,
    encoding: "buffer",
    env: trustedSystemEnv(),
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.status === 0 && Buffer.isBuffer(result.stdout) ? result.stdout : null;
}

// Locates the exact committed baseline whose SHA-256 matches the last approved
// digest, so the approval delta is computed against the real predecessor even
// when the baseline change was already committed. Returns null when no committed
// baseline matches, so the caller can fail closed.
export function findApprovedBaselineContent(root, approvedSha256) {
  const revList = spawnSync("git", ["rev-list", "HEAD", "--", "release/artifact-baseline.json"], {
    cwd: root,
    encoding: "utf8",
    env: trustedSystemEnv(),
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (revList.status !== 0 || typeof revList.stdout !== "string") return null;
  for (const commit of revList.stdout.split("\n").filter(Boolean)) {
    const content = baselineContentAtCommit(root, commit);
    if (content && createHash("sha256").update(content).digest("hex") === approvedSha256) {
      return content;
    }
  }
  return null;
}

async function renderBaselineDelta(predecessorContent, currentContent) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "n8n-baseline-delta-"));
  try {
    const predecessorPath = path.join(directory, "last-approved-baseline.json");
    const currentPath = path.join(directory, "current-baseline.json");
    await writeFile(predecessorPath, predecessorContent ?? Buffer.alloc(0));
    await writeFile(currentPath, currentContent);
    const result = spawnSync(
      "git",
      ["diff", "--no-index", "--no-color", "--", predecessorPath, currentPath],
      { encoding: "utf8", env: trustedSystemEnv(), timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
    );
    // git diff --no-index exits 0 when identical and 1 when they differ; any
    // higher status is a real failure.
    if (result.status !== 0 && result.status !== 1) {
      fail("Could not render the artifact baseline delta against the last approved state.");
    }
    return typeof result.stdout === "string" ? result.stdout : "";
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Computes the delta between the last APPROVED baseline (recovered from the
// receipt's digest) and the current baseline, whether or not the change was
// already committed. Fails closed when a receipt records a predecessor that no
// committed baseline can reproduce.
export async function computeBaselineApprovalDelta(root) {
  const currentContent = await readFile(path.join(root, "release", "artifact-baseline.json"));
  const currentSha256 = createHash("sha256").update(currentContent).digest("hex");
  let approvedSha256 = null;
  let receiptPresent = false;
  try {
    const receipt = JSON.parse(
      await readFile(path.join(root, "release", "artifact-baseline-review.json"), "utf8"),
    );
    receiptPresent = true;
    approvedSha256 = typeof receipt?.baselineSha256 === "string" ? receipt.baselineSha256 : null;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      fail("The existing artifact baseline review could not be read for predecessor comparison.");
    }
  }
  if (receiptPresent && !SHA256.test(approvedSha256 ?? "")) {
    fail(
      "The existing artifact baseline review has no valid predecessor digest. Regenerate it from a known-good baseline before approving.",
    );
  }
  let predecessorContent = null;
  if (approvedSha256 !== null) {
    predecessorContent =
      approvedSha256 === currentSha256
        ? currentContent
        : findApprovedBaselineContent(root, approvedSha256);
    if (predecessorContent === null) {
      fail(
        "No committed baseline matches the last approved digest. The predecessor is not trustworthy; regenerate the baseline from a known-good commit before approving.",
      );
    }
  }
  return {
    approvedSha256,
    currentSha256,
    changed: approvedSha256 !== currentSha256,
    diffText: await renderBaselineDelta(predecessorContent, currentContent),
  };
}

export function artifactReviewIsRequired(packagePrivate) {
  if (packagePrivate === true) return false;
  if (packagePrivate === false) return true;
  fail("Package private state must be an explicit boolean.");
}

export async function verifyArtifactReviewForPackageState(root, packagePrivate) {
  if (!artifactReviewIsRequired(packagePrivate)) {
    return { required: false, status: "not-required-private-candidate" };
  }
  return { ...(await verifyArtifactReview(root)), required: true, status: "pass" };
}

export async function verifyArtifactReview(root) {
  const [review, policy] = await Promise.all([
    readFile(path.join(root, "release", "artifact-baseline-review.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "release", "artifact-review-policy.json"), "utf8").then(JSON.parse),
  ]);
  const expected = await expectedArtifactReview(root);
  const policyKeys = ["approvalMethod", "localUsername", "reviewer", "schemaVersion"];
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    JSON.stringify(Object.keys(policy).sort()) !== JSON.stringify(policyKeys) ||
    policy.schemaVersion !== 1 ||
    policy.reviewer !== "Walter Zamarian Jr." ||
    policy.localUsername !== "walter" ||
    policy.approvalMethod !== "interactive-local-terminal" ||
    !review ||
    typeof review !== "object" ||
    Array.isArray(review) ||
    JSON.stringify(Object.keys(review).sort()) !==
      JSON.stringify([...Object.keys(expected), "approval"].sort()) ||
    !SHA256.test(review.baselineSha256 ?? "") ||
    !SHA256.test(review.sourceTreeSha256 ?? "") ||
    Object.entries(expected).some(([key, value]) => review[key] !== value)
  ) {
    fail(
      "Artifact baseline review is stale. Inspect the baseline diff, then run npm run artifacts:approve.",
    );
  }
  // Reading the operator-held key is mandatory on the release path: a missing,
  // empty, unreadable, or in-repo key fails closed here before any comparison.
  const key = await readApprovalKeyMaterial(root);
  const approval = review.approval;
  const approvedAt =
    typeof approval?.approvedAt === "string" ? Date.parse(approval.approvedAt) : NaN;
  if (
    !approval ||
    typeof approval !== "object" ||
    Array.isArray(approval) ||
    JSON.stringify(Object.keys(approval).sort()) !==
      JSON.stringify(
        [
          "approvalEvidenceHmacSha256",
          "approvalMethod",
          "approvedAt",
          "localUsername",
          "reviewer",
        ].sort(),
      ) ||
    approval.reviewer !== policy.reviewer ||
    approval.localUsername !== policy.localUsername ||
    approval.approvalMethod !== policy.approvalMethod ||
    !Number.isFinite(approvedAt) ||
    approvedAt > Date.now() + 5 * 60_000 ||
    !SHA256.test(approval.approvalEvidenceHmacSha256 ?? "") ||
    approval.approvalEvidenceHmacSha256 !== approvalEvidenceHmacSha256(expected, approval, key)
  ) {
    fail("Artifact baseline review lacks valid keyed reviewer evidence.");
  }
  return review;
}
