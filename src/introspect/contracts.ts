import { z } from "zod";
import { INTROSPECT_RULE_IDS } from "./rule-ids.js";

export const INTROSPECT_SCHEMA_VERSION = "1.0.0" as const;
export const INTROSPECT_ENGINE_VERSION = "2.0.0" as const;
export const INTROSPECT_ERROR_CODES = Object.freeze([
  "invalid_input",
  "invalid_output",
  "invalid_path",
  "deadline_exceeded",
  "response_too_large",
  "upstream_http_error",
  "invalid_json",
  "invalid_schema",
] as const);
export const INTROSPECT_LIMITATION_CODES = Object.freeze([
  "deadline_exceeded",
  "response_too_large",
  "upstream_http_error",
  "invalid_json",
  "invalid_schema",
  "repeated_cursor",
  "invalid_timestamp",
  "invalid_execution_id",
  "page_failed",
  "detail_failed",
  "ordering_unreliable",
  "finding_limit",
  "output_limit",
  "label_redaction_limit",
] as const);

export type IntrospectLimitationCode = (typeof INTROSPECT_LIMITATION_CODES)[number];

const WorkflowIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe("n8n workflow ID. Accepts only ASCII letters, digits, underscore, and hyphen.");

export const IntrospectInputSchema = z
  .object({
    workflowId: WorkflowIdSchema,
    profile: z
      .enum(["quick", "deep"])
      .default("quick")
      .describe(
        "Use quick for metadata-only analysis or deep for up to four redacted execution details.",
      ),
    lookbackHours: z
      .number()
      .int()
      .min(1)
      .max(720)
      .optional()
      .describe("History window in hours. Defaults to 24 for quick and 168 for deep."),
    maxExecutions: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Maximum saved executions to inspect. Defaults to 20 for quick and 50 for deep; quick is capped at 25.",
      ),
    includeSanitizedLabels: z
      .boolean()
      .default(false)
      .describe(
        "Include bounded pattern-sanitized workflow and node labels. Opaque identifiers are returned by default.",
      ),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.profile === "quick" &&
      input.maxExecutions !== undefined &&
      input.maxExecutions > 25
    ) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: 25,
        inclusive: true,
        type: "number",
        path: ["maxExecutions"],
        message: "Quick profile supports at most 25 executions",
      });
    }
  });

export type IntrospectInput = z.infer<typeof IntrospectInputSchema>;

export interface EffectiveIntrospectInput {
  workflowId: string;
  profile: "quick" | "deep";
  lookbackHours: number;
  maxExecutions: number;
  includeSanitizedLabels: boolean;
}

export function resolveIntrospectInput(input: IntrospectInput): EffectiveIntrospectInput {
  return {
    workflowId: input.workflowId,
    profile: input.profile,
    lookbackHours: input.lookbackHours ?? (input.profile === "quick" ? 24 : 168),
    maxExecutions: input.maxExecutions ?? (input.profile === "quick" ? 20 : 50),
    includeSanitizedLabels: input.includeSanitizedLabels,
  };
}

export const WorkflowNodeSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    type: z.string().optional(),
    typeVersion: z.number().finite().min(-10_000).max(10_000).optional(),
    disabled: z.boolean().optional(),
    retryOnFail: z.boolean().optional(),
    maxTries: z.number().optional(),
    waitBetweenTries: z.number().optional(),
    continueOnFail: z.boolean().optional(),
    onError: z.string().max(128).optional(),
    executeOnce: z.boolean().optional(),
    alwaysOutputData: z.boolean().optional(),
    parameters: z.record(z.unknown()).optional(),
    credentials: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const WorkflowResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    active: z.boolean(),
    triggerCount: z.number().int().nonnegative().optional(),
    nodes: z.array(WorkflowNodeSchema).max(1_000).default([]),
    connections: z.record(z.unknown()).default({}),
    settings: z.record(z.unknown()).default({}),
    pinData: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

const ApiIdentifierSchema = z.union([z.string(), z.number()]).transform(String);
const ExecutionCursorSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Execution cursors must not contain control characters.",
  );

export const ExecutionMetadataSchema = z
  .object({
    id: ApiIdentifierSchema,
    status: z.string(),
    mode: z.string().optional(),
    startedAt: z.string().nullable().optional(),
    stoppedAt: z.string().nullable().optional(),
    waitTill: z.string().nullable().optional(),
    workflowId: ApiIdentifierSchema.nullable().optional(),
  })
  .passthrough();

export const ExecutionListResponseSchema = z
  .object({
    data: z.array(ExecutionMetadataSchema).max(100).default([]),
    nextCursor: ExecutionCursorSchema.nullable().optional(),
  })
  .passthrough();

