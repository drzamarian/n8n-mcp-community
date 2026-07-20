import { Buffer } from "node:buffer";
import { PROFILE_BUDGETS, collectSnapshot } from "./collector.js";
import {
  INTROSPECT_ENGINE_VERSION,
  INTROSPECT_SCHEMA_VERSION,
  IntrospectInputSchema,
  IntrospectResultSchema,
  resolveIntrospectInput,
  type Finding,
  type IntrospectLimitationCode,
  type IntrospectResult,
  type N8nReadClient,
  type RuleCoverage,
} from "./contracts.js";
import { computeMetrics, evaluateRules } from "./rules.js";

export class IntrospectInputError extends Error {
  readonly code = "invalid_input";

  constructor(message = "The Introspect input is invalid.") {
    super(message);
    this.name = "IntrospectInputError";
  }
}

export class IntrospectOutputError extends Error {
  readonly code = "invalid_output";

  constructor(message = "The Introspect result could not be represented safely.") {
    super(message);
    this.name = "IntrospectOutputError";
  }
}

function findingCounts(findings: ReadonlyArray<Finding>) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  findings.forEach((finding) => {
    counts[finding.severity] += 1;
  });
  return counts;
}

function ruleOutcomeCounts(coverage: ReadonlyArray<RuleCoverage>) {
  const counts = {
    triggered: 0,
    passed: 0,
    notApplicable: 0,
    inconclusive: 0,
    partiallyInconclusive: 0,
  };
  coverage.forEach((record) => {
    if (record.outcome === "not_applicable") counts.notApplicable += 1;
    else counts[record.outcome] += 1;
    if (record.partiallyInconclusive) counts.partiallyInconclusive += 1;
  });
  return counts;
}

function findingDisclosure(coverage: ReadonlyArray<RuleCoverage>, retainedCount: number) {
  const totalCount = coverage.reduce((sum, record) => sum + record.totalFindingCount, 0);
  return {
    totalCount,
    retainedCount,
    omittedCount: totalCount - retainedCount,
    truncated: totalCount > retainedCount,
  };
}

