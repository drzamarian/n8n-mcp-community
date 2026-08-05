import { z } from "zod";
import { defineTool, type ToolDefinition } from "./definition.js";
import { booleanQuery, numberQuery } from "./common.js";
import { cursor, identifier, pageLimit, pathSegment } from "./schemas.js";

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
      "List one Public API page of saved execution metadata. Use it for discovery and bounded triage; use n8n_executions_get when an ID is known. status and workflowId filter upstream, cursor resumes one prior page, and includeData only reports whether data exists—values remain withheld. Requires execution-list permission and never auto-paginates; returns metadata and nextCursor.",
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
      "Get metadata for one saved execution. executionId is the execution record ID from n8n_executions_list, not its workflowId. includeData=true asks n8n whether saved payload data exists, but the MCP still withholds every node input and output; false skips that request detail. Use list for discovery. Requires execution-read permission; returns identity, status, timing, retry fields, and value-free dataPolicy.",
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
      "Permanently delete one saved execution and its retained history. executionId must be the execution record ID from n8n_executions_list or get; a workflow ID is not accepted. Confirm the target with get first. The server provides no recovery or rollback. Requires unsafe mode plus execution-delete permission; returns the request-bound executionId with deleted=true.",
    operation: "unsafe",
    outputDataDescription:
      "Object with the validated input executionId and deleted=true. Identity is bound to the request and does not rely on an upstream response body.",
    input: { executionId },
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
      "Retry one saved execution that has retry data and did not finish successfully; n8n rejects queued/new executions and successful finished executions. executionId comes from n8n_executions_get or list. loadWorkflow=true uses the currently saved workflow, while false uses the original execution snapshot. A retry may repeat earlier external effects; use stop for a running execution. Requires unsafe mode and retry permission; returns metadata without payload values.",
    operation: "unsafe",
    outputDataDescription:
      "Allowlisted metadata for the new or retried execution, including scalar identity/status/timing/retry fields when supplied by n8n; raw execution values are omitted.",
    input: {
      executionId,
      loadWorkflow: z
        .boolean()
        .default(true)
        .describe("Load the currently saved workflow definition for the retry (default true)."),
    },
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
      "Request cancellation of one stoppable execution: new, unknown, waiting, or running. executionId must be its record ID from n8n_executions_list or get, not a workflow ID. n8n rejects an execution that is already terminal. From a successful response, canceled maps to stopped, another terminal status maps to already_finished, and an unclear body maps to unknown; HTTP 200 alone never proves cancellation. Completed external effects remain. Requires unsafe mode and stop permission; returns the mapped state.",
    operation: "unsafe",
    outputDataDescription:
      "Object with executionId, stopped, state (stopped, already_finished, or unknown), and optional finished/status/stoppedAt metadata. HTTP success alone never asserts that a stop occurred.",
    input: { executionId },
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
      // Supported n8n versions normally reject an already-terminal target. For any successful
      // body, derive the outcome instead of trusting HTTP 200: only "canceled" proves this call
      // stopped it; another terminal state maps defensively to already_finished; anything else
      // is unknown.
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
