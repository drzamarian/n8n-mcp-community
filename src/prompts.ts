import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const PROMPT_NAMES = Object.freeze([
  "create-workflow",
  "debug-workflow",
  "optimize-workflow",
  "manage-credentials",
]);

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "create-workflow",
    {
      title: "Create an n8n workflow",
      description: "Plan and create a workflow through the safe Public API tools.",
      argsSchema: { objective: z.string().min(1).max(2_000) },
    },
    ({ objective }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Design an n8n Community workflow for this objective: ${objective}\n\nInspect the offline node references as needed. Explain trigger, data contract, failure handling, credentials, and test plan before calling n8n_workflows_create. Never place secret values in workflow parameters.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "debug-workflow",
    {
      title: "Debug an n8n workflow",
      description: "Diagnose a saved workflow without executing it.",
      argsSchema: { workflowId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) },
    },
    ({ workflowId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Diagnose workflow ${workflowId}. Start with n8n_introspect in quick mode, deepen only if the bounded evidence requires it, and use execution metadata without requesting raw payload values. Separate confirmed defects, limitations, and hypotheses. Do not mutate or execute the workflow.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "optimize-workflow",
    {
      title: "Optimize an n8n workflow",
      description: "Review a workflow and propose evidence-backed improvements.",
      argsSchema: { workflowId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) },
    },
    ({ workflowId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Review workflow ${workflowId} for reliability, performance, privacy, and maintainability. Use n8n_workflows_get and n8n_introspect. Present a minimal change set and verification plan before any write. Prefer n8n_update_node for one-node changes and disclose its non-atomic Public API limitation.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "manage-credentials",
    {
      title: "Manage n8n credentials",
      description: "Plan safe credential metadata and lifecycle operations.",
      argsSchema: { objective: z.string().min(1).max(1_000) },
    },
    ({ objective }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Handle this credential objective safely: ${objective}\n\nUse n8n_credentials_schema before creation or value changes. Never repeat, log, or place credential values in prose. Use metadata and usage tools for discovery. Explain that credential testing may contact an external service and requires unsafe mode plus exact confirmation.`,
          },
        },
      ],
    }),
  );
}
