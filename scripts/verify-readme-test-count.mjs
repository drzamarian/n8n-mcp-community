import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

async function testFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await testFiles(target)));
    else if (entry.name.endsWith(".test.js")) output.push(target);
  }
  return output.sort();
}

const files = await testFiles(path.join(process.cwd(), ".test-dist", "test"));
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-reporter=tap", ...files],
  { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
);
if (result.status !== 0) throw new Error("The test-count discovery run failed.");
const count = Number(/^# tests (\d+)$/m.exec(result.stdout)?.[1]);
if (!Number.isInteger(count) || count < 1) throw new Error("The test count could not be parsed.");
const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");
const documented = Number(/\*\*(\d+) passing tests\*\*/.exec(readme)?.[1]);
if (documented !== count) {
  throw new Error(
    `README test count ${documented || "missing"} differs from suite count ${count}.`,
  );
}
console.log(JSON.stringify({ tests: count, status: "pass" }, null, 2));
