import assert from "node:assert/strict";
import test from "node:test";
import { isOfficialN8nDocumentationUrl } from "../src/content/official-urls.js";
import type {
  IntrospectSnapshot,
  ReducedExecutionDetail,
  ReducedExecutionMetadata,
  ReducedWorkflowNode,
} from "../src/introspect/contracts.js";
import { FindingSchema } from "../src/introspect/contracts.js";
import { INTROSPECT_RULE_IDS } from "../src/introspect/rule-ids.js";
import { RULE_REGISTRY, computeMetrics, evaluateRules } from "../src/introspect/rules.js";

function node(overrides: Partial<ReducedWorkflowNode> = {}): ReducedWorkflowNode {
  return {
    ref: "node-1",
    type: "n8n-nodes-base.set",
    typeVersion: 1,
    disabled: false,
    retryOnFail: false,
    continueOnFail: false,
    webhookResponseMode: false,
    exactExpressionReferenceCount: 0,
    missingExpressionReferenceCount: 0,
    parameterScanComplete: true,
    subworkflowTarget: "not_applicable",
    hasIdempotencyHeader: false,
    idempotencyHeaderMissingValue: false,
    literalSecretCount: 0,
    ...overrides,
  };
}

function execution(
  status: ReducedExecutionMetadata["status"],
  index = 0,
  durationMs = 1_000,
  mode = "trigger",
  waitObserved = false,
): ReducedExecutionMetadata {
  const started = Date.parse("2026-07-17T12:00:00.000Z") - index * 60_000;
  return {
    status,
    mode,
    startedAt: new Date(started).toISOString(),
    stoppedAt: new Date(started + durationMs).toISOString(),
    waitObserved,
  };
}

function snapshot(overrides: Partial<IntrospectSnapshot> = {}): IntrospectSnapshot {
  return {
    input: {
      workflowId: "workflow-1",
      profile: "quick",
      lookbackHours: 24,
      maxExecutions: 20,
      includeSanitizedLabels: false,
    },
    workflow: {
      id: "workflow-1",
      active: false,
      triggerCount: 1,
      nodes: [node({ ref: "node-1", type: "n8n-nodes-base.manualTrigger" })],
      edges: [],
      graph: { duplicateNames: 0, invalidEdges: 0, danglingSources: 0, danglingTargets: 0 },
      settings: {
        errorWorkflowConfigured: false,
        errorWorkflowSelfReference: false,
        timezone: "valid",
        saveErrorDataDisabled: false,
      },
    },
    executions: [execution("success")],
    details: [],
    status: "complete",
    pages: 1,
    detailRequests: 0,
    acceptedBytes: 100,
    ordering: "verified_newest_first",
    historyBoundary: "complete",
    oldestStartedAt: "2026-07-17T12:00:00.000Z",
    newestStartedAt: "2026-07-17T12:00:00.000Z",
    totalMetadataExecutions: 1,
    sampledErrors: 0,
    limitations: [],
    ...overrides,
  };
}

function workflowSnapshot(
  nodes: ReducedWorkflowNode[],
  edges: Array<{ sourceIndex: number; targetIndex: number }> = [],
  graph: Partial<IntrospectSnapshot["workflow"]["graph"]> = {},
): IntrospectSnapshot {
  const base = snapshot();
  return {
    ...base,
    workflow: {
      ...base.workflow,
      nodes,
      edges,
      graph: { ...base.workflow.graph, ...graph },
    },
  };
}

function settingsSnapshot(
  settings: Partial<IntrospectSnapshot["workflow"]["settings"]>,
  active = true,
): IntrospectSnapshot {
  const base = snapshot();
  return {
    ...base,
    workflow: { ...base.workflow, active, settings: { ...base.workflow.settings, ...settings } },
  };
}

function outcome(ruleId: string, value: IntrospectSnapshot): string {
  const record = evaluateRules(value).coverage.find((item) => item.ruleId === ruleId);
  assert.ok(record, `missing coverage for ${ruleId}`);
  return record.outcome;
}

interface RuleCase {
  id: string;
  positive: IntrospectSnapshot;
  negative: IntrospectSnapshot;
  counterexample: IntrospectSnapshot;
  negativeOutcome?: string;
  counterexampleOutcome?: string;
}

