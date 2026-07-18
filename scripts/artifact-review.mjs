import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;
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

export function approvalEvidenceSha256(material, approval) {
  return createHash("sha256")
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
          "approvalEvidenceSha256",
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
    approval.approvalEvidenceSha256 !== approvalEvidenceSha256(expected, approval)
  ) {
    fail("Artifact baseline review lacks valid interactive reviewer evidence.");
  }
  return review;
}
