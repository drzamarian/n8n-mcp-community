import { z } from "zod";
import {
  ExecutionDetailResponseSchema,
  ExecutionListResponseSchema,
  type EffectiveIntrospectInput,
  type ExecutionStatus,
  type HistoryBoundary,
  type IntrospectLimitationCode,
  type IntrospectSnapshot,
  type N8nReadClient,
  type OrderingState,
  type Profile,
  type ReducedExecutionDetail,
  type ReducedExecutionMetadata,
  type ReducedWorkflow,
  type WorkflowNode,
  type WorkflowResponse,
  WorkflowResponseSchema,
} from "./contracts.js";
import { compareCodeUnits } from "./order.js";
import { fingerprintError, optionalLabel } from "./sanitize.js";

export const PROFILE_BUDGETS = Object.freeze({
  quick: Object.freeze({
    workflowRequests: 1,
    listPages: 1,
    detailRequests: 0,
    metadataExecutions: 25,
    requestTimeoutMs: 5_000,
    totalDeadlineMs: 10_000,
    workflowBytes: 1_048_576,
    listBytes: 524_288,
    detailBytes: 0,
    totalBytes: 1_572_864,
    structuredOutputBytes: 98_304,
    combinedOutputBytes: 229_376,
  }),
  deep: Object.freeze({
    workflowRequests: 1,
    listPages: 4,
    detailRequests: 4,
    metadataExecutions: 100,
    requestTimeoutMs: 5_000,
    totalDeadlineMs: 25_000,
    workflowBytes: 1_048_576,
    listBytes: 524_288,
    detailBytes: 524_288,
    totalBytes: 5_242_880,
    structuredOutputBytes: 131_072,
    combinedOutputBytes: 327_680,
  }),
} satisfies Record<Profile, Readonly<Record<string, number>>>);

export class IntrospectCollectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "IntrospectCollectionError";
  }
}

interface CollectedExecution extends ReducedExecutionMetadata {
  id: string;
}

const SAFE_LIMITATIONS: Readonly<Record<IntrospectLimitationCode, string>> = Object.freeze({
  deadline_exceeded: "The Introspect deadline was reached before collection completed.",
  response_too_large: "An upstream response exceeded the immutable Introspect byte limit.",
  upstream_http_error: "A public n8n API request failed.",
  invalid_json: "A public n8n API response was not valid JSON.",
  invalid_schema: "A public n8n API response did not match the supported schema.",
  repeated_cursor: "Pagination stopped because n8n returned a cursor that was already seen.",
  invalid_timestamp:
    "Executions with missing or invalid start timestamps were excluded from the lookback sample.",
  invalid_execution_id:
    "An execution detail was skipped because its identifier was not a safe path segment.",
  page_failed: "A later execution metadata page could not be collected.",
  detail_failed: "One or more selected execution details could not be reduced safely.",
  ordering_unreliable:
    "Execution pages were not consistently ordered newest first; temporal rules are inconclusive.",
  finding_limit:
    "One or more rules produced more occurrences than the immutable output cap allows.",
  output_limit: "The report was reduced to remain within the immutable output byte limit.",
  label_redaction_limit:
    "Pattern redaction cannot recognize every sensitive proper name; opaque identifiers remain authoritative.",
});

function limitation(code: IntrospectLimitationCode): {
  code: IntrospectLimitationCode;
  message: string;
} {
  return { code, message: SAFE_LIMITATIONS[code] };
}

function errorCode(error: unknown): IntrospectLimitationCode | undefined {
  if (!(error instanceof IntrospectCollectionError)) return undefined;
  return error.code in SAFE_LIMITATIONS
    ? (error.code as IntrospectLimitationCode)
    : "upstream_http_error";
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new IntrospectCollectionError(
      "invalid_schema",
      "The public n8n API response did not match the supported schema.",
    );
  }
  return parsed.data as z.output<S>;
}

function timestampMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedTimestamp(value: string | null | undefined): string | null {
  const parsed = timestampMs(value);
  return parsed === undefined ? null : new Date(parsed).toISOString();
}

function executionDuration(execution: ReducedExecutionMetadata): number | undefined {
  const start = timestampMs(execution.startedAt);
  const stop = timestampMs(execution.stoppedAt);
  if (start === undefined || stop === undefined || stop < start) return undefined;
  return stop - start;
}