const trigger = node({ ref: "node-1", type: "n8n-nodes-base.manualTrigger" });
const regular = node({ ref: "node-2" });
const webhook = node({ ref: "node-1", type: "n8n-nodes-base.webhook", webhookResponseMode: true });
const responseNode = node({ ref: "node-2", type: "n8n-nodes-base.respondToWebhook" });
const nodeWithoutTypeVersion = node();
delete nodeWithoutTypeVersion.typeVersion;

const repeatedDetails: ReducedExecutionDetail[] = [
  {
    status: "error",
    errorFingerprint: "0123456789abcdef",
    nodeTimings: [],
    redactionObserved: true,
  },
  {
    status: "error",
    errorFingerprint: "0123456789abcdef",
    nodeTimings: [],
    redactionObserved: true,
  },
];

const ruleCases: RuleCase[] = [
  {
    id: "GRAPH_DANGLING_SOURCE",
    positive: workflowSnapshot([trigger], [], { danglingSources: 1 }),
    negative: workflowSnapshot([trigger]),
    counterexample: workflowSnapshot([trigger], [], { danglingTargets: 1 }),
  },
  {
    id: "GRAPH_DANGLING_TARGET",
    positive: workflowSnapshot([trigger], [], { danglingTargets: 1 }),
    negative: workflowSnapshot([trigger]),
    counterexample: workflowSnapshot([trigger], [], { danglingSources: 1 }),
  },
  {
    id: "GRAPH_INVALID_EDGE",
    positive: workflowSnapshot([trigger], [], { invalidEdges: 1 }),
    negative: workflowSnapshot([trigger]),
    counterexample: workflowSnapshot([trigger], [], { danglingTargets: 1 }),
  },
  {
    id: "GRAPH_DISABLED_CONNECTED_NODE",
    positive: workflowSnapshot(
      [trigger, node({ ref: "node-2", disabled: true })],
      [{ sourceIndex: 0, targetIndex: 1 }],
    ),
    negative: workflowSnapshot([node({ disabled: true })]),
    counterexample: workflowSnapshot([trigger]),
    counterexampleOutcome: "not_applicable",
  },
  {
    id: "GRAPH_UNREACHABLE_NODE",
    positive: workflowSnapshot([trigger, regular]),
    negative: workflowSnapshot([trigger, regular], [{ sourceIndex: 0, targetIndex: 1 }]),
    counterexample: workflowSnapshot([regular]),
    counterexampleOutcome: "not_applicable",
  },
  {
    id: "GRAPH_CYCLE_WITHOUT_KNOWN_CONTROL",
    positive: workflowSnapshot(
      [node({ ref: "node-1" }), node({ ref: "node-2", type: "n8n-nodes-base.if" })],
      [
        { sourceIndex: 0, targetIndex: 1 },
        { sourceIndex: 1, targetIndex: 0 },
      ],
    ),
    negative: workflowSnapshot(
      [node({ ref: "node-1", type: "n8n-nodes-base.splitInBatches", typeVersion: 3 }), regular],
      [
        { sourceIndex: 0, targetIndex: 1 },
        { sourceIndex: 1, targetIndex: 0 },
      ],
    ),
    counterexample: workflowSnapshot(
      [node({ ref: "node-1", type: "community.unverified" }), regular],
      [
        { sourceIndex: 0, targetIndex: 1 },
        { sourceIndex: 1, targetIndex: 0 },
      ],
    ),
    counterexampleOutcome: "inconclusive",
  },
  {
    id: "CONTRACT_WEBHOOK_RESPONSE_MISSING",
    positive: workflowSnapshot([webhook]),
    negative: workflowSnapshot([webhook, responseNode], [{ sourceIndex: 0, targetIndex: 1 }]),
    counterexample: workflowSnapshot([
      node({ type: "n8n-nodes-base.webhook", webhookResponseMode: false }),
    ]),
    counterexampleOutcome: "not_applicable",
  },
  {
    id: "CONTRACT_WEBHOOK_RESPONSE_ORPHAN",
    positive: workflowSnapshot([webhook, responseNode]),
    negative: workflowSnapshot([webhook, responseNode], [{ sourceIndex: 0, targetIndex: 1 }]),
    counterexample: workflowSnapshot([responseNode]),
    counterexampleOutcome: "not_applicable",
  },
  {
    id: "CONTRACT_EXPRESSION_MISSING_NODE",
    positive: workflowSnapshot([
      node({ exactExpressionReferenceCount: 1, missingExpressionReferenceCount: 1 }),
    ]),
    negative: workflowSnapshot([
      node({ exactExpressionReferenceCount: 1, missingExpressionReferenceCount: 0 }),
    ]),
    counterexample: workflowSnapshot([node()]),
    counterexampleOutcome: "not_applicable",
  },
  {
    id: "CONTRACT_SUBWORKFLOW_SELF_REFERENCE",
    positive: workflowSnapshot([
      node({ type: "n8n-nodes-base.executeWorkflow", subworkflowTarget: "self" }),
    ]),
    negative: workflowSnapshot([
      node({ type: "n8n-nodes-base.executeWorkflow", subworkflowTarget: "other" }),
    ]),
    counterexample: workflowSnapshot([
      node({ type: "n8n-nodes-base.executeWorkflow", subworkflowTarget: "dynamic_or_missing" }),
    ]),
    counterexampleOutcome: "inconclusive",
  },
  {
    id: "WORKFLOW_ACTIVE_WITHOUT_TRIGGER",
    positive: {
      ...snapshot(),
      workflow: { ...snapshot().workflow, active: true, triggerCount: 0 },
    },
    negative: {
      ...snapshot(),
      workflow: { ...snapshot().workflow, active: true, triggerCount: 1 },
    },
    counterexample: {
      ...snapshot(),
      workflow: { ...snapshot().workflow, active: false, triggerCount: 0 },
    },
    counterexampleOutcome: "not_applicable",
  },
  {
    id: "WORKFLOW_ERROR_SELF_REFERENCE",
    positive: settingsSnapshot({ errorWorkflowConfigured: true, errorWorkflowSelfReference: true }),
    negative: settingsSnapshot({
      errorWorkflowConfigured: true,
      errorWorkflowSelfReference: false,
    }),
    counterexample: settingsSnapshot({
      errorWorkflowConfigured: false,
      errorWorkflowSelfReference: false,
    }),
    counterexampleOutcome: "not_applicable",
  },
  {
    id: "WORKFLOW_INVALID_TIMEZONE",
    positive: settingsSnapshot({ timezone: "invalid" }),
    negative: settingsSnapshot({ timezone: "valid" }),
    counterexample: settingsSnapshot({ timezone: "absent" }),
    counterexampleOutcome: "not_applicable",
  },
  {
    id: "WORKFLOW_ERROR_DATA_DISABLED",
    positive: settingsSnapshot({ saveErrorDataDisabled: true, errorWorkflowConfigured: false }),
    negative: settingsSnapshot({ saveErrorDataDisabled: true, errorWorkflowConfigured: true }),
    counterexample: settingsSnapshot({ saveErrorDataDisabled: true }, false),
    counterexampleOutcome: "not_applicable",
  },
  {
    id: "NODE_INVALID_TYPE_VERSION",
    positive: workflowSnapshot([node({ typeVersion: -1 })]),
    negative: workflowSnapshot([node({ typeVersion: 1 })]),
    counterexample: workflowSnapshot([nodeWithoutTypeVersion]),
    counterexampleOutcome: "inconclusive",
  },
  {
    id: "NODE_LEGACY_CONTINUE_ON_FAIL",
    positive: workflowSnapshot([node({ continueOnFail: true })]),
    negative: workflowSnapshot([]),
    counterexample: workflowSnapshot([
      node({ continueOnFail: true, onError: "continueRegularOutput" }),
    ]),
    negativeOutcome: "not_applicable",
    counterexampleOutcome: "not_applicable",
  },
  {
    id: "NODE_INVALID_RETRY_CONFIGURATION",
    positive: workflowSnapshot([node({ retryOnFail: true, maxTries: 0 })]),
    negative: workflowSnapshot([node({ retryOnFail: true, maxTries: 3, waitBetweenTries: 0 })]),
    counterexample: workflowSnapshot([node({ retryOnFail: false, maxTries: 0 })]),
    counterexampleOutcome: "not_applicable",
  },
  {
    id: "NODE_RETRY_SIDE_EFFECT",
    positive: workflowSnapshot([
      node({ type: "n8n-nodes-base.httpRequest", retryOnFail: true, httpMethod: "POST" }),
    ]),
    negative: workflowSnapshot([
      node({
        type: "n8n-nodes-base.httpRequest",
        retryOnFail: true,
        httpMethod: "POST",
        hasIdempotencyHeader: true,
        idempotencyHeaderMissingValue: false,
      }),
    ]),
    counterexample: workflowSnapshot([
      node({ type: "n8n-nodes-base.httpRequest", retryOnFail: true, httpMethod: "GET" }),
    ]),
    counterexampleOutcome: "not_applicable",
  },
  {
    id: "PRIVACY_LITERAL_SECRET",
    positive: workflowSnapshot([node({ literalSecretCount: 1 })]),
    negative: workflowSnapshot([node({ literalSecretCount: 0 })]),
    counterexample: workflowSnapshot([
      node({ parameterScanComplete: false, literalSecretCount: 0 }),
    ]),
    counterexampleOutcome: "inconclusive",
  },
  {
    id: "EXECUTION_FAILURE_STREAK",
    positive: {
      ...snapshot(),
      executions: [execution("error", 0), execution("error", 1), execution("error", 2)],
    },
    negative: {
      ...snapshot(),
      executions: [execution("error", 0), execution("error", 1), execution("success", 2)],
    },
    counterexample: {
      ...snapshot(),
      executions: [execution("error", 0), execution("error", 1), execution("error", 2)],
      ordering: "unreliable",
    },
    counterexampleOutcome: "inconclusive",
  },
  {
    id: "EXECUTION_REPEATED_ERROR",
    positive: {
      ...snapshot(),
      input: { ...snapshot().input, profile: "deep" },
      details: repeatedDetails,
      sampledErrors: 2,
    },
    negative: {
      ...snapshot(),
      input: { ...snapshot().input, profile: "deep" },
      details: [
        {
          status: "error",
          errorFingerprint: "0123456789abcdef",
          nodeTimings: [],
          redactionObserved: true,
        },
        {
          status: "error",
          errorFingerprint: "fedcba9876543210",
          nodeTimings: [],
          redactionObserved: true,
        },
      ],
      sampledErrors: 2,
    },
    counterexample: { ...snapshot(), details: repeatedDetails, sampledErrors: 2 },
    counterexampleOutcome: "inconclusive",
  },
  {
    id: "EXECUTION_DURATION_SHIFT",
    positive: {
      ...snapshot(),
      executions: Array.from({ length: 10 }, (_, index) =>
        execution("success", index, index < 5 ? 3_000 : 1_000),
      ),
    },
    negative: {
      ...snapshot(),
      executions: Array.from({ length: 10 }, (_, index) => execution("success", index, 1_000)),
    },
    counterexample: {
      ...snapshot(),
      executions: Array.from({ length: 10 }, (_, index) =>
        execution(
          "success",
          index,
          index < 5 ? 3_000 : 1_000,
          index < 5 ? "manual" : "trigger",
          false,
        ),
      ),
    },
    counterexampleOutcome: "inconclusive",
  },
  {
    id: "EXECUTION_CRASH_OBSERVED",
    positive: { ...snapshot(), executions: [execution("crashed")] },
    negative: { ...snapshot(), executions: [execution("success")] },
    counterexample: { ...snapshot(), executions: [execution("canceled"), execution("running", 1)] },
  },
];

