import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { pathToFileURL } from "node:url";

// The scripts under test are plain ESM .mjs modules. Importing through a
// computed specifier keeps them out of the test's static type graph, so they
// are typed here through hand-written interfaces of the exact surface exercised.
interface ArtifactReviewModule {
  expectedArtifactReview(root: string): Promise<{
    baselineSha256: string;
    sourceTreeSha256: string;
    sourceFileCount: number;
    schemaVersion: number;
    reviewProcedure: string;
  }>;
  approvalEvidenceHmacSha256(material: unknown, approval: unknown, key: Buffer): string;
  readApprovalKeyMaterial(root: string, env?: Record<string, string | undefined>): Promise<Buffer>;
  verifyArtifactReview(root: string): Promise<unknown>;
  computeBaselineApprovalDelta(root: string): Promise<{
    approvedSha256: string | null;
    currentSha256: string;
    changed: boolean;
    diffText: string;
  }>;
}

interface ReleaseArtifactsModule {
  sha256Hex(value: Buffer | string): string;
  canonicalSbomSha256(bytes: Buffer | string): string;
  verifyReleaseArtifactDigests(
    baseline: unknown,
    files: { serverJson: Buffer | string; sbom: Buffer | string },
  ): { serverJsonSha256: string; sbomCanonicalSha256: string };
}

interface MetadataPolicyModule {
  assertMcpbBaselineFileCounts(
    baseline: unknown,
    actual: {
      totalFileCount: number;
      dependencyFileCount: number;
      runtimeFileCount: number;
      otherProjectFileCount: number;
    },
  ): void;
}

interface OfficialUrlsModule {
  assertOfficialUrlParity(source: string, manifestText: string): string[];
}

async function loadScript<T>(file: string): Promise<T> {
  const href = pathToFileURL(path.join(process.cwd(), "scripts", file)).href;
  return (await import(href)) as T;
}

const APPROVAL_ENV = "N8N_MCP_APPROVAL_KEY_FILE";
const KEY_SECRET = "operator-held-approval-secret-key-material-value";

const REVIEW_POLICY = {
  schemaVersion: 1,
  reviewer: "Walter Zamarian Jr.",
  localUsername: "walter",
  approvalMethod: "interactive-local-terminal",
} as const;

async function makeReviewRepo(): Promise<{ root: string; git: (...args: string[]) => void }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-machinery-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Release Machinery Test");
  await mkdir(path.join(root, "release"), { recursive: true });
  await writeFile(
    path.join(root, "release", "artifact-review-policy.json"),
    `${JSON.stringify(REVIEW_POLICY, null, 2)}\n`,
  );
  await writeFile(path.join(root, "README.md"), "public candidate\n");
  return { root, git };
}

