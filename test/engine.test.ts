import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { PROFILE_BUDGETS } from "../src/introspect/collector.js";
import {
  IntrospectResultSchema,
  type N8nReadClient,
  type N8nReadResult,
  type ReadBudget,
} from "../src/introspect/contracts.js";
import {
  inspectWorkflow,
  IntrospectInputError,
  IntrospectOutputError,
  fitStructuredResult,
} from "../src/introspect/engine.js";
import { renderIntrospect } from "../src/introspect/render.js";
import { safeEntityKey, sanitizeIntrospectResultForOutput } from "../src/introspect/sanitize.js";

const SECRET = ["ENGINE", "SECRET", "CANARY", "4ce8eaa8"].join("_");

interface Call {
  endpoint: string;
  query: Readonly<Record<string, string>>;
  budget: ReadBudget;
}

class Client implements N8nReadClient {
  readonly calls: Call[] = [];

  constructor(
    private readonly responder: (
      call: Call,
      index: number,
    ) => N8nReadResult | Promise<N8nReadResult>,
  ) {}

  async get(endpoint: string, query: Readonly<Record<string, string>>, budget: ReadBudget) {
    const call = { endpoint, query, budget };
    this.calls.push(call);
    return this.responder(call, this.calls.length - 1);
  }
}

function recentExecution(id: string, status: string, minutesAgo: number, durationMs = 1_000) {
  const started = Date.now() - minutesAgo * 60_000;
  return {
    id,
    status,
    mode: "trigger",
    startedAt: new Date(started).toISOString(),
    stoppedAt: new Date(started + durationMs).toISOString(),
    workflowId: "workflow-1",
  };
}

function workflow(
  nodes: unknown[] = [
    {
      id: "raw-id",
      name: `Webhook ${SECRET}`,
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      parameters: { responseMode: "onReceived", apiKey: SECRET },
    },
  ],
) {
  return {
    id: "workflow-1",
    name: `Workflow ${SECRET}`,
    active: false,
    triggerCount: 1,
    nodes,
    connections: {},
    settings: { timezone: "America/Sao_Paulo" },
  };
}

function quickClient() {
  return new Client((call) => {
    if (call.endpoint.startsWith("/workflows/")) return { value: workflow(), bytes: 100 };
    return {
      value: { data: [recentExecution("execution-1", "success", 1)], nextCursor: null },
      bytes: 100,
    };
  });
}

test("adversarial and out-of-range inputs make zero upstream calls", async () => {
  const invalidInputs: unknown[] = [
    { workflowId: "" },
    { workflowId: "../executions" },
    { workflowId: "%2e%2e" },
    { workflowId: "workflow/1" },
    { workflowId: "workflow?x=1" },
    { workflowId: "workflow#fragment" },
    { workflowId: " workflow" },
    { workflowId: "w\u0000x" },
    { workflowId: "ｗorkflow" },
    { workflowId: "x".repeat(129) },
    { workflowId: "workflow-1", profile: "quick", maxExecutions: 26 },
    { workflowId: "workflow-1", maxExecutions: 0 },
    { workflowId: "workflow-1", maxExecutions: 1.5 },
    { workflowId: "workflow-1", lookbackHours: 0 },
    { workflowId: "workflow-1", lookbackHours: 721 },
    { workflowId: "workflow-1", profile: "security" },
    { workflowId: "workflow-1", unknown: true },
  ];

  for (const invalid of invalidInputs) {
    const client = quickClient();
    await assert.rejects(
      inspectWorkflow(client, invalid),
      (error: unknown) => error instanceof IntrospectInputError && error.code === "invalid_input",
      JSON.stringify(invalid),
    );
    assert.equal(client.calls.length, 0, JSON.stringify(invalid));
  }
});

