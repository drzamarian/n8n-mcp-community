#!/usr/bin/env node

import { writeSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigurationError, readN8nConnection, readStartupConfig } from "./config.js";
import { createServer } from "./server.js";
import { buildDoctorReport, probeFloorCompatibility } from "./doctor.js";
import { N8nClient } from "./n8n/client.js";
import { PACKAGE_VERSION } from "./version.js";

const HELP = `n8n-mcp-community ${PACKAGE_VERSION}

Usage:
  n8n-mcp-community            Start the MCP stdio server
  n8n-mcp-community doctor     Validate configuration offline; set
                               N8N_MCP_DOCTOR_PROBE=1 to add a bounded
                               floor-compatibility probe
  n8n-mcp-community --version  Print the package version
  n8n-mcp-community --help     Show this help

The server defaults to N8N_MCP_MODE=read-only. Connected tools require
N8N_API_URL and N8N_API_KEY. Never pass secrets as command-line arguments.`;

async function runDoctor(): Promise<void> {
  const startup = readStartupConfig();
  const connection = readN8nConnection(startup);
  const report = buildDoctorReport(startup, connection);
  if (process.env.N8N_MCP_DOCTOR_PROBE === "1") {
    const compatibility = await probeFloorCompatibility(new N8nClient(connection));
    console.log(JSON.stringify({ ...report, networkAccess: true, compatibility }, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  if (report.status === "fail") process.exitCode = 1;
}

async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(HELP);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    console.log(PACKAGE_VERSION);
    return;
  }
  if (args.length === 1 && args[0] === "doctor") {
    await runDoctor();
    return;
  }
  if (args.length > 0) {
    throw new Error("Unknown command or option. Use --help.");
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

function isBrokenPipe(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

let fatalHandled = false;

/**
 * Emit exactly one constant, secret-free structured line on stderr and exit with a
 * controlled code. stdout is the MCP protocol channel, so it is never written here.
 * `writeSync` guarantees the line is flushed before `process.exit` tears the process
 * down, and the guard makes repeated stream failures collapse to a single line.
 */
function reportFatal(event: string, exitCode: number): void {
  if (fatalHandled) return;
  fatalHandled = true;
  try {
    writeSync(2, `${JSON.stringify({ event })}\n`);
  } catch {
    // stderr itself is unavailable; there is nothing else we can safely do.
  }
  process.exit(exitCode);
}

/**
 * Install process-level guards so a broken stdout pipe (the client's read end
 * disappearing mid-session) or any other unhandled stream/async failure produces a
 * controlled, single-line shutdown instead of a raw Node stack trace on stderr.
 */
function installProcessGuards(): void {
  // A broken stdout pipe means the MCP peer is gone; shut down cleanly (exit 0).
  process.stdout.on("error", (error: unknown) => {
    reportFatal("transport_closed", isBrokenPipe(error) ? 0 : 1);
  });
  process.on("uncaughtException", (error: unknown) => {
    if (isBrokenPipe(error)) reportFatal("transport_closed", 0);
    else reportFatal("uncaught_exception", 1);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    if (isBrokenPipe(reason)) reportFatal("transport_closed", 0);
    else reportFatal("unhandled_rejection", 1);
  });
}

installProcessGuards();

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    console.error(
      JSON.stringify({
        event: "startup_failed",
        code: error.code,
        reason: error.reason,
        setting: error.setting,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "startup_error";
  console.error(JSON.stringify({ event: "startup_failed", code }));
  process.exitCode = 1;
});