function normalizeStatus(status: string): ExecutionStatus {
  switch (status.toLowerCase()) {
    case "success":
    case "error":
    case "crashed":
    case "canceled":
    case "running":
    case "waiting":
    case "new":
      return status.toLowerCase() as ExecutionStatus;
    default:
      return "unknown";
  }
}

function normalizeMode(mode: string | undefined): string {
  if (!mode || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(mode)) return "unknown";
  return mode.toLowerCase();
}

function reduceExecution(
  raw: z.output<typeof ExecutionListResponseSchema>["data"][number],
): CollectedExecution {
  return {
    id: raw.id,
    status: normalizeStatus(raw.status),
    mode: normalizeMode(raw.mode),
    startedAt: normalizedTimestamp(raw.startedAt),
    stoppedAt: normalizedTimestamp(raw.stoppedAt),
    waitObserved: raw.waitTill !== undefined && raw.waitTill !== null && raw.waitTill !== "",
  };
}

function assessOrdering(executions: ReadonlyArray<ReducedExecutionMetadata>): OrderingState {
  if (executions.length === 0) return "unknown";
  const timestamps = executions.map((execution) => timestampMs(execution.startedAt));
  if (timestamps.some((value) => value === undefined)) return "unknown";
  for (let index = 1; index < timestamps.length; index += 1) {
    if ((timestamps[index] as number) > (timestamps[index - 1] as number)) return "unreliable";
  }
  return "verified_newest_first";
}

function safeExecutionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/**
 * A string value counts as a literal secret when it is a real value rather than an
 * n8n expression (`=` / `={{ ... }}`), an environment reference, or an obvious
 * placeholder (asterisks, `[REDACTED]`-style tokens, or `<...>` templates). Only the
 * boolean verdict is used; the value itself is never retained.
 */
function isLiteralSecretValue(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed !== "" &&
    !trimmed.startsWith("=") &&
    !trimmed.includes("$env") &&
    !/^\*+$/.test(trimmed) &&
    !/^\[[A-Z_-]+\]$/.test(trimmed) &&
    !/^<[^>]+>$/.test(trimmed)
  );
}

function analyzeParameters(value: unknown, maxEntries = 1_000) {
  const seen = new WeakSet<object>();
  const references = new Set<string>();
  const stack: Array<{ key: string; value: unknown }> = [{ key: "", value }];
  const secretKey =
    /(password|passwd|secret|token|api.?key|authorization|private.?key|client.?secret)/i;
  let entries = 0;
  let hasIdempotencyHeader = false;
  let idempotencyHeaderMissingValue = false;
  let literalSecretCount = 0;

  while (stack.length > 0 && entries < maxEntries) {
    const current = stack.pop() as { key: string; value: unknown };
    entries += 1;
    const normalizedKey = current.key.toLowerCase().replace(/[_\s]/g, "-");
    const currentIsIdempotencyHeader =
      normalizedKey === "idempotency-key" || normalizedKey === "x-idempotency-key";
    if (currentIsIdempotencyHeader && typeof current.value === "string") {
      if (current.value.trim() === "") idempotencyHeaderMissingValue = true;
      else hasIdempotencyHeader = true;
    }
    if (current.value && typeof current.value === "object" && !Array.isArray(current.value)) {
      const record = current.value as Record<string, unknown>;
      const headerName = [record.name, record.key].find(
        (candidate): candidate is string => typeof candidate === "string",
      );
      const normalizedHeaderName = headerName?.toLowerCase().replace(/[_\s]/g, "-");
      if (
        normalizedHeaderName === "idempotency-key" ||
        normalizedHeaderName === "x-idempotency-key"
      ) {
        if (typeof record.value === "string" && record.value.trim() !== "") {
          hasIdempotencyHeader = true;
        } else {
          idempotencyHeaderMissingValue = true;
        }
      }
      // n8n's canonical parameter-entry shape stores the secret-indicating name in a
      // sibling `name`/`key` field and the literal in `value`
      // (e.g. headerParameters.parameters: [{ name: "Authorization", value: "Bearer ..." }]).
      if (
        headerName !== undefined &&
        secretKey.test(headerName) &&
        typeof record.value === "string" &&
        isLiteralSecretValue(record.value)
      ) {
        literalSecretCount += 1;
      }
    }
    if (
      typeof current.value === "string" &&
      secretKey.test(current.key) &&
      isLiteralSecretValue(current.value)
    ) {
      literalSecretCount += 1;
    }
    if (typeof current.value === "string" && current.value.includes("$")) {
      const patterns = [
        /\$node\[\s*["']([^"']{1,200})["']\s*\]/g,
        /\$items\(\s*["']([^"']{1,200})["']/g,
        /\$\(\s*["']([^"']{1,200})["']\s*\)/g,
      ];
      for (const pattern of patterns) {
        for (const match of current.value.matchAll(pattern)) {
          const reference = match[1];
          if (reference !== undefined) references.add(reference);
        }
      }
    }
    if (!current.value || typeof current.value !== "object" || seen.has(current.value)) continue;
    seen.add(current.value);
    const children: [string, unknown][] = Array.isArray(current.value)
      ? current.value.map((child, index) => [String(index), child] as const)
      : Object.entries(current.value as Record<string, unknown>);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const entry = children[index];
      if (entry === undefined) continue;
      const [key, child] = entry;
      stack.push({ key, value: child });
    }
  }

  return {
    references: [...references],
    hasIdempotencyHeader,
    idempotencyHeaderMissingValue,
    literalSecretCount,
    complete: stack.length === 0,
  };
}