test("the rule registry is unique, sorted, immutable, and contains exactly 23 rules", () => {
  const ids = RULE_REGISTRY.map((rule) => rule.id);
  assert.equal(ids.length, 23);
  assert.equal(new Set(ids).size, 23);
  assert.deepEqual(ids, [...ids].sort());
  assert.ok(Object.isFrozen(INTROSPECT_RULE_IDS));
  assert.ok(Object.isFrozen(RULE_REGISTRY));
  assert.ok(RULE_REGISTRY.every((rule) => Object.isFrozen(rule)));
  assert.deepEqual(ids, [...INTROSPECT_RULE_IDS]);
  assert.deepEqual(new Set(ruleCases.map((item) => item.id)), new Set(ids));
  for (const rule of RULE_REGISTRY) {
    if (rule.documentationUrl !== undefined) {
      assert.equal(
        isOfficialN8nDocumentationUrl(rule.documentationUrl),
        true,
        `${rule.id} must use an allowlisted official documentation URL`,
      );
    }
  }
});

for (const fixture of ruleCases) {
  test(`${fixture.id} positive fixture triggers`, () => {
    assert.equal(outcome(fixture.id, fixture.positive), "triggered");
  });
  test(`${fixture.id} negative fixture does not trigger`, () => {
    assert.equal(outcome(fixture.id, fixture.negative), fixture.negativeOutcome ?? "passed");
  });
  test(`${fixture.id} counterexample does not overreach`, () => {
    assert.equal(
      outcome(fixture.id, fixture.counterexample),
      fixture.counterexampleOutcome ?? "passed",
    );
  });
}

