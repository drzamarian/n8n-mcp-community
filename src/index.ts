#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readN8nConnection, readStartupConfig } from "./config.js";
import { createServer } from "./server.js";
import { buildDoctorReport } from "./doctor.js";
import { PACKAGE_VERSION } from "./version.js";

const HELP = `n8n-mcp-community ${PACKAGE_VERSION}

Usage:
  n8n-mcp-community            Start the MCP stdio server
  n8n-mcp-community doctor     Validate configuration without network access
  n8n-mcp-community --version  Print the package version
  n8n-mcp-community --help     Show this help

The server defaults to N8N_MCP_MODE=read-only. Connected tools require
N8N_API_URL and N8N_API_KEY. Never pass secrets as command-line arguments.`;

function runDoctor(): void {
  const startup = readStartupConfig();
  const connection = readN8nConnection(startup);
  const report = buildDoctorReport(startup, connection);
  console.log(JSON.stringify(report, null, 2));
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
    runDoctor();
    return;
  }
  if (args.length > 0) {
    throw new Error("Unknown command or option. Use --help.");
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "startup_error";
  console.error(JSON.stringify({ event: "startup_failed", code }));
  process.exitCode = 1;
});
