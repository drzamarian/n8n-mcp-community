import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { TOOL_DEFINITIONS } from "../dist/tools/registry.js";

const examplesPath = path.join(process.cwd(), "docs/examples.md");
const markdown = await readFile(examplesPath, "utf8");
const markedInput = /<!--\s*tool-input:\s*([a-z0-9_]+)\s*-->\s*```json\s*\n([\s\S]*?)```/g;
const definitions = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
const seen = new Set();
const failures = [];

for (const match of markdown.matchAll(markedInput)) {
  const [, name, rawJson] = match;
  const definition = definitions.get(name);
  if (!definition) {
    failures.push(`Unknown tool in marked example: ${name}`);
    continue;
  }
  if (seen.has(name)) failures.push(`Duplicate marked example: ${name}`);
  seen.add(name);
  let input;
  try {
    input = JSON.parse(rawJson);
  } catch {
    failures.push(`Invalid JSON in marked example: ${name}`);
    continue;
  }
  try {
    definition.validateInput(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown schema failure";
    failures.push(`Invalid ${name} input: ${message}`);
  }
}

if (seen.size !== 4) failures.push(`Expected 4 marked tool examples, found ${seen.size}`);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ schemaValidatedToolExamples: seen.size, status: "pass" }, null, 2));
}
