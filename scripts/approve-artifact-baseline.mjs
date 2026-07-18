import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { approvalEvidenceSha256, expectedArtifactReview } from "./artifact-review.mjs";

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
const material = await expectedArtifactReview(root);
const baselineDiff = spawnSync(
  "git",
  ["diff", "--no-ext-diff", "--", "release/artifact-baseline.json"],
  { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
);
if (baselineDiff.status !== 0) throw new Error("Could not display the artifact baseline diff.");
process.stdout.write(
  `${baselineDiff.stdout || "No uncommitted artifact-baseline diff is present.\n"}\n` +
    `Reviewer: ${policy.reviewer} (${localUsername})\n` +
    `Baseline SHA-256: ${material.baselineSha256}\n` +
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
    approvalEvidenceSha256: approvalEvidenceSha256(material, approval),
  },
};
await writeFile(
  path.join(root, "release", "artifact-baseline-review.json"),
  `${JSON.stringify(review, null, 2)}\n`,
);
console.log(JSON.stringify({ ...review, status: "approved" }));
