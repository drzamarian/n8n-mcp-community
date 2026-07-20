import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPT_NAMES } from "../dist/prompts.js";
import { RESOURCE_URIS } from "../dist/resources.js";
import { TOOL_DEFINITIONS } from "../dist/tools/registry.js";
import { verifyOfficialUrlManifest } from "./verify-official-urls.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function collect(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function assertUnique(values, label) {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length > 0) {
    throw new Error(
      `${label} contains duplicate identifiers: ${[...new Set(duplicates)].join(", ")}`,
    );
  }
}

function assertExact(actual, expected, label) {
  assertUnique(actual, label);
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    const missing = expectedSorted.filter((value) => !actualSorted.includes(value));
    const unexpected = actualSorted.filter((value) => !expectedSorted.includes(value));
    throw new Error(
      `${label} is out of sync. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }
}

const readme = await readFile(resolve(ROOT, "README.md"), "utf8");
const toolsReference = await readFile(resolve(ROOT, "docs/tools.md"), "utf8");
const runtimeTools = TOOL_DEFINITIONS.map((tool) => tool.name);
const readmeLinks = [
  ...readme.matchAll(/\[`(n8n_[a-z0-9_]+)`\]\(docs\/tools\.md#(n8n_[a-z0-9_]+)\)/g),
];
for (const link of readmeLinks) {
  if (link[1] !== link[2]) {
    throw new Error(`README tool link ${link[1]} points to mismatched anchor ${link[2]}.`);
  }
}
const readmeTools = readmeLinks.map((link) => link[1]);
const referenceTools = collect(toolsReference, /^## (n8n_[a-z0-9_]+)$/gm);

assertExact(readmeTools, runtimeTools, "README tool table");
assertExact(referenceTools, runtimeTools, "Tool reference headings");

for (const uri of RESOURCE_URIS) {
  if (!readme.includes(`\`${uri}\``)) throw new Error(`README is missing resource ${uri}.`);
}
for (const prompt of PROMPT_NAMES) {
  if (!readme.includes(`\`${prompt}\``)) throw new Error(`README is missing prompt ${prompt}.`);
}

const officialUrls = await verifyOfficialUrlManifest(ROOT);

console.log(
  JSON.stringify(
    {
      tools: runtimeTools.length,
      resources: RESOURCE_URIS.length,
      prompts: PROMPT_NAMES.length,
      officialUrls: officialUrls.length,
      readmeParity: true,
      referenceParity: true,
      officialUrlParity: true,
      status: "pass",
    },
    null,
    2,
  ),
);
