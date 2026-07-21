import { createHash } from "node:crypto";
import { parseAllDocuments, stringify } from "yaml";

const EXPECTED_RELEASE_SEMANTIC_SHA256 =
  "9977969e2c0f4b6936e6fdb08c30639187e07001ed88c14eddf9a6403ab43c60";

function fail(message) {
  throw new Error(message);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function parseReleaseWorkflow(workflow) {
  const documents = parseAllDocuments(workflow, { uniqueKeys: true });
  if (documents.length !== 1 || documents[0].errors.length > 0) {
    fail("Release workflow must contain exactly one valid YAML document with unique keys.");
  }
  return record(documents[0].toJSON(), "Release workflow");
}

export function releaseWorkflowSemanticSha256(workflow) {
  const document = parseReleaseWorkflow(workflow);
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(document)))
    .digest("hex");
}

function jobSteps(job, label) {
  const value = record(job, label).steps;
  if (!Array.isArray(value)) fail(`${label} must define steps.`);
  return value.map((step, index) => record(step, `${label} step ${index + 1}`));
}

function namedStep(steps, name) {
  const matches = steps.filter((step) => step.name === name);
  if (matches.length !== 1) fail(`Release workflow requires exactly one ${name} step.`);
  return matches[0];
}

function executableLines(step, label) {
  if (typeof step.run !== "string" || step.if !== undefined) {
    fail(`${label} must be an unconditional shell step.`);
  }
  if (/\bif\s+false\b|\bfalse\s*&&|:\s*<</.test(step.run)) {
    fail(`${label} contains a disabled or dead command path.`);
  }
  return step.run
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function requireExactRun(step, expected, label) {
  const actual = executableLines(step, label);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} does not match the reviewed executable command sequence.`);
  }
}

const APPROVAL_RUN = Object.freeze([
  "set -euo pipefail",
  'test "${RELEASE_CONFIRMATION}" = "PUBLISH ${RELEASE_TAG}"',
  '[[ "${SIGNED_MCPB_SHA256}" =~ ^[0-9a-f]{64}$ ]]',
  '[[ "${APPROVED_NPM_TARBALL_SHA256}" =~ ^[0-9a-f]{64}$ ]]',
  'test "$(git cat-file -t "${RELEASE_TAG}")" = "tag"',
  'test "$(git rev-list -n 1 "${RELEASE_TAG}")" = "${GITHUB_SHA}"',
  'test "$(node -p \'require("./package.json").private === true ? "private" : "public"\')" = "public"',
  'test "$(node -p \'require("./release/mcpb-signing-policy.json").status\')" = "active"',
  "(",
  "cd release-artifacts",
  "sha256sum --check SHA256SUMS.unsigned",
  ")",
  "mapfile -t packages < <(find release-artifacts -maxdepth 1 -type f -name '*.tgz' -print)",
  'test "${#packages[@]}" -eq 1',
  'test "$(sha256sum "${packages[0]}" | cut -d \' \' -f 1)" = "${APPROVED_NPM_TARBALL_SHA256}"',
  "node scripts/verify-release-artifacts.mjs release-artifacts",
]);

const SIGNED_VERIFIER_RUN = Object.freeze([
  "set -euo pipefail",
  "mapfile -t unsigned_bundles < <(find release-artifacts -maxdepth 1 -type f -name '*.mcpb' -print)",
  "mapfile -t signed_bundles < <(find signed-handoff -maxdepth 1 -type f -name '*.mcpb' -print)",
  'test "${#unsigned_bundles[@]}" -eq 1',
  'test "${#signed_bundles[@]}" -eq 1',
  "node scripts/verify-signed-mcpb.mjs \\",
  '"${unsigned_bundles[0]}" \\',
  '"${signed_bundles[0]}" \\',
  '"${SIGNED_MCPB_SHA256}" \\',
  "release/mcpb-signing-policy.json",
  'cp "${signed_bundles[0]}" "${unsigned_bundles[0]}"',
  "(",
  "cd release-artifacts",
  "sha256sum ./*.tgz ./*.mcpb ./server.json ./sbom.cdx.json > SHA256SUMS",
  ")",
]);

const PUBLISH_RUN = Object.freeze([
  "set -euo pipefail",
  // The tarball path must carry a ./ prefix: npm parses a bare name/name
  // argument as a github: specifier, not a local file.
  "mapfile -t packages < <(find ./release-artifacts -maxdepth 1 -type f -name '*.tgz' -print)",
  'test "${#packages[@]}" -eq 1',
  'test "$(sha256sum "${packages[0]}" | cut -d \' \' -f 1)" = "${APPROVED_NPM_TARBALL_SHA256}"',
  'npm publish "${packages[0]}" --access public --provenance --ignore-scripts',
]);

const VALIDATE_DISPATCH_RUN = Object.freeze([
  "set -euo pipefail",
  'test "${GITHUB_REF}" = "refs/tags/${RELEASE_TAG}"',
  'test "$(git cat-file -t "${RELEASE_TAG}")" = "tag"',
  'version="$(node -p \'require("./package.json").version\')"',
  'test "${RELEASE_TAG}" = "v${version}"',
  'test "$(git rev-list -n 1 "${RELEASE_TAG}")" = "${GITHUB_SHA}"',
  "git fetch --no-tags origin main:refs/remotes/origin/main",
  'git merge-base --is-ancestor "${GITHUB_SHA}" refs/remotes/origin/main',
]);

const EXPECTED_STEP_NAMES = Object.freeze({
  "validate-dispatch": Object.freeze([
    "Check out the selected tag",
    "Fail unless the dispatch ref and annotated tag agree",
  ]),
  "build-candidate": Object.freeze([
    "Check out the exact dispatched commit",
    "Set up Node.js",
    "Activate the audited npm client",
    "Install exact dependencies without lifecycle scripts",
    "Run the complete release gate",
    "Build the npm, MCPB, Registry, SBOM, and checksum set",
    "Retain the unsigned candidate for review",
  ]),
  "publish-release": Object.freeze([
    "Check out the exact dispatched commit",
    "Set up Node.js for trusted publishing",
    "Activate the audited npm client",
    "Install exact release tooling without lifecycle scripts",
    "Download the reviewed candidate",
    "Enforce publication approval and unsigned artifact integrity",
    "Download Walter's externally signed MCPB from the draft release",
    "Verify the signed handoff, identity, and byte-for-byte runtime parity",
    "Publish the reviewed npm tarball through trusted publishing",
    "Install the pinned MCP Registry publisher",
    "Publish validated metadata to the MCP Registry",
    "Complete the existing draft GitHub release for the exact tag",
  ]),
});

export function verifyReleaseWorkflow(workflow, enforceSemanticHash = true) {
  const document = parseReleaseWorkflow(workflow);
  if (
    enforceSemanticHash &&
    releaseWorkflowSemanticSha256(workflow) !== EXPECTED_RELEASE_SEMANTIC_SHA256
  ) {
    fail("Release workflow differs from the complete reviewed semantic specification.");
  }
  const jobs = record(document.jobs, "Release jobs");
  const expectedJobs = ["build-candidate", "publish-release", "validate-dispatch"];
  if (JSON.stringify(Object.keys(jobs).sort()) !== JSON.stringify(expectedJobs)) {
    fail("Release workflow job inventory changed.");
  }
  for (const [jobName, expectedNames] of Object.entries(EXPECTED_STEP_NAMES)) {
    const actualNames = jobSteps(jobs[jobName], jobName).map((step) => step.name);
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      fail(`${jobName} step inventory or ordering changed.`);
    }
  }
  for (const forbidden of ["mcpb_certificate_sha256", "MCPB_CERTIFICATE_SHA256", "mcpb verify"]) {
    if (JSON.stringify(document).includes(forbidden)) {
      fail(`Release workflow contains forbidden trust input: ${forbidden}`);
    }
  }
  for (const [name, jobValue] of Object.entries(jobs)) {
    const job = record(jobValue, name);
    if (job["runs-on"] !== "ubuntu-24.04") fail(`${name} must use the pinned Ubuntu runner.`);
  }

  const validateJob = record(jobs["validate-dispatch"], "validate-dispatch");
  const buildJob = record(jobs["build-candidate"], "build-candidate");
  const publishJob = record(jobs["publish-release"], "publish-release");
  const validateSteps = jobSteps(validateJob, "validate-dispatch");
  const dispatchGuard = namedStep(
    validateSteps,
    "Fail unless the dispatch ref and annotated tag agree",
  );
  requireExactRun(dispatchGuard, VALIDATE_DISPATCH_RUN, "Release-dispatch validation step");
  if (buildJob.needs !== "validate-dispatch" || publishJob.needs !== "build-candidate") {
    fail(
      "Release job dependencies must preserve validation before build and build before publish.",
    );
  }
  for (const [name, job] of [
    ["validate-dispatch", validateJob],
    ["build-candidate", buildJob],
  ]) {
    if (JSON.stringify(job.permissions) !== JSON.stringify({ contents: "read" })) {
      fail(`${name} requires exact read-only permissions.`);
    }
  }
  if (
    publishJob.if !== "inputs.publish" ||
    publishJob.environment !== "release" ||
    JSON.stringify(publishJob.permissions) !==
      JSON.stringify({ contents: "write", "id-token": "write" })
  ) {
    fail("The publication job must retain its protected authorization boundary.");
  }

  const allSteps = Object.entries(jobs).flatMap(([name, job]) => jobSteps(job, name));
  for (const step of allSteps) {
    if (step.if !== undefined) fail("Release steps must not use conditional execution.");
    if (
      typeof step.uses === "string" &&
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/.test(step.uses)
    ) {
      fail("Every release action must use an immutable full commit SHA.");
    }
  }
  const nodeSteps = allSteps.filter(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@"),
  );
  if (
    nodeSteps.length !== 2 ||
    nodeSteps.some((step) => record(step.with, "Node setup")["node-version"] !== "24.18.0")
  ) {
    fail("Both Node release jobs must use the exact supported Node patch.");
  }

  const triggers = record(document.on, "Release triggers");
  if (JSON.stringify(Object.keys(triggers)) !== JSON.stringify(["workflow_dispatch"])) {
    fail("Release workflow supports only the reviewed manual dispatch trigger.");
  }
  const dispatch = record(triggers.workflow_dispatch, "workflow_dispatch");
  const inputs = record(dispatch.inputs, "Release inputs");
  if (!Object.hasOwn(inputs, "npm_tarball_sha256")) {
    fail("Release workflow is missing the separately approved npm digest input.");
  }

  const publishSteps = jobSteps(publishJob, "publish-release");
  const approval = namedStep(
    publishSteps,
    "Enforce publication approval and unsigned artifact integrity",
  );
  const verifier = namedStep(
    publishSteps,
    "Verify the signed handoff, identity, and byte-for-byte runtime parity",
  );
  const publication = namedStep(
    publishSteps,
    "Publish the reviewed npm tarball through trusted publishing",
  );
  requireExactRun(approval, APPROVAL_RUN, "Publication approval step");
  requireExactRun(verifier, SIGNED_VERIFIER_RUN, "Signed-MCPB verification step");
  requireExactRun(publication, PUBLISH_RUN, "npm publication step");
  const expectedApprovalEnvironment = {
    RELEASE_TAG: "${{ inputs.tag }}",
    RELEASE_CONFIRMATION: "${{ inputs.confirmation }}",
    SIGNED_MCPB_SHA256: "${{ inputs.signed_mcpb_sha256 }}",
    APPROVED_NPM_TARBALL_SHA256: "${{ inputs.npm_tarball_sha256 }}",
  };
  if (
    JSON.stringify(record(approval.env, "Publication approval environment")) !==
    JSON.stringify(expectedApprovalEnvironment)
  ) {
    fail("The publication approval environment must retain every protected input binding.");
  }
  if (
    JSON.stringify(record(publication.env, "npm publication environment")) !==
    JSON.stringify({
      APPROVED_NPM_TARBALL_SHA256: "${{ inputs.npm_tarball_sha256 }}",
      // First-publish bootstrap: npm cannot pin a trusted publisher on a
      // package that does not exist yet. Revoked after v0.1.0.
      NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
    })
  ) {
    fail("The npm publication step must rebind the separately approved tarball digest.");
  }
  const approvalIndex = publishSteps.indexOf(approval);
  const verifierIndex = publishSteps.indexOf(verifier);
  const publishIndex = publishSteps.indexOf(publication);
  if (!(approvalIndex < verifierIndex && verifierIndex < publishIndex)) {
    fail("Artifact approval and signature verification must precede npm publication.");
  }

  const executableText = allSteps
    .flatMap((step) => (typeof step.run === "string" ? executableLines(step, "Release step") : []))
    .join("\n");
  for (const required of ["git merge-base --is-ancestor", "release/mcpb-signing-policy.json"]) {
    if (!executableText.includes(required)) fail(`Release workflow is missing: ${required}`);
  }

  return Object.freeze({
    pinnedReleaseRunners: Object.keys(jobs).length,
    pinnedNodeJobs: nodeSteps.length,
    signedVerifierRemovalBlocked: verifier !== undefined,
  });
}

export function verifyReleaseWorkflowTamperCases(workflow) {
  const document = parseReleaseWorkflow(workflow);
  const mutations = [];
  for (const [jobName, job] of Object.entries(document.jobs)) {
    job.steps.forEach((_step, index) => {
      mutations.push((value) => {
        value.jobs[jobName].steps[index].if = false;
      });
    });
  }
  mutations.push(
    (value) => {
      value.jobs["publish-release"].steps.splice(1, 0, {
        name: "Injected artifact replacement",
        run: "rm -f release-artifacts/*.tgz",
      });
    },
    (value) => {
      const step = value.jobs["publish-release"].steps.find((candidate) =>
        String(candidate.name).startsWith("Enforce publication approval"),
      );
      step.env.RELEASE_CONFIRMATION = "PUBLISH ${{ inputs.tag }}";
    },
    (value) => {
      delete value.jobs["build-candidate"].needs;
    },
    (value) => {
      delete value.jobs["publish-release"].needs;
    },
    (value) => {
      const step = value.jobs["validate-dispatch"].steps.at(-1);
      step.run = `${step.run}\ntrue`;
    },
    (value) => {
      value.jobs["publish-release"].steps[0].uses = "attacker/checkout@main";
    },
    (value) => {
      value.on.push = { branches: ["main"] };
    },
    (value) => {
      value.jobs["publish-release"].steps.reverse();
    },
  );
  for (const mutate of mutations) {
    const tampered = structuredClone(document);
    mutate(tampered);
    let blocked = false;
    try {
      verifyReleaseWorkflow(stringify(tampered), false);
    } catch {
      blocked = true;
    }
    if (!blocked) fail("Release policy accepted a semantic tamper case.");
  }
  return mutations.length;
}
