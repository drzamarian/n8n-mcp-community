import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_INVENTORY = Object.freeze({
  packagePaths: 224,
  uniqueComponents: 222,
  runtimePackagePaths: 93,
  developmentPackagePaths: 131,
});
const ALLOWED_LICENSES = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "MIT",
]);
const NOTICE_FILE = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
const NOTICE_EXCEPTIONS = new Map(
  [
    {
      name: "@humanfs/types",
      version: "0.15.0",
      license: "Apache-2.0",
      integrity:
        "sha512-ZZ1w0aoQkwuUuC7Yf+7sdeaNfqQiiLcSRbfI08oAxqLtpXQr9AIVX7Ay7HLDuiLYAaFPu8oBYNq/QIi9URHJ3Q==",
      repository: "git+https://github.com/humanwhocodes/humanfs.git",
    },
    {
      name: "esrecurse",
      version: "4.3.0",
      license: "BSD-2-Clause",
      integrity:
        "sha512-KmfKL3b6G+RXvP8N1vr3Tq1kL/oCFgn2NYXEtqP8/L3pKapUA4G8cFVaoF3SU323CD4XypR/ffioHmkti6/Tag==",
      repository: "https://github.com/estools/esrecurse.git",
    },
    {
      name: "flora-colossus",
      version: "2.0.0",
      license: "MIT",
      integrity:
        "sha512-dz4HxH6pOvbUzZpZ/yXhafjbR2I8cenK5xL0KtBFb7U2ADsR+OwXifnxZjij/pZWF775uSCMzWVd+jDik2H2IA==",
      repository: "https://github.com/MarshallOfSound/flora-colossus",
    },
    {
      name: "imurmurhash",
      version: "0.1.4",
      license: "MIT",
      integrity:
        "sha512-JmXMZ6wuvDmLiHEml9ykzqO6lwFbof0GG4IkcGaENdCRDDmMVnny7s5HsIgHCbaq0w2MyPhDqkhTUgS2LU2PHA==",
      repository: "https://github.com/jensyt/imurmurhash-js",
    },
    {
      name: "keyv",
      version: "4.5.4",
      license: "MIT",
      integrity:
        "sha512-oxVHkHR/EJf2CNXnWxRLW6mg7JyCCUcG0DtEGmL2ctUo1PNTin1PUil+r/+4r5MpVgC/fn1kjsx7mjSujKqIpw==",
      repository: "git+https://github.com/jaredwray/keyv.git",
    },
    {
      name: "natural-compare",
      version: "1.4.0",
      license: "MIT",
      integrity:
        "sha512-OWND8ei3VtNC9h7V60qff3SVobHr996CTwgxubgyQYEpg290h9J0buyECNNJexkFm5sOajh5G116RYA1c8ZMSw==",
      repository: "git://github.com/litejs/natural-compare-lite.git",
    },
  ].map((entry) => [`${entry.name}@${entry.version}`, entry]),
);
const LICENSE_SELECTIONS = new Map(
  [
    {
      name: "node-forge",
      version: "1.4.0",
      declaredLicense: "(BSD-3-Clause OR GPL-2.0)",
      selectedLicense: "BSD-3-Clause",
      integrity:
        "sha512-LarFH0+6VfriEhqMMcLX2F7SwSXeWwnEAJEsYm5QKWchiVYVvJyV9v7UDvUv+w5HO23ZpQTXDv/GxdDdMyOuoQ==",
      repository: "https://github.com/digitalbazaar/forge",
    },
    {
      name: "type-fest",
      version: "0.21.3",
      declaredLicense: "(MIT OR CC0-1.0)",
      selectedLicense: "MIT",
      integrity:
        "sha512-t0rzBq87m3fVcduHDUFhKmyyX+9eo6WQjZvf51Ea/M0Q7+T374Jp1aUiyUl0GKxp8M/OETVHSDvmkyPgvX+X2w==",
      repository: "sindresorhus/type-fest",
    },
  ].map((entry) => [`${entry.name}@${entry.version}`, entry]),
);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value;
}

const lock = await readJson(resolve(ROOT, "package-lock.json"));
if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
  throw new Error("package-lock.json does not contain a valid packages map.");
}