test("metrics use only terminal success, error, and crashed statuses in success rate", () => {
  const metrics = computeMetrics({
    ...snapshot(),
    executions: [
      execution("success", 0),
      execution("error", 1),
      execution("crashed", 2),
      execution("canceled", 3),
      execution("running", 4),
      execution("waiting", 5),
      execution("new", 6),
      execution("unknown", 7),
    ],
  });
  assert.equal(metrics.successRate, 1 / 3);
  assert.deepEqual(metrics.statusCounts, {
    success: 1,
    error: 1,
    crashed: 1,
    canceled: 1,
    running: 1,
    waiting: 1,
    new: 1,
    unknown: 1,
  });
});

test("empty and non-terminal history has a null success rate", () => {
  assert.equal(computeMetrics({ ...snapshot(), executions: [] }).successRate, null);
  assert.equal(
    computeMetrics({ ...snapshot(), executions: [execution("running")] }).successRate,
    null,
  );
});

test("duration percentiles use nearest rank and invalid durations are excluded", () => {
  const metrics = computeMetrics({
    ...snapshot(),
    executions: [
      execution("success", 0, 10),
      execution("success", 1, 20),
      execution("success", 2, 30),
      execution("success", 3, 40),
    ],
  });
  assert.equal(metrics.duration.p50Ms, 20);
  assert.equal(metrics.duration.p95Ms, 40);
  assert.equal(metrics.duration.p99Ms, 40);
});

