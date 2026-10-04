import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const loadModule = createRequire(import.meta.url);
const Ajv = loadModule("ajv");
const addFormats = loadModule("ajv-formats");

const SIGNATURE_HEADER = Buffer.from("MCPB_SIG_V1", "utf8");
const SIGNATURE_FOOTER = Buffer.from("MCPB_SIG_END", "utf8");
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const EXCLUDED_BASENAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".gitignore",
  ".mcpbignore",
  ".npmrc",
  ".yarnrc",
  ".eslintrc",
  ".editorconfig",
  ".prettierrc",
  ".prettierignore",
  ".eslintignore",
  ".nycrc",
  ".babelrc",
  "package-lock.json",
  "yarn.lock",
  "tsconfig.json",
]);
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", ".npm", ".yarn"]);

/** @param {unknown} value @param {string} label */
function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

/** @param {string} relativePath */
export function isExcludedMcpbPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const components = normalized.split("/");
  const basename = components.at(-1) ?? "";
  if (components.some((component) => EXCLUDED_DIRECTORY_NAMES.has(component))) return true;
  if (
    components.some(
      (component, index) =>
        component === "node_modules" &&
        (components[index + 1] === ".cache" || components[index + 1] === ".bin"),
    )
  ) {
    return true;
  }
  return (
    EXCLUDED_BASENAMES.has(basename) ||
    basename.startsWith(".env") ||
    basename.startsWith(".pnp.") ||
    basename.startsWith("npm-debug.log") ||
    basename.startsWith("yarn-debug.log") ||
    basename.startsWith("yarn-error.log") ||
    basename.endsWith(".log") ||
    basename.endsWith(".map") ||
    basename.endsWith(".d.ts") ||
    basename.endsWith(".tsbuildinfo") ||
    basename.endsWith(".mcpb")
  );
}

/** @param {Buffer} fileContent */
export function extractMcpbPayload(fileContent) {
  if (!Buffer.isBuffer(fileContent)) {
    throw new Error("MCPB content must be a Buffer.");
  }
  const footerIndex = fileContent.length - SIGNATURE_FOOTER.length;
  if (footerIndex < 0 || !fileContent.subarray(footerIndex).equals(SIGNATURE_FOOTER)) {
    return fileContent;
  }
  const headerIndex = fileContent.lastIndexOf(SIGNATURE_HEADER, footerIndex);
  if (headerIndex < 0) throw new Error("Signed MCPB has no signature header.");
  const lengthOffset = headerIndex + SIGNATURE_HEADER.length;
  if (lengthOffset + 4 > footerIndex) throw new Error("Signed MCPB signature length is missing.");
  const signatureLength = fileContent.readUInt32LE(lengthOffset);
  const signatureOffset = lengthOffset + 4;
  if (signatureLength <= 0 || signatureOffset + signatureLength !== footerIndex) {
    throw new Error("Signed MCPB signature framing is not canonical.");
  }
  return fileContent.subarray(0, headerIndex);
}

/** @param {string} manifestPath @returns {Promise<Record<string, unknown>>} */
export async function validateMcpbManifestFile(manifestPath) {
  const schemaPath = fileURLToPath(
    new URL("../mcpb/mcpb-manifest-v0.4.schema.json", import.meta.url),
  );
  const [manifestText, schemaText] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(schemaPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const schema = JSON.parse(schemaText);
  assertPlainObject(manifest, "MCPB manifest");
  assertPlainObject(schema, "MCPB manifest schema");
  const ajv = new Ajv({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(manifest)) {
    const errors = (validate.errors ?? [])
      .slice(0, 8)
      .map(
        /** @param {import("ajv").ErrorObject} error */
        (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      )
      .join("; ");
    throw new Error(`MCPB manifest does not match the pinned official v0.4 schema: ${errors}`);
  }
  return manifest;
}

/** @param {string} relativePath */
function safeArchivePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(relativePath)
  ) {
    throw new Error(`MCPB contains an unsafe archive path: ${relativePath}`);
  }
  const components = relativePath.split(/[\\/]/);
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw new Error(`MCPB contains an unsafe archive path: ${relativePath}`);
  }
  return components.join("/");
}

