import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { readN8nConnection, type N8nConnectionConfig, type StartupConfig } from "../config.js";
import { N8nClient } from "../n8n/client.js";
import { authorizeOperation, type OperationClass } from "../security/operation-policy.js";
import { boundedJson, sanitizeForOutput } from "../security/redaction.js";
import { TOOL_ENDPOINT_CONTRACTS } from "./endpoint-contracts.js";
import { confirmation as confirmationField } from "./schemas.js";

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
  // The exact confirmation phrase template (e.g. "DELETE <workflowId>") for confirmation-guarded
  // tools, derived from the tool's own confirmation function; absent for tools without a guard.
  readonly confirmationPhrase?: string;
  validateInput(input: unknown): unknown;
  register(server: McpServer, context: ToolContext): void;
}

interface ToolSpec<Shape extends ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly operation: OperationClass;
  readonly input: Shape;
  readonly confirmation?: (input: z.output<z.ZodObject<Shape>>) => {
    readonly supplied: string | undefined;
    readonly expected: string;
  };
  readonly handler: (input: z.output<z.ZodObject<Shape>>, context: ToolContext) => Promise<unknown>;
  readonly outputSchema?: z.ZodTypeAny;
  readonly formatResult?: (value: unknown) => CallToolResult;
  readonly destructive?: boolean;
  readonly openWorld?: boolean;
  readonly idempotent?: boolean;
}

function annotationsFor<Shape extends ZodRawShape>(spec: ToolSpec<Shape>): ToolAnnotations {
  return {
    title: spec.title,
    readOnlyHint: spec.operation === "read-only",
    destructiveHint: spec.destructive ?? spec.operation !== "read-only",
    idempotentHint: spec.idempotent ?? spec.operation === "read-only",
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

function successResult(value: unknown): CallToolResult {
  const safe = sanitizeForOutput(value);
  return {
    content: [{ type: "text", text: boundedJson(safe) }],
    structuredContent: { ...safe },
  };
}

// When a mutation's full result exceeds the output cap, the write already landed upstream, so
// summarize it to a bounded, stable shape (truncated + the scalar identity fields) instead of
// reporting an error that would induce a retry of an applied mutation.
function truncatedMutationResult(value: unknown): Record<string, unknown> {
  const identity: Record<string, unknown> = {};
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    let retained = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (retained >= 32) break;
      if (
        entry === null ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        (typeof entry === "string" && entry.length <= 512)
      ) {
        identity[key] = entry;
        retained += 1;
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

function buildSuccessResult(value: unknown, operation: OperationClass): CallToolResult {
  try {
    return successResult(value);
  } catch (error) {
    // boundedJson's output-size cap is the only throw here. Read-only tools keep the existing
    // cap error; a mutating tool has already applied its write, so an over-cap result is a
    // truthful, bounded success summary rather than a misleading failure.
    if (operation === "read-only") throw error;
    return successResult(truncatedMutationResult(value));
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
  const endpointContract = TOOL_ENDPOINT_CONTRACTS[spec.name];
  if (endpointContract === undefined) {
    throw new Error(`Tool ${spec.name} is missing its endpoint documentation contract.`);
  }
  // Make the required confirmation phrase discoverable in the tool schema by deriving it from the
  // tool's own confirmation function (single source of truth, so the documented phrase can never
  // drift from the enforced one). A placeholder proxy turns `DELETE ${input.workflowId}` into the
  // template `DELETE <workflowId>`. The phrase is documented on the field but is deliberately never
  // echoed back on a mismatch, so the guard still demands a deliberate, constructed confirmation.
  const inputShape = { ...spec.input };
  let confirmationPhrase: string | undefined;
  if (spec.confirmation && "confirmation" in inputShape) {
    const placeholder = new Proxy(
      {},
      { get: (_target, property) => (typeof property === "string" ? `<${property}>` : undefined) },
    ) as z.output<z.ZodObject<Shape>>;
    confirmationPhrase = spec.confirmation(placeholder).expected;
    const substitution = confirmationPhrase.includes("<") ? " — substitute the real value(s)" : "";
    (inputShape as Record<string, z.ZodTypeAny>).confirmation = confirmationField.describe(
      `Deliberate-action guard. Must equal exactly: ${confirmationPhrase}${substitution}. A mismatch is rejected without echoing the expected phrase.`,
    );
  }
  const inputSchema = z.object(inputShape).strict();
  return Object.freeze({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    operation: spec.operation,
    annotations,
    endpointContract: Object.freeze([...endpointContract]),
    ...(confirmationPhrase === undefined ? {} : { confirmationPhrase }),
    validateInput: (input: unknown): unknown => inputSchema.parse(input),
    register(server: McpServer, context: ToolContext): void {
      server.registerTool(
        spec.name,
        {
          title: spec.title,
          description: spec.description,
          inputSchema,
          outputSchema:
            spec.outputSchema ??
            z.object({
              data: z.unknown(),
              redacted: z.boolean(),
              untrusted: z.literal(true),
            }),
          annotations,
        },
        async (input) => {
          const correlationId = randomUUID();
          try {
            authorizeOperation(context.startup.mode, spec.operation, spec.confirmation?.(input));
            const value = await spec.handler(input, context);
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
            if (spec.formatResult) return spec.formatResult(value);
            return buildSuccessResult(value, spec.operation);
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