function literalSubworkflowId(node: WorkflowNode): string | undefined {
  if (node.type !== "n8n-nodes-base.executeWorkflow") return undefined;
  const raw = node.parameters?.workflowId;
  if (typeof raw === "string") return raw.startsWith("=") ? undefined : raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>).value;
    if (typeof value === "string" && !value.startsWith("=")) return value;
  }
  return undefined;
}

function safeNodeType(type: string | undefined): string | undefined {
  if (!type || type.length > 160 || !/^[A-Za-z0-9_.@/-]+$/.test(type)) return undefined;
  return type;
}

function reduceHttpMethod(
  value: unknown,
): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OTHER" | undefined {
  if (typeof value !== "string") return undefined;
  const method = value.toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)
    ? (method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
    : "OTHER";
}

function timezoneState(value: unknown): "absent" | "valid" | "invalid" {
  if (value === undefined || value === "") return "absent";
  if (typeof value !== "string" || value.length > 100) return "invalid";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return "valid";
  } catch {
    return "invalid";
  }
}

function reduceWorkflow(raw: WorkflowResponse, input: EffectiveIntrospectInput): ReducedWorkflow {
  if (raw.id !== input.workflowId) {
    throw new IntrospectCollectionError(
      "invalid_schema",
      "The workflow response ID did not match the request.",
    );
  }

  const firstIndexByName = new Map<string, number>();
  let duplicateNames = 0;
  raw.nodes.forEach((node, index) => {
    if (firstIndexByName.has(node.name)) duplicateNames += 1;
    else firstIndexByName.set(node.name, index);
  });

  const nodes = raw.nodes.map((node, index) => {
    const parameterFacts = analyzeParameters(node.parameters);
    const references = parameterFacts.references;
    const target = literalSubworkflowId(node);
    const type = safeNodeType(node.type);
    const label = optionalLabel(node.name, input.includeSanitizedLabels);
    const httpMethod =
      type === "n8n-nodes-base.httpRequest" ? reduceHttpMethod(node.parameters?.method) : undefined;
    let subworkflowTarget: "not_applicable" | "self" | "other" | "dynamic_or_missing" =
      "not_applicable";
    if (type === "n8n-nodes-base.executeWorkflow") {
      subworkflowTarget =
        target === undefined
          ? "dynamic_or_missing"
          : target === input.workflowId
            ? "self"
            : "other";
    }
    return {
      ref: `node-${index + 1}`,
      ...(label ? { label } : {}),
      ...(type ? { type } : {}),
      ...(node.typeVersion !== undefined ? { typeVersion: node.typeVersion } : {}),
      disabled: node.disabled === true,
      retryOnFail: node.retryOnFail === true,
      ...(node.maxTries !== undefined ? { maxTries: node.maxTries } : {}),
      ...(node.waitBetweenTries !== undefined ? { waitBetweenTries: node.waitBetweenTries } : {}),
      continueOnFail: node.continueOnFail === true,
      ...(node.onError === undefined ? {} : { onError: node.onError }),
      webhookResponseMode:
        type === "n8n-nodes-base.webhook" && node.parameters?.responseMode === "responseNode",
      exactExpressionReferenceCount: references.length,
      missingExpressionReferenceCount: references.filter((name) => !firstIndexByName.has(name))
        .length,
      parameterScanComplete: parameterFacts.complete,
      subworkflowTarget,
      ...(httpMethod === undefined ? {} : { httpMethod }),
      hasIdempotencyHeader: parameterFacts.hasIdempotencyHeader,
      idempotencyHeaderMissingValue: parameterFacts.idempotencyHeaderMissingValue,
      literalSecretCount: parameterFacts.literalSecretCount,
    };
  });

  const edges: Array<{ sourceIndex: number; targetIndex: number }> = [];
  let invalidEdges = 0;
  let danglingSources = 0;
  let danglingTargets = 0;
  for (const [sourceName, outputGroups] of Object.entries(raw.connections)) {
    const sourceIndex = firstIndexByName.get(sourceName);
    if (sourceIndex === undefined) {
      danglingSources += 1;
      continue;
    }
    if (!outputGroups || typeof outputGroups !== "object" || Array.isArray(outputGroups)) {
      invalidEdges += 1;
      continue;
    }
    for (const branches of Object.values(outputGroups as Record<string, unknown>)) {
      if (!Array.isArray(branches)) {
        invalidEdges += 1;
        continue;
      }
      for (const branch of branches) {
        if (!Array.isArray(branch)) {
          invalidEdges += 1;
          continue;
        }
        for (const rawTarget of branch) {
          if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
            invalidEdges += 1;
            continue;
          }
          const targetRecord = rawTarget as Record<string, unknown>;
          if (
            typeof targetRecord.node !== "string" ||
            (targetRecord.index !== undefined &&
              (!Number.isInteger(targetRecord.index) || (targetRecord.index as number) < 0)) ||
            (targetRecord.type !== undefined && typeof targetRecord.type !== "string")
          ) {
            invalidEdges += 1;
            continue;
          }
          const targetIndex = firstIndexByName.get(targetRecord.node);
          if (targetIndex === undefined) {
            danglingTargets += 1;
            continue;
          }
          edges.push({ sourceIndex, targetIndex });
        }
      }
    }
  }

  const errorWorkflow = raw.settings.errorWorkflow;
  const label = optionalLabel(raw.name, input.includeSanitizedLabels);
  return {
    id: input.workflowId,
    ...(label ? { label } : {}),
    active: raw.active,
    ...(raw.triggerCount !== undefined ? { triggerCount: raw.triggerCount } : {}),
    nodes,
    edges,
    graph: { duplicateNames, invalidEdges, danglingSources, danglingTargets },
    settings: {
      errorWorkflowConfigured: typeof errorWorkflow === "string" && errorWorkflow !== "",
      errorWorkflowSelfReference: errorWorkflow === input.workflowId,
      timezone: timezoneState(raw.settings.timezone),
      saveErrorDataDisabled: raw.settings.saveDataErrorExecution === "none",
    },
  };
}

