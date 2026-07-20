import { OFFICIAL_N8N_DOCUMENTATION_URLS } from "../content/official-urls.js";
import type {
  Category,
  Confidence,
  Finding,
  IntrospectSnapshot,
  ReducedExecutionMetadata,
  ReducedWorkflowNode,
  RuleCoverage,
  Severity,
} from "./contracts.js";
import { compareCodeUnits } from "./order.js";
import type { IntrospectRuleId } from "./rule-ids.js";
import { safeEntityKey } from "./sanitize.js";

const VERSION_BASIS = "n8n-community-2.30.5";
const MAX_FINDINGS_PER_RULE = 20;

interface NodeInfo {
  node: ReducedWorkflowNode;
  index: number;
  ref: string;
  label?: string;
}

interface GraphContext {
  nodes: NodeInfo[];
  adjacency: Map<number, Set<number>>;
  incoming: Map<number, number>;
  outgoing: Map<number, number>;
  duplicateNames: number;
  invalidEdges: number;
  danglingSources: number;
  danglingTargets: number;
}

interface RuleContext {
  snapshot: IntrospectSnapshot;
  graph: GraphContext;
}

type RuleOutcome = "triggered" | "passed" | "not_applicable" | "inconclusive";

interface RuleResult {
  outcome: RuleOutcome;
  partiallyInconclusive?: boolean;
  detectedCycleCount?: number;
  inconclusiveCycleCount?: number;
  reason: string;
  findings?: Finding[];
}

export interface RuleDefinition {
  id: IntrospectRuleId;
  category: Category;
  severity: Severity;
  confidence: Confidence;
  profiles: ReadonlyArray<"quick" | "deep">;
  versionBasis: string;
  description: string;
  remediation: string;
  documentationUrl?: string;
  evaluate(context: RuleContext): RuleResult;
}

export interface RuleEvaluation {
  findings: Finding[];
  coverage: RuleCoverage[];
  truncatedRuleIds: IntrospectRuleId[];
}

function entityForNode(info: NodeInfo) {
  return {
    kind: "node",
    key: info.ref,
    ...(info.label ? { label: info.label } : {}),
  };
}

function workflowEntity(context: RuleContext, suffix = "workflow") {
  return {
    kind: "workflow",
    key:
      suffix === "workflow"
        ? context.snapshot.workflow.id
        : safeEntityKey(`${context.snapshot.workflow.id}-${suffix}`),
    ...(context.snapshot.workflow.label ? { label: context.snapshot.workflow.label } : {}),
  };
}

function finding(
  definition: Omit<RuleDefinition, "evaluate">,
  entity:
    | ReturnType<typeof entityForNode>
    | ReturnType<typeof workflowEntity>
    | { kind: string; key: string; label?: string },
  title: string,
  summary: string,
  evidenceSummary: string,
  facts?: Record<string, string | number | boolean | null>,
): Finding {
  return {
    id: `${definition.id}:${safeEntityKey(entity.key)}`,
    ruleId: definition.id,
    category: definition.category,
    severity: definition.severity,
    confidence: definition.confidence,
    title,
    summary,
    affectedEntity: entity,
    evidence: {
      summary: evidenceSummary,
      ...(facts ? { facts } : {}),
    },
    remediation: definition.remediation,
    ...(definition.documentationUrl ? { documentationUrl: definition.documentationUrl } : {}),
  };
}

function buildGraph(snapshot: IntrospectSnapshot): GraphContext {
  const nodes = snapshot.workflow.nodes.map((node, index) => ({
    node,
    index,
    ref: node.ref,
    ...(node.label === undefined ? {} : { label: node.label }),
  }));
  const adjacency = new Map<number, Set<number>>();
  const incoming = new Map<number, number>();
  const outgoing = new Map<number, number>();
  nodes.forEach((info) => adjacency.set(info.index, new Set()));
  for (const edge of snapshot.workflow.edges) {
    adjacency.get(edge.sourceIndex)?.add(edge.targetIndex);
    outgoing.set(edge.sourceIndex, (outgoing.get(edge.sourceIndex) ?? 0) + 1);
    incoming.set(edge.targetIndex, (incoming.get(edge.targetIndex) ?? 0) + 1);
  }

  return {
    nodes,
    adjacency,
    incoming,
    outgoing,
    ...snapshot.workflow.graph,
  };
}

function graphIsReliable(graph: GraphContext): boolean {
  return (
    graph.duplicateNames === 0 &&
    graph.invalidEdges === 0 &&
    graph.danglingSources === 0 &&
    graph.danglingTargets === 0
  );
}

// Bounded, best-effort allowlist of core n8n entry/trigger node types whose type
// string does not contain the substring "trigger". This is an explicit, non-
// exhaustive convenience set: it makes no completeness or availability claim and
// only prevents false GRAPH_UNREACHABLE_NODE findings for recognized entry nodes.
// Values are lowercased to match the case-folded comparison in isTrigger.
const CORE_ENTRY_NODE_TYPES: ReadonlySet<string> = new Set([
  "n8n-nodes-base.start",
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.cron",
  "n8n-nodes-base.interval",
  "n8n-nodes-base.emailreadimap",
]);

function isTrigger(info: NodeInfo): boolean {
  const type = (info.node.type ?? "").toLowerCase();
  return type.includes("trigger") || CORE_ENTRY_NODE_TYPES.has(type);
}

function reachableFrom(graph: GraphContext, roots: ReadonlyArray<number>): Set<number> {
  const seen = new Set<number>();
  const pending = [...roots];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];
    if (current === undefined) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const target of graph.adjacency.get(current) ?? []) {
      if (!seen.has(target)) pending.push(target);
    }
  }
  return seen;
}

