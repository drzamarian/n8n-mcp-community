import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const {
  composeNpxInvocation,
  resolveNodeEntrypoint,
  resolveNpmCli,
  resolveNpxInvocation,
  runPortableCommandSync,
  trustedSystemEnv,
} = (await import(
  pathToFileURL(path.join(process.cwd(), "scripts", "portable-cli.mjs")).href
)) as typeof import("../scripts/portable-cli.mjs");

test("trustedSystemEnv strips node_modules/.bin from PATH while keeping system directories", () => {
  const projectRoot = path.join(path.sep, "workspace", "project");
  const nodeBin = path.join(projectRoot, "node_modules", ".bin");
  const nestedNodeBin = path.join(projectRoot, "packages", "child", "node_modules", ".bin");
  const originalPath = [nodeBin, "/usr/bin", "/bin", nestedNodeBin, "/usr/local/bin"].join(
    path.delimiter,
  );
  const result = trustedSystemEnv({ PATH: originalPath, N8N_MCP_KEEP_ME: "retained" });
  const segments = (result.PATH ?? "").split(path.delimiter);
  assert.equal(segments.includes(nodeBin), false);
  assert.equal(segments.includes(nestedNodeBin), false);
  assert.equal(segments.includes("/usr/bin"), true);
  assert.equal(segments.includes("/bin"), true);
  assert.equal(segments.includes("/usr/local/bin"), true);
  assert.equal(result.N8N_MCP_KEEP_ME, "retained");
});