function nodeMaps(nodes: ReadonlyArray<WorkflowNode>, includeLabels: boolean) {
  const byName = new Map<string, { ref: string; label?: string }>();
  nodes.forEach((node, index) => {
    if (!byName.has(node.name)) {
      const label = optionalLabel(node.name, includeLabels);
      byName.set(node.name, {
        ref: `node-${index + 1}`,
        ...(label === undefined ? {} : { label }),
      });
    }
  });
  return byName;
}

function reduceDetail(
  raw: z.output<typeof ExecutionDetailResponseSchema>,
  nodes: ReadonlyArray<WorkflowNode>,
  includeLabels: boolean,
): ReducedExecutionDetail {
  const references = nodeMaps(nodes, includeLabels);
  const data = raw.data;
  const resultData =
    data && typeof data.resultData === "object" && data.resultData !== null
      ? (data.resultData as Record<string, unknown>)
      : undefined;
  const lastNodeName =
    typeof resultData?.lastNodeExecuted === "string" ? resultData.lastNodeExecuted : undefined;
  const lastNode = lastNodeName ? references.get(lastNodeName) : undefined;
  const error = resultData?.error;
  const timings: Array<{ nodeRef: string; label?: string; executionTimeMs: number }> = [];
  const runData =
    resultData && typeof resultData.runData === "object" && resultData.runData !== null
      ? (resultData.runData as Record<string, unknown>)
      : undefined;

  if (runData) {
    for (const [nodeName, runs] of Object.entries(runData)) {
      if (!Array.isArray(runs)) continue;
      const node = references.get(nodeName);
      if (!node) continue;
      for (const run of runs) {
        if (!run || typeof run !== "object") continue;
        const executionTime = (run as Record<string, unknown>).executionTime;
        if (
          typeof executionTime !== "number" ||
          !Number.isFinite(executionTime) ||
          executionTime < 0
        )
          continue;
        timings.push({
          nodeRef: node.ref,
          ...(node.label ? { label: node.label } : {}),
          executionTimeMs: executionTime,
        });
      }
    }
  }

  const redactionInfo =
    data && typeof data.redactionInfo === "object" && data.redactionInfo !== null
      ? (data.redactionInfo as Record<string, unknown>)
      : undefined;
  const errorFingerprint = fingerprintError(error, lastNode?.ref);

  return {
    status: normalizeStatus(raw.status),
    ...(lastNode ? { lastNodeRef: lastNode.ref } : {}),
    ...(lastNode?.label ? { lastNodeLabel: lastNode.label } : {}),
    ...(errorFingerprint ? { errorFingerprint } : {}),
    nodeTimings: timings,
    redactionObserved: redactionInfo?.isRedacted === true,
  };
}