function stronglyConnectedComponents(graph: GraphContext): number[][] {
  const reverse = new Map<number, number[]>();
  graph.nodes.forEach((info) => reverse.set(info.index, []));
  for (const [source, targets] of graph.adjacency) {
    for (const target of targets) reverse.get(target)?.push(source);
  }

  const visited = new Set<number>();
  const order: number[] = [];
  for (const info of graph.nodes) {
    if (visited.has(info.index)) continue;
    visited.add(info.index);
    const stack: Array<{ node: number; targets: number[]; cursor: number }> = [
      {
        node: info.index,
        targets: [...(graph.adjacency.get(info.index) ?? [])].sort((left, right) => left - right),
        cursor: 0,
      },
    ];
    while (stack.length > 0) {
      const current = stack.at(-1) as { node: number; targets: number[]; cursor: number };
      const target = current.targets[current.cursor];
      if (target === undefined) {
        order.push(current.node);
        stack.pop();
        continue;
      }
      current.cursor += 1;
      if (visited.has(target)) continue;
      visited.add(target);
      stack.push({
        node: target,
        targets: [...(graph.adjacency.get(target) ?? [])].sort((left, right) => left - right),
        cursor: 0,
      });
    }
  }

  const components: number[][] = [];
  visited.clear();
  for (let orderIndex = order.length - 1; orderIndex >= 0; orderIndex -= 1) {
    const root = order[orderIndex];
    if (root === undefined) continue;
    if (visited.has(root)) continue;
    const component: number[] = [];
    const stack = [root];
    visited.add(root);
    while (stack.length > 0) {
      const current = stack.pop() as number;
      component.push(current);
      const sources = [...(reverse.get(current) ?? [])].sort((left, right) => right - left);
      for (const source of sources) {
        if (visited.has(source)) continue;
        visited.add(source);
        stack.push(source);
      }
    }
    component.sort((left, right) => left - right);
    const onlyNode = component.length === 1 ? component[0] : undefined;
    const selfLoop =
      onlyNode !== undefined && graph.adjacency.get(onlyNode)?.has(onlyNode) === true;
    if (component.length > 1 || selfLoop) components.push(component);
  }
  return components.sort((left, right) => (left[0] ?? -1) - (right[0] ?? -1));
}

function timestampMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function durationMs(execution: ReducedExecutionMetadata): number | undefined {
  const start = timestampMs(execution.startedAt);
  const stop = timestampMs(execution.stoppedAt);
  if (start === undefined || stop === undefined || stop < start) return undefined;
  return stop - start;
}

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new Error("Median requires at least one value.");
  if (sorted.length % 2 !== 0) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) throw new Error("Median requires at least two values.");
  return (lower + upper) / 2;
}

function simpleRule(
  definition: Omit<RuleDefinition, "evaluate">,
  evaluate: (definition: Omit<RuleDefinition, "evaluate">, context: RuleContext) => RuleResult,
): RuleDefinition {
  return Object.freeze({
    ...definition,
    evaluate: (context: RuleContext) => evaluate(definition, context),
  });
}

const common = (
  id: IntrospectRuleId,
  category: Category,
  severity: Severity,
  confidence: Confidence,
  description: string,
  remediation: string,
  documentationUrl?: string,
) => ({
  id,
  category,
  severity,
  confidence,
  profiles: ["quick", "deep"] as const,
  versionBasis: VERSION_BASIS,
  description,
  remediation,
  ...(documentationUrl ? { documentationUrl } : {}),
});

