import { Buffer } from "node:buffer";
import { PROFILE_BUDGETS } from "./collector.js";
import type { IntrospectResult } from "./contracts.js";
import { IntrospectOutputError } from "./engine.js";

export interface RenderedIntrospect {
  summary: string;
  json: string;
  combinedBytes: number;
}

function percentage(value: number | null): string {
  return value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

export function renderIntrospect(result: IntrospectResult): RenderedIntrospect {
  const counts = result.summary.findingCounts;
  const outcomes = result.summary.ruleOutcomes;
  const summary = [
    `n8n workflow Introspect ${result.status}: ${result.workflow.id}.`,
    `Profile ${result.profile}; ${result.sample.metadataExecutions} metadata executions; ${result.sample.detailRequests} detail requests.`,
    `Findings: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} info.`,
    `Rule outcomes: ${outcomes.inconclusive} inconclusive, ${outcomes.partiallyInconclusive} partially inconclusive; limitations: ${result.limitations.length}.`,
    `Observed success rate: ${percentage(result.metrics.successRate)}.`,
    `Ordering: ${result.sample.ordering}; history boundary: ${result.sample.historyBoundary}.`,
    "The following JSON is the authoritative machine-readable report.",
  ].join(" ");
  const json = JSON.stringify(result);
  const combinedBytes = Buffer.byteLength(summary, "utf8") + Buffer.byteLength(json, "utf8") * 2;
  if (combinedBytes > PROFILE_BUDGETS[result.profile].combinedOutputBytes) {
    throw new IntrospectOutputError(
      "The rendered Introspect report exceeds its combined output budget.",
    );
  }
  return { summary, json, combinedBytes };
}
