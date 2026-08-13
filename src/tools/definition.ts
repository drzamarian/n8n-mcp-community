import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { readN8nConnection, type N8nConnectionConfig, type StartupConfig } from "../config.js";
import { N8nClient } from "../n8n/client.js";
import { authorizeOperation, type OperationClass } from "../security/operation-policy.js";
import {
  boundedJson,
  OutputLimitError,
  sanitizeForOutput,
  sanitizeForOutputDetailed,
  type SanitizationOptions,
} from "../security/redaction.js";
import { TOOL_ENDPOINT_CONTRACTS } from "./endpoint-contracts.js";
import { genericToolOutputContract, MUTATION_IDENTITY_KEYS } from "./output-contracts.js";

const MAX_SERIALIZED_TOOL_RESULT_BYTES = 256 * 1024;
const DEFAULT_READ_ONLY_OUTPUT_LIMIT_MESSAGE =
  "The sanitized result exceeded safe output limits. Use narrower inputs when available; otherwise inspect the full object in n8n.";

export interface ToolContext {
  readonly startup: StartupConfig;
  connection(): N8nConnectionConfig;
  client(): N8nClient;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly operation: OperationClass;
  readonly annotations: ToolAnnotations;
  readonly endpointContract: readonly string[];
  readonly outputDataDescription: string;
  validateInput(input: unknown): unknown;
  register(server: McpServer, context: ToolContext): void;
}

interface ToolSpec<Shape extends ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly operation: OperationClass;
  readonly outputDataDescription: string;
  readonly input: Shape;
  readonly handler: (input: z.output<z.ZodObject<Shape>>, context: ToolContext) => Promise<unknown>;
  readonly outputSchema?: z.ZodTypeAny;
  readonly formatResult?: (value: unknown) => CallToolResult;
  readonly preserveValidatedRootRecordValues?: boolean;
  readonly sanitizationOptions?: SanitizationOptions;
  readonly failOnSanitizerLimit?: boolean;
  readonly readOnly?: boolean;
  readonly readOnlyOutputLimitMessage?: string;
  readonly destructive?: boolean;
  readonly openWorld?: boolean;
  readonly idempotent?: boolean;
}

function annotationsFor<Shape extends ZodRawShape>(spec: ToolSpec<Shape>): ToolAnnotations {
  const readOnly = spec.readOnly ?? spec.operation === "read-only";
  return {
    title: spec.title,
    readOnlyHint: readOnly,
    destructiveHint: spec.destructive ?? spec.operation !== "read-only",
    idempotentHint: spec.idempotent ?? readOnly,
    openWorldHint: spec.openWorld ?? true,
  };
}

function errorResult(error: unknown, correlationId: string, toolName: string): CallToolResult {
  // A Zod failure reaching here is a RESPONSE-schema failure (older/newer n8n shape drift): the
  // per-tool inputs are validated by the SDK before the handler runs, and local invariants —
  // including the introspect input and output contracts — are thrown as plain coded Errors, not
  // raw ZodErrors. Map it to a stable, distinct code with a bounded message that names only the
  // tool, so the raw ZodError issue dump (paths/expectations) can never surface.
  if (error instanceof z.ZodError) {
    const safe = sanitizeForOutput({
      error: {
        code: "upstream_shape_mismatch",
        message: `The ${toolName} response did not match the supported n8n API schema.`,
        correlationId,
      },
    });
    return { isError: true, content: [{ type: "text", text: boundedJson(safe) }] };
  }
  const candidate =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "tool_error";
  const message = error instanceof Error ? error.message : "The tool could not complete safely.";
  const safe = sanitizeForOutput({ error: { code: candidate, message, correlationId } });
  return { isError: true, content: [{ type: "text", text: boundedJson(safe) }] };
}

class ToolOutputError extends Error {
  readonly code = "invalid_output";

  constructor(
    message = "The tool produced a result that did not match its published output contract.",
  ) {
    super(message);
    this.name = "ToolOutputError";
  }
}

function validatedOutput(value: unknown, outputSchema: z.ZodTypeAny): unknown {
  const parsed = outputSchema.safeParse(value);
  if (!parsed.success) throw new ToolOutputError();
  return parsed.data;
}

function resultFromValidatedOutput(safe: unknown): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: boundedJson(safe) }],
    structuredContent: { ...(safe as Record<string, unknown>) },
  };
  // The MCP result carries both the compatibility text and structured content. Bound their
  // combined serialized form so consumers never receive a nominally successful result above
  // the documented 256 KiB envelope.
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_SERIALIZED_TOOL_RESULT_BYTES) {
    throw new OutputLimitError();
  }
  return result;
}

function fallbackResult(value: unknown, outputSchema: z.ZodTypeAny): CallToolResult {
  const sanitized = sanitizeForOutput(value);
  return resultFromValidatedOutput(validatedOutput({ ...sanitized, redacted: true }, outputSchema));
}

// When a mutation's full result exceeds the output cap, the write already landed upstream, so
// summarize it to a bounded, stable shape (truncated + the scalar identity fields) instead of
// reporting an error that would induce a retry of an applied mutation.
function truncatedMutationResult(value: unknown): Record<string, unknown> {
  const identity: Record<string, unknown> = {};
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    for (const key of MUTATION_IDENTITY_KEYS) {
      const entry = source[key];
      if (
        entry === null ||
        typeof entry === "boolean" ||
        (typeof entry === "number" && Number.isFinite(entry)) ||
        (typeof entry === "string" && entry.length <= 512)
      ) {
        identity[key] = entry;
      }
    }
  }
  return {
    truncated: true,
    outcome: "success",
    detail:
      "The mutation completed upstream, but its full result exceeded the output size limit and was summarized to the identity fields below.",
    identity,
  };
}