function selectDetails(executions: ReadonlyArray<CollectedExecution>): CollectedExecution[] {
  const newestFirst = [...executions].sort(
    (left, right) =>
      (timestampMs(right.startedAt) ?? 0) - (timestampMs(left.startedAt) ?? 0) ||
      compareCodeUnits(left.id, right.id),
  );
  const errors = newestFirst.filter((execution) => execution.status === "error").slice(0, 3);
  const slowSuccess = newestFirst
    .filter(
      (execution) => execution.status === "success" && executionDuration(execution) !== undefined,
    )
    .sort(
      (left, right) =>
        (executionDuration(right) ?? 0) - (executionDuration(left) ?? 0) ||
        compareCodeUnits(left.id, right.id),
    )[0];
  const selected = slowSuccess ? [...errors, slowSuccess] : errors;
  const seen = new Set<string>();
  return selected
    .filter((execution) => {
      if (seen.has(execution.id)) return false;
      seen.add(execution.id);
      return true;
    })
    .slice(0, 4);
}

export async function collectSnapshot(
  client: N8nReadClient,
  input: EffectiveIntrospectInput,
): Promise<IntrospectSnapshot> {
  const profileBudget = PROFILE_BUDGETS[input.profile];
  const maximumRequests =
    profileBudget.workflowRequests + profileBudget.listPages + profileBudget.detailRequests;
  const requestTimeoutMs = Math.min(
    profileBudget.requestTimeoutMs,
    Math.floor(profileBudget.totalDeadlineMs / maximumRequests),
  );
  let acceptedBytes = 0;
  let pages = 0;
  let detailRequests = 0;
  let status: "complete" | "partial" = "complete";
  const limitations: Array<{ code: IntrospectLimitationCode; message: string }> = [];

  const read = async (
    endpoint: string,
    query: Readonly<Record<string, string>>,
    perResponseBytes: number,
  ) => {
    const remainingBytes = profileBudget.totalBytes - acceptedBytes;
    if (remainingBytes <= 0) {
      throw new IntrospectCollectionError(
        "response_too_large",
        "The total response budget was exhausted.",
      );
    }
    const result = await client.get(endpoint, query, {
      maxBytes: Math.min(perResponseBytes, remainingBytes),
      timeoutMs: requestTimeoutMs,
    });
    if (result.bytes < 0 || result.bytes > Math.min(perResponseBytes, remainingBytes)) {
      throw new IntrospectCollectionError(
        "response_too_large",
        "The response reader exceeded its assigned byte limit.",
      );
    }
    acceptedBytes += result.bytes;
    return result;
  };

  const workflowRead = await read(
    `/workflows/${encodeURIComponent(input.workflowId)}`,
    // Exclude pinned data: Introspect never reads pinData, and including it can push
    // an otherwise small workflow past the bounded byte cap and hard-fail the tool.
    { excludePinnedData: "true" },
    profileBudget.workflowBytes,
  );
  const rawWorkflow = parseOrThrow(WorkflowResponseSchema, workflowRead.value);
  const workflow = reduceWorkflow(rawWorkflow, input);

  const collected: CollectedExecution[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let nextCursor: string | null | undefined;
  let lookbackReached = false;
  let pageFailure = false;
  let cutoff: number | undefined;

  for (
    let page = 0;
    page < profileBudget.listPages && collected.length < input.maxExecutions;
    page += 1
  ) {
    const remaining = input.maxExecutions - collected.length;
    const query: Record<string, string> = {
      workflowId: input.workflowId,
      includeData: "false",
      limit: String(Math.min(25, remaining)),
    };
    if (cursor) query.cursor = cursor;

    try {
      const pageRead = await read("/executions", query, profileBudget.listBytes);
      const parsed = parseOrThrow(ExecutionListResponseSchema, pageRead.value);
      pages += 1;
      collected.push(...parsed.data.slice(0, remaining).map(reduceExecution));
      nextCursor = parsed.nextCursor;

      const currentOrdering = assessOrdering(collected);
      const validTimes = collected
        .map((execution) => timestampMs(execution.startedAt))
        .filter((value): value is number => value !== undefined);
      if (cutoff === undefined && validTimes.length > 0) {
        cutoff = Math.max(...validTimes) - input.lookbackHours * 60 * 60 * 1_000;
      }
      const activeCutoff = cutoff;
      if (
        currentOrdering === "verified_newest_first" &&
        activeCutoff !== undefined &&
        validTimes.some((value) => value < activeCutoff)
      ) {
        lookbackReached = true;
        break;
      }
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor)) {
        status = "partial";
        limitations.push(limitation("repeated_cursor"));
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } catch (error) {
      if (page === 0) throw error;
      status = "partial";
      pageFailure = true;
      const code = errorCode(error);
      if (code === undefined) throw error;
      limitations.push(limitation(code === "upstream_http_error" ? "page_failed" : code));
      break;
    }
  }

  const ordering = assessOrdering(collected);
  if (ordering === "unreliable") {
    status = "partial";
    limitations.push(limitation("ordering_unreliable"));
  }

  const invalidTimestampCount = collected.filter(
    (execution) => timestampMs(execution.startedAt) === undefined,
  ).length;
  if (invalidTimestampCount > 0) {
    status = "partial";
    limitations.push(limitation("invalid_timestamp"));
  }

  const executionsWithId = collected.filter((execution) => {
    const time = timestampMs(execution.startedAt);
    return time !== undefined && cutoff !== undefined && time >= cutoff;
  });
  const executions: ReducedExecutionMetadata[] = executionsWithId.map(
    ({ id: _id, ...execution }) => execution,
  );
  const validSampleTimes = executions
    .map((execution) => timestampMs(execution.startedAt))
    .filter((value): value is number => value !== undefined);

  let historyBoundary: HistoryBoundary;
  if (ordering === "unreliable") historyBoundary = "ordering_unreliable";
  else if (ordering === "unknown" && collected.length > 0) historyBoundary = "unknown";
  else if (lookbackReached) historyBoundary = "lookback_reached";
  else if (!nextCursor) historyBoundary = "complete";
  else if (collected.length >= input.maxExecutions) historyBoundary = "execution_limited";
  else if (pageFailure || pages >= profileBudget.listPages) historyBoundary = "request_limited";
  else historyBoundary = "unknown";

  const details: ReducedExecutionDetail[] = [];
  if (input.profile === "deep") {
    for (const execution of selectDetails(executionsWithId)) {
      if (detailRequests >= profileBudget.detailRequests) break;
      if (!safeExecutionId(execution.id)) {
        status = "partial";
        limitations.push(limitation("invalid_execution_id"));
        continue;
      }
      detailRequests += 1;
      try {
        const detailRead = await read(
          `/executions/${encodeURIComponent(execution.id)}`,
          {
            includeData: "true",
            redactExecutionData: "true",
            ignoreDataSizeLimit: "false",
          },
          profileBudget.detailBytes,
        );
        const parsed = parseOrThrow(ExecutionDetailResponseSchema, detailRead.value);
        details.push(reduceDetail(parsed, rawWorkflow.nodes, input.includeSanitizedLabels));
      } catch (error) {
        status = "partial";
        const code = errorCode(error);
        if (code === undefined) throw error;
        limitations.push(limitation(code === "upstream_http_error" ? "detail_failed" : code));
        if (code === "deadline_exceeded" || code === "response_too_large") break;
      }
    }
  }

  return {
    input,
    workflow,
    executions,
    details,
    status,
    pages,
    detailRequests,
    acceptedBytes,
    ordering,
    historyBoundary,
    oldestStartedAt:
      validSampleTimes.length > 0 ? new Date(Math.min(...validSampleTimes)).toISOString() : null,
    newestStartedAt:
      validSampleTimes.length > 0 ? new Date(Math.max(...validSampleTimes)).toISOString() : null,
    totalMetadataExecutions: collected.length,
    sampledErrors: executions.filter((execution) => execution.status === "error").length,
    limitations,
  };
}
