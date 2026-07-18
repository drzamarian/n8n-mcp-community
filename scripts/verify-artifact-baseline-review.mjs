import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  artifactReviewIsRequired,
  verifyArtifactReviewForPackageState,
} from "./artifact-review.mjs";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
let invalidStateRejected = false;
try {
  artifactReviewIsRequired(undefined);
} catch {
  invalidStateRejected = true;
}
if (artifactReviewIsRequired(true) || !artifactReviewIsRequired(false) || !invalidStateRejected) {
  throw new Error("Artifact-review requirement self-test failed.");
}
const review = await verifyArtifactReviewForPackageState(root, packageJson.private);
console.log(JSON.stringify(review));