test("portable npm and npx commands execute JavaScript entrypoints through Node", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-npm-cli-"));
  try {
    const bin = path.join(root, "npm", "bin");
    await mkdir(bin, { recursive: true });
    const npm = path.join(bin, "npm-cli.js");
    const npx = path.join(bin, "npx-cli.js");
    await Promise.all([
      writeFile(npm, ""),
      writeFile(npx, ""),
      writeFile(
        path.join(root, "npm", "package.json"),
        JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js", npx: "bin/npx-cli.js" } }),
      ),
    ]);
    const environment = { npm_execpath: npm };

    assert.deepEqual(resolveNpmCli("npm", environment), {
      command: process.execPath,
      argumentPrefix: [await realpath(npm)],
    });
    assert.deepEqual(resolveNpmCli("npx", environment), {
      command: process.execPath,
      argumentPrefix: [await realpath(npx)],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable npm command resolution fails closed on missing or relative entrypoints", () => {
  assert.throws(() => resolveNpmCli("npm", {}), /npm_execpath/i);
  assert.throws(() => resolveNpmCli("npx", { npm_execpath: "relative/npm-cli.js" }), /absolute/i);
});

test("portable npx resolution falls back to shell-free npm exec for Corepack layouts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-corepack-cli-"));
  try {
    const npm = path.join(root, "npm", "bin", "npm-cli.js");
    await mkdir(path.dirname(npm), { recursive: true });
    await writeFile(npm, "");
    await writeFile(
      path.join(root, "npm", "package.json"),
      JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" } }),
    );
    assert.deepEqual(resolveNpmCli("npx", { npm_execpath: npm }), {
      command: process.execPath,
      argumentPrefix: [await realpath(npm), "exec", "--yes=false", "--"],
    });
    assert.deepEqual(
      resolveNpxInvocation(["--no-install", "n8n-mcp-community", "--version"], {
        npm_execpath: npm,
      }),
      {
        command: process.execPath,
        argumentPrefix: [
          await realpath(npm),
          "exec",
          "--yes=false",
          "--",
          "n8n-mcp-community",
          "--version",
        ],
      },
    );
    assert.deepEqual(resolveNodeEntrypoint(npm, "fixture"), {
      command: process.execPath,
      argumentPrefix: [npm],
    });
    const deceptiveCli = {
      command: process.execPath,
      argumentPrefix: ["fixture", "exec", "--yes=false", "--"],
    };
    assert.deepEqual(composeNpxInvocation(deceptiveCli, ["--no-install", "fixture"], false), {
      command: process.execPath,
      argumentPrefix: ["fixture", "exec", "--yes=false", "--", "--no-install", "fixture"],
    });
    assert.deepEqual(
      composeNpxInvocation(
        { command: process.execPath, argumentPrefix: ["fixture"] },
        ["--no-install", "fixture"],
        true,
      ),
      { command: process.execPath, argumentPrefix: ["fixture", "fixture"] },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable command resolution rejects non-JavaScript entrypoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-non-js-cli-"));
  try {
    const shim = path.join(root, "npm.cmd");
    await writeFile(shim, "");
    assert.throws(() => resolveNpmCli("npm", { npm_execpath: shim }), /unavailable/i);
    assert.throws(() => resolveNodeEntrypoint(shim, "fixture"), /unavailable/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable npm resolution rejects arbitrary JavaScript and non-npm package managers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-untrusted-cli-"));
  try {
    const arbitrary = path.join(root, "arbitrary.cjs");
    await writeFile(arbitrary, "");
    assert.throws(() => resolveNpmCli("npm", { npm_execpath: arbitrary }), /identify the npm CLI/i);

    const pnpm = path.join(root, "pnpm", "bin", "npm-cli.js");
    await mkdir(path.dirname(pnpm), { recursive: true });
    await writeFile(pnpm, "");
    await writeFile(
      path.join(root, "pnpm", "package.json"),
      JSON.stringify({ name: "pnpm", bin: { npm: "bin/npm-cli.js" } }),
    );
    assert.throws(() => resolveNpmCli("npm", { npm_execpath: pnpm }), /verified npm package/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable npm resolution discovers a standard Node layout without npm_execpath", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-path-cli-"));
  try {
    const npm = path.join(root, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(path.dirname(npm), { recursive: true });
    await writeFile(npm, "");
    await writeFile(
      path.join(root, "node_modules", "npm", "package.json"),
      JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" } }),
    );
    assert.deepEqual(resolveNpmCli("npm", { PATH: root }), {
      command: process.execPath,
      argumentPrefix: [await realpath(npm)],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable subprocess errors are stable when launch fails", () => {
  assert.throws(
    () =>
      runPortableCommandSync("/definitely/missing/n8n-mcp-command", [], {
        cwd: process.cwd(),
        label: "Fixture subprocess",
      }),
    { message: "Fixture subprocess could not be launched." },
  );
});

test("portable subprocess errors are stable when a command times out", () => {
  assert.throws(
    () =>
      runPortableCommandSync(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        cwd: process.cwd(),
        label: "Fixture subprocess",
        timeout: 10,
      }),
    { message: "Fixture subprocess timed out." },
  );
});

test("portable subprocess errors distinguish output-buffer exhaustion", () => {
  assert.throws(
    () =>
      runPortableCommandSync(process.execPath, ["-e", "process.stdout.write('x'.repeat(10_000))"], {
        cwd: process.cwd(),
        label: "Fixture subprocess",
        maxBuffer: 100,
      }),
    { message: "Fixture subprocess exceeded its output limit." },
  );
});

test("portable subprocess failures bound captured stderr", () => {
  assert.throws(
    () =>
      runPortableCommandSync(
        process.execPath,
        ["-e", "process.stderr.write('x'.repeat(10_000)); process.exit(2)"],
        { cwd: process.cwd(), label: "Fixture subprocess" },
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith("Fixture subprocess failed. ") &&
      error.message.length <= "Fixture subprocess failed. ".length + 4_096,
  );
});

test("package verification delegates subprocess diagnostics to the portable helper", async () => {
  const source = await readFile(path.join(process.cwd(), "scripts", "verify-package.mjs"), "utf8");
  assert.match(source, /runPortableCommandSync/);
  assert.match(source, /Package verification subprocess \(\$\{entrypoint\}\)/);
  assert.doesNotMatch(source, /from ["']node:child_process["']/);
});

test("compiled tests remove the unused emitted portable helper before execution", () => {
  assert.equal(
    existsSync(path.join(process.cwd(), ".test-dist", "scripts", "portable-cli.mjs")),
    false,
  );
});

test("MCPB and baseline subprocess callers make timeout and output limits reachable", async () => {
  for (const file of ["build-mcpb.mjs", "verify-mcpb.mjs", "update-artifact-baseline.mjs"]) {
    const source = await readFile(path.join(process.cwd(), "scripts", file), "utf8");
    assert.match(source, /runPortableCommandSync/);
    assert.match(source, /maxBuffer:\s*16 \* 1024 \* 1024/);
    assert.match(source, /timeout:\s*120_000/);
  }
});

test("Corepack-style npx fallback executes the installed package without network installation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-corepack-e2e-"));
  try {
    const npmEntrypoint = resolveNpmCli("npm").argumentPrefix[0];
    assert(npmEntrypoint);
    const wrapper = path.join(root, "npm", "bin", "npm-cli.js");
    await mkdir(path.dirname(wrapper), { recursive: true });
    await writeFile(wrapper, `require(${JSON.stringify(npmEntrypoint)});\n`);
    await writeFile(
      path.join(root, "npm", "package.json"),
      JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" } }),
    );
    const invocation = resolveNpxInvocation(["--no-install", "prettier", "--version"], {
      npm_execpath: wrapper,
    });
    const prettierManifest = JSON.parse(
      await readFile(path.join(process.cwd(), "node_modules", "prettier", "package.json"), "utf8"),
    ) as { version: string };
    assert.equal(
      runPortableCommandSync(invocation.command, invocation.argumentPrefix, {
        cwd: process.cwd(),
        label: "Corepack fixture",
        timeout: 30_000,
      }),
      prettierManifest.version,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
