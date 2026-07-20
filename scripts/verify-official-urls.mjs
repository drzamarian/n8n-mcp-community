import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DOCS_URL = /https:\/\/docs\.n8n\.io\/[^\s"'`)]+/g;
const DOCS_PREFIX = /^https:\/\/docs\.n8n\.io\//;

// The tracked manifest release/official-urls.txt is fed to the CI link-liveness
// gate. This parity check keeps it byte-locked to the URLs the server actually
// serves from src/content/official-urls.ts, so a runtime URL can never drift
// out of link coverage.
export const OFFICIAL_URL_MANIFEST = "release/official-urls.txt";
export const OFFICIAL_URL_SOURCE = "src/content/official-urls.ts";

function fail(message) {
  throw new Error(message);
}

export function extractOfficialUrls(source) {
  const urls = [...new Set(source.match(DOCS_URL) ?? [])].sort();
  if (urls.length === 0) {
    fail(`No official n8n documentation URLs were found in ${OFFICIAL_URL_SOURCE}.`);
  }
  return urls;
}

export function parseUrlManifest(text) {
  if (!text.endsWith("\n")) fail(`${OFFICIAL_URL_MANIFEST} must end with a newline.`);
  const urls = text.slice(0, -1).split("\n");
  if (urls.length === 0 || urls.some((url) => url === "")) {
    fail(`${OFFICIAL_URL_MANIFEST} must not contain blank lines.`);
  }
  if (urls.some((url) => !DOCS_PREFIX.test(url))) {
    fail(`${OFFICIAL_URL_MANIFEST} contains a non-docs.n8n.io entry.`);
  }
  if (new Set(urls).size !== urls.length) fail(`${OFFICIAL_URL_MANIFEST} contains duplicate URLs.`);
  if (JSON.stringify(urls) !== JSON.stringify([...urls].sort())) {
    fail(`${OFFICIAL_URL_MANIFEST} is not sorted.`);
  }
  return urls;
}

export function assertOfficialUrlParity(source, manifestText) {
  const sourceUrls = extractOfficialUrls(source);
  const manifestUrls = parseUrlManifest(manifestText);
  if (JSON.stringify(sourceUrls) !== JSON.stringify(manifestUrls)) {
    fail(
      `${OFFICIAL_URL_MANIFEST} diverges from ${OFFICIAL_URL_SOURCE}. ` +
        "Regenerate the manifest from the runtime URL set.",
    );
  }
  return sourceUrls;
}

export async function verifyOfficialUrlManifest(root) {
  const [source, manifestText] = await Promise.all([
    readFile(path.join(root, OFFICIAL_URL_SOURCE), "utf8"),
    readFile(path.join(root, OFFICIAL_URL_MANIFEST), "utf8"),
  ]);
  return assertOfficialUrlParity(source, manifestText);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const urls = await verifyOfficialUrlManifest(process.cwd());
  console.log(JSON.stringify({ officialUrls: urls.length, status: "pass" }, null, 2));
}