function keylessSha256Evidence(material: unknown, approval: Record<string, string>): string {
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

test("keyed approval receipt rejects a forgery minted without the operator key", async () => {
  const review = await loadScript<ArtifactReviewModule>("artifact-review.mjs");
  const { root } = await makeReviewRepo();
  const keyDir = await mkdtemp(path.join(os.tmpdir(), "release-machinery-key-"));
  const keyFile = path.join(keyDir, "approval.key");
  const savedEnv = process.env[APPROVAL_ENV];
  try {
    await writeFile(keyFile, Buffer.from(KEY_SECRET));
    await writeFile(
      path.join(root, "release", "artifact-baseline.json"),
      `${JSON.stringify({ schemaVersion: 1, packageVersion: "0.1.0" }, null, 2)}\n`,
    );
    execFileSync("git", ["add", "."], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["commit", "-qm", "candidate"], { cwd: root, stdio: "pipe" });

    const material = await review.expectedArtifactReview(root);
    const approval = {
      reviewer: REVIEW_POLICY.reviewer,
      localUsername: REVIEW_POLICY.localUsername,
      approvalMethod: REVIEW_POLICY.approvalMethod,
      approvedAt: new Date().toISOString(),
    };
    const key = await review.readApprovalKeyMaterial(root, { [APPROVAL_ENV]: keyFile });

    const validReceipt = {
      ...material,
      approval: {
        ...approval,
        approvalEvidenceHmacSha256: review.approvalEvidenceHmacSha256(material, approval, key),
      },
    };
    const receiptPath = path.join(root, "release", "artifact-baseline-review.json");

    process.env[APPROVAL_ENV] = keyFile;
    await writeFile(receiptPath, `${JSON.stringify(validReceipt, null, 2)}\n`);
    await review.verifyArtifactReview(root);

    // A receipt whose evidence is the old unsalted SHA-256 (mintable by any
    // process without the key) must be rejected, and the safe message must
    // never disclose the key material.
    const forgedReceipt = {
      ...material,
      approval: {
        ...approval,
        approvalEvidenceHmacSha256: keylessSha256Evidence(material, approval),
      },
    };
    await writeFile(receiptPath, `${JSON.stringify(forgedReceipt, null, 2)}\n`);
    await assert.rejects(
      review.verifyArtifactReview(root),
      (error: unknown) =>
        error instanceof Error &&
        /keyed reviewer evidence/.test(error.message) &&
        !error.message.includes(KEY_SECRET),
    );

    // With the mandatory receipt present but the key unavailable, verification
    // fails closed instead of passing.
    await writeFile(receiptPath, `${JSON.stringify(validReceipt, null, 2)}\n`);
    delete process.env[APPROVAL_ENV];
    await assert.rejects(review.verifyArtifactReview(root), new RegExp(APPROVAL_ENV));
  } finally {
    if (savedEnv === undefined) delete process.env[APPROVAL_ENV];
    else process.env[APPROVAL_ENV] = savedEnv;
    await rm(root, { recursive: true, force: true });
    await rm(keyDir, { recursive: true, force: true });
  }
});

test("approval key material shorter than the minimum length fails closed", async () => {
  const review = await loadScript<ArtifactReviewModule>("artifact-review.mjs");
  const { root } = await makeReviewRepo();
  const keyDir = await mkdtemp(path.join(os.tmpdir(), "release-machinery-key-"));
  const keyFile = path.join(keyDir, "approval.key");
  try {
    // Sixteen bytes is below the 32-byte (256-bit) operator-key floor.
    const shortKey = "0123456789abcdef"; // synthetic under-length test value, not a real secret. gitleaks:allow
    await writeFile(keyFile, Buffer.from(shortKey));
    await assert.rejects(
      review.readApprovalKeyMaterial(root, { [APPROVAL_ENV]: keyFile }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(APPROVAL_ENV) &&
        /\b32\b/.test(error.message) &&
        !error.message.includes(shortKey),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(keyDir, { recursive: true, force: true });
  }
});

test("approval delta shows a committed-but-unapproved baseline change on a clean tree", async () => {
  const review = await loadScript<ArtifactReviewModule>("artifact-review.mjs");
  const { root, git } = await makeReviewRepo();
  const keyDir = await mkdtemp(path.join(os.tmpdir(), "release-machinery-key-"));
  const keyFile = path.join(keyDir, "approval.key");
  try {
    await writeFile(keyFile, Buffer.from(KEY_SECRET));
    await writeFile(
      path.join(root, "release", "artifact-baseline.json"),
      `${JSON.stringify({ schemaVersion: 1, note: "approved-baseline" }, null, 2)}\n`,
    );
    git("add", ".");
    git("commit", "-qm", "baseline v1");

    const approvedMaterial = await review.expectedArtifactReview(root);
    const approval = {
      reviewer: REVIEW_POLICY.reviewer,
      localUsername: REVIEW_POLICY.localUsername,
      approvalMethod: REVIEW_POLICY.approvalMethod,
      approvedAt: new Date().toISOString(),
    };
    const key = await review.readApprovalKeyMaterial(root, { [APPROVAL_ENV]: keyFile });
    const receipt = {
      ...approvedMaterial,
      approval: {
        ...approval,
        approvalEvidenceHmacSha256: review.approvalEvidenceHmacSha256(
          approvedMaterial,
          approval,
          key,
        ),
      },
    };
    await writeFile(
      path.join(root, "release", "artifact-baseline-review.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    git("add", ".");
    git("commit", "-qm", "approve baseline v1");

    // Commit a baseline change WITHOUT re-approving. The working tree is clean,
    // so the previous "git diff" review material would be empty.
    await writeFile(
      path.join(root, "release", "artifact-baseline.json"),
      `${JSON.stringify({ schemaVersion: 1, note: "changed-but-unapproved" }, null, 2)}\n`,
    );
    git("add", ".");
    git("commit", "-qm", "committed baseline change");

    const workingTreeDiff = execFileSync("git", ["diff", "--", "release/artifact-baseline.json"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(workingTreeDiff.trim(), "", "the committed change leaves no working-tree diff");

    const delta = await review.computeBaselineApprovalDelta(root);
    assert.equal(delta.changed, true);
    assert.equal(delta.approvedSha256, approvedMaterial.baselineSha256);
    assert.match(delta.diffText, /changed-but-unapproved/);
    assert.match(delta.diffText, /approved-baseline/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(keyDir, { recursive: true, force: true });
  }
});

test("release-artifact digests bind server.json and the canonical SBOM", async () => {
  const releaseArtifacts = await loadScript<ReleaseArtifactsModule>("verify-release-artifacts.mjs");
  const serverJson = Buffer.from(
    JSON.stringify({
      name: "io.github.drzamarian/n8n-mcp-community",
      packages: [{ identifier: "n8n-mcp-community" }],
    }),
  );
  const sbomReviewed = JSON.stringify({
    serialNumber: "urn:uuid:11111111-1111-1111-1111-111111111111",
    version: 1,
    metadata: { timestamp: "2026-01-01T00:00:00.000Z", component: { name: "n8n-mcp-community" } },
    components: [{ name: "zod", version: "3.25.76" }],
  });
  const sbomRerun = JSON.stringify({
    serialNumber: "urn:uuid:22222222-2222-2222-2222-222222222222",
    version: 1,
    metadata: { timestamp: "2026-07-20T15:00:00.000Z", component: { name: "n8n-mcp-community" } },
    components: [{ name: "zod", version: "3.25.76" }],
  });
  const sbomTampered = JSON.stringify({
    serialNumber: "urn:uuid:11111111-1111-1111-1111-111111111111",
    version: 1,
    metadata: { timestamp: "2026-01-01T00:00:00.000Z", component: { name: "n8n-mcp-community" } },
    components: [{ name: "malicious-dependency", version: "9.9.9" }],
  });
  const baseline = {
    release: {
      serverJsonSha256: releaseArtifacts.sha256Hex(serverJson),
      sbomCanonicalSha256: releaseArtifacts.canonicalSbomSha256(sbomReviewed),
    },
  };

  assert.doesNotThrow(() =>
    releaseArtifacts.verifyReleaseArtifactDigests(baseline, { serverJson, sbom: sbomReviewed }),
  );
  // A rerun SBOM with the same dependency set but a fresh serialNumber and
  // timestamp still matches the canonical digest.
  assert.doesNotThrow(() =>
    releaseArtifacts.verifyReleaseArtifactDigests(baseline, { serverJson, sbom: sbomRerun }),
  );
  assert.throws(
    () =>
      releaseArtifacts.verifyReleaseArtifactDigests(baseline, {
        serverJson: Buffer.from(
          serverJson.toString("utf8").replace("n8n-mcp-community", "evil-package"),
        ),
        sbom: sbomReviewed,
      }),
    /server\.json differs/,
  );
  assert.throws(
    () =>
      releaseArtifacts.verifyReleaseArtifactDigests(baseline, { serverJson, sbom: sbomTampered }),
    /sbom\.cdx\.json differs/,
  );
  assert.throws(
    () => releaseArtifacts.verifyReleaseArtifactDigests({}, { serverJson, sbom: sbomReviewed }),
    /no reviewed release-digest anchor/,
  );
});

test("MCPB baseline file-count binding rejects a tampered dependency count", async () => {
  const policy = await loadScript<MetadataPolicyModule>("release-metadata-policy.mjs");
  const baselineMcpb = { totalFileCount: 2182, dependencyFileCount: 2145 };
  const actual = {
    totalFileCount: 2182,
    dependencyFileCount: 2145,
    runtimeFileCount: 33,
    otherProjectFileCount: 4,
  };
  assert.doesNotThrow(() => policy.assertMcpbBaselineFileCounts(baselineMcpb, actual));
  assert.throws(
    () =>
      policy.assertMcpbBaselineFileCounts(
        { totalFileCount: 2182, dependencyFileCount: 9999 },
        actual,
      ),
    /differ from the reviewed baseline/,
  );
  assert.throws(
    () =>
      policy.assertMcpbBaselineFileCounts(baselineMcpb, {
        ...actual,
        runtimeFileCount: actual.runtimeFileCount + 5,
      }),
    /do not sum to the total/,
  );
});

test("official-URL manifest parity matches the runtime source and catches drift", async () => {
  const officialUrls = await loadScript<OfficialUrlsModule>("verify-official-urls.mjs");
  const [source, manifest] = await Promise.all([
    readFile(path.join(process.cwd(), "src", "content", "official-urls.ts"), "utf8"),
    readFile(path.join(process.cwd(), "release", "official-urls.txt"), "utf8"),
  ]);
  const parity = officialUrls.assertOfficialUrlParity(source, manifest);
  assert.equal(parity.length, 5);
  const dropped = manifest.split("\n").slice(1).join("\n");
  assert.throws(() => officialUrls.assertOfficialUrlParity(source, dropped), /diverges|not sorted/);
});
