import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(message);
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Removes only the two run-varying fields npm sbom emits (a random serialNumber
// and a generation timestamp) so the same reviewed dependency set always hashes
// to the same value, while any change to the dependency inventory does not.
export function canonicalizeSbom(sbomBytes) {
  let parsed;
  try {
    parsed = JSON.parse(typeof sbomBytes === "string" ? sbomBytes : sbomBytes.toString("utf8"));
  } catch {
    fail("The SBOM is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("The SBOM must be a JSON object.");
  }
  delete parsed.serialNumber;
  if (parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)) {
    delete parsed.metadata.timestamp;
  }
  return JSON.stringify(parsed);
}

export function canonicalSbomSha256(sbomBytes) {
  return sha256Hex(canonicalizeSbom(sbomBytes));
}

// Recomputes and binds the exact server.json digest and the canonical SBOM
// digest to the operator-approved baseline. Fails closed on any missing anchor
// or mismatch, so a build job that rewrites either published file is rejected
// before publication.
export function verifyReleaseArtifactDigests(baseline, { serverJson, sbom }) {
  const release = baseline?.release;
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    fail("The artifact baseline has no reviewed release-digest anchor.");
  }
  if (
    !SHA256.test(release.serverJsonSha256 ?? "") ||
    !SHA256.test(release.sbomCanonicalSha256 ?? "")
  ) {
    fail("The artifact baseline release-digest anchor is malformed.");
  }
  if (sha256Hex(serverJson) !== release.serverJsonSha256) {
    fail("server.json differs from the operator-approved baseline digest.");
  }
  if (canonicalSbomSha256(sbom) !== release.sbomCanonicalSha256) {
    fail("sbom.cdx.json differs from the operator-approved baseline digest.");
  }
  return {
    serverJsonSha256: release.serverJsonSha256,
    sbomCanonicalSha256: release.sbomCanonicalSha256,
  };
}

async function main() {
  const root = process.cwd();
  const directory = process.argv[2];
  if (!directory) fail("Usage: verify-release-artifacts.mjs <release-artifacts-directory>");
  const baseline = JSON.parse(
    await readFile(path.join(root, "release", "artifact-baseline.json"), "utf8"),
  );
  const [serverJson, sbom, checkoutServerJson] = await Promise.all([
    readFile(path.join(directory, "server.json")),
    readFile(path.join(directory, "sbom.cdx.json")),
    readFile(path.join(root, "server.json")),
  ]);
  const anchor = verifyReleaseArtifactDigests(baseline, { serverJson, sbom });
  // The MCP Registry publishes the checked-out server.json while the GitHub
  // release ships the artifact copy; bind both to the same reviewed digest so
  // the two published copies can never diverge.
  if (sha256Hex(checkoutServerJson) !== anchor.serverJsonSha256) {
    fail("The checked-out server.json diverges from the operator-approved baseline digest.");
  }
  console.log(JSON.stringify({ ...anchor, status: "pass" }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