test("bounded parameter scans are inconclusive instead of silently passing", () => {
  const incomplete = node({ parameterScanComplete: false });
  assert.equal(
    outcome("CONTRACT_EXPRESSION_MISSING_NODE", workflowSnapshot([incomplete])),
    "inconclusive",
  );
  assert.equal(outcome("PRIVACY_LITERAL_SECRET", workflowSnapshot([incomplete])), "inconclusive");
  assert.equal(
    outcome(
      "NODE_RETRY_SIDE_EFFECT",
      workflowSnapshot([
        node({
          type: "n8n-nodes-base.httpRequest",
          retryOnFail: true,
          httpMethod: "POST",
          parameterScanComplete: false,
        }),
      ]),
    ),
    "inconclusive",
  );
});

test("an idempotency header without a value remains inconclusive", () => {
  assert.equal(
    outcome(
      "NODE_RETRY_SIDE_EFFECT",
      workflowSnapshot([
        node({
          type: "n8n-nodes-base.httpRequest",
          retryOnFail: true,
          httpMethod: "POST",
          idempotencyHeaderMissingValue: true,
        }),
      ]),
    ),
    "inconclusive",
  );
});

test("mixed recognized and unrecognized cycles preserve an explicit inconclusive signal", () => {
  const value = workflowSnapshot(
    [
      node({ ref: "node-1" }),
      node({ ref: "node-2", type: "n8n-nodes-base.if" }),
      node({ ref: "node-3", type: "community.unverified" }),
      node({ ref: "node-4" }),
    ],
    [
      { sourceIndex: 0, targetIndex: 1 },
      { sourceIndex: 1, targetIndex: 0 },
      { sourceIndex: 2, targetIndex: 3 },
      { sourceIndex: 3, targetIndex: 2 },
    ],
  );
  const record = evaluateRules(value).coverage.find(
    (item) => item.ruleId === "GRAPH_CYCLE_WITHOUT_KNOWN_CONTROL",
  );
  assert.equal(record?.outcome, "triggered");
  assert.equal(record?.partiallyInconclusive, true);
  assert.equal(record?.detectedCycleCount, 2);
  assert.equal(record?.inconclusiveCycleCount, 1);
  assert.match(record?.reason ?? "", /additional cycle is inconclusive/);
});

