const NUMERIC_IDENTIFIER = /^(?:0|[1-9][0-9]*)$/;
const VERSION_IDENTIFIER = /^[0-9A-Za-z-]+$/;

export const EXPECTED_MCPB_PLATFORMS = Object.freeze(["linux", "darwin", "win32"]);

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

function isCalendarDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function unpublishedCandidateAnchor(version) {
  const heading = `[${version}] - Unpublished candidate`;
  return `#${heading
    .toLowerCase()
    .replace(/[^a-z0-9_ -]/g, "")
    .replaceAll(" ", "-")}`;
}

export function changelogDescribesPackageState(packageJson, changelog, repositoryUrl) {
  const version = packageJson.version;
  if (!isSemanticVersion(version)) return false;
  const lines = changelog.split(/\r?\n/);
  if (!changelog.includes("[Unreleased]:")) return false;

  if (packageJson.private === true) {
    const unpublishedHeading = `[${version}] - Unpublished candidate`;
    return (
      lines.filter((line) => line === `## ${unpublishedHeading}`).length === 1 &&
      changelog.includes(`[${version}]: ${unpublishedCandidateAnchor(version)}`) &&
      changelog.includes("[Unreleased]: #unreleased") &&
      changelog.includes("No public version has been released.")
    );
  }

  if (packageJson.private !== false) return false;
  const releasePrefix = `## [${version}] - `;
  const releaseHeadings = lines.filter((line) => line.startsWith(releasePrefix));
  const releaseDate = releaseHeadings[0]?.slice(releasePrefix.length);
  return (
    releaseHeadings.length === 1 &&
    isCalendarDate(releaseDate) &&
    changelog.includes(`[${version}]: ${repositoryUrl}/releases/tag/v${version}`) &&
    changelog.includes(`[Unreleased]: ${repositoryUrl}/compare/v${version}...HEAD`) &&
    !changelog.includes(`## [${version}] - Unpublished candidate`) &&
    !changelog.includes("No public version has been released.")
  );
}

export function verifyReleaseMetadataPolicySelfTest() {
  const repository = "https://github.com/example/project";
  const privatePackage = { version: "1.2.3-rc.1", private: true };
  const privateChangelog = `## [1.2.3-rc.1] - Unpublished candidate\n\nNo public version has been released.\n\n[Unreleased]: #unreleased\n[1.2.3-rc.1]: #123-rc1---unpublished-candidate\n`;
  const privateChangelogWithWrongAnchor = privateChangelog.replace(
    "#123-rc1---unpublished-candidate",
    "#1231---unpublished-candidate",
  );
  const stablePrivatePackage = { version: "0.1.0", private: true };
  const stablePrivateChangelog = `## [0.1.0] - Unpublished candidate\n\nNo public version has been released.\n\n[Unreleased]: #unreleased\n[0.1.0]: #010---unpublished-candidate\n`;
  const publicPackage = { version: "1.2.3", private: false };
  const publicChangelog = `## [1.2.3] - 2026-07-18\n\n[Unreleased]: ${repository}/compare/v1.2.3...HEAD\n[1.2.3]: ${repository}/releases/tag/v1.2.3\n`;

  if (
    !isSemanticVersion(privatePackage.version) ||
    isSemanticVersion("01.2.3") ||
    isSemanticVersion("1.2") ||
    isSemanticVersion("1.2.3-01") ||
    !isSemanticVersion("1.2.3+01") ||
    !changelogDescribesPackageState(privatePackage, privateChangelog, repository) ||
    changelogDescribesPackageState(privatePackage, privateChangelogWithWrongAnchor, repository) ||
    !changelogDescribesPackageState(stablePrivatePackage, stablePrivateChangelog, repository) ||
    !changelogDescribesPackageState(publicPackage, publicChangelog, repository) ||
    changelogDescribesPackageState(
      { ...publicPackage, private: true },
      publicChangelog,
      repository,
    ) ||
    changelogDescribesPackageState(
      { ...privatePackage, private: false },
      privateChangelog,
      repository,
    )
  ) {
    throw new Error("Release metadata policy self-test failed.");
  }
}
