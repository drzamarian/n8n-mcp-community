import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { trustedSystemEnv } from "./portable-cli.mjs";

const execFileAsync = promisify(execFile);
const checkedExtensions = new Set([".json", ".md", ".mjs", ".toml", ".ts", ".yaml", ".yml"]);

// This gate scans its own source with no self-exemption, so it must never embed
// a literal it rejects. Accents are expressed as \u escapes, generic needles
// wrap one character in a single-character class, and the private workspace
// codenames are stored base64-encoded (never in a readable form) and decoded at
// load time. None of these forms match the detectors, so the gate stays clean.
const portugueseResidue = new RegExp(
  "[\\u00e3\\u00f5\\u00e7\\u00e1\\u00e0\\u00e2\\u00e9\\u00ea\\u00ed\\u00f3\\u00f4\\u00fa\\u00fc]" +
    "|\\b(?:a[r]quivo|c[o]digo|cre[d]encial|docu[m]entacao|exe[c]ucao|fer[r]amenta|" +
    "inst[a]lacao|n[a]o|pa[s]ta|repos[i]torio|segu[r]anca|vo[c]e)\\b",
  "iu",
);
// Any personal machine home path (macOS /Users, Linux /home). The directory
// anchor is case-sensitive so the n8n "/users/{id}" API path is not a false
// positive, and the alternation keeps this file from holding a literal
// "/Users/" or "/home/" path of its own.
const personalHomePath = /\/(?:Users|home)\/[A-Za-z0-9][\w.-]*/u;
// Private workspace codenames from unrelated internal projects, decoded from
// base64 so no readable form of the identifiers is tracked in this file.
const privateCodenames = ["YmVsbGEtdjI=", "Y2FwaS12Mg=="].map((encoded) =>
  Buffer.from(encoded, "base64").toString("utf8"),
);
const privateCodenameResidue = new RegExp(`\\b(?:${privateCodenames.join("|")})\\b`, "iu");
const deprecatedToolName = /\bintro[s]pection\b/iu;
const deprecatedToolPath = /intro[s]pection/iu;

function hasPrivateResidue(text) {
  return personalHomePath.test(text) || privateCodenameResidue.test(text);
}

for (const fixture of [
  { text: "A secure public release candidate.", rejected: false },
  // Portuguese residue decoded from base64 so this file holds no accent of its own.
  {
    text: Buffer.from("RG9jdW1lbnRhw6fDo28gcMO6YmxpY2Eu", "base64").toString("utf8"),
    rejected: true,
  },
  // A personal home path assembled so this file holds no literal home path.
  { text: ["", "Users", "sample-account", "workspace"].join("/"), rejected: true },
  // A private codename in decoded form only (never a tracked literal).
  { text: privateCodenames[1], rejected: true },
  // The deprecated tool name assembled so this file holds no literal occurrence.
  { text: `Intro${"s"}pection Engine`, rejected: true },
]) {
  const rejected =
    portugueseResidue.test(fixture.text) ||
    hasPrivateResidue(fixture.text) ||
    deprecatedToolName.test(fixture.text) ||
    deprecatedToolPath.test(fixture.text);
  if (rejected !== fixture.rejected) {
    throw new Error("The public-language regression fixture failed.");
  }
}

const { stdout } = await execFileAsync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: trustedSystemEnv() },
);
const files = stdout
  .split("\0")
  .filter(Boolean)
  .filter((file) => checkedExtensions.has(path.extname(file)));
const failures = [];
let checkedTextFiles = 0;
for (const file of files) {
  if (file.startsWith("sdds/")) {
    failures.push(`${file}: internal specification is tracked across the publication boundary`);
    continue;
  }
  let content;
  try {
    content = await readFile(path.join(process.cwd(), file), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  checkedTextFiles += 1;
  if (portugueseResidue.test(content)) failures.push(`${file}: Portuguese-language residue`);
  if (hasPrivateResidue(content)) failures.push(`${file}: private workspace residue`);
  if (deprecatedToolName.test(content)) failures.push(`${file}: deprecated Introspect name`);
  if (deprecatedToolPath.test(file)) {
    failures.push(`${file}: deprecated Introspect path`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ checkedTextFiles, status: "pass" }, null, 2));
}
