import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveNpmCli, runPortableCommandSync } from "./portable-cli.mjs";

/**
 * @typedef {{ name: string, version: string, purl: string }} ComponentIdentity
 * @typedef {{ rootRef: string, refs: Set<string>, componentRefs: Set<string>, identities: Map<string, ComponentIdentity>, scopes: Map<string, "optional" | "required">, edges: Map<string, Set<string>>, packagePaths: number }} RuntimeRefInventory
 */

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Error(message);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} label @returns {string} */
function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} is missing or invalid.`);
  return value;
}

/** @param {string} directory @returns {string} */
export function packageNameFromLockPath(directory) {
  const marker = "node_modules/";
  const markerIndex = directory.lastIndexOf(marker);
  if (markerIndex < 0) fail(`Lockfile package path is invalid: ${directory}`);
  const parts = directory.slice(markerIndex + marker.length).split("/");
  const name = parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return requireString(name, `Package name for ${directory}`);
}

/** @param {string} name @param {string} version @returns {string} */
function npmPurl(name, version) {
  if (!name.startsWith("@"))
    return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
  const [scope, packageName, ...rest] = name.split("/");
  if (!scope || !packageName || rest.length > 0)
    fail(`Scoped npm package name is invalid: ${name}`);
  return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
}

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function optionalRecord(value, label) {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(`${label} is invalid.`);
  return value;
}

/** @param {string} directory @returns {string | null} */
function parentPackageDirectory(directory) {
  const markerIndex = directory.lastIndexOf("node_modules/");
  if (markerIndex < 0) return null;
  return directory.slice(0, markerIndex).replace(/\/$/, "");
}

/**
 * Resolve an installed dependency with Node's ancestor node_modules lookup.
 * @param {string} sourceDirectory
 * @param {string} dependencyName
 * @param {Record<string, unknown>} packages
 * @returns {string | null}
 */
function resolveInstalledDependency(sourceDirectory, dependencyName, packages) {
  let directory = sourceDirectory;
  while (true) {
    const candidate = directory
      ? `${directory}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (isRecord(packages[candidate])) return candidate;
    const parent = parentPackageDirectory(directory);
    if (parent === null) return null;
    directory = parent;
  }
}

/**
 * @param {Record<string, unknown>} entry
 * @param {string} label
 * @returns {Map<string, boolean>}
 */
function declaredRuntimeDependencies(entry, label) {
  const dependencies = optionalRecord(entry.dependencies, `${label} dependencies`);
  const optionalDependencies = optionalRecord(
    entry.optionalDependencies,
    `${label} optionalDependencies`,
  );
  const peerDependencies = optionalRecord(entry.peerDependencies, `${label} peerDependencies`);
  const peerDependenciesMeta = optionalRecord(
    entry.peerDependenciesMeta,
    `${label} peerDependenciesMeta`,
  );
  /** @type {Map<string, boolean>} */
  const names = new Map();
  for (const name of Object.keys(dependencies)) names.set(name, false);
  for (const name of Object.keys(optionalDependencies)) names.set(name, true);
  for (const name of Object.keys(peerDependencies)) {
    const metadata = peerDependenciesMeta[name];
    names.set(name, isRecord(metadata) && metadata.optional === true);
  }
  return names;
}

/**
 * @param {Record<string, unknown>} component
 * @param {ComponentIdentity} expected
 * @param {string} label
 */
function assertComponentIdentity(component, expected, label) {
  if (
    requireString(component.name, `${label} name`) !== expected.name ||
    requireString(component.version, `${label} version`) !== expected.version ||
    requireString(component.purl, `${label} purl`) !== expected.purl
  ) {
    fail(`${label} identity differs from the production lockfile.`);
  }
}

