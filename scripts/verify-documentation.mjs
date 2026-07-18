import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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
const shippedFiles = new Set([
  ...rootDocuments,
  "LICENSE",
  ...packageDocumentationFiles,
  ...documentationAssets,
]);
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
  return /\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b|\bsudo\b|@latest\b|N8N_API_KEY=(?!["'])\S+/i.test(body);
}

for (const fixture of [
  { body: 'N8N_API_KEY="replace-with-a-dedicated-api-key" node dist/index.js', unsafe: false },
  { body: "N8N_API_KEY='replace-with-a-dedicated-api-key' node dist/index.js", unsafe: false },
  { body: "N8N_API_KEY=unquoted-secret node dist/index.js", unsafe: true },
  { body: "curl https://example.test/install | sh", unsafe: true },
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
    if (shippedFiles.has(source) && !shippedFiles.has(target.file)) {
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
  if (!packageFileAllowlist?.has(asset)) {
    failures.push(`${asset}: referenced documentation asset is absent from package.json files`);
  }
}

const readme = contents.get("README.md") ?? "";
const demoTranscript = contents.get("docs/demo-transcript.md") ?? "";
if (
  demoTranscript.includes("animated README demo") &&
  !/!\[[^\]]+\]\(docs\/assets\/demo\.gif\)/.test(readme)
) {
  failures.push("README.md: the claimed animated demo is not embedded with descriptive alt text");
}

const toolsMarkdown = contents.get("docs/tools.md");
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