test("fan-out and merge DAG is never classified as a directed cycle", () => {
  const value = workflowSnapshot(
    [
      node({ ref: "node-1", type: "n8n-nodes-base.webhook" }),
      node({ ref: "node-2", type: "n8n-nodes-base.code" }),
      node({ ref: "node-3", type: "n8n-nodes-base.merge" }),
    ],
    [
      { sourceIndex: 0, targetIndex: 1 },
      { sourceIndex: 0, targetIndex: 2 },
      { sourceIndex: 1, targetIndex: 2 },
    ],
  );
  const record = evaluateRules(value).coverage.find(
    (item) => item.ruleId === "GRAPH_CYCLE_WITHOUT_KNOWN_CONTROL",
  );
  assert.equal(record?.outcome, "not_applicable");
  assert.equal(record?.detectedCycleCount, 0);
  assert.equal(record?.inconclusiveCycleCount, 0);
});

test("the legacy Start node is a reachability root", () => {
  const value = workflowSnapshot(
    [node({ ref: "node-1", type: "n8n-nodes-base.start" }), regular],
    [{ sourceIndex: 0, targetIndex: 1 }],
  );
  assert.equal(outcome("GRAPH_UNREACHABLE_NODE", value), "passed");
});

const findingSchemaFixture = {
  id: "finding-1",
  ruleId: "GRAPH_DANGLING_SOURCE",
  category: "structure",
  severity: "low",
  confidence: "high",
  title: "Title",
  summary: "Summary",
  affectedEntity: { kind: "workflow", key: "workflow-1" },
  evidence: { summary: "Evidence" },
  remediation: "Remediation",
} as const;

test("finding identity bounds accept exact limits and reject overflow", () => {
  assert.equal(
    FindingSchema.safeParse({ ...findingSchemaFixture, id: "f".repeat(164) }).success,
    true,
  );
  assert.equal(
    FindingSchema.safeParse({ ...findingSchemaFixture, id: "f".repeat(165) }).success,
    false,
  );
  assert.equal(
    FindingSchema.safeParse({
      ...findingSchemaFixture,
      affectedEntity: { ...findingSchemaFixture.affectedEntity, key: "w".repeat(128) },
    }).success,
    true,
  );
  assert.equal(
    FindingSchema.safeParse({
      ...findingSchemaFixture,
      affectedEntity: { ...findingSchemaFixture.affectedEntity, key: "w".repeat(129) },
    }).success,
    false,
  );
});

test("documentation links reject non-HTTP schemes", () => {
  assert(
    FindingSchema.safeParse({
      ...findingSchemaFixture,
      documentationUrl: "https://example.test",
    }).success,
  );
  for (const documentationUrl of [
    "javascript:alert(1)",
    "data:text/plain,unsafe",
    "//evil.test/x",
    "/relative",
    "http://",
    "not a URL",
  ]) {
    let result: ReturnType<typeof FindingSchema.safeParse> | undefined;
    assert.doesNotThrow(() => {
      result = FindingSchema.safeParse({ ...findingSchemaFixture, documentationUrl });
    });
    assert.equal(result?.success, false);
  }
});

test("canceled-heavy history cannot become a failure streak or duration-shift finding", () => {
  const value = {
    ...snapshot(),
    executions: [
      ...Array.from({ length: 20 }, (_, index) => execution("canceled", index, 99_000)),
      execution("success", 21, 1_000),
      execution("error", 22, 2_000),
    ],
  };
  const metrics = computeMetrics(value);
  assert.equal(metrics.successRate, 0.5);
  assert.equal(metrics.duration.sampleCount, 22);
  assert.notEqual(outcome("EXECUTION_FAILURE_STREAK", value), "triggered");
  assert.notEqual(outcome("EXECUTION_DURATION_SHIFT", value), "triggered");
});

test("large graph traversal remains iterative and deterministic", () => {
  const nodeCount = 15_000;
  const nodes = Array.from({ length: nodeCount }, (_, index) =>
    node({
      ref: `node-${index + 1}`,
      type: index === 0 ? "n8n-nodes-base.manualTrigger" : "n8n-nodes-base.set",
    }),
  );
  const edges = Array.from({ length: nodeCount - 1 }, (_, index) => ({
    sourceIndex: index,
    targetIndex: index + 1,
  }));
  edges.push({ sourceIndex: nodeCount - 1, targetIndex: 0 });
  const value = workflowSnapshot(nodes, edges);
  assert.equal(outcome("GRAPH_UNREACHABLE_NODE", value), "passed");
  assert.equal(outcome("GRAPH_CYCLE_WITHOUT_KNOWN_CONTROL", value), "triggered");
});
