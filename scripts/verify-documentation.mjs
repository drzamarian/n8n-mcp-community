import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { assertDemoVersionHistory, readPreviousDemoRelease } from "./demo-review-contract.mjs";

const root = process.cwd();
const rootDocuments = [
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "README.md",
  "ROADMAP.md",
  "SECURITY.md",
  "SUPPORT.md",
  "THIRD_PARTY_NOTICES.md",
];
const documentationFiles = (await readdir(path.join(root, "docs")))
  .filter((name) => name.endsWith(".md"))
  .sort()
  .map((name) => `docs/${name}`);
const documentationAssets = (
  await readdir(path.join(root, "docs", "assets"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isFile())
  .map((entry) => `docs/assets/${entry.name}`)
  .sort();
const packageDocumentationFiles = documentationFiles.filter((file) => file !== "docs/releasing.md");
const repositoryOnlyAssets = new Set(["docs/assets/demo.gif"]);
const shippedFiles = new Set([...rootDocuments, "LICENSE", ...packageDocumentationFiles]);
const localLink = /\[[^\]]*\]\(([^)]+)\)/g;
const fencedBlock = /```(json|bash|sh|shell)\s*\n([\s\S]*?)```/g;
const failures = [];
let checkedLinks = 0;
let checkedJsonBlocks = 0;
let checkedShellBlocks = 0;
const referencedLocalFiles = new Set();

const troubleshooting = await readFile(path.join(root, "docs", "troubleshooting.md"), "utf8");
const { INTROSPECT_ERROR_CODES, INTROSPECT_LIMITATION_CODES } = await import(
  pathToFileURL(path.join(root, "dist", "introspect", "contracts.js")).href
);
for (const code of INTROSPECT_ERROR_CODES) {
  if (!troubleshooting.includes(`\`${code}\``)) {
    failures.push(`docs/troubleshooting.md: missing stable Introspect code ${code}`);
  }
}
const errorStartMarker = "<!-- introspect-errors:start -->";
const errorEndMarker = "<!-- introspect-errors:end -->";
const errorStart = troubleshooting.indexOf(errorStartMarker);
const errorEnd = troubleshooting.indexOf(errorEndMarker);
if (errorStart < 0 || errorEnd <= errorStart) {
  failures.push("docs/troubleshooting.md: missing Introspect error-code block");
} else {
  const errorBlock = troubleshooting.slice(errorStart + errorStartMarker.length, errorEnd);
  const documented = [...errorBlock.matchAll(/^\| `([a-z_]+)`\s*\|/gm)].map((match) => match[1]);
  if (
    JSON.stringify([...documented].sort()) !== JSON.stringify([...INTROSPECT_ERROR_CODES].sort())
  ) {
    failures.push("docs/troubleshooting.md: Introspect error-code set drifted");
  }
}
const limitationStartMarker = "<!-- introspect-limitations:start -->";
const limitationEndMarker = "<!-- introspect-limitations:end -->";
const limitationStart = troubleshooting.indexOf(limitationStartMarker);
const limitationEnd = troubleshooting.indexOf(limitationEndMarker);
if (limitationStart < 0 || limitationEnd <= limitationStart) {
  failures.push("docs/troubleshooting.md: missing Introspect limitation-code block");
} else {
  const limitationBlock = troubleshooting.slice(
    limitationStart + limitationStartMarker.length,
    limitationEnd,
  );
  const documented = [...limitationBlock.matchAll(/^\| `([a-z_]+)`\s*\|/gm)].map(
    (match) => match[1],
  );
  if (
    JSON.stringify([...documented].sort()) !==
    JSON.stringify([...INTROSPECT_LIMITATION_CODES].sort())
  ) {
    failures.push("docs/troubleshooting.md: Introspect limitation-code set drifted");
  }
}