const RULES: ReadonlyArray<RuleDefinition> = [
  simpleRule(
    common(
      "GRAPH_DANGLING_SOURCE",
      "structure",
      "high",
      "high",
      "Find connection sources that are not workflow nodes.",
      "Remove the stale connection source or restore the missing node.",
    ),
    (definition, context) => {
      if (context.graph.danglingSources === 0)
        return { outcome: "passed", reason: "All connection sources resolve." };
      return {
        outcome: "triggered",
        reason: "One or more connection sources do not resolve.",
        findings: [
          finding(
            definition,
            workflowEntity(context),
            "Dangling connection source",
            "The workflow contains a connection source that does not resolve to a node.",
            "Connection-source resolution failed.",
            { count: context.graph.danglingSources },
          ),
        ],
      };
    },
  ),
  simpleRule(
    common(
      "GRAPH_DANGLING_TARGET",
      "structure",
      "high",
      "high",
      "Find connection targets that are not workflow nodes.",
      "Reconnect the branch to an existing node or remove the stale target.",
    ),
    (definition, context) => {
      if (context.graph.danglingTargets === 0)
        return { outcome: "passed", reason: "All connection targets resolve." };
      return {
        outcome: "triggered",
        reason: "One or more connection targets do not resolve.",
        findings: [
          finding(
            definition,
            workflowEntity(context),
            "Dangling connection target",
            "The workflow contains a connection target that does not resolve to a node.",
            "Connection-target resolution failed.",
            { count: context.graph.danglingTargets },
          ),
        ],
      };
    },
  ),
  simpleRule(
    common(
      "GRAPH_INVALID_EDGE",
      "structure",
      "high",
      "high",
      "Find malformed edges or ambiguous duplicate node names.",
      "Repair the malformed connection shape and ensure node names are unique.",
    ),
    (definition, context) => {
      const count = context.graph.invalidEdges + context.graph.duplicateNames;
      if (count === 0)
        return { outcome: "passed", reason: "Connection shapes and node names are unambiguous." };
      return {
        outcome: "triggered",
        reason: "The graph contains malformed or ambiguous connection data.",
        findings: [
          finding(
            definition,
            workflowEntity(context),
            "Invalid workflow edge",
            "The graph contains malformed edges or duplicate node names.",
            "Graph normalization found invalid structure.",
            {
              malformedEdges: context.graph.invalidEdges,
              duplicateNames: context.graph.duplicateNames,
            },
          ),
        ],
      };
    },
  ),
  simpleRule(
    common(
      "GRAPH_DISABLED_CONNECTED_NODE",
      "structure",
      "medium",
      "high",
      "Find disabled nodes that remain connected.",
      "Confirm the disabled-node bypass is intentional or remove its stale connections.",
    ),
    (definition, context) => {
      const connected = context.graph.nodes.filter(
        (info) =>
          info.node.disabled === true &&
          ((context.graph.incoming.get(info.index) ?? 0) > 0 ||
            (context.graph.outgoing.get(info.index) ?? 0) > 0),
      );
      if (!context.graph.nodes.some((info) => info.node.disabled === true)) {
        return { outcome: "not_applicable", reason: "The workflow has no disabled nodes." };
      }
      if (connected.length === 0)
        return { outcome: "passed", reason: "Disabled nodes are disconnected." };
      return {
        outcome: "triggered",
        reason: "Connected disabled nodes were observed.",
        findings: connected.map((info) =>
          finding(
            definition,
            entityForNode(info),
            "Disabled node remains connected",
            "A disabled node still participates in the saved graph.",
            "The node has at least one incoming or outgoing edge.",
            {
              incoming: context.graph.incoming.get(info.index) ?? 0,
              outgoing: context.graph.outgoing.get(info.index) ?? 0,
            },
          ),
        ),
      };
    },
  ),
  simpleRule(
    common(
      "GRAPH_UNREACHABLE_NODE",
      "structure",
      "medium",
      "medium",
      "Find enabled non-trigger nodes unreachable from every enabled trigger.",
      "Connect the node to an intended trigger path or remove the orphaned node.",
    ),
    (definition, context) => {
      if (!graphIsReliable(context.graph))
        return {
          outcome: "inconclusive",
          reason: "Graph structure is not reliable enough for reachability.",
        };
      const roots = context.graph.nodes
        .filter((info) => info.node.disabled !== true && isTrigger(info))
        .map((info) => info.index);
      if (roots.length === 0)
        return { outcome: "not_applicable", reason: "No enabled trigger root is available." };
      const reachable = reachableFrom(context.graph, roots);
      const unreachable = context.graph.nodes.filter(
        (info) => info.node.disabled !== true && !isTrigger(info) && !reachable.has(info.index),
      );
      if (unreachable.length === 0)
        return { outcome: "passed", reason: "All enabled non-trigger nodes are reachable." };
      return {
        outcome: "triggered",
        reason: "Enabled nodes unreachable from trigger roots were observed.",
        findings: unreachable.map((info) =>
          finding(
            definition,
            entityForNode(info),
            "Unreachable enabled node",
            "An enabled node is unreachable from every enabled trigger.",
            "Reachability traversal did not visit this node.",
          ),
        ),
      };
    },
  ),
  simpleRule(
    common(
      "GRAPH_CYCLE_WITHOUT_KNOWN_CONTROL",
      "structure",
      "low",
      "high",
      "Report a neutral cycle observation when no pinned loop-control node is present.",
      "Review the cycle and use the supported Loop Over Items node when explicit iteration is intended.",
      OFFICIAL_N8N_DOCUMENTATION_URLS.splitInBatches,
    ),
    (definition, context) => {
      if (!graphIsReliable(context.graph))
        return {
          outcome: "inconclusive",
          detectedCycleCount: 0,
          inconclusiveCycleCount: 0,
          reason: "Graph structure is not reliable enough for cycle analysis.",
        };
      const cycles = stronglyConnectedComponents(context.graph);
      if (cycles.length === 0)
        return {
          outcome: "not_applicable",
          detectedCycleCount: 0,
          inconclusiveCycleCount: 0,
          reason: "The graph has no directed cycle.",
        };
      const observations: Finding[] = [];
      let inconclusiveCycleCount = 0;
      cycles.forEach((cycle, cycleIndex) => {
        const members = cycle.map((index) => context.graph.nodes[index]);
        const recognized = members.every((info) => {
          if (info === undefined) return false;
          const version = info.node.typeVersion;
          return (
            typeof info.node.type === "string" &&
            info.node.type.startsWith("n8n-nodes-base.") &&
            typeof version === "number" &&
            Number.isFinite(version) &&
            version > 0
          );
        });
        if (!recognized) {
          inconclusiveCycleCount += 1;
          return;
        }
        const controlled = members.some(
          (info) =>
            info !== undefined &&
            info.node.type === "n8n-nodes-base.splitInBatches" &&
            typeof info.node.typeVersion === "number" &&
            [1, 2, 3].includes(info.node.typeVersion),
        );
        if (!controlled) {
          observations.push(
            finding(
              definition,
              workflowEntity(context, `cycle-${cycleIndex + 1}`),
              "Cycle without a pinned loop-control node",
              "A directed cycle does not contain a recognized Loop Over Items node.",
              "This is a neutral graph observation, not an unsafe-workflow verdict.",
              { nodeCount: members.length },
            ),
          );
        }
      });
      if (observations.length > 0)
        return {
          outcome: "triggered",
          partiallyInconclusive: inconclusiveCycleCount > 0,
          detectedCycleCount: cycles.length,
          inconclusiveCycleCount,
          reason:
            inconclusiveCycleCount > 0
              ? "Cycles without known controls were observed; at least one additional cycle is inconclusive because it contains an unrecognized node type or version."
              : "Cycles without known controls were observed.",
          findings: observations,
        };
      if (inconclusiveCycleCount > 0)
        return {
          outcome: "inconclusive",
          detectedCycleCount: cycles.length,
          inconclusiveCycleCount,
          reason: "At least one cycle contains an unrecognized node type or version.",
        };
      return {
        outcome: "passed",
        detectedCycleCount: cycles.length,
        inconclusiveCycleCount: 0,
        reason: "Every cycle contains a pinned loop-control node.",
      };
    },
  ),
  simpleRule(
    common(
      "CONTRACT_WEBHOOK_RESPONSE_MISSING",
      "contract",
      "high",
      "high",
      "Find response-node webhooks without a reachable Respond to Webhook node.",
      "Connect a Respond to Webhook node to every response-node webhook path.",
      OFFICIAL_N8N_DOCUMENTATION_URLS.webhook,
    ),
    (definition, context) => {
      if (!graphIsReliable(context.graph))
        return {
          outcome: "inconclusive",
          reason: "Graph structure is not reliable enough for webhook reachability.",
        };
      const hooks = context.graph.nodes.filter((info) => info.node.webhookResponseMode);
      if (hooks.length === 0)
        return { outcome: "not_applicable", reason: "No response-node webhook is configured." };
      const respondIndexes = new Set(
        context.graph.nodes
          .filter((info) => info.node.type === "n8n-nodes-base.respondToWebhook")
          .map((info) => info.index),
      );
      const missing = hooks.filter(
        (hook) =>
          ![...reachableFrom(context.graph, [hook.index])].some((index) =>
            respondIndexes.has(index),
          ),
      );
      if (missing.length === 0)
        return {
          outcome: "passed",
          reason: "Every response-node webhook reaches a response node.",
        };
      return {
        outcome: "triggered",
        reason: "A response-node webhook cannot reach a response node.",
        findings: missing.map((info) =>
          finding(
            definition,
            entityForNode(info),
            "Webhook response node is missing",
            "A response-node webhook has no reachable Respond to Webhook node.",
            "Reachability from this webhook found no response node.",
          ),
        ),
      };
    },
  ),
  simpleRule(
    common(
      "CONTRACT_WEBHOOK_RESPONSE_ORPHAN",
      "contract",
      "medium",
      "high",
      "Find Respond to Webhook nodes unreachable from compatible webhooks.",
      "Connect the response node to a compatible response-node webhook path or remove it.",
    ),
    (definition, context) => {
      if (!graphIsReliable(context.graph))
        return {
          outcome: "inconclusive",
          reason: "Graph structure is not reliable enough for webhook reachability.",
        };
      const responses = context.graph.nodes.filter(
        (info) => info.node.type === "n8n-nodes-base.respondToWebhook",
      );
      if (responses.length === 0)
        return { outcome: "not_applicable", reason: "No Respond to Webhook node is present." };
      const hooks = context.graph.nodes.filter((info) => info.node.webhookResponseMode);
      if (hooks.length === 0)
        return {
          outcome: "not_applicable",
          reason: "No compatible response-node webhook is present.",
        };
      const reachable = reachableFrom(
        context.graph,
        hooks.map((info) => info.index),
      );
      const orphaned = responses.filter((info) => !reachable.has(info.index));
      if (orphaned.length === 0)
        return {
          outcome: "passed",
          reason: "All response nodes are reachable from compatible webhooks.",
        };
      return {
        outcome: "triggered",
        reason: "Orphaned response nodes were observed.",
        findings: orphaned.map((info) =>
          finding(
            definition,
            entityForNode(info),
            "Orphaned webhook response node",
            "A Respond to Webhook node is unreachable from every compatible webhook.",
            "Compatible-webhook reachability did not visit this node.",
          ),
        ),
      };
    },
  ),
  simpleRule(
    common(
      "CONTRACT_EXPRESSION_MISSING_NODE",
      "contract",
      "high",
      "high",
      "Find conservative exact expression references to missing nodes.",
      "Update the expression to reference an existing node or restore the renamed node.",
    ),
    (definition, context) => {
      let referenceCount = 0;
      let scanIncomplete = false;
      const missing: Array<{ info: NodeInfo; count: number }> = [];
      for (const info of context.graph.nodes) {
        referenceCount += info.node.exactExpressionReferenceCount;
        if (!info.node.parameterScanComplete) scanIncomplete = true;
        const count = info.node.missingExpressionReferenceCount;
        if (count > 0) missing.push({ info, count });
      }
      if (missing.length > 0)
        return {
          outcome: "triggered",
          reason: "Expressions referencing missing nodes were observed.",
          findings: missing.map(({ info, count }) =>
            finding(
              definition,
              entityForNode(info),
              "Expression references a missing node",
              "A node expression contains an exact reference that does not resolve.",
              "One or more conservative expression references are missing.",
              { missingReferenceCount: count },
            ),
          ),
        };
      if (scanIncomplete)
        return {
          outcome: "inconclusive",
          reason: "At least one parameter scan reached its immutable entry cap.",
        };
      if (referenceCount === 0)
        return {
          outcome: "not_applicable",
          reason: "No conservative exact node-reference expression was found.",
        };
      return { outcome: "passed", reason: "Every exact node-reference expression resolves." };
    },
  ),
  simpleRule(
    common(
      "CONTRACT_SUBWORKFLOW_SELF_REFERENCE",
      "contract",
      "high",
      "high",
      "Find literal Execute Workflow references to the current workflow.",
      "Point the Execute Workflow node to a different workflow or remove the self-reference.",
    ),
    (definition, context) => {
      const executeNodes = context.graph.nodes.filter(
        (info) => info.node.type === "n8n-nodes-base.executeWorkflow",
      );
      if (executeNodes.length === 0)
        return { outcome: "not_applicable", reason: "No Execute Workflow node is present." };
      const matches = executeNodes.filter((info) => info.node.subworkflowTarget === "self");
      const unresolved = executeNodes.some(
        (info) => info.node.subworkflowTarget === "dynamic_or_missing",
      );
      if (matches.length > 0)
        return {
          outcome: "triggered",
          reason: "A literal subworkflow self-reference was observed.",
          findings: matches.map((info) =>
            finding(
              definition,
              entityForNode(info),
              "Subworkflow self-reference",
              "An Execute Workflow node targets its own workflow.",
              "The literal target equals the current workflow ID.",
            ),
          ),
        };
      if (unresolved)
        return {
          outcome: "inconclusive",
          reason: "One or more subworkflow targets are dynamic or missing.",
        };
      return {
        outcome: "passed",
        reason: "Literal subworkflow targets do not reference the current workflow.",
      };
    },
  ),
  simpleRule(
    common(
      "WORKFLOW_ACTIVE_WITHOUT_TRIGGER",
      "reliability",
      "high",
      "high",
      "Find active workflows whose public response reports zero triggers.",
      "Add and enable an appropriate trigger or deactivate the workflow.",
    ),
    (definition, context) => {
      if (!context.snapshot.workflow.active)
        return { outcome: "not_applicable", reason: "The workflow is inactive." };
      const count = context.snapshot.workflow.triggerCount;
      if (count === undefined)
        return {
          outcome: "inconclusive",
          reason: "The public response did not report triggerCount.",
        };
      if (count > 0)
        return { outcome: "passed", reason: "The active workflow reports at least one trigger." };
      return {
        outcome: "triggered",
        reason: "The active workflow reports zero triggers.",
        findings: [
          finding(
            definition,
            workflowEntity(context),
            "Active workflow has no trigger",
            "The workflow is active but reports no trigger.",
            "The public workflow response reports triggerCount=0.",
          ),
        ],
      };
    },
  ),
  simpleRule(
    common(
      "WORKFLOW_ERROR_SELF_REFERENCE",
      "reliability",
      "high",
      "high",
      "Find an error workflow that points to the current workflow.",
      "Configure a separate workflow containing an Error Trigger node.",
    ),
    (definition, context) => {
      if (!context.snapshot.workflow.settings.errorWorkflowConfigured) {
        return { outcome: "not_applicable", reason: "No error workflow is configured." };
      }
      if (!context.snapshot.workflow.settings.errorWorkflowSelfReference) {
        return { outcome: "passed", reason: "The error workflow is not a self-reference." };
      }
      return {
        outcome: "triggered",
        reason: "The error-workflow target equals the current workflow ID.",
        findings: [
          finding(
            definition,
            workflowEntity(context),
            "Error workflow self-reference",
            "The workflow is configured as its own error workflow.",
            "The errorWorkflow setting equals the current workflow ID.",
          ),
        ],
      };
    },
  ),
  simpleRule(
    common(
      "WORKFLOW_INVALID_TIMEZONE",
      "reliability",
      "medium",
      "high",
      "Find an explicit timezone that is not a valid IANA timezone.",
      "Replace the timezone with a valid IANA identifier such as America/Sao_Paulo.",
    ),
    (definition, context) => {
      const timezone = context.snapshot.workflow.settings.timezone;
      if (timezone === "absent")
        return { outcome: "not_applicable", reason: "No explicit timezone is configured." };
      if (timezone === "valid")
        return { outcome: "passed", reason: "The explicit timezone is a valid IANA identifier." };
      return {
        outcome: "triggered",
        reason: "The explicit timezone is not accepted as an IANA identifier.",
        findings: [
          finding(
            definition,
            workflowEntity(context),
            "Invalid workflow timezone",
            "The explicit workflow timezone is not a valid IANA identifier.",
            "Intl.DateTimeFormat rejected the configured timezone.",
          ),
        ],
      };
    },
  ),
  simpleRule(
    common(
      "WORKFLOW_ERROR_DATA_DISABLED",
      "observability",
      "medium",
      "high",
      "Find active workflows that explicitly save no error data and have no error workflow.",
      "Save error executions or configure a separate error workflow for operational evidence.",
    ),
    (definition, context) => {
      if (!context.snapshot.workflow.active)
        return { outcome: "not_applicable", reason: "The workflow is inactive." };
      if (!context.snapshot.workflow.settings.saveErrorDataDisabled) {
        return {
          outcome: "not_applicable",
          reason: "Error-data saving is not explicitly disabled.",
        };
      }
      if (context.snapshot.workflow.settings.errorWorkflowConfigured) {
        return { outcome: "passed", reason: "A separate error workflow is configured." };
      }
      return {
        outcome: "triggered",
        reason: "Error data is disabled without an error workflow.",
        findings: [
          finding(
            definition,
            workflowEntity(context),
            "Error evidence is disabled",
            "The active workflow explicitly saves no error data and has no error workflow.",
            "saveDataErrorExecution is none and errorWorkflow is absent.",
          ),
        ],
      };
    },
  ),
  simpleRule(
    common(
      "NODE_INVALID_TYPE_VERSION",
      "maintainability",
      "medium",
      "high",
      "Find explicitly present non-positive node type versions within the supported input bounds.",
      "Set the node to a positive supported typeVersion or recreate it in the n8n editor.",
    ),
    (definition, context) => {
      const invalid = context.graph.nodes.filter(
        (info) => info.node.typeVersion !== undefined && info.node.typeVersion <= 0,
      );
      const missing = context.graph.nodes.some((info) => info.node.typeVersion === undefined);
      if (invalid.length > 0)
        return {
          outcome: "triggered",
          reason: "Invalid explicit node type versions were observed.",
          findings: invalid.map((info) =>
            finding(
              definition,
              entityForNode(info),
              "Invalid node type version",
              "The node has an explicitly invalid typeVersion.",
              "typeVersion is non-positive.",
            ),
          ),
        };
      if (missing)
        return {
          outcome: "inconclusive",
          reason: "At least one node omits typeVersion; absence is not treated as invalid.",
        };
      return {
        outcome: "passed",
        reason: "All explicit node type versions are positive and finite.",
      };
    },
  ),
  simpleRule(
    common(
      "NODE_LEGACY_CONTINUE_ON_FAIL",
      "maintainability",
      "low",
      "high",
      "Find deprecated continueOnFail=true node configuration.",
      "Replace continueOnFail with the supported onError behavior.",
    ),
    (definition, context) => {
      const matches = context.graph.nodes.filter(
        (info) => info.node.continueOnFail === true && info.node.onError === undefined,
      );
      if (matches.length === 0)
        return { outcome: "not_applicable", reason: "No node enables legacy continueOnFail." };
      return {
        outcome: "triggered",
        reason: "Legacy continueOnFail configuration was observed.",
        findings: matches.map((info) =>
          finding(
            definition,
            entityForNode(info),
            "Legacy continue-on-fail setting",
            "The node uses deprecated continueOnFail=true.",
            "The public node schema marks continueOnFail as deprecated.",
          ),
        ),
      };
    },
  ),
  simpleRule(
    common(
      "NODE_INVALID_RETRY_CONFIGURATION",
      "reliability",
      "high",
      "high",
      "Find invalid retry count or wait settings.",
      "Use a positive integer maxTries and a non-negative finite waitBetweenTries.",
    ),
    (definition, context) => {
      const retryNodes = context.graph.nodes.filter((info) => info.node.retryOnFail === true);
      if (retryNodes.length === 0)
        return { outcome: "not_applicable", reason: "No node enables retryOnFail." };
      const invalid = retryNodes.filter((info) => {
        const tries = info.node.maxTries;
        const wait = info.node.waitBetweenTries;
        return (
          (tries !== undefined && (!Number.isInteger(tries) || tries <= 0)) ||
          (wait !== undefined && (!Number.isFinite(wait) || wait < 0))
        );
      });
      if (invalid.length === 0)
        return {
          outcome: "passed",
          reason: "Retry settings are finite and within structural bounds.",
        };
      return {
        outcome: "triggered",
        reason: "Invalid retry settings were observed.",
        findings: invalid.map((info) =>
          finding(
            definition,
            entityForNode(info),
            "Invalid retry configuration",
            "The node has an invalid retry count or delay.",
            "Retry values are non-integer, non-positive, negative, or non-finite.",
          ),
        ),
      };
    },
  ),
  simpleRule(
    common(
      "NODE_RETRY_SIDE_EFFECT",
      "reliability",
      "medium",
      "medium",
      "Find retried mutating HTTP requests without a detectable idempotency-key header.",
      "Add an idempotency key accepted by the upstream service or disable automatic retry for the mutation.",
    ),
    (definition, context) => {
      const httpRetryNodes = context.graph.nodes.filter(
        (info) => info.node.type === "n8n-nodes-base.httpRequest" && info.node.retryOnFail === true,
      );
      if (httpRetryNodes.length === 0)
        return { outcome: "not_applicable", reason: "No retried HTTP Request node is present." };
      const mutating = httpRetryNodes.filter(
        (info) =>
          info.node.httpMethod !== undefined &&
          ["POST", "PUT", "PATCH", "DELETE"].includes(info.node.httpMethod),
      );
      if (mutating.length === 0)
        return {
          outcome: "not_applicable",
          reason: "Retried HTTP requests use non-mutating methods.",
        };
      const risky = mutating.filter(
        (info) =>
          !info.node.hasIdempotencyHeader &&
          !info.node.idempotencyHeaderMissingValue &&
          info.node.parameterScanComplete,
      );
      const unresolved = mutating.filter(
        (info) =>
          !info.node.hasIdempotencyHeader &&
          (!info.node.parameterScanComplete || info.node.idempotencyHeaderMissingValue),
      );
      if (risky.length > 0)
        return {
          outcome: "triggered",
          reason: "A retried mutating HTTP request lacks a detectable idempotency key.",
          findings: risky.map((info) =>
            finding(
              definition,
              entityForNode(info),
              "Retry may repeat an HTTP side effect",
              "A mutating HTTP request is retried without a detectable idempotency-key header.",
              "retryOnFail is enabled for a mutating HTTP method and no idempotency key was detected.",
            ),
          ),
        };
      if (unresolved.length > 0)
        return {
          outcome: "inconclusive",
          reason: "A mutating retry parameter scan reached its immutable entry cap.",
        };
      return {
        outcome: "passed",
        reason: "Mutating retried requests contain a detectable idempotency-key header.",
      };
    },
  ),
  simpleRule(
    common(
      "PRIVACY_LITERAL_SECRET",
      "privacy",
      "high",
      "medium",
      "Find secret-named parameters that contain a non-expression literal.",
      "Move the value into an n8n credential or environment-backed expression and rotate it if exposed.",
    ),
    (definition, context) => {
      const matches = context.graph.nodes
        .map((info) => ({ info, count: info.node.literalSecretCount }))
        .filter(({ count }) => count > 0);
      if (matches.length > 0)
        return {
          outcome: "triggered",
          reason: "Potential literal secrets were observed without retaining their values.",
          findings: matches.map(({ info, count }) =>
            finding(
              definition,
              entityForNode(info),
              "Literal value in a secret-named parameter",
              "A secret-named parameter contains a non-expression literal.",
              "Only the presence and count were retained; values were discarded.",
              { occurrenceCount: count },
            ),
          ),
        };
      if (context.graph.nodes.some((info) => !info.node.parameterScanComplete)) {
        return {
          outcome: "inconclusive",
          reason: "At least one parameter scan reached its immutable entry cap.",
        };
      }
      return {
        outcome: "passed",
        reason: "No non-expression literal was found under a secret-named parameter.",
      };
    },
  ),
  simpleRule(
    common(
      "EXECUTION_FAILURE_STREAK",
      "reliability",
      "high",
      "high",
      "Find at least three newest success/error outcomes that are errors.",
      "Inspect the newest failed executions and correct the recurring failure before retrying.",
    ),
    (definition, context) => {
      if (context.snapshot.ordering !== "verified_newest_first") {
        return { outcome: "inconclusive", reason: "Newest-first ordering was not verified." };
      }
      const terminal = context.snapshot.executions.filter(
        (execution) => execution.status === "success" || execution.status === "error",
      );
      if (terminal.length < 3)
        return {
          outcome: "inconclusive",
          reason: "Fewer than three success/error outcomes are available.",
        };
      let count = 0;
      for (const execution of terminal) {
        if (execution.status !== "error") break;
        count += 1;
      }
      if (count < 3)
        return {
          outcome: "passed",
          reason: "The newest success/error outcomes do not form a three-error streak.",
        };
      return {
        outcome: "triggered",
        reason: "At least three newest success/error outcomes are errors.",
        findings: [
          finding(
            definition,
            workflowEntity(context),
            "Recent execution failure streak",
            "The newest success/error outcomes contain a consecutive failure streak.",
            "Only verified newest-first success/error outcomes were counted.",
            { consecutiveErrors: count },
          ),
        ],
      };
    },
  ),
  simpleRule(
    {
      ...common(
        "EXECUTION_REPEATED_ERROR",
        "reliability",
        "medium",
        "high",
        "Find a repeated error fingerprint within fetched deep-detail samples.",
        "Inspect the sampled executions sharing the fingerprint and fix their common failure cause.",
      ),
      profiles: ["deep"],
    },
    (definition, context) => {
      if (context.snapshot.input.profile !== "deep")
        return { outcome: "inconclusive", reason: "deep_profile_required" };
      const groups = new Map<string, number>();
      context.snapshot.details.forEach((detail) => {
        if (detail.errorFingerprint)
          groups.set(detail.errorFingerprint, (groups.get(detail.errorFingerprint) ?? 0) + 1);
      });
      const repeated = [...groups.entries()].filter(([, count]) => count >= 2);
      if (context.snapshot.details.filter((detail) => detail.status === "error").length < 2) {
        return {
          outcome: "inconclusive",
          reason: "Fewer than two error details were safely reduced.",
        };
      }
      if (repeated.length === 0)
        return {
          outcome: "passed",
          reason: "No fingerprint repeats within the fetched error-detail sample.",
        };
      return {
        outcome: "triggered",
        reason: "A fingerprint repeats within the bounded detail sample.",
        findings: repeated.map(([fingerprint, count]) =>
          finding(
            definition,
            {
              kind: "execution_cluster",
              key: fingerprint,
            },
            "Repeated error in sampled details",
            "An error fingerprint repeats within the fetched detail sample.",
            "The count applies only to fetched error details, not full history.",
            {
              sampleCount: count,
              sampledErrorDetails: context.snapshot.details.filter(
                (detail) => detail.status === "error",
              ).length,
              sampledErrors: context.snapshot.sampledErrors,
            },
          ),
        ),
      };
    },
  ),
  simpleRule(
    common(
      "EXECUTION_DURATION_SHIFT",
      "performance",
      "low",
      "medium",
      "Report a neutral recent wall-clock duration shift within comparable successful executions.",
      "Review recent workflow or upstream changes and confirm whether the wall-clock shift is intentional.",
    ),
    (definition, context) => {
      if (context.snapshot.ordering !== "verified_newest_first") {
        return { outcome: "inconclusive", reason: "Newest-first ordering was not verified." };
      }
      const groups = new Map<string, number[]>();
      context.snapshot.executions.forEach((execution) => {
        if (execution.status !== "success" || execution.waitObserved) return;
        const duration = durationMs(execution);
        if (duration === undefined) return;
        const mode = execution.mode ?? "unknown";
        const values = groups.get(mode) ?? [];
        values.push(duration);
        groups.set(mode, values);
      });
      const findings: Finding[] = [];
      for (const [mode, values] of groups) {
        const half = Math.floor(values.length / 2);
        if (half < 5) continue;
        const recent = values.slice(0, half);
        const older = values.slice(values.length - half);
        const recentMedian = median(recent);
        const olderMedian = median(older);
        if (recentMedian >= olderMedian * 2 && recentMedian - olderMedian >= 1_000) {
          findings.push(
            finding(
              definition,
              workflowEntity(context, `duration-${mode}`),
              "Recent wall-clock duration shift",
              "Comparable recent successful executions have a higher median wall-clock duration.",
              "This is a neutral shift observation, not a performance-defect verdict.",
              {
                mode,
                recentMedianMs: recentMedian,
                olderMedianMs: olderMedian,
                recentSampleCount: recent.length,
                olderSampleCount: older.length,
              },
            ),
          );
        }
      }
      if (findings.length > 0)
        return {
          outcome: "triggered",
          reason: "A comparable duration shift was observed.",
          findings,
        };
      if (![...groups.values()].some((values) => Math.floor(values.length / 2) >= 5)) {
        return {
          outcome: "inconclusive",
          reason: "No execution mode has five comparable successful durations per half.",
        };
      }
      return { outcome: "passed", reason: "No configured duration shift threshold was met." };
    },
  ),
  simpleRule(
    common(
      "EXECUTION_CRASH_OBSERVED",
      "reliability",
      "high",
      "high",
      "Report factual crashed execution statuses in the sample.",
      "Inspect instance logs and the crashed executions to identify the runtime or worker failure.",
    ),
    (definition, context) => {
      const count = context.snapshot.executions.filter(
        (execution) => execution.status === "crashed",
      ).length;
      if (count === 0)
        return {
          outcome: "passed",
          reason: "No crashed execution status is present in the sample.",
        };
      return {
        outcome: "triggered",
        reason: "Crashed execution statuses were observed.",
        findings: [
          finding(
            definition,
            workflowEntity(context),
            "Crashed execution observed",
            "The bounded execution sample contains a crashed status.",
            "This is a factual sampled-status observation.",
            { count },
          ),
        ],
      };
    },
  ),
];