/** @param {Buffer} payload */
function inspectZipCentralDirectory(payload) {
  if (payload.length === 0 || payload.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`MCPB archive size must be between 1 and ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  const minimumEocd = 22;
  const maximumComment = 65_535;
  const searchStart = Math.max(0, payload.length - minimumEocd - maximumComment);
  let eocdOffset = -1;
  for (let offset = payload.length - minimumEocd; offset >= searchStart; offset -= 1) {
    if (payload.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      const commentLength = payload.readUInt16LE(offset + 20);
      if (offset + minimumEocd + commentLength === payload.length) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) throw new Error("MCPB has no canonical ZIP end record.");

  const eocdCommentLength = payload.readUInt16LE(eocdOffset + 20);
  if (eocdCommentLength !== 0) {
    throw new Error("MCPB ZIP comments are not supported.");
  }
  if (
    eocdOffset >= 20 &&
    payload.readUInt32LE(eocdOffset - 20) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR
  ) {
    throw new Error("MCPB ZIP64 archives are not supported.");
  }

  const disk = payload.readUInt16LE(eocdOffset + 4);
  const centralDisk = payload.readUInt16LE(eocdOffset + 6);
  const diskEntries = payload.readUInt16LE(eocdOffset + 8);
  const totalEntries = payload.readUInt16LE(eocdOffset + 10);
  const centralSize = payload.readUInt32LE(eocdOffset + 12);
  const centralOffset = payload.readUInt32LE(eocdOffset + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("MCPB must use one non-ZIP64 archive disk.");
  }
  if (totalEntries === 0 || totalEntries > MAX_FILES) {
    throw new Error(`MCPB file count must be between 1 and ${MAX_FILES}.`);
  }
  if (centralOffset + centralSize !== eocdOffset) {
    throw new Error("MCPB central directory boundaries are invalid.");
  }

  let offset = centralOffset;
  let unpackedBytes = 0;
  const names = new Set();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > eocdOffset || payload.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER) {
      throw new Error("MCPB central directory entry is invalid.");
    }
    const flags = payload.readUInt16LE(offset + 8);
    const method = payload.readUInt16LE(offset + 10);
    const compressedSize = payload.readUInt32LE(offset + 20);
    const uncompressedSize = payload.readUInt32LE(offset + 24);
    const nameLength = payload.readUInt16LE(offset + 28);
    const extraLength = payload.readUInt16LE(offset + 30);
    const commentLength = payload.readUInt16LE(offset + 32);
    const diskStart = payload.readUInt16LE(offset + 34);
    const localOffset = payload.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (
      end > eocdOffset ||
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      (flags & 1) !== 0 ||
      (method !== 0 && method !== 8)
    ) {
      throw new Error("MCPB central directory uses an unsupported ZIP feature.");
    }
    let originalName;
    try {
      originalName = decoder.decode(payload.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      throw new Error("MCPB contains a non-UTF-8 archive path.");
    }
    const relativeName = safeArchivePath(originalName);
    if (names.has(relativeName)) {
      throw new Error(`MCPB contains duplicate normalized path: ${relativeName}`);
    }
    names.add(relativeName);
    unpackedBytes += uncompressedSize;
    if (unpackedBytes > MAX_UNPACKED_BYTES) {
      throw new Error(`MCPB expands beyond ${MAX_UNPACKED_BYTES} bytes.`);
    }
    offset = end;
  }
  if (offset !== eocdOffset) throw new Error("MCPB central directory has trailing data.");
  return { files: totalEntries, unpackedBytes };
}

/**
 * @param {string} mcpbPath
 * @param {string} outputDirectory
 */
export async function unpackMcpbFile(mcpbPath, outputDirectory) {
  const payload = extractMcpbPayload(await readFile(mcpbPath));
  const declared = inspectZipCentralDirectory(payload);
  const entries = unzipSync(payload);
  const names = Object.keys(entries);
  if (names.length !== declared.files) {
    throw new Error("MCPB extracted file count differs from its central directory.");
  }
  let totalBytes = 0;
  const normalizedNames = new Set();
  for (const originalName of names) {
    const relativeName = safeArchivePath(originalName);
    if (normalizedNames.has(relativeName)) {
      throw new Error(`MCPB contains duplicate normalized path: ${relativeName}`);
    }
    normalizedNames.add(relativeName);
    const content = entries[originalName];
    if (!(content instanceof Uint8Array)) {
      throw new Error(`MCPB entry has no file content: ${relativeName}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_UNPACKED_BYTES) {
      throw new Error(`MCPB expands beyond ${MAX_UNPACKED_BYTES} bytes.`);
    }
    const target = path.resolve(outputDirectory, relativeName);
    const boundary = path.relative(path.resolve(outputDirectory), target);
    if (boundary.startsWith("..") || path.isAbsolute(boundary)) {
      throw new Error(`MCPB path escapes the output directory: ${relativeName}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o644 });
  }
  if (totalBytes !== declared.unpackedBytes) {
    throw new Error("MCPB extracted size differs from its central directory.");
  }
  return declared;
}
