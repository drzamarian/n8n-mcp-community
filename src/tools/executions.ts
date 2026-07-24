import { z } from "zod";
import { defineTool, type ToolDefinition } from "./definition.js";
import { booleanQuery, numberQuery } from "./common.js";
import { confirmation, cursor, identifier, pageLimit, pathSegment } from "./schemas.js";

const executionId = z
  .union([
    identifier("Stable string ID of the saved execution."),
    z.number().int().nonnegative().transform(String),
  ])
  .describe("Stable execution ID, supplied as a valid string ID or non-negative integer.");
const executionStatus = z
  .enum(["new", "running", "success", "unknown", "error", "canceled", "crashed", "waiting"])
  .describe("Return only executions with this n8n status.");

const executionSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    status: z.string(),
    mode: z.string().optional(),
    workflowId: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
    startedAt: z.string().nullable().optional(),
    stoppedAt: z.string().nullable().optional(),
    finished: z.boolean().optional(),
    retryOf: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
    retrySuccessId: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const executionListSchema = z
  .object({
    data: z.array(executionSchema).max(100),
    nextCursor: cursor.nullable().optional(),
  })
  .passthrough();

function summarizeExecution(
  execution: z.output<typeof executionSchema>,
  requestedData: boolean,
): Record<string, unknown> {
  return {
    id: execution.id,
    status: execution.status,
    ...(execution.mode === undefined ? {} : { mode: execution.mode }),
    ...(execution.workflowId === undefined ? {} : { workflowId: execution.workflowId }),
    ...(execution.startedAt === undefined ? {} : { startedAt: execution.startedAt }),
    ...(execution.stoppedAt === undefined ? {} : { stoppedAt: execution.stoppedAt }),
    ...(execution.finished === undefined ? {} : { finished: execution.finished }),
    ...(execution.retryOf === undefined ? {} : { retryOf: execution.retryOf }),
    ...(execution.retrySuccessId === undefined ? {} : { retrySuccessId: execution.retrySuccessId }),
    dataPolicy: requestedData
      ? {
          requested: true,
          rawValuesReturned: false,
          upstreamDataPresent: execution.data !== undefined,
          reason:
            "Execution payload values are not returned because they may contain arbitrary sensitive workflow data.",
        }
      : { requested: false, rawValuesReturned: false },
  };
}

