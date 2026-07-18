import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { readN8nConnection, type N8nConnectionConfig, type StartupConfig } from "../config.js";
import { N8nClient } from "../n8n/client.js";
import { authorizeOperation, type OperationClass } from "../security/operation-policy.js";
import { boundedJson, sanitizeForOutput } from "../security/redaction.js";
import { TOOL_ENDPOINT_CONTRACTS } from "./endpoint-contracts.js";

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

function errorResult(error: unknown, correlationId: string): CallToolResult {
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
  const inputSchema = z.object(spec.input).strict();
  return Object.freeze({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    operation: spec.operation,
    annotations,
    endpointContract: Object.freeze([...endpointContract]),
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
            return spec.formatResult ? spec.formatResult(value) : successResult(value);
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
            return errorResult(error, correlationId);
          }
        },
      );
    },
  });
}
