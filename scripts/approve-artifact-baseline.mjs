import { readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import {
  approvalEvidenceHmacSha256,
  computeBaselineApprovalDelta,
  expectedArtifactReview,
  readApprovalKeyMaterial,
} from "./artifact-review.mjs";

const root = process.cwd();
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("Artifact approval requires an interactive local terminal.");
}
const policy = JSON.parse(
  await readFile(path.join(root, "release", "artifact-review-policy.json"), "utf8"),
);
const localUsername = userInfo().username;
if (localUsername !== policy.localUsername) {
  throw new Error("Artifact approval requires the repository-pinned local reviewer account.");
}
const key = await readApprovalKeyMaterial(root);
const material = await expectedArtifactReview(root);
const delta = await computeBaselineApprovalDelta(root);
process.stdout.write(
  `${delta.diffText || "The current baseline is identical to the last approved baseline.\n"}\n` +
    `Reviewer: ${policy.reviewer} (${localUsername})\n` +
    `Last approved baseline SHA-256: ${delta.approvedSha256 ?? "none (first approval)"}\n` +
    `Current baseline SHA-256: ${material.baselineSha256}\n` +
    `Baseline changed since last approval: ${delta.changed ? "yes" : "no"}\n` +
    `Source-tree SHA-256: ${material.sourceTreeSha256}\n` +
    `Source files: ${material.sourceFileCount}\n`,
);
const phrase = `APPROVE ${material.baselineSha256} ${material.sourceTreeSha256}`;
const readline = createInterface({ input: process.stdin, output: process.stdout });
const answer = await readline.question(`Type the exact approval phrase:\n${phrase}\n> `);
readline.close();
if (answer !== phrase) throw new Error("Artifact approval phrase did not match exactly.");
const approval = {
  reviewer: policy.reviewer,
  localUsername,
  approvalMethod: policy.approvalMethod,
  approvedAt: new Date().toISOString(),
};
const review = {
  ...material,
  approval: {
    ...approval,
    approvalEvidenceHmacSha256: approvalEvidenceHmacSha256(material, approval, key),
  },
};
await writeFile(
  path.join(root, "release", "artifact-baseline-review.json"),
  `${JSON.stringify(review, null, 2)}\n`,
);
console.log(JSON.stringify({ ...review, status: "approved" }));
