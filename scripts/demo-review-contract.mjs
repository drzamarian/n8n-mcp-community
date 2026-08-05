import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { trustedSystemEnv } from "./portable-cli.mjs";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function fail(message) {
  throw new Error(`Invalid demo version history: ${message}`);
}

function parseReleaseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) fail(`expected an exact release version, received ${JSON.stringify(value)}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function runGit(root, args, encoding = "utf8") {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding,
    env: trustedSystemEnv(),
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errorCode = result.error?.code;
  if (errorCode === "ETIMEDOUT") fail("the Git release-anchor check timed out");
  if (errorCode === "ENOBUFS") fail("the Git release-anchor check exceeded its output limit");
  if (result.error) fail("could not launch Git for the release-anchor check");
  return result;
}

function validateHistoryEntries(history) {
  if (!Array.isArray(history) || history.length < 2) {
    fail("expected at least the predecessor and current release entries");
  }

  const versions = new Set();
  let previousVersion;

  for (const [index, entry] of history.entries()) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["gifSha256", "packageVersion"])
    ) {
      fail(`entry ${index} must contain only packageVersion and gifSha256`);
    }

    const version = parseReleaseVersion(entry.packageVersion);
    if (!/^[0-9a-f]{64}$/.test(entry.gifSha256)) {
      fail(`entry ${index} has an invalid SHA-256 digest`);
    }
    if (previousVersion && compareVersions(previousVersion, version) >= 0) {
      fail("release versions must be strictly increasing");
    }
    if (versions.has(entry.packageVersion))
      fail(`duplicate release version ${entry.packageVersion}`);

    versions.add(entry.packageVersion);
    previousVersion = version;
  }

  const current = history.at(-1);
  return current;
}

export function readPreviousDemoRelease(root, currentVersion) {
  const current = parseReleaseVersion(currentVersion);
  const tags = runGit(root, ["tag", "--list", "v*"]);
  if (tags.status !== 0) fail("could not enumerate release tags");

  const candidates = tags.stdout
    .split("\n")
    .map((tag) => ({ tag, match: /^v(\d+\.\d+\.\d+)$/.exec(tag) }))
    .filter(({ match }) => match && compareVersions(parseReleaseVersion(match[1]), current) < 0)
    .sort(({ match: left }, { match: right }) =>
      compareVersions(parseReleaseVersion(right[1]), parseReleaseVersion(left[1])),
    );
  const previous = candidates[0];
  if (!previous) fail(`no prior release tag exists before ${currentVersion}`);

  const objectType = runGit(root, ["cat-file", "-t", previous.tag]);
  if (objectType.status !== 0 || objectType.stdout.trim() !== "tag") {
    fail(`${previous.tag} must be an annotated release tag`);
  }

  const show = (path, encoding) => {
    const result = runGit(root, ["show", `${previous.tag}:${path}`], encoding);
    if (result.status !== 0) fail(`could not read ${path} from ${previous.tag}`);
    return result.stdout;
  };

  let previousManifest;
  let previousPackage;
  try {
    previousPackage = JSON.parse(show("package.json", "utf8"));
  } catch {
    fail(`${previous.tag} contains invalid package metadata`);
  }
  const previousVersion = previous.match[1];
  if (previousPackage.version !== previousVersion) {
    fail(`${previous.tag} does not match its package version`);
  }

  const manifestPath = "release/demo-review.json";
  const tree = runGit(root, ["ls-tree", "-r", "--name-only", previous.tag, "--", manifestPath]);
  if (tree.status !== 0) fail(`could not inspect ${previous.tag}`);
  if (tree.stdout.trim() === manifestPath) {
    try {
      previousManifest = JSON.parse(show(manifestPath, "utf8"));
    } catch {
      fail(`${previous.tag} contains an invalid demo review manifest`);
    }
    if (
      previousManifest === null ||
      typeof previousManifest !== "object" ||
      Array.isArray(previousManifest) ||
      ![2, 3].includes(previousManifest.schemaVersion) ||
      !Array.isArray(previousManifest.versionHistory)
    ) {
      fail(`${previous.tag} must contain a supported schema and a valid version history`);
    }
    validateHistoryEntries(previousManifest.versionHistory);
  }

  const gifSha256 = createHash("sha256").update(show("docs/assets/demo.gif", null)).digest("hex");
  if (previousManifest) {
    const previousCurrent = previousManifest.versionHistory.at(-1);
    if (
      previousCurrent.packageVersion !== previousVersion ||
      previousCurrent.gifSha256 !== gifSha256
    ) {
      fail(`${previous.tag} demo review manifest does not bind its released GIF`);
    }
  }

  return {
    packageVersion: previousVersion,
    gifSha256,
    versionHistory: previousManifest ? previousManifest.versionHistory : null,
  };
}

export function assertDemoVersionHistory(
  history,
  currentVersion,
  currentGifSha256,
  previousRelease,
) {
  const current = validateHistoryEntries(history);
  if (current.packageVersion !== currentVersion || current.gifSha256 !== currentGifSha256) {
    fail("the final entry must bind the current package version to the current GIF digest");
  }

  if (
    previousRelease === null ||
    typeof previousRelease !== "object" ||
    Array.isArray(previousRelease) ||
    !/^[0-9a-f]{64}$/.test(previousRelease.gifSha256) ||
    compareVersions(
      parseReleaseVersion(previousRelease.packageVersion),
      parseReleaseVersion(currentVersion),
    ) >= 0
  ) {
    fail("the previous release anchor is invalid");
  }

  if (previousRelease.versionHistory === null) {
    if (
      history.length !== 2 ||
      history[0].packageVersion !== previousRelease.packageVersion ||
      history[0].gifSha256 !== previousRelease.gifSha256
    ) {
      fail("the initial history must bind the predecessor tag and current release exactly");
    }
    return;
  }

  const previousCurrent = validateHistoryEntries(previousRelease.versionHistory);
  if (
    previousCurrent.packageVersion !== previousRelease.packageVersion ||
    previousCurrent.gifSha256 !== previousRelease.gifSha256
  ) {
    fail("the predecessor tag manifest does not bind its released GIF");
  }
  if (
    history.length !== previousRelease.versionHistory.length + 1 ||
    JSON.stringify(history.slice(0, -1)) !== JSON.stringify(previousRelease.versionHistory)
  ) {
    fail("the current history must extend the predecessor tag history without rewriting it");
  }
}