export const RULE_REGISTRY: ReadonlyArray<RuleDefinition> = Object.freeze(
  [...RULES].sort((left, right) => compareCodeUnits(left.id, right.id)),
);

export function evaluateRules(snapshot: IntrospectSnapshot): RuleEvaluation {
  const graph = buildGraph(snapshot);
  const context: RuleContext = { snapshot, graph };
  const findings: Finding[] = [];
  const coverage: RuleCoverage[] = [];
  const truncatedRuleIds: IntrospectRuleId[] = [];

  for (const definition of RULE_REGISTRY) {
    const result = definition.evaluate(context);
    const rawFindings = result.findings ?? [];
    const selected = rawFindings.slice(0, MAX_FINDINGS_PER_RULE);
    if (rawFindings.length > selected.length) truncatedRuleIds.push(definition.id);
    findings.push(...selected);
    coverage.push({
      ruleId: definition.id,
      outcome: result.outcome,
      partiallyInconclusive: result.partiallyInconclusive ?? false,
      reason:
        rawFindings.length > selected.length
          ? `${result.reason} Additional occurrences were omitted by the immutable per-rule cap.`
          : result.reason,
      findingCount: selected.length,
      totalFindingCount: rawFindings.length,
      omittedFindingCount: rawFindings.length - selected.length,
      detectedCycleCount: result.detectedCycleCount ?? 0,
      inconclusiveCycleCount: result.inconclusiveCycleCount ?? 0,
    });
  }

  const severityRank: Record<Severity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  findings.sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      compareCodeUnits(left.ruleId, right.ruleId) ||
      compareCodeUnits(left.affectedEntity.kind, right.affectedEntity.kind) ||
      compareCodeUnits(left.affectedEntity.key, right.affectedEntity.key),
  );
  coverage.sort((left, right) => compareCodeUnits(left.ruleId, right.ruleId));

  return { findings, coverage, truncatedRuleIds };
}