function buildSuccessResult(
  value: unknown,
  readOnly: boolean,
  primaryDataSchema: z.ZodTypeAny,
  outputSchema: z.ZodTypeAny,
  preserveValidatedRootRecordValues = false,
  sanitizationOptions: SanitizationOptions = {},
  failOnSanitizerLimit = false,
  readOnlyOutputLimitMessage?: string,
): CallToolResult {
  // A handler may return only its official primary shape. The public mutation fallback is a
  // server-generated recovery form and can never be supplied directly by an upstream handler.
  validatedOutput(value, primaryDataSchema);
  const sanitized = sanitizeForOutputDetailed(value, {
    ...sanitizationOptions,
    preserveValidatedRootRecordValues,
  });
  if (failOnSanitizerLimit && sanitized.sizeReduced) {
    throw new ToolOutputError(readOnlyOutputLimitMessage ?? DEFAULT_READ_ONLY_OUTPUT_LIMIT_MESSAGE);
  }
  let safe: unknown;
  try {
    safe = validatedOutput(sanitized.output, outputSchema);
  } catch (error) {
    // A completed mutation falls back only when the sanitizer explicitly reduced structure
    // because of its depth/node/breadth bounds. Ordinary post-sanitization schema drift must fail.
    if (readOnly || !(error instanceof ToolOutputError) || !sanitized.structurallyReduced) {
      throw error;
    }
    return fallbackResult(truncatedMutationResult(value), outputSchema);
  }
  try {
    return resultFromValidatedOutput(safe);
  } catch (error) {
    if (readOnly && error instanceof OutputLimitError) {
      throw new ToolOutputError(
        readOnlyOutputLimitMessage ?? DEFAULT_READ_ONLY_OUTPUT_LIMIT_MESSAGE,
      );
    }
    if (readOnly || !(error instanceof OutputLimitError)) throw error;
    // A mutating tool has already applied its write, so an over-cap result is a
    // truthful, bounded success summary rather than a misleading failure.
    return fallbackResult(truncatedMutationResult(value), outputSchema);
  }
}

export function createToolContext(startup: StartupConfig): ToolContext {
  const connection = (): N8nConnectionConfig => readN8nConnection(startup);
  return {
    startup,
    connection,
    client: () => new N8nClient(connection()),
  };
}

export function defineTool<Shape extends ZodRawShape>(spec: ToolSpec<Shape>): ToolDefinition {
  const annotations = annotationsFor(spec);
  if (annotations.readOnlyHint === true && annotations.destructiveHint === true) {
    throw new Error(`Tool ${spec.name} cannot be both read-only and destructive.`);
  }
  if (spec.failOnSanitizerLimit === true && annotations.readOnlyHint !== true) {
    throw new Error(`Tool ${spec.name} can fail on sanitizer limits only when it is read-only.`);
  }
  const endpointContract = TOOL_ENDPOINT_CONTRACTS[spec.name];
  if (endpointContract === undefined) {
    throw new Error(`Tool ${spec.name} is missing its endpoint documentation contract.`);
  }
  const inputShape = { ...spec.input };
  const inputSchema = z.object(inputShape).strict();
  const genericOutput =
    spec.outputSchema === undefined
      ? genericToolOutputContract(
          spec.name,
          annotations.readOnlyHint === true,
          spec.outputDataDescription,
        )
      : undefined;
  const outputSchema = spec.outputSchema ?? genericOutput?.outputSchema;
  if (outputSchema === undefined) {
    throw new Error(`Tool ${spec.name} is missing its output schema.`);
  }
  return Object.freeze({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    operation: spec.operation,
    annotations,
    endpointContract: Object.freeze([...endpointContract]),
    outputDataDescription: spec.outputDataDescription,
    validateInput: (input: unknown): unknown => inputSchema.parse(input),
    register(server: McpServer, context: ToolContext): void {
      server.registerTool(
        spec.name,
        {
          title: spec.title,
          description: spec.description,
          inputSchema,
          outputSchema,
          annotations,
        },
        async (input) => {
          const correlationId = randomUUID();
          try {
            authorizeOperation(context.startup.mode, spec.operation);
            const value = await spec.handler(input, context);
            let result: CallToolResult;
            if (spec.formatResult) {
              result = spec.formatResult(value);
            } else {
              if (genericOutput === undefined) {
                throw new Error(`Tool ${spec.name} is missing its primary output contract.`);
              }
              result = buildSuccessResult(
                value,
                annotations.readOnlyHint === true,
                genericOutput.primaryDataSchema,
                outputSchema,
                spec.preserveValidatedRootRecordValues,
                spec.sanitizationOptions,
                spec.failOnSanitizerLimit,
                spec.readOnlyOutputLimitMessage,
              );
            }
            if (spec.operation !== "read-only") {
              console.error(
                JSON.stringify({
                  timestamp: new Date().toISOString(),
                  event: "security_operation",
                  tool: spec.name,
                  outcome: "success",
                  correlationId,
                }),
              );
            }
            return result;
          } catch (error) {
            if (spec.operation !== "read-only") {
              console.error(
                JSON.stringify({
                  timestamp: new Date().toISOString(),
                  event: "security_operation",
                  tool: spec.name,
                  outcome: "failure",
                  correlationId,
                }),
              );
            }
            return errorResult(error, correlationId, spec.name);
          }
        },
      );
    },
  });
}