function synchronizeFindingDisclosure(result: IntrospectResult): void {
  const retainedByRule = new Map<string, number>();
  for (const finding of result.findings) {
    retainedByRule.set(finding.ruleId, (retainedByRule.get(finding.ruleId) ?? 0) + 1);
  }
  for (const record of result.ruleCoverage) {
    record.findingCount = retainedByRule.get(record.ruleId) ?? 0;
    record.omittedFindingCount = record.totalFindingCount - record.findingCount;
  }
  result.summary.findingCounts = findingCounts(result.findings);
  result.summary.findings = findingDisclosure(result.ruleCoverage, result.findings.length);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function addLimitation(
  limitations: Array<{ code: IntrospectLimitationCode; message: string }>,
  code: IntrospectLimitationCode,
  message: string,
): void {
  if (!limitations.some((item) => item.code === code)) limitations.push({ code, message });
}

function retainLargestPrefix<T>(items: T[], fits: () => boolean): void {
  const original = [...items];
  let low = 0;
  let high = original.length;
  let best = 0;
  const setLength = (length: number) => {
    items.length = 0;
    for (const item of original.slice(0, length)) items.push(item);
  };

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    setLength(middle);
    if (fits()) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  setLength(best);
}

export function fitStructuredResult(result: IntrospectResult): IntrospectResult {
  const limit = PROFILE_BUDGETS[result.profile].structuredOutputBytes;
  if (jsonBytes(result) <= limit) return result;

  const reduced: IntrospectResult = structuredClone(result);
  reduced.status = "partial";
  addLimitation(
    reduced.limitations,
    "output_limit",
    "The report was reduced to remain within the immutable output byte limit.",
  );

  const synchronizedResultFits = () => {
    synchronizeFindingDisclosure(reduced);
    return jsonBytes(reduced) <= limit;
  };

  retainLargestPrefix(reduced.metrics.perNodeTimings, synchronizedResultFits);
  if (!synchronizedResultFits()) {
    retainLargestPrefix(reduced.metrics.errorClusters, synchronizedResultFits);
  }
  if (!synchronizedResultFits()) {
    retainLargestPrefix(reduced.findings, synchronizedResultFits);
  }

  if (!synchronizedResultFits()) {
    throw new IntrospectOutputError("The fixed Introspect contract exceeds its output budget.");
  }
  // A mismatch here is an internal engine invariant failure, never upstream n8n shape drift.
  const fitted = IntrospectResultSchema.safeParse(reduced);
  if (!fitted.success) throw new IntrospectOutputError();
  return fitted.data;
}

export async function inspectWorkflow(
  client: N8nReadClient,
  rawInput: unknown,
): Promise<IntrospectResult> {
  const parsedInput = IntrospectInputSchema.safeParse(rawInput);
  if (!parsedInput.success) throw new IntrospectInputError();
  const input = resolveIntrospectInput(parsedInput.data);
  const snapshot = await collectSnapshot(client, input);
  const evaluation = evaluateRules(snapshot);
  const metrics = computeMetrics(snapshot);
  const limitations: Array<{ code: IntrospectLimitationCode; message: string }> = [];
  snapshot.limitations.forEach((item) => addLimitation(limitations, item.code, item.message));

  if (evaluation.truncatedRuleIds.length > 0) {
    addLimitation(
      limitations,
      "finding_limit",
      "One or more rules produced more occurrences than the immutable output cap allows.",
    );
  }
  if (input.includeSanitizedLabels) {
    addLimitation(
      limitations,
      "label_redaction_limit",
      "Pattern redaction cannot recognize every sensitive proper name; opaque identifiers remain authoritative.",
    );
  }

  // The assembled result is a local invariant: a mismatch is an internal output failure
  // (invalid_output), never upstream n8n response-shape drift.
  const assembled = IntrospectResultSchema.safeParse({
    schemaVersion: INTROSPECT_SCHEMA_VERSION,
    engineVersion: INTROSPECT_ENGINE_VERSION,
    status:
      snapshot.status === "partial" || evaluation.truncatedRuleIds.length > 0
        ? "partial"
        : "complete",
    profile: input.profile,
    workflow: {
      id: snapshot.workflow.id,
      ...(snapshot.workflow.label ? { label: snapshot.workflow.label } : {}),
      active: snapshot.workflow.active,
      nodeCount: snapshot.workflow.nodes.length,
    },
    sample: {
      lookbackHours: input.lookbackHours,
      maxExecutions: input.maxExecutions,
      metadataExecutions: snapshot.totalMetadataExecutions,
      eligibleExecutions:
        metrics.statusCounts.success + metrics.statusCounts.error + metrics.statusCounts.crashed,
      pages: snapshot.pages,
      detailRequests: snapshot.detailRequests,
      sampledErrors: snapshot.sampledErrors,
      acceptedBytes: snapshot.acceptedBytes,
      ordering: snapshot.ordering,
      historyBoundary: snapshot.historyBoundary,
      oldestStartedAt: snapshot.oldestStartedAt,
      newestStartedAt: snapshot.newestStartedAt,
    },
    summary: {
      findingCounts: findingCounts(evaluation.findings),
      ruleOutcomes: ruleOutcomeCounts(evaluation.coverage),
      findings: findingDisclosure(evaluation.coverage, evaluation.findings.length),
    },
    metrics,
    findings: evaluation.findings,
    ruleCoverage: evaluation.coverage,
    limitations,
    guidance: {
      instanceSecurityTool: "n8n_audit_generate",
      message:
        "Use n8n_audit_generate for instance-wide security facts; this report inspects one saved workflow and a bounded execution sample.",
    },
  });
  if (!assembled.success) throw new IntrospectOutputError();

  return fitStructuredResult(assembled.data);
}