export const executionTools: readonly ToolDefinition[] = Object.freeze([
  defineTool({
    name: "n8n_executions_list",
    title: "List executions",
    description:
      "List one page of saved execution metadata, optionally filtered by status or workflow. Use it for discovery and bounded triage; use n8n_executions_get when an execution ID is known. Returns metadata and a cursor, never raw workflow payload values.",
    operation: "read-only",
    outputDataDescription:
      "Object with data (up to 100 allowlisted execution metadata records) and nextCursor. Each record includes identity/status/timing/retry metadata plus value-free dataPolicy; raw execution values are never returned.",
    input: {
      includeData: z
        .boolean()
        .default(false)
        .describe(
          "Ask n8n whether execution data exists; values remain withheld even when true (default false).",
        ),
      status: executionStatus.optional(),
      workflowId: identifier(
        "Return only executions belonging to this stable workflow ID.",
      ).optional(),
      limit: pageLimit(),
      cursor: cursor.optional(),
    },
    handler: async (input, context) => {
      const result = executionListSchema.parse(
        await context.client().request({
          path: "/executions",
          query: {
            includeData: booleanQuery(input.includeData),
            redactExecutionData: "true",
            status: input.status,
            workflowId: input.workflowId,
            limit: numberQuery(input.limit),
            cursor: input.cursor,
          },
        }),
      );
      return {
        data: result.data.map((execution) => summarizeExecution(execution, input.includeData)),
        nextCursor: result.nextCursor ?? null,
      };
    },
  }),
  defineTool({
    name: "n8n_executions_get",
    title: "Get execution",
    description:
      "Get metadata for one saved execution. Use it when the ID is known; use n8n_executions_list to discover or filter executions. Returns status, timing, workflow identity, and data presence without exposing node inputs or outputs.",
    operation: "read-only",
    outputDataDescription:
      "One allowlisted execution metadata record with identity, status, mode, workflow/timing/retry fields when present, and value-free dataPolicy. Raw execution values are never returned.",
    input: {
      executionId,
      includeData: z
        .boolean()
        .default(false)
        .describe(
          "Ask n8n whether execution data exists; values remain withheld even when true (default false).",
        ),
    },
    handler: async (input, context) =>
      summarizeExecution(
        executionSchema.parse(
          await context.client().request({
            path: `/executions/${pathSegment(input.executionId)}`,
            query: {
              includeData: booleanQuery(input.includeData),
              redactExecutionData: "true",
            },
          }),
        ),
        input.includeData,
      ),
  }),
  defineTool({
    name: "n8n_executions_delete",
    title: "Delete execution",
    description:
      "Permanently delete one saved execution. Use it only after n8n_executions_get confirms the target and retained history is no longer needed; inspection alone should use the read tools. Unsafe mode and exact confirmation are required; returns deleted=true.",
    operation: "unsafe",
    outputDataDescription:
      "Object with the validated input executionId and deleted=true. Identity is bound to the request and does not rely on an upstream response body.",
    input: { executionId, confirmation },
    confirmation: (input) => ({
      supplied: input.confirmation,
      expected: `DELETE ${input.executionId}`,
    }),
    handler: async (input, context) => {
      await context
        .client()
        .request({ method: "DELETE", path: `/executions/${pathSegment(input.executionId)}` });
      return { executionId: input.executionId, deleted: true };
    },
  }),
  defineTool({
    name: "n8n_executions_retry",
    title: "Retry execution",
    description:
      "Retry one eligible saved execution, which may repeat external side effects. Use it only after n8n_executions_get review; use n8n_executions_stop for a currently running execution. Unsafe mode and exact confirmation are required; returns value-free retry metadata.",
    operation: "unsafe",
    outputDataDescription:
      "Allowlisted metadata for the new or retried execution, including scalar identity/status/timing/retry fields when supplied by n8n; raw execution values are omitted.",
    input: {
      executionId,
      loadWorkflow: z
        .boolean()
        .default(true)
        .describe("Load the currently saved workflow definition for the retry (default true)."),
      confirmation,
    },
    confirmation: (input) => ({
      supplied: input.confirmation,
      expected: `RETRY ${input.executionId}`,
    }),
    handler: async (input, context) =>
      summarizeExecution(
        executionSchema.parse(
          await context.client().request({
            method: "POST",
            path: `/executions/${pathSegment(input.executionId)}/retry`,
            body: { loadWorkflow: input.loadWorkflow },
          }),
        ),
        false,
      ),
  }),
  defineTool({
    name: "n8n_executions_stop",
    title: "Stop execution",
    description:
      "Request cancellation of one running execution without rolling back completed external effects. Use n8n_executions_get for inspection or n8n_executions_retry for an eligible saved failure. Unsafe mode and exact confirmation are required; returns stopped, already_finished, or unknown.",
    operation: "unsafe",
    outputDataDescription:
      "Object with executionId, stopped, state (stopped, already_finished, or unknown), and optional finished/status/stoppedAt metadata. HTTP success alone never asserts that a stop occurred.",
    input: { executionId, confirmation },
    confirmation: (input) => ({
      supplied: input.confirmation,
      expected: `STOP ${input.executionId}`,
    }),
    handler: async (input, context) => {
      const upstream = z
        .object({
          status: z.string().optional(),
          finished: z.boolean().optional(),
          stoppedAt: z.string().nullable().optional(),
        })
        .passthrough()
        .parse(
          await context.client().request({
            method: "POST",
            path: `/executions/${pathSegment(input.executionId)}/stop`,
          }),
        );
      // n8n answers 200 even when the execution already finished in the race between the
      // operator's check and this call. Derive the outcome from the validated body instead of
      // asserting a stop that never happened: only a "canceled" terminal state means we stopped
      // it; other terminal states mean it finished on its own; anything else is unknown.
      const normalizedStatus = upstream.status?.toLowerCase();
      const outcome =
        normalizedStatus === "canceled"
          ? { stopped: true, state: "stopped" as const }
          : normalizedStatus === "success" ||
              normalizedStatus === "error" ||
              normalizedStatus === "crashed" ||
              upstream.finished === true
            ? { stopped: false, state: "already_finished" as const }
            : { stopped: false, state: "unknown" as const };
      return {
        executionId: input.executionId,
        stopped: outcome.stopped,
        state: outcome.state,
        ...(upstream.status === undefined ? {} : { status: upstream.status }),
        ...(upstream.finished === undefined ? {} : { finished: upstream.finished }),
        ...(upstream.stoppedAt === undefined ? {} : { stoppedAt: upstream.stoppedAt }),
      };
    },
  }),
]);
