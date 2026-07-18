import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const checkedExtensions = new Set([".json", ".md", ".mjs", ".toml", ".ts", ".yaml", ".yml"]);
const portugueseResidue =
  /[ãõçáàâéêíóôúü]|\b(?:arquivo|codigo|credencial|documentacao|execucao|ferramenta|instalacao|nao|pasta|repositorio|seguranca|voce)\b/iu;
const privateResidue = /\/Users\/walter\b|\b(?:bella-v2|capi-v2)\b/iu;
const deprecatedToolName = /\bintrospection\b/iu;

for (const fixture of [
  { text: "A secure public repository.", rejected: false },
  { text: "Documentação pública.", rejected: true },
  { text: "/Users/walter/private", rejected: true },
  { text: "Introspection Engine", rejected: true },
]) {
  const rejected =
    portugueseResidue.test(fixture.text) ||
    privateResidue.test(fixture.text) ||
    deprecatedToolName.test(fixture.text);
  if (rejected !== fixture.rejected) {
    throw new Error("The public-language regression fixture failed.");
  }
}

const { stdout } = await execFileAsync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
);
const files = stdout
  .split("\0")
  .filter(Boolean)
  .filter((file) => file !== "scripts/verify-public-language.mjs")
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
  if (privateResidue.test(content)) failures.push(`${file}: private workspace residue`);
  if (deprecatedToolName.test(content)) failures.push(`${file}: deprecated Introspect name`);
  if (file.toLowerCase().includes("introspection")) {
    failures.push(`${file}: deprecated Introspect path`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ checkedTextFiles, status: "pass" }, null, 2));
}
