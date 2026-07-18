import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const SCHEMA_URL = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const SCHEMA_SHA256 = "3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0";
const MAX_SCHEMA_BYTES = 256 * 1024;
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 30_000;

async function fetchPinnedSchema() {
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(SCHEMA_URL, {
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt === FETCH_ATTEMPTS) {
        throw new Error(
          `The pinned MCP Registry schema could not be retrieved after ${FETCH_ATTEMPTS} attempts.`,
          { cause: error },
        );
      }
    }
  }

  throw new Error("The pinned MCP Registry schema fetch loop ended unexpectedly.");
}

const response = await fetchPinnedSchema();
if (!response.ok) {
  throw new Error("The pinned MCP Registry schema could not be retrieved.");
}
const bytes = new Uint8Array(await response.arrayBuffer());
if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCHEMA_BYTES) {
  throw new Error("The pinned MCP Registry schema exceeded its size boundary.");
}
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== SCHEMA_SHA256) {
  throw new Error("The pinned MCP Registry schema digest changed unexpectedly.");
}

const schema = JSON.parse(new TextDecoder().decode(bytes));
const document = JSON.parse(await readFile(path.join(process.cwd(), "server.json"), "utf8"));
const ajv = new Ajv({ strict: true, strictRequired: false });
ajv.addKeyword("example");
addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(document)) {
  throw new Error("server.json does not satisfy the pinned official MCP Registry schema.");
}

console.log(
  JSON.stringify(
    {
      schema: "2025-12-11",
      sha256: digest,
      bytes: bytes.byteLength,
      status: "pass",
    },
    null,
    2,
  ),
);
