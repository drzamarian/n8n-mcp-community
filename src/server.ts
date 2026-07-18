import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readStartupConfig, type StartupConfig } from "./config.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { createToolContext } from "./tools/definition.js";
import { TOOL_DEFINITIONS } from "./tools/registry.js";
import { PACKAGE_VERSION } from "./version.js";

export function createServer(startup: StartupConfig = readStartupConfig()): McpServer {
  const server = new McpServer({ name: "n8n-mcp-community", version: PACKAGE_VERSION });
  const context = createToolContext(startup);
  for (const tool of TOOL_DEFINITIONS) tool.register(server, context);
  registerResources(server);
  registerPrompts(server);
  return server;
}