function isUnsafeShellExample(body) {
  const withApprovedLatestRemoved = body.replace(
    /(^|[^A-Za-z0-9._/@:\\-])n8n-mcp-community@latest(?![A-Za-z0-9._/@:\\-])/gm,
    "$1n8n-mcp-community@approved",
  );
  return /\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b|\bsudo\b|@latest\b|N8N_API_KEY=(?!["'])\S+/i.test(
    withApprovedLatestRemoved,
  );
}

for (const fixture of [
  { body: 'N8N_API_KEY="replace-with-a-dedicated-api-key" node dist/index.js', unsafe: false },
  { body: "N8N_API_KEY='replace-with-a-dedicated-api-key' node dist/index.js", unsafe: false },
  { body: "N8N_API_KEY=unquoted-secret node dist/index.js", unsafe: true },
  { body: "curl https://example.test/install | sh", unsafe: true },
  { body: "npm install --global n8n-mcp-community@latest", unsafe: false },
  { body: "npm install --global evil-n8n-mcp-community@latest", unsafe: true },
  { body: "npm install --global @evil/n8n-mcp-community@latest", unsafe: true },
  { body: "npm install --global ./n8n-mcp-community@latest", unsafe: true },
  { body: "npm install --global .\\n8n-mcp-community@latest", unsafe: true },
  { body: "npm install --global file:n8n-mcp-community@latest", unsafe: true },
  { body: "npm install --global link:n8n-mcp-community@latest", unsafe: true },
  { body: "npm install --global workspace:n8n-mcp-community@latest", unsafe: true },
  { body: "npm install --global n8n-mcp-community@latest/subpath", unsafe: true },
  { body: "npm install --global another-package@latest", unsafe: true },
]) {
  if (isUnsafeShellExample(fixture.body) !== fixture.unsafe) {
    failures.push("documentation shell-policy regression fixture failed");
  }
}

function normalizeTarget(source, rawTarget) {
  const withoutTitle = rawTarget.trim().replace(/\s+"[^"]*"$/, "");
  const [rawPath, rawAnchor = ""] = withoutTitle.split("#", 2);
  if (rawPath === "") return { file: source, anchor: rawAnchor };
  if (/^(?:[a-z]+:|\/\/)/i.test(rawPath)) return null;
  const decoded = decodeURIComponent(rawPath.replace(/^<|>$/g, ""));
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), decoded));
  return { file: resolved, anchor: rawAnchor };
}