export const ExecutionDetailResponseSchema = ExecutionMetadataSchema.extend({
  data: z.record(z.unknown()).optional(),
}).passthrough();

export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;

export type ExecutionStatus =
  "success" | "error" | "crashed" | "canceled" | "running" | "waiting" | "new" | "unknown";

export interface ReducedWorkflowNode {
  ref: string;
  label?: string;
  type?: string;
  typeVersion?: number;
  disabled: boolean;
  retryOnFail: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  continueOnFail: boolean;
  onError?: string;
  webhookResponseMode: boolean;
  exactExpressionReferenceCount: number;
  missingExpressionReferenceCount: number;
  parameterScanComplete: boolean;
  subworkflowTarget: "not_applicable" | "self" | "other" | "dynamic_or_missing";
  httpMethod?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OTHER";
  hasIdempotencyHeader: boolean;
  idempotencyHeaderMissingValue: boolean;
  literalSecretCount: number;
}

export interface ReducedWorkflow {
  id: string;
  label?: string;
  active: boolean;
  triggerCount?: number;
  nodes: ReadonlyArray<ReducedWorkflowNode>;
  edges: ReadonlyArray<{ sourceIndex: number; targetIndex: number }>;
  graph: {
    duplicateNames: number;
    invalidEdges: number;
    danglingSources: number;
    danglingTargets: number;
  };
  settings: {
    errorWorkflowConfigured: boolean;
    errorWorkflowSelfReference: boolean;
    timezone: "absent" | "valid" | "invalid";
    saveErrorDataDisabled: boolean;
  };
}

export interface ReducedExecutionMetadata {
  status: ExecutionStatus;
  mode: string;
  startedAt: string | null;
  stoppedAt: string | null;
  waitObserved: boolean;
}

export interface ReadBudget {
  maxBytes: number;
  timeoutMs: number;
}

export interface N8nReadResult {
  value: unknown;
  bytes: number;
}

export interface N8nReadClient {
  get(
    endpoint: string,
    query: Readonly<Record<string, string>>,
    budget: ReadBudget,
  ): Promise<N8nReadResult>;
}

export type Profile = "quick" | "deep";
export type OrderingState = "verified_newest_first" | "unreliable" | "unknown";
export type HistoryBoundary =
  | "complete"
  | "lookback_reached"
  | "request_limited"
  | "execution_limited"
  | "ordering_unreliable"
  | "unknown";

export interface ReducedExecutionDetail {
  status: ExecutionStatus;
  lastNodeRef?: string;
  lastNodeLabel?: string;
  errorFingerprint?: string;
  nodeTimings: ReadonlyArray<{
    nodeRef: string;
    label?: string;
    executionTimeMs: number;
  }>;
  redactionObserved: boolean;
}

export interface CollectionLimitation {
  code: IntrospectLimitationCode;
  message: string;
}

export interface IntrospectSnapshot {
  input: EffectiveIntrospectInput;
  workflow: ReducedWorkflow;
  executions: ReadonlyArray<ReducedExecutionMetadata>;
  details: ReadonlyArray<ReducedExecutionDetail>;
  status: "complete" | "partial";
  pages: number;
  detailRequests: number;
  acceptedBytes: number;
  ordering: OrderingState;
  historyBoundary: HistoryBoundary;
  oldestStartedAt: string | null;
  newestStartedAt: string | null;
  totalMetadataExecutions: number;
  sampledErrors: number;
  limitations: ReadonlyArray<CollectionLimitation>;
}

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export const CategorySchema = z.enum([
  "structure",
  "contract",
  "reliability",
  "performance",
  "privacy",
  "maintainability",
  "observability",
]);

export type Severity = z.infer<typeof SeveritySchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type Category = z.infer<typeof CategorySchema>;

const FactValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const MAX_FINDING_ENTITY_KEY_LENGTH = 128;
const MAX_FINDING_ID_LENGTH =
  Math.max(...INTROSPECT_RULE_IDS.map((ruleId) => ruleId.length)) +
  1 +
  MAX_FINDING_ENTITY_KEY_LENGTH;

