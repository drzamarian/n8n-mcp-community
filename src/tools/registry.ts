import type { ToolDefinition } from "./definition.js";
import { credentialTools } from "./credentials.js";
import { executionTools } from "./executions.js";
import { tagTools } from "./tags.js";
import { userTools } from "./users.js";
import { utilityTools } from "./utilities.js";
import { workflowTools } from "./workflows.js";
import { TOOL_ENDPOINT_CONTRACTS } from "./endpoint-contracts.js";

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  ...workflowTools,
  ...executionTools,
  ...credentialTools,
  ...tagTools,
  ...userTools,
  ...utilityTools,
]);

const names = TOOL_DEFINITIONS.map((tool) => tool.name);
if (names.length !== 44 || new Set(names).size !== 44) {
  throw new Error(
    `The tool registry must contain exactly 44 unique names; found ${names.length} entries.`,
  );
}
if (
  JSON.stringify([...Object.keys(TOOL_ENDPOINT_CONTRACTS)].sort()) !==
  JSON.stringify([...names].sort())
) {
  throw new Error("The endpoint-contract inventory must exactly match the runtime tool registry.");
}

export const TOOL_NAMES: readonly string[] = Object.freeze(names);