test("quick output conforms to schema, applies defaults, and has an exact JSON fallback", async () => {
  const client = quickClient();
  const result = await inspectWorkflow(client, { workflowId: "workflow-1" });
  const rendered = renderIntrospect(result);

  assert.deepEqual(IntrospectResultSchema.parse(result), result);
  assert.equal(result.profile, "quick");
  assert.equal(result.sample.lookbackHours, 24);
  assert.equal(result.sample.maxExecutions, 20);
  assert.equal(result.sample.detailRequests, 0);
  assert.equal(result.ruleCoverage.length, 23);
  assert.equal(
    result.summary.ruleOutcomes.partiallyInconclusive,
    result.ruleCoverage.filter((record) => record.partiallyInconclusive).length,
  );
  assert.equal(result.summary.findings.retainedCount, result.findings.length);
  assert.equal(
    result.summary.findings.omittedCount,
    result.summary.findings.totalCount - result.findings.length,
  );
  assert.deepEqual(JSON.parse(rendered.json), result);
  assert.ok(
    Buffer.byteLength(JSON.stringify(result)) <= PROFILE_BUDGETS.quick.structuredOutputBytes,
  );
  assert.ok(rendered.combinedBytes <= PROFILE_BUDGETS.quick.combinedOutputBytes);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.match(
    rendered.summary,
    /Rule outcomes: \d+ inconclusive, \d+ partially inconclusive; limitations: \d+\./,
  );
});

test("output sanitization preserves schema-valid error fingerprints", async () => {
  const result = await inspectWorkflow(quickClient(), { workflowId: "workflow-1" });
  result.metrics.errorClusters = [
    {
      fingerprint: "0123456789abcdef",
      sampleCount: 1,
      sampledErrorDetails: 1,
      sampledErrors: 1,
    },
  ];
  const sanitized = sanitizeIntrospectResultForOutput(result);
  assert.equal(sanitized.metrics.errorClusters[0]?.fingerprint, "0123456789abcdef");
});

test("output sanitization rejects an unregistered rule ID before restoration", async () => {
  const result = await inspectWorkflow(quickClient(), { workflowId: "workflow-1" });
  const invalidResult = structuredClone(result);
  const sourceFinding = invalidResult.findings[0] as unknown as {
    ruleId: string;
    id: string;
    affectedEntity: { key: string };
  };
  assert(sourceFinding);
  const untrustedRuleId = "R".repeat(48);
  sourceFinding.ruleId = untrustedRuleId;
  sourceFinding.id = `${untrustedRuleId}:${safeEntityKey(sourceFinding.affectedEntity.key)}`;
  assert.throws(() => sanitizeIntrospectResultForOutput(invalidResult));
});

test("non-positive stored type versions reach the advertised Introspect rule", async () => {
  const client = new Client((call) =>
    call.endpoint.startsWith("/workflows/")
      ? {
          value: workflow([
            {
              id: "legacy-node",
              name: "Legacy node",
              type: "n8n-nodes-base.noOp",
              typeVersion: 0,
              parameters: {},
            },
          ]),
          bytes: 100,
        }
      : { value: { data: [], nextCursor: null }, bytes: 100 },
  );
  const result = await inspectWorkflow(client, { workflowId: "workflow-1" });
  const coverage = result.ruleCoverage.find(
    (record) => record.ruleId === "NODE_INVALID_TYPE_VERSION",
  );
  assert.equal(coverage?.outcome, "triggered");
  assert.equal(coverage?.findingCount, 1);
  assert.equal(
    result.findings.filter((finding) => finding.ruleId === "NODE_INVALID_TYPE_VERSION").length,
    1,
  );
});