const rows = [];
const observedLicenseSelections = new Set();
for (const [directory, entry] of Object.entries(lock.packages)) {
  if (directory === "") continue;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Lockfile entry ${directory} is invalid.`);
  }
  const packageDirectory = resolve(ROOT, directory);
  if (!packageDirectory.startsWith(`${ROOT}${sep}`)) {
    throw new Error(`Lockfile entry ${directory} resolves outside the repository.`);
  }
  const manifest = await readJson(resolve(packageDirectory, "package.json"));
  const name = requireString(manifest.name, `${directory} package name`);
  const version = requireString(manifest.version, `${name} package version`);
  const declaredLicense = requireString(
    manifest.license ?? entry.license,
    `${name}@${version} license`,
  );
  const integrity = requireString(entry.integrity, `${name}@${version} integrity`);
  const repository =
    typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  let license = declaredLicense;
  if (!ALLOWED_LICENSES.has(license)) {
    const selection = LICENSE_SELECTIONS.get(`${name}@${version}`);
    if (
      entry.dev !== true ||
      !selection ||
      selection.declaredLicense !== declaredLicense ||
      !ALLOWED_LICENSES.has(selection.selectedLicense) ||
      selection.integrity !== integrity ||
      selection.repository !== repository
    ) {
      throw new Error(`${name}@${version} uses unreviewed license ${declaredLicense}.`);
    }
    license = selection.selectedLicense;
    observedLicenseSelections.add(`${name}@${version}`);
  }
  const noticeFiles = (await readdir(packageDirectory)).filter((file) => NOTICE_FILE.test(file));
  let documentedNoticeException = false;
  if (noticeFiles.length === 0) {
    const exception = NOTICE_EXCEPTIONS.get(`${name}@${version}`);
    if (
      entry.dev !== true ||
      !exception ||
      exception.license !== license ||
      exception.integrity !== integrity ||
      exception.repository !== repository
    ) {
      throw new Error(`${name}@${version} has no installed license or notice file.`);
    }
    documentedNoticeException = true;
  }
  rows.push({
    name,
    version,
    license,
    declaredLicense,
    role: entry.dev === true ? "development" : "runtime",
    integrity,
    noticeFiles: noticeFiles.sort(),
    documentedNoticeException,
  });
}

const observedExceptions = new Set(
  rows.filter((row) => row.documentedNoticeException).map((row) => `${row.name}@${row.version}`),
);
for (const key of NOTICE_EXCEPTIONS.keys()) {
  if (!observedExceptions.has(key)) {
    throw new Error(`Documented notice exception ${key} is stale or not installed.`);
  }
}
for (const key of LICENSE_SELECTIONS.keys()) {
  if (!observedLicenseSelections.has(key)) {
    throw new Error(`Documented license selection ${key} is stale or not installed.`);
  }
}

rows.sort(
  (left, right) =>
    left.name.localeCompare(right.name, "en-US") ||
    left.version.localeCompare(right.version, "en-US") ||
    left.role.localeCompare(right.role, "en-US"),
);
const uniqueComponents = new Set(rows.map((row) => `${row.name}@${row.version}`));
const observedInventory = {
  packagePaths: rows.length,
  uniqueComponents: uniqueComponents.size,
  runtimePackagePaths: rows.filter((row) => row.role === "runtime").length,
  developmentPackagePaths: rows.filter((row) => row.role === "development").length,
};
if (JSON.stringify(observedInventory) !== JSON.stringify(EXPECTED_INVENTORY)) {
  throw new Error(
    `Installed package-path inventory drifted: ${JSON.stringify(observedInventory)}. Review dependencies and update the approved inventory deliberately.`,
  );
}
const licenses = Object.fromEntries(
  [...ALLOWED_LICENSES]
    .sort()
    .map((license) => [license, rows.filter((row) => row.license === license).length])
    .filter(([, count]) => count > 0),
);

console.log(
  JSON.stringify(
    {
      ...observedInventory,
      licenses,
      missingIntegrity: 0,
      missingLicense: 0,
      missingNoticeFile: 0,
      documentedDevOnlyNoticeExceptions: observedExceptions.size,
      selectedDevOnlyLicenseAlternatives: observedLicenseSelections.size,
      status: "pass",
    },
    null,
    2,
  ),
);
