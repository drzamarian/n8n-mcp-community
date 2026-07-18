import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const targets = {
  runtime: "dist",
  test: ".test-dist",
};

const selected = process.argv.slice(2);
const names = selected.length === 0 ? Object.keys(targets) : selected;

for (const name of names) {
  const target = targets[name];
  if (!target) {
    throw new Error("Unknown clean target. Expected runtime or test.");
  }
  await rm(path.join(process.cwd(), target), { recursive: true, force: true });
}