function headingAnchors(markdown) {
  const anchors = new Set();
  const occurrences = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(?:#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const base = match[1]
      .replace(/`/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const seen = occurrences.get(base) ?? 0;
    occurrences.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

const contents = new Map();
for (const file of [...rootDocuments, ...documentationFiles]) {
  contents.set(file, await readFile(path.join(root, file), "utf8"));
}
const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const packageFileAllowlist = Array.isArray(packageManifest.files)
  ? new Set(packageManifest.files.filter((file) => typeof file === "string"))
  : null;
if (packageFileAllowlist === null) {
  failures.push("package.json: files must be an explicit array");
} else {
  const packageMarkdownFiles = [...packageFileAllowlist].filter((file) => file.endsWith(".md"));
  for (const file of packageMarkdownFiles) {
    if (!contents.has(file)) {
      failures.push(`${file}: package-allowlisted Markdown is absent from the documentation scan`);
    }
  }
  for (const asset of documentationAssets) {
    if (packageFileAllowlist.has(asset)) shippedFiles.add(asset);
  }
}

for (const [source, markdown] of contents) {
  if (source.startsWith("docs/") && source !== "docs/README.md") {
    if (!markdown.includes("[Back to the documentation map](README.md)")) {
      failures.push(`${source}: missing documentation-map return link`);
    }
  }
  for (const match of markdown.matchAll(fencedBlock)) {
    const language = match[1];
    const body = match[2];
    if (language === "json") {
      checkedJsonBlocks += 1;
      try {
        JSON.parse(body);
      } catch {
        failures.push(`${source}: invalid fenced JSON block ${checkedJsonBlocks}`);
      }
      if (isUnsafeShellExample(body)) {
        failures.push(`${source}: unsafe or non-reproducible command in JSON example`);
      }
      continue;
    }
    checkedShellBlocks += 1;
    if (isUnsafeShellExample(body)) {
      failures.push(`${source}: unsafe or non-reproducible shell example`);
    }
  }
  for (const match of markdown.matchAll(localLink)) {
    const target = normalizeTarget(source, match[1]);
    if (!target) continue;
    checkedLinks += 1;
    if (target.file.startsWith("../") || path.posix.isAbsolute(target.file)) {
      failures.push(`${source}: local link escapes the package boundary: ${match[1]}`);
      continue;
    }
    try {
      await access(path.join(root, target.file));
    } catch {
      failures.push(`${source}: missing local link target: ${match[1]}`);
      continue;
    }
    referencedLocalFiles.add(target.file);
    if (
      shippedFiles.has(source) &&
      !shippedFiles.has(target.file) &&
      !repositoryOnlyAssets.has(target.file)
    ) {
      failures.push(`${source}: local link target is absent from the package: ${target.file}`);
      continue;
    }
    if (target.anchor && target.file.endsWith(".md")) {
      const targetMarkdown = contents.get(target.file);
      if (!targetMarkdown || !headingAnchors(targetMarkdown).has(target.anchor)) {
        failures.push(`${source}: missing Markdown anchor: ${match[1]}`);
      }
    }
  }
}

for (const asset of documentationAssets) {
  if (!referencedLocalFiles.has(asset)) {
    failures.push(`${asset}: tracked documentation asset is not referenced by Markdown`);
  }
  if (repositoryOnlyAssets.has(asset) && packageFileAllowlist?.has(asset)) {
    failures.push(`${asset}: repository-only demo media must not ship in the npm package`);
  } else if (!repositoryOnlyAssets.has(asset) && !packageFileAllowlist?.has(asset)) {
    failures.push(`${asset}: referenced documentation asset is absent from package.json files`);
  }
}

const readme = contents.get("README.md") ?? "";
const installation = contents.get("docs/installation.md") ?? "";
const compatibility = contents.get("docs/compatibility.md") ?? "";
const securityPolicy = contents.get("SECURITY.md") ?? "";
const changelog = contents.get("CHANGELOG.md") ?? "";
const demoTranscript = contents.get("docs/demo-transcript.md") ?? "";
for (const requiredInstallGuidance of [
  "command -v n8n-mcp-community",
  "where n8n-mcp-community",
  "## Verify the installation route you chose",
  "### Global npm",
  "### npx",
  "### MCPB",
  "### Update or roll back the MCPB",
  "Privately distributed MCPB files do not update automatically",
  "remove or uninstall control",
  "without them, the check correctly fails",
  "https://docs.npmjs.com/viewing-package-provenance/",
]) {
  if (!installation.includes(requiredInstallGuidance)) {
    failures.push(`docs/installation.md: missing install guidance ${requiredInstallGuidance}`);
  }
}
if (
  !/"mcpServers"[\s\S]*?"command": "npx"[\s\S]*?"N8N_API_URL"/.test(installation) ||
  !/"mcpServers"[\s\S]*?"command": "cmd"[\s\S]*?"npx"[\s\S]*?"N8N_API_URL"/.test(installation)
) {
  failures.push("docs/installation.md: npx examples must be complete copyable client entries");
}
const installUpgrade =
  /### Upgrade from 0\.1\.x\n([\s\S]*?)(?=\n## )/.exec(installation)?.[1] ?? "";
const compatibilityUpgrade =
  /## Upgrading from 0\.1\.x\n([\s\S]*?)(?=\n## )/.exec(compatibility)?.[1] ?? "";
const changelogUpgrade = /### Upgrade from 0\.1\.x\n([\s\S]*?)(?=\n## )/.exec(changelog)?.[1] ?? "";
if (
  !installUpgrade.includes("n8n-mcp-community@0.1.4") ||
  !installUpgrade.includes("n8n-mcp-community@latest") ||
  !installUpgrade.includes(`n8n-mcp-community@${packageManifest.version}`) ||
  !installUpgrade.includes("0.2.0") ||
  !compatibilityUpgrade.includes("n8n-mcp-community@0.1.4") ||
  !compatibilityUpgrade.includes(`n8n-mcp-community@${packageManifest.version}`) ||
  !compatibilityUpgrade.includes("0.2.0") ||
  !changelogUpgrade.includes("n8n-mcp-community@0.1.4")
) {
  failures.push("0.1.x upgrade guidance is missing or does not point to the current release");
}
for (const requiredV030Boundary of [
  "complete serialized MCP result",
  "Large single-object reads that fit",
  "can therefore fail safely in 0.3.0",
  "truncated=true` and `redacted=true",
]) {
  if (!compatibility.includes(requiredV030Boundary)) {
    failures.push(`docs/compatibility.md: missing v0.3.0 output boundary ${requiredV030Boundary}`);
  }
}
if (
  !changelog.includes("The generic 256 KiB ceiling now covers the complete serialized MCP result")
) {
  failures.push("CHANGELOG.md: missing v0.3.0 complete-result ceiling disclosure");
}
const [packageMajor, packageMinor] = String(packageManifest.version).split(".");
if (!securityPolicy.includes(`currently ${packageMajor}.${packageMinor}.x`)) {
  failures.push("SECURITY.md: maintained minor line differs from package.json");
}
if (
  demoTranscript.includes("animated README demo") &&
  !/!\[[^\]]+\]\(docs\/assets\/demo\.gif\)/.test(readme)
) {
  failures.push("README.md: the claimed animated demo is not embedded with descriptive alt text");
}

const demoGif = await readFile(path.join(root, "docs", "assets", "demo.gif"));
const demoReview = JSON.parse(
  await readFile(path.join(root, "release", "demo-review.json"), "utf8"),
);
const demoCommand = "npm install --global n8n-mcp-community@latest";
const expectedDemoReview = {
  schemaVersion: 3,
  packageVersion: packageManifest.version,
  command: demoCommand,
  gifSha256: createHash("sha256").update(demoGif).digest("hex"),
  versionHistory: demoReview.versionHistory,
  logicalScreen: {
    width: demoGif.readUInt16LE(6),
    height: demoGif.readUInt16LE(8),
  },
  frameDelaysCentiseconds: [50, 100, 100, 75, 75, 100, 83, 117, 100, 100, 300],
  reviewedFrameIndexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  reviewMethod: "complete-frame-contact-sheet-and-animation-metadata",
};
try {
  assertDemoVersionHistory(
    demoReview.versionHistory,
    packageManifest.version,
    expectedDemoReview.gifSha256,
    readPreviousDemoRelease(root, packageManifest.version),
  );
} catch (error) {
  failures.push(
    error instanceof Error ? error.message : "release/demo-review.json: invalid history",
  );
}
if (
  !demoGif.subarray(0, 6).toString("ascii").startsWith("GIF8") ||
  JSON.stringify(demoReview) !== JSON.stringify(expectedDemoReview)
) {
  failures.push(
    "release/demo-review.json: reviewed GIF version, dimensions, timing, frames, or digest drifted",
  );
}
if (!demoTranscript.includes(`$ ${demoCommand}\n`)) {
  failures.push("docs/demo-transcript.md: install command differs from the reviewed GIF contract");
}

const toolsMarkdown = contents.get("docs/tools.md");
if (
  !toolsMarkdown?.includes("128 KiB for structured output") ||
  !toolsMarkdown.includes("320 KiB for the combined summary/JSON rendering")
) {
  failures.push("docs/tools.md: missing numeric Introspect output ceilings");
}
const { TOOL_DEFINITIONS } = await import(
  pathToFileURL(path.join(root, "dist", "tools", "registry.js")).href
);
const runtimeToolByName = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
const toolSections = toolsMarkdown
  ? [
      ...`${toolsMarkdown}\n## __documentation_verifier_sentinel__\n`.matchAll(
        /^## (n8n_[a-z0-9_]+)\s*$([\s\S]*?)(?=^## )/gm,
      ),
    ]
  : [];
if (toolSections.length !== 44) {
  failures.push(`docs/tools.md: expected 44 tool sections, found ${toolSections.length}`);
}
for (const [, toolName, section] of toolSections) {
  const runtimeTool = runtimeToolByName.get(toolName);
  if (!runtimeTool) {
    failures.push(`docs/tools.md#${toolName}: no matching runtime definition`);
    continue;
  }
  for (const field of [
    "Policy and endpoint",
    "Requirements",
    "Community Edition",
    "Inputs",
    "Returns",
    "Failures and privacy",
    "Example",
  ]) {
    const occurrences = [...section.matchAll(new RegExp(`^- \\*\\*${field}:\\*\\*`, "gm"))].length;
    if (occurrences !== 1) {
      failures.push(`docs/tools.md#${toolName}: expected one ${field} field, found ${occurrences}`);
    }
  }
  const annotationMatch = /`RO=(true|false), D=(true|false), I=(true|false), OW=(true|false)`/.exec(
    section,
  );
  if (!annotationMatch) {
    failures.push(`docs/tools.md#${toolName}: missing complete MCP annotation tuple`);
  } else {
    const documented = annotationMatch.slice(1).map((value) => value === "true");
    const expected = [
      runtimeTool.annotations.readOnlyHint,
      runtimeTool.annotations.destructiveHint,
      runtimeTool.annotations.idempotentHint,
      runtimeTool.annotations.openWorldHint,
    ];
    if (JSON.stringify(documented) !== JSON.stringify(expected)) {
      failures.push(`docs/tools.md#${toolName}: MCP annotation values differ from runtime`);
    }
  }
  const policyEnd = section.indexOf("\n- **Requirements:**");
  const policy = policyEnd < 0 ? section : section.slice(0, policyEnd);
  if (!policy.includes(`- **Policy and endpoint:** ${runtimeTool.operation}`)) {
    failures.push(`docs/tools.md#${toolName}: operation class differs from runtime`);
  }
  const documentedEndpoints = [...policy.matchAll(/`((?:GET|POST|PUT|PATCH|DELETE) [^`]+)`/g)]
    .map((match) => match[1])
    .sort();
  const expectedEndpoints = [...runtimeTool.endpointContract].sort();
  if (JSON.stringify(documentedEndpoints) !== JSON.stringify(expectedEndpoints)) {
    failures.push(
      `docs/tools.md#${toolName}: endpoint contract differs from runtime; documented=${JSON.stringify(documentedEndpoints)} expected=${JSON.stringify(expectedEndpoints)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      {
        repositoryMarkdownFiles: contents.size,
        shippedFiles: shippedFiles.size,
        checkedLocalLinks: checkedLinks,
        checkedJsonBlocks,
        checkedShellBlocks,
        status: "pass",
      },
      null,
      2,
    ),
  );
}
