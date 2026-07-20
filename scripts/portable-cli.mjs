import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const JAVASCRIPT_ENTRYPOINT = /\.(?:c|m)?js$/i;

/**
 * @typedef {{ command: string, argumentPrefix: readonly string[] }} ResolvedNodeCli
 * @typedef {{ cwd: string, label: string, env?: NodeJS.ProcessEnv, maxBuffer?: number, timeout?: number }} PortableCommandOptions
 */

/**
 * Returns a copy of the given environment whose PATH has been stripped of every
 * `node_modules/.bin` entry. `npm run` prepends the project's `node_modules/.bin`
 * to PATH, so a malicious transitive dependency that ships a `bin` named `git` or
 * `openssl` could shadow the trusted system executable even under `--ignore-scripts`.
 * Trusted subprocess spawns (git, openssl) must resolve only the real system binary,
 * so drop those segments while preserving every other PATH entry and variable.
 *
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function trustedSystemEnv(baseEnv = process.env) {
  const rawPath = baseEnv.PATH;
  if (typeof rawPath !== "string") return { ...baseEnv };
  const trustedPath = rawPath
    .split(path.delimiter)
    .filter(
      (segment) =>
        !(
          path.basename(segment) === ".bin" &&
          path.basename(path.dirname(segment)) === "node_modules"
        ),
    )
    .join(path.delimiter);
  return { ...baseEnv, PATH: trustedPath };
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {PortableCommandOptions} options
 * @returns {string}
 */
export function runPortableCommandSync(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
  });
  const errorCode = /** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code;
  if (errorCode === "ETIMEDOUT") throw new Error(`${options.label} timed out.`);
  if (errorCode === "ENOBUFS") throw new Error(`${options.label} exceeded its output limit.`);
  if (result.error) throw new Error(`${options.label} could not be launched.`);
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "")
      .trim()
      .slice(0, 4_096);
    throw new Error(`${options.label} failed.${detail ? ` ${detail}` : ""}`);
  }
  return String(result.stdout ?? "").trim();
}

/**
 * @param {string} entrypoint
 * @param {string} [label]
 * @returns {ResolvedNodeCli}
 */
export function resolveNodeEntrypoint(entrypoint, label = "CLI") {
  if (!path.isAbsolute(entrypoint)) {
    throw new Error(`The ${label} JavaScript entrypoint must be an absolute path.`);
  }
  if (!JAVASCRIPT_ENTRYPOINT.test(entrypoint) || !existsSync(entrypoint)) {
    throw new Error(`The ${label} JavaScript entrypoint is unavailable.`);
  }
  return { command: process.execPath, argumentPrefix: [entrypoint] };
}

/**
 * @param {string} entrypoint
 * @returns {string}
 */
function verifyNpmEntrypoint(entrypoint) {
  const npmCli = resolveNodeEntrypoint(entrypoint, "npm");
  const resolvedEntrypoint = npmCli.argumentPrefix[0];
  if (!resolvedEntrypoint) throw new Error("The npm JavaScript entrypoint is unavailable.");
  const resolved = realpathSync(resolvedEntrypoint);
  const packageRoot = path.dirname(path.dirname(resolved));
  const manifestPath = path.join(packageRoot, "package.json");
  if (path.basename(resolved) !== "npm-cli.js" || path.basename(path.dirname(resolved)) !== "bin") {
    throw new Error("The npm JavaScript entrypoint does not identify the npm CLI.");
  }
  try {
    const manifest = /** @type {unknown} */ (JSON.parse(readFileSync(manifestPath, "utf8")));
    if (!manifest || typeof manifest !== "object") throw new Error("invalid manifest");
    const fields = /** @type {{ name?: unknown, bin?: unknown }} */ (manifest);
    if (
      fields.name !== "npm" ||
      !fields.bin ||
      typeof fields.bin !== "object" ||
      /** @type {{ npm?: unknown }} */ (fields.bin).npm !== "bin/npm-cli.js"
    ) {
      throw new Error("unexpected package identity");
    }
  } catch {
    throw new Error("The npm JavaScript entrypoint does not identify a verified npm package.");
  }
  return resolved;
}

/**
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @returns {string}
 */
function discoverNpmEntrypoint(environment) {
  if (environment.npm_execpath) return verifyNpmEntrypoint(environment.npm_execpath);
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const executable of ["npm", "npm.cmd", "npm.exe"]) {
      const candidate = path.join(directory, executable);
      if (!existsSync(candidate)) continue;
      const resolved = realpathSync(candidate);
      if (JAVASCRIPT_ENTRYPOINT.test(resolved)) {
        try {
          return verifyNpmEntrypoint(resolved);
        } catch {
          continue;
        }
      }
    }
    for (const candidate of [
      path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ]) {
      if (existsSync(candidate)) {
        try {
          return verifyNpmEntrypoint(candidate);
        } catch {
          continue;
        }
      }
    }
  }
  throw new Error("A JavaScript npm entrypoint could not be discovered from npm_execpath or PATH.");
}

/**
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @returns {{ cli: ResolvedNodeCli, usesNpmExec: boolean }}
 */
function resolveNpxCli(environment) {
  const npmEntrypoint = discoverNpmEntrypoint(environment);
  const npmCli = resolveNodeEntrypoint(npmEntrypoint, "npm");
  const npxEntrypoint = path.join(path.dirname(npmEntrypoint), "npx-cli.js");
  return existsSync(npxEntrypoint)
    ? { cli: resolveNodeEntrypoint(npxEntrypoint, "npx"), usesNpmExec: false }
    : {
        cli: {
          command: npmCli.command,
          argumentPrefix: [...npmCli.argumentPrefix, "exec", "--yes=false", "--"],
        },
        usesNpmExec: true,
      };
}

/**
 * @param {"npm" | "npx"} tool
 * @param {Readonly<Record<string, string | undefined>>} [environment]
 * @returns {ResolvedNodeCli}
 */
export function resolveNpmCli(tool, environment = process.env) {
  if (tool !== "npm" && tool !== "npx") {
    throw new Error("Only the npm and npx CLI entrypoints are supported.");
  }
  if (tool === "npx") return resolveNpxCli(environment).cli;
  const npmEntrypoint = discoverNpmEntrypoint(environment);
  return resolveNodeEntrypoint(npmEntrypoint, "npm");
}

/**
 * @param {ResolvedNodeCli} cli
 * @param {readonly string[]} args
 * @param {boolean} usesNpmExec
 * @returns {ResolvedNodeCli}
 */
export function composeNpxInvocation(cli, args, usesNpmExec) {
  const normalizedArgs = usesNpmExec && args[0] === "--no-install" ? args.slice(1) : args;
  return { command: cli.command, argumentPrefix: [...cli.argumentPrefix, ...normalizedArgs] };
}

/**
 * @param {readonly string[]} args
 * @param {Readonly<Record<string, string | undefined>>} [environment]
 * @returns {ResolvedNodeCli}
 */
export function resolveNpxInvocation(args, environment = process.env) {
  const { cli, usesNpmExec } = resolveNpxCli(environment);
  return composeNpxInvocation(cli, args, usesNpmExec);
}
