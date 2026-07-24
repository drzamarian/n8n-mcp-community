const NUMERIC_IDENTIFIER = /^(?:0|[1-9][0-9]*)$/;
const VERSION_IDENTIFIER = /^[0-9A-Za-z-]+$/;

export const EXPECTED_MCPB_PLATFORMS = Object.freeze(["linux", "darwin", "win32"]);

/**
 * Binds the recorded MCPB dependency file count to the recomputed bundle and
 * enforces that the runtime, dependency, and other-project categories partition
 * the total exactly. Fails closed on any drift or tamper.
 *
 * @param {{ totalFileCount: number, dependencyFileCount: number }} baselineMcpb
 * @param {{ totalFileCount: number, dependencyFileCount: number, runtimeFileCount: number, otherProjectFileCount: number }} actual
 */
export function assertMcpbBaselineFileCounts(baselineMcpb, actual) {
  for (const [name, value] of Object.entries(actual)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Recomputed MCPB ${name} must be a non-negative integer.`);
    }
  }
  const { totalFileCount, dependencyFileCount, runtimeFileCount, otherProjectFileCount } = actual;
  if (totalFileCount !== runtimeFileCount + dependencyFileCount + otherProjectFileCount) {
    throw new Error("MCPB runtime, dependency, and project file counts do not sum to the total.");
  }
  if (
    !baselineMcpb ||
    typeof baselineMcpb !== "object" ||
    baselineMcpb.totalFileCount !== totalFileCount ||
    baselineMcpb.dependencyFileCount !== dependencyFileCount
  ) {
    throw new Error("MCPB file counts differ from the reviewed baseline.");
  }
}

function identifiersAreValid(value, forbidLeadingZeroNumeric = false) {
  if (value === undefined) return true;
  const identifiers = value.split(".");
  return (
    identifiers.length > 0 &&
    identifiers.every(
      (identifier) =>
        identifier.length > 0 &&
        identifier.length <= 64 &&
        VERSION_IDENTIFIER.test(identifier) &&
        (!forbidLeadingZeroNumeric ||
          !/^[0-9]+$/.test(identifier) ||
          NUMERIC_IDENTIFIER.test(identifier)),
    )
  );
}

export function isSemanticVersion(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;

  const buildParts = value.split("+");
  if (buildParts.length > 2 || !identifiersAreValid(buildParts[1])) return false;
  const versionAndPrerelease = buildParts[0];
  const prereleaseSeparator = versionAndPrerelease.indexOf("-");
  const core =
    prereleaseSeparator === -1
      ? versionAndPrerelease
      : versionAndPrerelease.slice(0, prereleaseSeparator);
  const prerelease =
    prereleaseSeparator === -1 ? undefined : versionAndPrerelease.slice(prereleaseSeparator + 1);
  const numeric = core.split(".");

  return (
    numeric.length === 3 &&
    numeric.every((identifier) => NUMERIC_IDENTIFIER.test(identifier)) &&
    identifiersAreValid(prerelease, true)
  );
}

function frozenCandidateAnchor(version) {
  const heading = `[${version}] - Frozen release candidate`;
  return `#${heading
    .toLowerCase()
    .replace(/[^a-z0-9_ -]/g, "")
    .replaceAll(" ", "-")}`;
}

export function changelogDescribesPackageState(packageJson, changelog) {
  const version = packageJson.version;
  if (!isSemanticVersion(version)) return false;
  const lines = changelog.split(/\r?\n/);
  if (!changelog.includes("[Unreleased]:")) return false;
  if (
    (packageJson.private !== true && packageJson.private !== false) ||
    packageJson.releaseState !== "candidate"
  ) {
    return false;
  }
  const candidateHeading = `[${version}] - Frozen release candidate`;
  return (
    lines.filter((line) => line === `## ${candidateHeading}`).length === 1 &&
    changelog.includes(`[${version}]: ${frozenCandidateAnchor(version)}`) &&
    changelog.includes("[Unreleased]: #unreleased") &&
    changelog.includes(`Version ${version} is a frozen release candidate.`) &&
    changelog.includes("this immutable entry is not rewritten after publication")
  );
}

export function verifyReleaseMetadataPolicySelfTest() {
  const privatePackage = { version: "1.2.3-rc.1", private: true, releaseState: "candidate" };
  const privateChangelog = `## [1.2.3-rc.1] - Frozen release candidate\n\nVersion 1.2.3-rc.1 is a frozen release candidate. Availability is established only by matching external readbacks; this immutable entry is not rewritten after publication.\n\n[Unreleased]: #unreleased\n[1.2.3-rc.1]: #123-rc1---frozen-release-candidate\n`;
  const privateChangelogWithWrongAnchor = privateChangelog.replace(
    "#123-rc1---frozen-release-candidate",
    "#1231---frozen-release-candidate",
  );
  const stablePrivatePackage = { version: "0.1.0", private: true, releaseState: "candidate" };
  const stablePrivateChangelog = `## [0.1.0] - Frozen release candidate\n\nVersion 0.1.0 is a frozen release candidate. Availability is established only by matching external readbacks; this immutable entry is not rewritten after publication.\n\n[Unreleased]: #unreleased\n[0.1.0]: #010---frozen-release-candidate\n`;
  const publicCandidatePackage = { version: "1.2.3", private: false, releaseState: "candidate" };
  const publicCandidateChangelog = `## [1.2.3] - Frozen release candidate\n\nVersion 1.2.3 is a frozen release candidate. Availability is established only by matching external readbacks; this immutable entry is not rewritten after publication.\n\n[Unreleased]: #unreleased\n[1.2.3]: #123---frozen-release-candidate\n`;
  const publicPackage = { version: "1.2.3", private: false, releaseState: "released" };

  if (
    !isSemanticVersion(privatePackage.version) ||
    isSemanticVersion("01.2.3") ||
    isSemanticVersion("1.2") ||
    isSemanticVersion("1.2.3-01") ||
    !isSemanticVersion("1.2.3+01") ||
    !changelogDescribesPackageState(privatePackage, privateChangelog) ||
    changelogDescribesPackageState(privatePackage, privateChangelogWithWrongAnchor) ||
    !changelogDescribesPackageState(stablePrivatePackage, stablePrivateChangelog) ||
    !changelogDescribesPackageState(publicCandidatePackage, publicCandidateChangelog) ||
    changelogDescribesPackageState(publicPackage, publicCandidateChangelog) ||
    changelogDescribesPackageState(
      { ...privatePackage, releaseState: "released" },
      privateChangelog,
    )
  ) {
    throw new Error("Release metadata policy self-test failed.");
  }
}
