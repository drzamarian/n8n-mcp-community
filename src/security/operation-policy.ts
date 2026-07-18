import type { OperationMode } from "../config.js";

export type OperationClass = "read-only" | "write" | "unsafe";

export class PolicyError extends Error {
  readonly code = "operation_denied";

  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export function authorizeOperation(
  configuredMode: OperationMode,
  operation: OperationClass,
  confirmation?: { readonly supplied: string | undefined; readonly expected: string },
): void {
  if (operation === "write" && configuredMode === "read-only") {
    throw new PolicyError("This tool requires N8N_MCP_MODE=write or unsafe.");
  }
  if (operation !== "unsafe") return;
  if (configuredMode !== "unsafe") {
    throw new PolicyError("This tool requires N8N_MCP_MODE=unsafe.");
  }
  if (!confirmation || confirmation.supplied !== confirmation.expected) {
    throw new PolicyError("The supplied confirmation did not match the required exact phrase.");
  }
}