function nearestRank(values: ReadonlyArray<number>, percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index] ?? null;
}

export function computeMetrics(snapshot: IntrospectSnapshot) {
  const statusCounts = {
    success: 0,
    error: 0,
    crashed: 0,
    canceled: 0,
    running: 0,
    waiting: 0,
    new: 0,
    unknown: 0,
  };
  const durations: number[] = [];
  snapshot.executions.forEach((execution) => {
    if (execution.status in statusCounts) {
      statusCounts[execution.status] += 1;
    } else {
      statusCounts.unknown += 1;
    }
    const duration = durationMs(execution);
    if (duration !== undefined) durations.push(duration);
  });
  const denominator = statusCounts.success + statusCounts.error + statusCounts.crashed;
  const successRate = denominator === 0 ? null : statusCounts.success / denominator;
  const sum = durations.reduce((total, value) => total + value, 0);

  let consecutiveErrors: number | null = null;
  if (snapshot.ordering === "verified_newest_first") {
    consecutiveErrors = 0;
    for (const execution of snapshot.executions.filter(
      (item) => item.status === "success" || item.status === "error",
    )) {
      if (execution.status !== "error") break;
      consecutiveErrors += 1;
    }
  }

  const timingGroups = new Map<string, { label?: string; values: number[] }>();
  snapshot.details.forEach((detail) =>
    detail.nodeTimings.forEach((timing) => {
      const group = timingGroups.get(timing.nodeRef) ?? { values: [] };
      group.values.push(timing.executionTimeMs);
      if (timing.label) group.label = timing.label;
      timingGroups.set(timing.nodeRef, group);
    }),
  );
  const perNodeTimings = [...timingGroups.entries()]
    .map(([nodeRef, group]) => ({
      nodeRef,
      ...(group.label ? { label: group.label } : {}),
      sampleCount: group.values.length,
      medianMs: median(group.values),
      maxMs: Math.max(...group.values),
    }))
    .sort(
      (left, right) => right.maxMs - left.maxMs || compareCodeUnits(left.nodeRef, right.nodeRef),
    );

  const sampledErrorDetails = snapshot.details.filter((detail) => detail.status === "error").length;
  const clusterGroups = new Map<string, { nodeRef?: string; label?: string; count: number }>();
  snapshot.details.forEach((detail) => {
    if (!detail.errorFingerprint) return;
    const group = clusterGroups.get(detail.errorFingerprint) ?? { count: 0 };
    group.count += 1;
    if (detail.lastNodeRef) group.nodeRef = detail.lastNodeRef;
    if (detail.lastNodeLabel) group.label = detail.lastNodeLabel;
    clusterGroups.set(detail.errorFingerprint, group);
  });
  const errorClusters = [...clusterGroups.entries()]
    .map(([fingerprint, group]) => ({
      fingerprint,
      ...(group.nodeRef ? { nodeRef: group.nodeRef } : {}),
      ...(group.label ? { label: group.label } : {}),
      sampleCount: group.count,
      sampledErrorDetails,
      sampledErrors: snapshot.sampledErrors,
    }))
    .sort(
      (left, right) =>
        right.sampleCount - left.sampleCount ||
        compareCodeUnits(left.fingerprint, right.fingerprint),
    );

  return {
    statusCounts,
    successRate,
    duration: {
      sampleCount: durations.length,
      meanMs: durations.length > 0 ? sum / durations.length : null,
      minMs: durations.length > 0 ? Math.min(...durations) : null,
      maxMs: durations.length > 0 ? Math.max(...durations) : null,
      p50Ms: nearestRank(durations, 0.5),
      p95Ms: nearestRank(durations, 0.95),
      p99Ms: nearestRank(durations, 0.99),
    },
    consecutiveErrors,
    perNodeTimings,
    errorClusters,
  };
}
