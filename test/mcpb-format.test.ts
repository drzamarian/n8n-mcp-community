import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { zipSync } from "fflate";

interface McpbFormatModule {
  extractMcpbPayload(content: Buffer): Buffer;
  isExcludedMcpbPath(path: string): boolean;
  unpackMcpbFile(source: string, target: string): Promise<{ files: number; unpackedBytes: number }>;
  validateMcpbManifestFile(file: string): Promise<Record<string, unknown>>;
}

test("the local packer preserves the official MCPB exclusion contract", async () => {
  const format = await loadMcpbFormat();
  for (const excluded of [
    ".env",
    "server/.env.production",
    "server/node_modules/.bin/tool",
    "server/node_modules/pkg/index.d.ts",
    "server/node_modules/pkg/index.js.map",
    "server/node_modules/pkg/tsconfig.json",
    "server/node_modules/pkg/package-lock.json",
    "nested/debug.log",
    "nested/archive.mcpb",
    "nested/.git/config",
  ]) {
    assert.equal(format.isExcludedMcpbPath(excluded), true, excluded);
  }
  for (const included of [
    "manifest.json",
    "LICENSE",
    "server/package.json",
    "server/dist/index.js",
    "server/node_modules/pkg/LICENSE",
  ]) {
    assert.equal(format.isExcludedMcpbPath(included), false, included);
  }
});

async function loadMcpbFormat(): Promise<McpbFormatModule> {
  const href = pathToFileURL(path.join(process.cwd(), "scripts", "mcpb-format.mjs")).href;
  return (await import(href)) as McpbFormatModule;
}

test("the pinned official schema accepts the maintained MCPB manifest", async () => {
  const format = await loadMcpbFormat();
  const repositoryRoot = process.cwd();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "mcpb-cwd-test-"));
  try {
    process.chdir(temporaryRoot);
    const manifest = await format.validateMcpbManifestFile(
      path.join(repositoryRoot, "mcpb", "manifest.json"),
    );
    assert.equal(manifest.manifest_version, "0.4");
    assert.equal(manifest.name, "n8n-mcp-community");
  } finally {
    process.chdir(repositoryRoot);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the pinned official schema rejects an incompatible manifest version", async () => {
  const format = await loadMcpbFormat();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "mcpb-schema-test-"));
  try {
    const manifest = JSON.parse(
      await readFile(path.join(process.cwd(), "mcpb", "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    manifest.manifest_version = "0.3";
    const candidate = path.join(temporaryRoot, "manifest.json");
    await writeFile(candidate, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      format.validateMcpbManifestFile(candidate),
      /pinned official v0\.4 schema/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("signature framing recovers the exact unsigned MCPB payload", async () => {
  const format = await loadMcpbFormat();
  const payload = Buffer.from("reviewed-mcpb-payload");
  const signature = Buffer.from("synthetic-cms-signature");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signature.length);
  const signed = Buffer.concat([
    payload,
    Buffer.from("MCPB_SIG_V1"),
    length,
    signature,
    Buffer.from("MCPB_SIG_END"),
  ]);
  assert.deepEqual(format.extractMcpbPayload(signed), payload);

  const malformed = Buffer.from(signed);
  malformed.writeUInt32LE(signature.length + 1, payload.length + Buffer.byteLength("MCPB_SIG_V1"));
  assert.throws(() => format.extractMcpbPayload(malformed), /framing is not canonical/);
});

test("MCPB extraction writes bounded regular files and rejects traversal", async () => {
  const format = await loadMcpbFormat();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "mcpb-unpack-test-"));
  try {
    const safeBundle = path.join(temporaryRoot, "safe.mcpb");
    await writeFile(
      safeBundle,
      zipSync({
        "manifest.json": Buffer.from("{}"),
        "server/dist/index.js": Buffer.from("export {};\n"),
      }),
    );
    const safeOutput = path.join(temporaryRoot, "safe-output");
    const result = await format.unpackMcpbFile(safeBundle, safeOutput);
    assert.deepEqual(result, {
      files: 2,
      unpackedBytes: Buffer.byteLength("{}") + Buffer.byteLength("export {};\n"),
    });
    assert.equal(
      await readFile(path.join(safeOutput, "server", "dist", "index.js"), "utf8"),
      "export {};\n",
    );

    const traversalBundle = path.join(temporaryRoot, "traversal.mcpb");
    await writeFile(traversalBundle, zipSync({ "../escape": Buffer.from("blocked") }));
    await assert.rejects(
      format.unpackMcpbFile(traversalBundle, path.join(temporaryRoot, "traversal-output")),
      /unsafe archive path/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("MCPB extraction rejects ambiguous or oversized ZIP metadata before decompression", async () => {
  const format = await loadMcpbFormat();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "mcpb-zip-bomb-test-"));
  try {
    const archive = Buffer.from(zipSync({ "manifest.json": Buffer.from("{}") }));
    const centralHeader = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert(centralHeader >= 0, "Synthetic ZIP must contain a central-directory entry.");
    archive.writeUInt32LE(512 * 1024 * 1024 + 1, centralHeader + 24);
    const candidate = path.join(temporaryRoot, "bomb.mcpb");
    await writeFile(candidate, archive);
    await assert.rejects(
      format.unpackMcpbFile(candidate, path.join(temporaryRoot, "output")),
      /expands beyond/,
    );

    const canonical = Buffer.from(zipSync({ "manifest.json": Buffer.from("{}") }));
    const eocd = canonical.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert(eocd >= 0, "Synthetic ZIP must contain an end-of-central-directory record.");

    const commented = Buffer.concat([canonical, Buffer.from("note")]);
    commented.writeUInt16LE(4, eocd + 20);
    const commentedCandidate = path.join(temporaryRoot, "commented.mcpb");
    await writeFile(commentedCandidate, commented);
    await assert.rejects(
      format.unpackMcpbFile(commentedCandidate, path.join(temporaryRoot, "comment-output")),
      /ZIP comments are not supported/,
    );

    const zip64Locator = Buffer.alloc(20);
    zip64Locator.writeUInt32LE(0x07064b50);
    const zip64Candidate = path.join(temporaryRoot, "zip64-locator.mcpb");
    await writeFile(
      zip64Candidate,
      Buffer.concat([canonical.subarray(0, eocd), zip64Locator, canonical.subarray(eocd)]),
    );
    await assert.rejects(
      format.unpackMcpbFile(zip64Candidate, path.join(temporaryRoot, "zip64-output")),
      /ZIP64 archives are not supported/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