test("the same reduced facts produce byte-equivalent deterministic reports", async () => {
  const fixedExecution = {
    id: "execution-1",
    status: "success",
    mode: "trigger",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    stoppedAt: new Date(Date.now() - 59_000).toISOString(),
    workflowId: "workflow-1",
  };
  const makeClient = () =>
    new Client((call) =>
      call.endpoint.startsWith("/workflows/")
        ? { value: workflow(), bytes: 100 }
        : { value: { data: [fixedExecution], nextCursor: null }, bytes: 100 },
    );
  const first = await inspectWorkflow(makeClient(), { workflowId: "workflow-1" });
  const second = await inspectWorkflow(makeClient(), { workflowId: "workflow-1" });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("the same fixed fixture is byte-deterministic across fresh Node processes", () => {
  const fixture = resolve(".test-dist/test/introspect-process-fixture.js");
  const run = (locale: string, timezone: string) =>
    spawnSync(process.execPath, [fixture], {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, LANG: locale, LC_ALL: locale, TZ: timezone },
    });
  const first = run("en_US.UTF-8", "UTC");
  const second = run("sv_SE.UTF-8", "Pacific/Auckland");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  const payload = JSON.parse(first.stdout) as {
    orderedUnicode: unknown;
    result: unknown;
  };
  assert.deepEqual(payload.orderedUnicode, ["a-node", "z-node", "ä-node"]);
  const result = IntrospectResultSchema.parse(payload.result);
  assert.deepEqual(result, payload.result);
  assert.equal(result.sample.oldestStartedAt, "2026-07-17T12:00:00.000Z");
  assert.equal(result.sample.newestStartedAt, "2026-07-17T12:00:00.000Z");
});

test("deep reports remain within both output caps at the maximum workflow-node boundary", async () => {
  const nodes = Array.from({ length: 1_000 }, (_, index) => ({
    id: `raw-${index}`,
    name: `Node ${index} ${SECRET}`,
    type: "n8n-nodes-base.set",
    typeVersion: 1,
    disabled: true,
    continueOnFail: true,
    retryOnFail: true,
    maxTries: 0,
    parameters: { apiKey: `${SECRET}-${index}` },
  }));
  const runData = Object.fromEntries(
    nodes.map((rawNode, index) => [
      rawNode.name,
      [{ executionTime: index + 1, data: { raw: SECRET } }],
    ]),
  );
  const executions = [
    recentExecution("error-1", "error", 1),
    recentExecution("error-2", "error", 2),
    recentExecution("error-3", "error", 3),
    recentExecution("success-1", "success", 4, 10_000),
  ];
  const client = new Client((call) => {
    if (call.endpoint.startsWith("/workflows/")) return { value: workflow(nodes), bytes: 1_000 };
    if (call.endpoint === "/executions")
      return { value: { data: executions, nextCursor: null }, bytes: 1_000 };
    const firstNode = nodes[0];
    assert(firstNode);
    return {
      value: {
        ...executions[0],
        id: call.endpoint.split("/").at(-1),
        data: {
          redactionInfo: { isRedacted: true },
          resultData: {
            lastNodeExecuted: firstNode.name,
            error: { name: "Error", message: SECRET },
            runData,
          },
        },
      },
      bytes: 1_000,
    };
  });

  const result = await inspectWorkflow(client, {
    workflowId: "workflow-1",
    profile: "deep",
    maxExecutions: 50,
    lookbackHours: 168,
  });
  const rendered = renderIntrospect(result);
  assert.equal(result.status, "partial");
  assert.ok(result.limitations.some((item) => item.code === "finding_limit"));
  assert.ok(
    Buffer.byteLength(JSON.stringify(result)) <= PROFILE_BUDGETS.deep.structuredOutputBytes,
  );
  assert.ok(rendered.combinedBytes <= PROFILE_BUDGETS.deep.combinedOutputBytes);
  assert.equal(rendered.json.includes(SECRET), false);
  assert.deepEqual(JSON.parse(rendered.json), result);
});

test("finding counts describe only findings retained after output reduction", async () => {
  const baseline = await inspectWorkflow(quickClient(), { workflowId: "workflow-1" });
  const source = baseline.findings[0];
  assert(source);
  const oversized = structuredClone(baseline);
  oversized.findings = Array.from({ length: 1_000 }, (_, index) => ({
    ...source,
    id: `finding-${index}`,
    summary: `${source.summary} ${"bounded evidence ".repeat(20)}`,
  }));
  oversized.summary.findingCounts = {
    critical: 0,
    high: oversized.findings.filter((finding) => finding.severity === "high").length,
    medium: oversized.findings.filter((finding) => finding.severity === "medium").length,
    low: oversized.findings.filter((finding) => finding.severity === "low").length,
    info: oversized.findings.filter((finding) => finding.severity === "info").length,
  };
  const sourceCoverage = oversized.ruleCoverage.find((record) => record.ruleId === source.ruleId);
  assert(sourceCoverage);
  sourceCoverage.totalFindingCount = oversized.findings.length;
  sourceCoverage.findingCount = oversized.findings.length;
  sourceCoverage.omittedFindingCount = 0;
  oversized.summary.findings = {
    totalCount: oversized.findings.length,
    retainedCount: oversized.findings.length,
    omittedCount: 0,
    truncated: false,
  };
  const fitted = fitStructuredResult(oversized);
  const retainedCount = Object.values(fitted.summary.findingCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  assert(fitted.findings.length < oversized.findings.length);
  assert.equal(retainedCount, fitted.findings.length);
  assert.equal(fitted.summary.findings.retainedCount, fitted.findings.length);
  assert.equal(
    fitted.summary.findings.omittedCount,
    fitted.summary.findings.totalCount - fitted.findings.length,
  );
  assert.equal(fitted.summary.findings.truncated, true);
  for (const record of fitted.ruleCoverage) {
    assert.equal(
      record.omittedFindingCount,
      record.totalFindingCount - record.findingCount,
      record.ruleId,
    );
  }
});

test("output reduction evaluates every candidate with synchronized finding disclosure", async () => {
  const baseline = await inspectWorkflow(quickClient(), { workflowId: "workflow-1" });
  const source = baseline.findings[0];
  assert(source);
  for (let padding = 0; padding < 64; padding += 1) {
    const oversized = structuredClone(baseline);
    oversized.findings = Array.from({ length: 999 }, (_, index) => ({
      ...source,
      id: `FINDING_RULE:node-${index}`,
      summary: `${source.summary} ${"bounded evidence ".repeat(12)}${"x".repeat(padding)}`,
    }));
    const sourceCoverage = oversized.ruleCoverage.find((record) => record.ruleId === source.ruleId);
    assert(sourceCoverage);
    sourceCoverage.totalFindingCount = oversized.findings.length;
    sourceCoverage.findingCount = oversized.findings.length;
    sourceCoverage.omittedFindingCount = 0;
    oversized.summary.findings = {
      totalCount: oversized.findings.length,
      retainedCount: oversized.findings.length,
      omittedCount: 0,
      truncated: false,
    };
    oversized.summary.findingCounts = {
      critical: 0,
      high: source.severity === "high" ? oversized.findings.length : 0,
      medium: source.severity === "medium" ? oversized.findings.length : 0,
      low: source.severity === "low" ? oversized.findings.length : 0,
      info: source.severity === "info" ? oversized.findings.length : 0,
    };
    const fitted = fitStructuredResult(oversized);
    assert.ok(
      Buffer.byteLength(JSON.stringify(fitted)) <=
        PROFILE_BUDGETS[fitted.profile].structuredOutputBytes,
    );
    assert.equal(fitted.summary.findings.retainedCount, fitted.findings.length);
  }
});

test("optional labels carry an explicit redaction limitation", async () => {
  const result = await inspectWorkflow(quickClient(), {
    workflowId: "workflow-1",
    includeSanitizedLabels: true,
  });
  assert.ok(result.workflow.label);
  assert.ok(result.limitations.some((item) => item.code === "label_redaction_limit"));
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("rendering reports unavailable success rate and enforces the combined byte budget", async () => {
  const result = await inspectWorkflow(quickClient(), { workflowId: "workflow-1" });
  const noHistoryResult = {
    ...result,
    metrics: { ...result.metrics, successRate: null },
  };
  assert(renderIntrospect(noHistoryResult).summary.includes("success rate: unavailable"));
  const oversized = {
    ...noHistoryResult,
    workflow: {
      ...noHistoryResult.workflow,
      label: "x ".repeat(PROFILE_BUDGETS.quick.combinedOutputBytes),
    },
  };
  assert.throws(() => renderIntrospect(oversized), IntrospectOutputError);
});