export const FindingSchema = z.object({
  id: z.string().max(MAX_FINDING_ID_LENGTH),
  ruleId: z.enum(INTROSPECT_RULE_IDS),
  category: CategorySchema,
  severity: SeveritySchema,
  confidence: ConfidenceSchema,
  title: z.string(),
  summary: z.string(),
  affectedEntity: z.object({
    kind: z.string(),
    key: z.string().max(MAX_FINDING_ENTITY_KEY_LENGTH),
    label: z.string().optional(),
  }),
  evidence: z.object({
    summary: z.string(),
    facts: z.record(FactValueSchema).optional(),
  }),
  remediation: z.string(),
  documentationUrl: z
    .string()
    .max(2_048)
    .refine((value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "https:" || protocol === "http:";
      } catch {
        return false;
      }
    }, "Documentation URLs must use HTTP or HTTPS.")
    .optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const RuleCoverageSchema = z.object({
  ruleId: z.enum(INTROSPECT_RULE_IDS),
  outcome: z.enum(["triggered", "passed", "not_applicable", "inconclusive"]),
  partiallyInconclusive: z.boolean(),
  reason: z.string(),
  findingCount: z.number().int().nonnegative(),
  totalFindingCount: z.number().int().nonnegative(),
  omittedFindingCount: z.number().int().nonnegative(),
  detectedCycleCount: z.number().int().nonnegative(),
  inconclusiveCycleCount: z.number().int().nonnegative(),
});

export type RuleCoverage = z.infer<typeof RuleCoverageSchema>;

const StatusCountsSchema = z.object({
  success: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  crashed: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  new: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
});

const DurationMetricsSchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  meanMs: z.number().nonnegative().nullable(),
  minMs: z.number().nonnegative().nullable(),
  maxMs: z.number().nonnegative().nullable(),
  p50Ms: z.number().nonnegative().nullable(),
  p95Ms: z.number().nonnegative().nullable(),
  p99Ms: z.number().nonnegative().nullable(),
});

export const IntrospectResultSchema = z.object({
  schemaVersion: z.literal(INTROSPECT_SCHEMA_VERSION),
  engineVersion: z.literal(INTROSPECT_ENGINE_VERSION),
  status: z.enum(["complete", "partial"]),
  profile: z.enum(["quick", "deep"]),
  workflow: z.object({
    id: z.string(),
    label: z.string().optional(),
    active: z.boolean(),
    nodeCount: z.number().int().nonnegative(),
  }),
  sample: z.object({
    lookbackHours: z.number().int().positive(),
    maxExecutions: z.number().int().positive(),
    metadataExecutions: z.number().int().nonnegative(),
    eligibleExecutions: z.number().int().nonnegative(),
    pages: z.number().int().nonnegative(),
    detailRequests: z.number().int().nonnegative(),
    sampledErrors: z.number().int().nonnegative(),
    acceptedBytes: z.number().int().nonnegative(),
    ordering: z.enum(["verified_newest_first", "unreliable", "unknown"]),
    historyBoundary: z.enum([
      "complete",
      "lookback_reached",
      "request_limited",
      "execution_limited",
      "ordering_unreliable",
      "unknown",
    ]),
    oldestStartedAt: z.string().nullable(),
    newestStartedAt: z.string().nullable(),
  }),
  summary: z.object({
    findingCounts: z.object({
      critical: z.number().int().nonnegative(),
      high: z.number().int().nonnegative(),
      medium: z.number().int().nonnegative(),
      low: z.number().int().nonnegative(),
      info: z.number().int().nonnegative(),
    }),
    ruleOutcomes: z.object({
      triggered: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      notApplicable: z.number().int().nonnegative(),
      inconclusive: z.number().int().nonnegative(),
      partiallyInconclusive: z.number().int().nonnegative(),
    }),
    findings: z.object({
      totalCount: z.number().int().nonnegative(),
      retainedCount: z.number().int().nonnegative(),
      omittedCount: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
  }),
  metrics: z.object({
    statusCounts: StatusCountsSchema,
    successRate: z.number().min(0).max(1).nullable(),
    duration: DurationMetricsSchema,
    consecutiveErrors: z.number().int().nonnegative().nullable(),
    perNodeTimings: z
      .array(
        z.object({
          nodeRef: z.string(),
          label: z.string().optional(),
          sampleCount: z.number().int().positive(),
          medianMs: z.number().nonnegative(),
          maxMs: z.number().nonnegative(),
        }),
      )
      .max(1_000),
    errorClusters: z
      .array(
        z.object({
          fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
          nodeRef: z.string().optional(),
          label: z.string().optional(),
          sampleCount: z.number().int().positive(),
          sampledErrorDetails: z.number().int().nonnegative(),
          sampledErrors: z.number().int().nonnegative(),
        }),
      )
      .max(100),
  }),
  findings: z.array(FindingSchema).max(1_000),
  ruleCoverage: z.array(RuleCoverageSchema).max(100),
  limitations: z
    .array(z.object({ code: z.enum(INTROSPECT_LIMITATION_CODES), message: z.string() }))
    .max(100),
  guidance: z.object({
    instanceSecurityTool: z.literal("n8n_audit_generate"),
    message: z.string(),
  }),
});

export type IntrospectResult = z.infer<typeof IntrospectResultSchema>;