/** @param {unknown} lock @returns {RuntimeRefInventory} */
export function runtimeRefInventory(lock) {
  if (!isRecord(lock) || !isRecord(lock.packages)) {
    fail("package-lock.json does not contain a valid packages map.");
  }
  const root = lock.packages[""];
  if (!isRecord(root)) fail("package-lock.json has no root package entry.");
  const rootName = requireString(root.name, "Root package name");
  const rootVersion = requireString(root.version, "Root package version");
  const rootRef = `${rootName}@${rootVersion}`;
  const refs = new Set([rootRef]);
  /** @type {Set<string>} */
  const componentRefs = new Set();
  /** @type {Map<string, "optional" | "required">} */
  const scopes = new Map();
  /** @type {Map<string, ComponentIdentity>} */
  const identities = new Map([
    [rootRef, { name: rootName, version: rootVersion, purl: npmPurl(rootName, rootVersion) }],
  ]);
  /** @type {Map<string, string>} */
  const refsByDirectory = new Map();
  /** @type {Map<string, Set<string>>} */
  const edges = new Map([[rootRef, new Set()]]);
  let packagePaths = 0;

  for (const [directory, entry] of Object.entries(lock.packages)) {
    if (directory === "" || !isRecord(entry) || entry.dev === true) continue;
    const name =
      typeof entry.name === "string" && entry.name.length > 0
        ? entry.name
        : packageNameFromLockPath(directory);
    const version = requireString(entry.version, `${name} version`);
    const ref = `${name}@${version}`;
    packagePaths += 1;
    refs.add(ref);
    componentRefs.add(ref);
    refsByDirectory.set(directory, ref);
    identities.set(ref, { name, version, purl: npmPurl(name, version) });
    if (!edges.has(ref)) edges.set(ref, new Set());
    if (entry.optional !== true || !scopes.has(ref)) {
      scopes.set(ref, entry.optional === true ? "optional" : "required");
    }
  }

  for (const [directory, entry] of Object.entries(lock.packages)) {
    if (!isRecord(entry) || (directory !== "" && entry.dev === true)) continue;
    const sourceRef = directory === "" ? rootRef : refsByDirectory.get(directory);
    if (!sourceRef) fail(`The runtime lockfile entry ${directory} has no component reference.`);
    const sourceEdges = edges.get(sourceRef);
    if (!sourceEdges) fail(`The runtime lockfile entry ${sourceRef} has no dependency set.`);
    for (const [dependencyName, optional] of declaredRuntimeDependencies(
      entry,
      directory || "root package",
    )) {
      const targetDirectory = resolveInstalledDependency(directory, dependencyName, lock.packages);
      if (targetDirectory === null) {
        if (optional) continue;
        fail(
          `The runtime lockfile cannot resolve ${dependencyName} from ${directory || "the root"}.`,
        );
      }
      const targetRef = refsByDirectory.get(targetDirectory);
      if (!targetRef) {
        fail(
          `The runtime lockfile dependency ${sourceRef} resolves ${dependencyName} to a non-runtime package.`,
        );
      }
      sourceEdges.add(targetRef);
    }
  }

  return { rootRef, refs, componentRefs, identities, scopes, edges, packagePaths };
}

/**
 * @param {Record<string, unknown>} component
 * @param {"optional" | "required"} scope
 * @param {ComponentIdentity} identity
 * @returns {Record<string, unknown>}
 */
function normalizedRuntimeComponent(component, scope, identity) {
  const normalized = structuredClone(component);
  normalized.name = identity.name;
  normalized.version = identity.version;
  normalized.purl = identity.purl;
  normalized.scope = scope;
  if (Array.isArray(normalized.properties)) {
    normalized.properties = normalized.properties.filter(
      (property) => !isRecord(property) || property.name !== "cdx:npm:package:development",
    );
  }
  return normalized;
}

/**
 * @param {unknown} sbom
 * @param {unknown} lock
 * @returns {{ runtimePackagePaths: number, runtimeComponents: number, runtimeDependencyEntries: number }}
 */
export function assertRuntimeSbomParity(sbom, lock) {
  if (!isRecord(sbom) || !Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies)) {
    fail("The CycloneDX SBOM has no valid component and dependency arrays.");
  }
  const inventory = runtimeRefInventory(lock);
  if (!isRecord(sbom.metadata) || !isRecord(sbom.metadata.component)) {
    fail("The runtime SBOM has no valid root component metadata.");
  }
  if (
    requireString(sbom.metadata.component["bom-ref"], "SBOM root component reference") !==
    inventory.rootRef
  ) {
    fail("The runtime SBOM root component differs from the lockfile root.");
  }
  const rootIdentity = inventory.identities.get(inventory.rootRef);
  if (!rootIdentity) fail("The runtime lockfile has no root component identity.");
  assertComponentIdentity(sbom.metadata.component, rootIdentity, "SBOM root component");
  const components = /** @type {unknown[]} */ (sbom.components);
  const componentRefs = components.map((component) => {
    if (!isRecord(component)) fail("The CycloneDX SBOM contains an invalid component.");
    return requireString(component["bom-ref"], "SBOM component reference");
  });
  if (new Set(componentRefs).size !== componentRefs.length) {
    fail("The runtime SBOM contains duplicate component references.");
  }
  if (
    JSON.stringify([...componentRefs].sort()) !==
    JSON.stringify([...inventory.componentRefs].sort())
  ) {
    fail("The runtime SBOM component inventory differs from the production lockfile.");
  }
  for (const component of components) {
    if (!isRecord(component)) fail("The CycloneDX SBOM contains an invalid component.");
    const ref = requireString(component["bom-ref"], "SBOM component reference");
    const expectedIdentity = inventory.identities.get(ref);
    if (!expectedIdentity) fail(`The runtime lockfile has no identity for ${ref}.`);
    assertComponentIdentity(component, expectedIdentity, `SBOM component ${ref}`);
    if (component.scope !== inventory.scopes.get(ref)) {
      fail(`The runtime SBOM scope is incorrect for ${ref}.`);
    }
    if (
      Array.isArray(component.properties) &&
      component.properties.some(
        (property) =>
          isRecord(property) &&
          property.name === "cdx:npm:package:development" &&
          property.value === "true",
      )
    ) {
      fail(`The runtime SBOM marks ${ref} as development-only.`);
    }
  }

  const dependencies = /** @type {unknown[]} */ (sbom.dependencies);
  const dependencyRefs = dependencies.map((dependency) => {
    if (!isRecord(dependency) || !Array.isArray(dependency.dependsOn)) {
      fail("The CycloneDX SBOM contains an invalid dependency entry.");
    }
    const ref = requireString(dependency.ref, "SBOM dependency reference");
    const targets = /** @type {unknown[]} */ (dependency.dependsOn);
    if (new Set(targets).size !== targets.length) {
      fail(`The runtime SBOM dependency ${ref} repeats a target reference.`);
    }
    for (const target of targets) {
      if (typeof target !== "string" || !inventory.refs.has(target)) {
        fail(`The runtime SBOM dependency ${ref} references a non-runtime component.`);
      }
    }
    const expectedTargets = inventory.edges.get(ref);
    if (!expectedTargets) fail(`The production lockfile has no dependency entry for ${ref}.`);
    if (JSON.stringify([...targets].sort()) !== JSON.stringify([...expectedTargets].sort())) {
      fail(`The runtime SBOM dependency edges differ from the production lockfile for ${ref}.`);
    }
    return ref;
  });
  if (new Set(dependencyRefs).size !== dependencyRefs.length) {
    fail("The runtime SBOM contains duplicate dependency references.");
  }
  if (JSON.stringify([...dependencyRefs].sort()) !== JSON.stringify([...inventory.refs].sort())) {
    fail("The runtime SBOM dependency inventory differs from the production lockfile.");
  }

  return {
    runtimePackagePaths: inventory.packagePaths,
    runtimeComponents: inventory.componentRefs.size,
    runtimeDependencyEntries: inventory.refs.size,
  };
}

/** @param {unknown} fullSbom @param {unknown} lock @returns {Record<string, unknown>} */
export function createRuntimeSbom(fullSbom, lock) {
  if (
    !isRecord(fullSbom) ||
    !Array.isArray(fullSbom.components) ||
    !Array.isArray(fullSbom.dependencies)
  ) {
    fail("The npm CycloneDX SBOM has no valid component and dependency arrays.");
  }
  const inventory = runtimeRefInventory(lock);
  /** @type {Map<string, Record<string, unknown>>} */
  const componentsByRef = new Map();
  for (const component of /** @type {unknown[]} */ (fullSbom.components)) {
    if (!isRecord(component)) fail("The npm SBOM contains an invalid component.");
    const ref = requireString(component["bom-ref"], "npm SBOM component reference");
    if (componentsByRef.has(ref)) fail(`The npm SBOM repeats component ${ref}.`);
    componentsByRef.set(ref, component);
  }
  for (const ref of inventory.componentRefs) {
    if (!componentsByRef.has(ref)) fail(`The npm SBOM omits runtime component ${ref}.`);
  }

  const runtimeSbom = structuredClone(fullSbom);
  if (!isRecord(runtimeSbom.metadata) || !isRecord(runtimeSbom.metadata.component)) {
    fail("The npm SBOM has no valid root component metadata.");
  }
  const rootIdentity = inventory.identities.get(inventory.rootRef);
  if (!rootIdentity) fail("The runtime lockfile has no root component identity.");
  runtimeSbom.metadata.component["bom-ref"] = inventory.rootRef;
  runtimeSbom.metadata.component.name = rootIdentity.name;
  runtimeSbom.metadata.component.version = rootIdentity.version;
  runtimeSbom.metadata.component.purl = rootIdentity.purl;
  runtimeSbom.components = [...inventory.componentRefs].map((ref) => {
    const component = componentsByRef.get(ref);
    const scope = inventory.scopes.get(ref);
    const expectedIdentity = inventory.identities.get(ref);
    if (!component || !scope || !expectedIdentity) {
      fail(`The runtime inventory is incomplete for ${ref}.`);
    }
    return normalizedRuntimeComponent(component, scope, expectedIdentity);
  });
  runtimeSbom.dependencies = [...inventory.refs].map((ref) => {
    const targets = inventory.edges.get(ref);
    if (!targets) fail(`The runtime dependency inventory is incomplete for ${ref}.`);
    return {
      ref,
      dependsOn: [...targets].sort(),
    };
  });
  assertRuntimeSbomParity(runtimeSbom, lock);
  return runtimeSbom;
}

async function main() {
  const root = process.cwd();
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const npmCli = resolveNpmCli("npm");
  const fullSbom = JSON.parse(
    runPortableCommandSync(
      npmCli.command,
      [
        ...npmCli.argumentPrefix,
        "sbom",
        "--package-lock-only",
        "--sbom-format",
        "cyclonedx",
        "--sbom-type",
        "application",
      ],
      {
        cwd: root,
        env: { ...process.env, npm_config_loglevel: "silent" },
        label: "The complete npm SBOM generator",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
      },
    ),
  );
  const sbom = createRuntimeSbom(fullSbom, lock);
  if (process.argv.includes("--check")) {
    console.log(
      JSON.stringify({ ...assertRuntimeSbomParity(sbom, lock), status: "pass" }, null, 2),
    );
  } else {
    console.log(JSON.stringify(sbom, null, 2));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
