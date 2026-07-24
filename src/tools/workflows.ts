import { z } from "zod";
import { N8nApiError, type N8nClient } from "../n8n/client.js";
import {
  boundedJson,
  sanitizeForOutput,
  sanitizePathSegmentForOutput,
} from "../security/redaction.js";
import { defineTool, type ToolDefinition } from "./definition.js";
import {
  assertBoundedDepth,
  assertSafeJson,
  confirmation,
  cursor,
  identifier,
  isRecord,
  MUTABLE_NODE_ROOTS,
  pageLimit,
  pathSegment,
  requiredSafeJsonValue,
  safeJsonValue,
  setUnknownPath,
  validateDotPath,
} from "./schemas.js";
import { booleanQuery, numberQuery } from "./common.js";
import { parseWorkflowLifecycleMetadata } from "./response-contracts.js";

// Trusted server-returned workflow data is carried through unchanged (large or prototype-named
// pinned data must survive), but it still recurses through structuredClone and canonicalization,
// so bound its depth well above any real workflow yet far below the native stack limit.
const MAX_WORKFLOW_JSON_DEPTH = 256;

const DEFAULT_FALSE_NODE_FIELDS = new Set<string>([
  "retryOnFail",
  "continueOnFail",
  "notesInFlow",
  "alwaysOutputData",
  "executeOnce",
]);

const nodeSchema = z
  .object({
    id: identifier().optional(),
    name: z.string().min(1).max(256),
    type: z.string().min(1).max(256),
    typeVersion: z.number().finite().positive().max(10_000),
    position: z
      .array(z.number().finite())
      .length(2)
      .describe("Node canvas position as exactly two finite numbers."),
    parameters: z.record(z.unknown()).default({}),
    credentials: z.record(z.unknown()).optional(),
    disabled: z.boolean().optional(),
    webhookId: identifier("Stable dynamic-webhook routing identifier when present.").optional(),
  })
  .passthrough();

const connectionTargetSchema = z
  .object({
    node: z.string().min(1).max(256),
    type: z.string().min(1).max(128),
    index: z.number().int().nonnegative().max(1_000),
  })
  .passthrough();

const connectionsSchema = z.record(
  z.record(z.array(z.array(connectionTargetSchema).max(1_000)).max(1_000)),
);

const staticDataSchema = z.union([z.record(z.unknown()), z.string().max(1024 * 1024)]).nullable();

const workflowSchema = z.object({
  id: identifier(),
  versionId: identifier().optional(),
  name: z.string().min(1).max(256),
  description: z.string().max(16_384).nullable().optional(),
  active: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  nodes: z.array(nodeSchema).max(1_000),
  connections: connectionsSchema,
  settings: z.record(z.unknown()).default({}),
  pinData: z.record(z.unknown()).nullable().optional(),
  staticData: staticDataSchema.optional(),
  nodeGroups: z.array(z.unknown()).max(1_000).optional(),
});

const historicalWorkflowSchema = z.object({
  workflowId: identifier(),
  versionId: identifier(),
  name: z.string().max(256).nullable().optional(),
  nodes: z.array(nodeSchema).max(1_000),
  connections: connectionsSchema,
});

const workflowListSchema = z
  .object({
    data: z.array(workflowSchema).max(100),
    nextCursor: cursor.nullable().optional(),
  })
  .passthrough();

const tagSchema = z
  .object({
    id: identifier(),
    name: z.string().max(256).optional(),
    createdAt: z.string().max(64).optional(),
    updatedAt: z.string().max(64).optional(),
  })
  .strict();

function boundedTagCollection(value: unknown) {
  const raw = z.array(z.unknown()).max(10_000).parse(value);
  const data = z.array(tagSchema).parse(raw.slice(0, 100));
  return {
    data,
    totalCount: raw.length,
    truncated: raw.length > data.length,
    omittedCount: raw.length - data.length,
  };
}

const workflowWriteFields = {
  name: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Replacement workflow name (1-128 characters)."),
  description: z
    .string()
    .max(16_384)
    .optional()
    .describe("Replacement workflow description (up to 16,384 characters)."),
  nodes: z
    .array(nodeSchema)
    .max(1_000)
    .optional()
    .describe(
      "Complete replacement node array when supplied. Omit this field to preserve the existing array; nodes absent from a supplied array are removed.",
    ),
  connections: connectionsSchema
    .optional()
    .describe("Complete replacement connection graph keyed by node name."),
  settings: z
    .record(z.unknown())
    .optional()
    .describe("Complete replacement workflow settings object."),
  pinData: z
    .record(z.unknown())
    .nullable()
    .optional()
    .describe(
      "Complete replacement pinned-data map, or null to clear it; values are never returned.",
    ),
  staticData: staticDataSchema
    .optional()
    .describe("Complete replacement static workflow data; values are never returned."),
  nodeGroups: z
    .array(safeJsonValue)
    .max(1_000)
    .optional()
    .describe("Complete replacement node-group array containing safe JSON values."),
};

type Workflow = z.output<typeof workflowSchema>;
type DiffSnapshot = z.output<typeof historicalWorkflowSchema>;
type WorkflowNode = Workflow["nodes"][number];
type WorkflowConnections = z.output<typeof connectionsSchema>;
type MutableNodeRoot = (typeof MUTABLE_NODE_ROOTS)[number];

class WorkflowContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowContractError";
    this.code = code;
  }
}

// Per-root type contract for the single value applied by n8n_update_node. Keys mirror
// MUTABLE_NODE_ROOTS exactly; every allowed root is bounded so a corrupt value (a string
// for a boolean, a non-integer retry count, an unknown onError enum) is rejected before PUT.
const NODE_ROOT_VALUE_CONTRACTS: Readonly<Record<MutableNodeRoot, z.ZodTypeAny>> = {
  parameters: z.record(z.unknown()),
  position: z.tuple([z.number().finite(), z.number().finite()]),
  disabled: z.boolean(),
  retryOnFail: z.boolean(),
  maxTries: z.number().int().min(0).max(10_000),
  waitBetweenTries: z.number().int().min(0).max(300_000),
  continueOnFail: z.boolean(),
  onError: z.enum(["continueErrorOutput", "continueRegularOutput", "stopWorkflow"]),
  notes: z.string().max(16_384),
  notesInFlow: z.boolean(),
  alwaysOutputData: z.boolean(),
  executeOnce: z.boolean(),
};

function isMutableNodeRoot(segment: string): segment is MutableNodeRoot {
  return (MUTABLE_NODE_ROOTS as readonly string[]).includes(segment);
}

function assertMutatedNodeValid(node: WorkflowNode, root: MutableNodeRoot): void {
  const record = node as unknown as Record<string, unknown>;
  if (!NODE_ROOT_VALUE_CONTRACTS[root].safeParse(record[root]).success) {
    throw new Error(
      `The node update value does not satisfy the type contract for the '${root}' node field.`,
    );
  }
  // Local invariant on the node this tool just mutated; surface a plain tool error rather than a
  // raw ZodError so it is never misreported as an upstream response-shape mismatch.
  if (!nodeSchema.safeParse(node).success) {
    throw new Error("The mutated node no longer satisfies the node schema; no update was sent.");
  }
}

function assertWorkflowVersionIdentitySupported(workflow: Workflow, operationName: string): void {
  if (workflow.versionId === undefined) {
    throw new WorkflowContractError(
      "version_identity_unsupported",
      `This n8n instance did not return a workflow versionId, so the optimistic-concurrency precondition required by ${operationName} cannot be enforced. This is characteristic of an n8n release below the supported Community 2.30.5 floor; it is not a concurrent modification. No update was sent.`,
    );
  }
}

async function fetchWorkflowVersion(client: N8nClient, path: string): Promise<unknown> {
  try {
    return await client.request({ path });
  } catch (error) {
    if (error instanceof N8nApiError && error.status === 404) {
      throw new WorkflowContractError(
        "version_history_unavailable",
        "n8n returned HTTP 404 for the workflow version-history endpoint. This server cannot determine which of two distinct causes applies: the endpoint requires the supported floor (n8n Community 2.30.5 or newer) and may be absent on an older instance, or the requested version was pruned or never retained under this instance's history retention. Confirm the running n8n version before treating this as a retention limit.",
      );
    }
    throw error;
  }
}

function writableWorkflow(workflow: Workflow): Record<string, unknown> {
  assertBoundedDepth(workflow, MAX_WORKFLOW_JSON_DEPTH);
  const output: Record<string, unknown> = {
    name: workflow.name,
    nodes: structuredClone(workflow.nodes),
    connections: structuredClone(workflow.connections),
    settings: structuredClone(workflow.settings),
  };
  if (typeof workflow.description === "string") output.description = workflow.description;
  for (const key of ["nodeGroups", "staticData", "pinData"] as const) {
    if (Object.hasOwn(workflow, key)) output[key] = structuredClone(workflow[key]);
  }
  return output;
}

function workflowForOutput(
  workflow: Workflow,
  sensitiveDataExcluded = false,
): Record<string, unknown> {
  return {
    id: workflow.id,
    ...(workflow.versionId === undefined ? {} : { versionId: workflow.versionId }),
    name: workflow.name,
    ...(typeof workflow.description === "string" ? { description: workflow.description } : {}),
    ...(workflow.active === undefined ? {} : { active: workflow.active }),
    ...(workflow.isArchived === undefined ? {} : { isArchived: workflow.isArchived }),
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings,
    sensitiveWorkflowData: {
      pinDataReturned: false,
      staticDataReturned: false,
      pinDataPresent: sensitiveDataExcluded
        ? "not_requested"
        : workflow.pinData !== undefined && workflow.pinData !== null,
      staticDataPresent: sensitiveDataExcluded
        ? "not_requested"
        : workflow.staticData !== undefined && workflow.staticData !== null,
    },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  // Use a null-prototype object so a literal "__proto__" data key becomes an own property
  // instead of invoking the prototype setter (which would silently drop it from the canonical
  // form and blind the post-write preservation comparisons). JSON.stringify still serializes it.
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

function equivalent(left: unknown, right: unknown): boolean {
  assertBoundedDepth(left, MAX_WORKFLOW_JSON_DEPTH);
  assertBoundedDepth(right, MAX_WORKFLOW_JSON_DEPTH);
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function requireUniqueNode(nodes: readonly WorkflowNode[], nodeId: string): WorkflowNode {
  const matches = nodes.filter((node) => node.id === nodeId);
  if (matches.length === 0) throw new Error("The requested node ID was not found in the workflow.");
  if (matches.length > 1) throw new Error("The requested node ID is duplicated in the workflow.");
  const match = matches[0];
  if (!match) throw new Error("The requested node ID was not found in the workflow.");
  return match;
}

function assertUniqueWorkflowNodes(nodes: readonly WorkflowNode[]): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const node of nodes) {
    if (names.has(node.name)) throw new Error("Workflow node names must be unique.");
    names.add(node.name);
    if (node.id === undefined) continue;
    if (ids.has(node.id)) throw new Error("Defined workflow node IDs must be unique.");
    ids.add(node.id);
  }
}

function assertWorkflowGraphConsistent(
  nodes: readonly WorkflowNode[],
  connections: WorkflowConnections,
): void {
  const names = new Set(nodes.map((node) => node.name));
  for (const source of Object.keys(connections)) {
    if (!names.has(source)) throw new Error("Every workflow connection source must name a node.");
  }

  let visited = 0;
  for (const outputGroups of Object.values(connections)) {
    for (const branches of Object.values(outputGroups)) {
      for (const branch of branches) {
        for (const target of branch) {
          visited += 1;
          if (visited > 20_000) throw new Error("The workflow connection graph is too large.");
          if (!names.has(target.node)) {
            throw new Error("Every workflow connection target must name a node.");
          }
        }
      }
    }
  }
}

function readUnknownPath(target: Record<string, unknown>, segments: readonly string[]): unknown {
  let current: unknown = target;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index)) return undefined;
      current = current.at(index);
      continue;
    }
    if (!isRecord(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = Reflect.get(current, segment);
  }
  return current;
}

function assertSensitiveWorkflowDataPreserved(
  expectedPinData: unknown,
  expectedStaticData: unknown,
  after: Workflow,
  operationName: string,
): void {
  // n8n's PUT response may report absent pinned or static data as `null` even when the
  // pre-write GET omitted it (`undefined`). Both mean "no data", so normalize the nullish
  // pair before comparing; a genuine change (no-data -> data, or data -> different data)
  // still fails closed.
  const normalizeNullish = (value: unknown): unknown =>
    value === undefined || value === null ? null : value;
  if (
    !equivalent(normalizeNullish(expectedPinData), normalizeNullish(after.pinData)) ||
    !equivalent(normalizeNullish(expectedStaticData), normalizeNullish(after.staticData))
  ) {
    throw new Error(
      `n8n did not preserve pinned or static workflow data in its response to ${operationName}. The workflow update may already have been applied and must be inspected immediately.`,
    );
  }
}

function assertWorkflowIdentity(workflow: Workflow, expectedId: string): void {
  if (workflow.id !== expectedId) {
    throw new Error("n8n returned a different workflow identity than requested.");
  }
}

function assertWorkflowStatePreserved(
  before: Workflow,
  after: Workflow,
  operationName: string,
): void {
  for (const key of ["active", "isArchived"] as const) {
    if (before[key] !== undefined && before[key] !== after[key]) {
      throw new Error(
        `n8n did not preserve the workflow ${key} state in its response to ${operationName}. The workflow update may already have been applied and must be inspected immediately.`,
      );
    }
  }
}

function assertWritableWorkflowDataLanded(
  expected: Readonly<Record<string, unknown>>,
  after: Workflow,
  operationName: string,
): void {
  const returned = after as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    if (!equivalent(value, returned[key])) {
      throw new Error(
        `n8n did not confirm the submitted ${key} value in its response to ${operationName}. The workflow update may already have been applied and must be inspected immediately.`,
      );
    }
  }
}

function diffSnapshot(value: unknown): DiffSnapshot {
  return historicalWorkflowSchema.parse(value);
}

interface DiffChange {
  readonly kind:
    | "workflow_name_changed"
    | "node_added"
    | "node_removed"
    | "node_modified"
    | "connections_changed";
  readonly nodeId?: string;
  readonly nodeName?: string;
  readonly nodeType?: string;
  readonly fields?: readonly string[];
  readonly parameterChanges?: readonly ParameterChange[];
  readonly parameterChangesTruncated?: true;
  readonly omittedParameterChanges?: number;
  readonly referenceChanged?: true;
  readonly changed?: true;
}

type DiffValueType = "array" | "boolean" | "null" | "number" | "object" | "string" | "unsupported";

interface ParameterState {
  readonly present: boolean;
  readonly type: DiffValueType | null;
}

interface ParameterChange {
  readonly path: readonly string[];
  readonly pathRedacted?: true;
  readonly before: ParameterState;
  readonly after: ParameterState;
  readonly changed: true;
}

interface PendingParameterChange {
  readonly beforePresent: boolean;
  readonly beforeValue: unknown;
  readonly afterPresent: boolean;
  readonly afterValue: unknown;
  readonly path: readonly string[];
  readonly pathRedacted: boolean;
}

const MAX_PARAMETER_PATH_SEGMENTS = 16;
const MAX_PARAMETER_CHANGE_DETAILS = 200;
// Fit the exact sanitized MCP success envelope with headroom below the shared 256 KiB
// transport ceiling. This accounts for NFKC expansion, redaction markers, selectors,
// summaries, coverage, omission metadata, and pretty-print indentation.
const MAX_WORKFLOW_DIFF_OUTPUT_BYTES = 128 * 1024;

function diffValueType(value: unknown): DiffValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isRecord(value)) return "object";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return "unsupported";
}

function parameterState(present: boolean, value: unknown): ParameterState {
  return {
    present,
    type: present ? diffValueType(value) : null,
  };
}

function collectParameterChanges(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  detailLimit: number,
): { readonly changes: readonly ParameterChange[]; readonly total: number } {
  const stack: PendingParameterChange[] = [];
  const rootKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (let index = rootKeys.length - 1; index >= 0; index -= 1) {
    const key = rootKeys[index];
    if (key === undefined) continue;
    const safeKey = sanitizePathSegmentForOutput(key);
    stack.push({
      beforePresent: Object.hasOwn(before, key),
      beforeValue: before[key],
      afterPresent: Object.hasOwn(after, key),
      afterValue: after[key],
      path: ["parameters", safeKey.value],
      pathRedacted: safeKey.redacted,
    });
  }

  const changes: ParameterChange[] = [];
  let total = 0;
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate) continue;
    const beforeType = candidate.beforePresent ? diffValueType(candidate.beforeValue) : undefined;
    const afterType = candidate.afterPresent ? diffValueType(candidate.afterValue) : undefined;

    if (
      candidate.beforePresent &&
      candidate.afterPresent &&
      beforeType === "object" &&
      afterType === "object" &&
      candidate.path.length < MAX_PARAMETER_PATH_SEGMENTS &&
      !candidate.pathRedacted
    ) {
      const beforeObject = candidate.beforeValue as Readonly<Record<string, unknown>>;
      const afterObject = candidate.afterValue as Readonly<Record<string, unknown>>;
      const keys = [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])].sort();
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        if (key === undefined) continue;
        const safeKey = sanitizePathSegmentForOutput(key);
        stack.push({
          beforePresent: Object.hasOwn(beforeObject, key),
          beforeValue: beforeObject[key],
          afterPresent: Object.hasOwn(afterObject, key),
          afterValue: afterObject[key],
          path: [...candidate.path, safeKey.value],
          pathRedacted: candidate.pathRedacted || safeKey.redacted,
        });
      }
      continue;
    }

    if (
      candidate.beforePresent === candidate.afterPresent &&
      equivalent(candidate.beforeValue, candidate.afterValue)
    ) {
      continue;
    }

    total += 1;
    if (changes.length >= detailLimit) continue;
    changes.push({
      path: candidate.path,
      ...(candidate.pathRedacted ? { pathRedacted: true } : {}),
      before: parameterState(candidate.beforePresent, candidate.beforeValue),
      after: parameterState(candidate.afterPresent, candidate.afterValue),
      changed: true,
    });
  }
  return { changes, total };
}

function withParameterDetails(
  change: DiffChange,
  parameterChanges: readonly ParameterChange[],
): DiffChange {
  const originalParameterChanges = change.parameterChanges;
  const originalOmittedParameterChanges = change.omittedParameterChanges;
  const totalParameterChanges =
    (originalParameterChanges?.length ?? 0) + (originalOmittedParameterChanges ?? 0);
  const omittedParameterChanges = totalParameterChanges - parameterChanges.length;
  return {
    kind: change.kind,
    ...(change.nodeId === undefined ? {} : { nodeId: change.nodeId }),
    ...(change.nodeName === undefined ? {} : { nodeName: change.nodeName }),
    ...(change.nodeType === undefined ? {} : { nodeType: change.nodeType }),
    ...(change.fields === undefined ? {} : { fields: change.fields }),
    ...(change.referenceChanged === undefined ? {} : { referenceChanged: change.referenceChanged }),
    ...(change.changed === undefined ? {} : { changed: change.changed }),
    parameterChanges,
    ...(omittedParameterChanges > 0
      ? {
          parameterChangesTruncated: true as const,
          omittedParameterChanges,
        }
      : {}),
  };
}

function workflowDiffOutput(
  base: Readonly<Record<string, unknown>>,
  totalChanges: number,
  changes: readonly DiffChange[],
): Record<string, unknown> {
  return {
    ...base,
    changes,
    truncated: changes.length < totalChanges,
    omittedDetails: totalChanges - changes.length,
  };
}

function changesFitOutputBudget(
  base: Readonly<Record<string, unknown>>,
  totalChanges: number,
  changes: readonly DiffChange[],
): boolean {
  try {
    boundedJson(
      sanitizeForOutput(workflowDiffOutput(base, totalChanges, changes)),
      MAX_WORKFLOW_DIFF_OUTPUT_BYTES,
    );
    return true;
  } catch {
    return false;
  }
}

function fitChangesToOutputBudget(
  base: Readonly<Record<string, unknown>>,
  changes: readonly DiffChange[],
): Record<string, unknown> {
  const totalChanges = changes.length;
  const candidates = changes.slice(0, 200);
  const fitted: DiffChange[] = [];
  for (const change of candidates) {
    if (change.parameterChanges === undefined) {
      if (!changesFitOutputBudget(base, totalChanges, [...fitted, change])) break;
      fitted.push(change);
      continue;
    }

    let acceptedParameterChanges: readonly ParameterChange[] = [];
    let candidate = withParameterDetails(change, acceptedParameterChanges);
    if (!changesFitOutputBudget(base, totalChanges, [...fitted, candidate])) break;
    for (const parameterChange of change.parameterChanges) {
      const nextParameterChanges = [...acceptedParameterChanges, parameterChange];
      const nextCandidate = withParameterDetails(change, nextParameterChanges);
      if (!changesFitOutputBudget(base, totalChanges, [...fitted, nextCandidate])) break;
      acceptedParameterChanges = nextParameterChanges;
      candidate = nextCandidate;
    }
    fitted.push(candidate);
  }
  return workflowDiffOutput(base, totalChanges, fitted);
}

function computeWorkflowDiff(
  from: DiffSnapshot,
  to: DiffSnapshot,
  ignoreLayout: boolean,
): {
  readonly summary: Readonly<Record<string, unknown>>;
  readonly comparisonCoverage: Readonly<Record<string, unknown>>;
  readonly changes: readonly DiffChange[];
} {
  const fromNodes = new Map(from.nodes.map((node) => [node.id, node]));
  const toNodes = new Map(to.nodes.map((node) => [node.id, node]));
  if (fromNodes.has(undefined) || toNodes.has(undefined)) {
    throw new Error("Every compared node must have a stable ID.");
  }
  if (fromNodes.size !== from.nodes.length || toNodes.size !== to.nodes.length) {
    throw new Error("Compared node IDs must be unique within each workflow snapshot.");
  }

  const changes: DiffChange[] = [];
  const namesComparable = typeof from.name === "string" && typeof to.name === "string";
  const workflowNameChanged = namesComparable ? from.name !== to.name : null;
  if (workflowNameChanged) changes.push({ kind: "workflow_name_changed", changed: true });
  const ids = [...new Set([...fromNodes.keys(), ...toNodes.keys()])]
    .filter((value): value is string => value !== undefined)
    .sort();
  let added = 0;
  let removed = 0;
  let modified = 0;
  let remainingParameterDetails = MAX_PARAMETER_CHANGE_DETAILS;

  for (const id of ids) {
    const before = fromNodes.get(id);
    const after = toNodes.get(id);
    if (!before && after) {
      added += 1;
      changes.push({ kind: "node_added", nodeId: id, nodeName: after.name, nodeType: after.type });
      continue;
    }
    if (before && !after) {
      removed += 1;
      changes.push({
        kind: "node_removed",
        nodeId: id,
        nodeName: before.name,
        nodeType: before.type,
      });
      continue;
    }
    if (!before || !after) continue;
    const fields: string[] = [];
    if (before.name !== after.name) fields.push("name");
    if (before.type !== after.type) fields.push("type");
    if (before.typeVersion !== after.typeVersion) fields.push("typeVersion");
    const parametersChanged = !equivalent(before.parameters, after.parameters);
    if (parametersChanged) fields.push("parameters");
    const credentialsChanged = !equivalent(before.credentials ?? {}, after.credentials ?? {});
    if (credentialsChanged) {
      fields.push("credentialReferences");
    }
    if ((before.disabled ?? false) !== (after.disabled ?? false)) fields.push("disabled");
    if (!ignoreLayout && !equivalent(before.position, after.position)) fields.push("position");
    const beforeRecord = before as unknown as Record<string, unknown>;
    const afterRecord = after as unknown as Record<string, unknown>;
    if (!equivalent(beforeRecord.webhookId, afterRecord.webhookId)) fields.push("webhookId");
    for (const field of MUTABLE_NODE_ROOTS) {
      if (field === "parameters" || field === "position" || field === "disabled") continue;
      const beforeValue = beforeRecord[field];
      const afterValue = afterRecord[field];
      const bothSemanticallyFalse =
        DEFAULT_FALSE_NODE_FIELDS.has(field) &&
        (beforeValue === undefined || beforeValue === false) &&
        (afterValue === undefined || afterValue === false);
      if (!bothSemanticallyFalse && !equivalent(beforeValue, afterValue)) fields.push(field);
    }
    if (fields.length > 0) {
      modified += 1;
      const parameterDiff = parametersChanged
        ? collectParameterChanges(
            before.parameters,
            after.parameters,
            Math.max(0, remainingParameterDetails),
          )
        : undefined;
      remainingParameterDetails -= parameterDiff?.changes.length ?? 0;
      const omittedParameterChanges =
        parameterDiff === undefined ? 0 : parameterDiff.total - parameterDiff.changes.length;
      changes.push({
        kind: "node_modified",
        nodeId: id,
        nodeName: after.name,
        nodeType: after.type,
        fields,
        ...(parameterDiff === undefined
          ? {}
          : {
              parameterChanges: parameterDiff.changes,
              ...(omittedParameterChanges > 0
                ? {
                    parameterChangesTruncated: true as const,
                    omittedParameterChanges,
                  }
                : {}),
            }),
        ...(credentialsChanged ? { referenceChanged: true as const } : {}),
      });
    }
  }

  const connectionsChanged = !equivalent(from.connections, to.connections);
  if (connectionsChanged) changes.push({ kind: "connections_changed", changed: true });
  return {
    summary: {
      workflowNameChanged,
      nodesAdded: added,
      nodesRemoved: removed,
      nodesModified: modified,
      connectionsChanged,
      totalChanges: changes.length,
    },
    comparisonCoverage: {
      name: namesComparable ? "compared" : "unavailable_in_snapshot",
      nodes: "compared",
      connections: "compared",
      description: "unavailable_historical_api",
      settings: "unavailable_historical_api",
      pinData: "unavailable_historical_api",
      staticData: "unavailable_historical_api",
      nodeGroups: "unavailable_historical_api",
    },
    changes,
  };
}

function asHistoricalCurrent(workflow: Workflow): DiffSnapshot {
  return historicalWorkflowSchema.parse({
    workflowId: workflow.id,
    versionId: workflow.versionId ?? "current",
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
  });
}

function historicalWorkflowForOutput(workflow: DiffSnapshot): Record<string, unknown> {
  return {
    workflowId: workflow.workflowId,
    versionId: workflow.versionId,
    ...(typeof workflow.name === "string" ? { name: workflow.name } : {}),
    nodes: workflow.nodes,
    connections: workflow.connections,
  };
}

function assertHistoricalWorkflowIdentity(
  workflow: DiffSnapshot,
  expectedWorkflowId: string,
  expectedVersionId: string,
): void {
  if (workflow.workflowId !== expectedWorkflowId || workflow.versionId !== expectedVersionId) {
    throw new Error("n8n returned a different workflow version identity than requested.");
  }
}

export const workflowTools: readonly ToolDefinition[] = Object.freeze([
  defineTool({
    name: "n8n_workflows_list",
    title: "List workflows",
    description:
      "List one page of workflows visible to the configured API key. Use it for unsearched discovery; use n8n_search_workflows for local substring matching or n8n_workflows_get when the ID is known. Returns projected workflows and a cursor, never pin/static values.",
    operation: "read-only",
    outputDataDescription:
      "Object with data (up to 100 projected workflows) and nextCursor (string or null). Each workflow includes structure/state plus pinDataPresent and staticDataPresent presence markers, but never pinned or static values.",
    input: {
      active: z
        .boolean()
        .optional()
        .describe("When supplied, return only active or inactive workflows."),
      tags: z
        .string()
        .max(512)
        .optional()
        .describe("Optional n8n Public API tag filter (up to 512 characters)."),
      name: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe("Optional workflow-name filter passed to n8n (1-128 characters)."),
      excludePinnedData: z
        .boolean()
        .default(true)
        .describe(
          "Ask n8n to omit pinned values; values are withheld from output regardless (default true).",
        ),
      limit: pageLimit(),
      cursor: cursor.optional(),
    },
    handler: async (input, context) => {
      const result = workflowListSchema.parse(
        await context.client().request({
          path: "/workflows",
          query: {
            active: booleanQuery(input.active),
            tags: input.tags,
            name: input.name,
            excludePinnedData: booleanQuery(input.excludePinnedData),
            limit: numberQuery(input.limit),
            cursor: input.cursor,
          },
        }),
      );
      return {
        data: result.data.map((workflow) => workflowForOutput(workflow, input.excludePinnedData)),
        nextCursor: result.nextCursor ?? null,
      };
    },
  }),
  defineTool({
    name: "n8n_workflows_get",
    title: "Get workflow",
    description:
      "Get one current workflow by stable ID for inspection or reviewed editing. Use n8n_workflows_get_version for retained history or n8n_workflows_list for discovery. Returns structure, state, settings, and presence flags; pin/static values are always withheld.",
    operation: "read-only",
    outputDataDescription:
      "Current workflow projection with id, optional versionId/description/state, name, nodes, connections, settings, and pinDataPresent/staticDataPresent markers. Pinned and static values are never returned.",
    input: {
      workflowId: identifier("Stable ID of the current workflow to retrieve."),
      excludePinnedData: z
        .boolean()
        .default(true)
        .describe(
          "Ask n8n to omit pinned values; values are withheld from output regardless (default true).",
        ),
    },
    handler: async (input, context) =>
      workflowForOutput(
        workflowSchema.parse(
          await context.client().request({
            path: `/workflows/${pathSegment(input.workflowId)}`,
            query: { excludePinnedData: booleanQuery(input.excludePinnedData) },
          }),
        ),
        input.excludePinnedData,
      ),
  }),
  defineTool({
    name: "n8n_workflows_create",
    title: "Create workflow",
    description:
      "Create one workflow from a complete validated definition. Use it for a new workflow; use n8n_workflows_update for an existing workflow and n8n_workflows_activate separately for triggers. Validates the graph and returns a projection without pin/static values.",
    operation: "write",
    outputDataDescription:
      "Created workflow projection with id, optional versionId/description/state, name, nodes, connections, settings, and withheld pin/static presence markers. Pinned and static values are never returned.",
    input: {
      name: z.string().min(1).max(128).describe("Workflow name (1-128 characters)."),
      description: z
        .string()
        .max(16_384)
        .optional()
        .describe("Optional workflow description (up to 16,384 characters)."),
      nodes: z
        .array(nodeSchema)
        .min(1)
        .max(1_000)
        .describe(
          "Complete non-empty node array with unique names; supplied IDs, when present, must also be unique.",
        ),
      connections: connectionsSchema.describe(
        "Complete connection graph keyed by existing node names.",
      ),
      settings: z
        .record(z.unknown())
        .default({})
        .describe("Workflow settings object (default empty object)."),
      nodeGroups: z
        .array(safeJsonValue)
        .max(1_000)
        .optional()
        .describe("Optional node-group array containing safe JSON values."),
      staticData: staticDataSchema
        .optional()
        .describe("Optional static workflow data; accepted for creation but never returned."),
      pinData: z
        .record(z.unknown())
        .nullable()
        .optional()
        .describe("Optional pinned-data map or null; accepted for creation but never returned."),
    },
    handler: async (input, context) => {
      assertSafeJson(input);
      assertUniqueWorkflowNodes(input.nodes);
      assertWorkflowGraphConsistent(input.nodes, input.connections);
      const created = workflowSchema.parse(
        await context.client().request({ method: "POST", path: "/workflows", body: input }),
      );
      assertUniqueWorkflowNodes(created.nodes);
      assertWorkflowGraphConsistent(created.nodes, created.connections);
      return workflowForOutput(created);
    },
  }),
  defineTool({
    name: "n8n_workflows_update",
    title: "Update workflow",
    description:
      "Update selected top-level workflow fields while preserving omitted writable fields. Use n8n_update_node for one node property and n8n_workflows_update_tags for tag assignments. Requires the current versionId, performs a non-atomic full PUT, and returns the confirmed projection.",
    operation: "write",
    outputDataDescription:
      "Confirmed updated workflow projection with id, version/state, name, optional description, nodes, connections, settings, and withheld pin/static presence markers. Omitted writable fields come from the immediate pre-write read.",
    destructive: true,
    input: {
      workflowId: identifier("Stable ID of the workflow to update."),
      expectedVersionId: identifier(
        "Current workflow versionId that must still match before the PUT.",
      ),
      ...workflowWriteFields,
    },
    handler: async (input, context) => {
      if (
        [
          input.name,
          input.description,
          input.nodes,
          input.connections,
          input.settings,
          input.pinData,
          input.staticData,
          input.nodeGroups,
        ].every((value) => value === undefined)
      ) {
        throw new Error("Provide at least one workflow field to update.");
      }
      assertSafeJson(input);
      if (input.nodes !== undefined) assertUniqueWorkflowNodes(input.nodes);
      const client = context.client();
      const current = workflowSchema.parse(
        await client.request({ path: `/workflows/${pathSegment(input.workflowId)}` }),
      );
      assertWorkflowIdentity(current, input.workflowId);
      assertUniqueWorkflowNodes(current.nodes);
      assertWorkflowVersionIdentitySupported(current, "n8n_workflows_update");
      if (current.versionId !== input.expectedVersionId) {
        throw new Error("The workflow version changed before the workflow update began.");
      }
      const immediatelyCurrent = workflowSchema.parse(
        await client.request({ path: `/workflows/${pathSegment(input.workflowId)}` }),
      );
      assertWorkflowIdentity(immediatelyCurrent, input.workflowId);
      assertUniqueWorkflowNodes(immediatelyCurrent.nodes);
      if (immediatelyCurrent.versionId !== input.expectedVersionId) {
        throw new Error("The workflow changed before the non-atomic update could be sent.");
      }
      const body = writableWorkflow(immediatelyCurrent);
      for (const key of [
        "name",
        "description",
        "nodes",
        "connections",
        "settings",
        "pinData",
        "staticData",
        "nodeGroups",
      ] as const) {
        if (input[key] !== undefined) body[key] = structuredClone(input[key]);
      }
      const bodyNodes = z.array(nodeSchema).parse(body.nodes);
      const bodyConnections = connectionsSchema.parse(body.connections);
      assertUniqueWorkflowNodes(bodyNodes);
      assertWorkflowGraphConsistent(bodyNodes, bodyConnections);
      const updated = workflowSchema.parse(
        await client.request({
          method: "PUT",
          path: `/workflows/${pathSegment(input.workflowId)}`,
          body,
        }),
      );
      assertWorkflowIdentity(updated, input.workflowId);
      assertUniqueWorkflowNodes(updated.nodes);
      assertWorkflowGraphConsistent(updated.nodes, updated.connections);
      assertWorkflowStatePreserved(immediatelyCurrent, updated, "n8n_workflows_update");
      assertWritableWorkflowDataLanded(body, updated, "n8n_workflows_update");
      assertSensitiveWorkflowDataPreserved(
        body.pinData,
        body.staticData,
        updated,
        "n8n_workflows_update",
      );
      return workflowForOutput(updated);
    },
  }),
  defineTool({
    name: "n8n_update_node",
    title: "Update one workflow node",
    description:
      "Update one validated mutable property on one workflow node while preserving the rest. Use it instead of n8n_workflows_update for a single-node change; use the full update for top-level or multi-node edits. Requires version/risk guards and returns the path plus non-atomic risk.",
    operation: "write",
    outputDataDescription:
      "Object with workflowId, versionId, nodeId, path, updated=true, atomic=false, and residualRisk describing the Public API's non-atomic full-workflow PUT limitation.",
    destructive: true,
    input: {
      workflowId: identifier("Stable ID of the workflow containing the target node."),
      nodeId: identifier("Unique stable ID of the single node to update."),
      path: z
        .string()
        .min(1)
        .max(512)
        .describe(
          "Allowed dot path under a mutable node field, such as parameters.url or disabled.",
        ),
      value: requiredSafeJsonValue.describe("Safe JSON value to write at the selected node path."),
      expectedVersionId: identifier(
        "Current workflow versionId that must still match before the PUT.",
      ),
      acknowledgeNonAtomicRisk: z
        .literal(true)
        .describe("Must be true to acknowledge that n8n exposes a non-atomic full-workflow PUT."),
    },
    handler: async (input, context) => {
      const segments = validateDotPath(input.path);
      const root = segments[0];
      if (root === undefined || !isMutableNodeRoot(root)) {
        throw new Error("The update path targets an immutable or unsupported node field.");
      }
      assertSafeJson(input.value);
      const client = context.client();
      const current = workflowSchema.parse(
        await client.request({ path: `/workflows/${pathSegment(input.workflowId)}` }),
      );
      assertWorkflowIdentity(current, input.workflowId);
      assertUniqueWorkflowNodes(current.nodes);
      assertWorkflowVersionIdentitySupported(current, "n8n_update_node");
      if (current.versionId !== input.expectedVersionId) {
        throw new Error("The workflow version changed before the node update began.");
      }
      requireUniqueNode(current.nodes, input.nodeId);
      assertWorkflowGraphConsistent(current.nodes, current.connections);
      const immediatelyCurrent = workflowSchema.parse(
        await client.request({ path: `/workflows/${pathSegment(input.workflowId)}` }),
      );
      assertWorkflowIdentity(immediatelyCurrent, input.workflowId);
      assertUniqueWorkflowNodes(immediatelyCurrent.nodes);
      if (immediatelyCurrent.versionId !== input.expectedVersionId) {
        throw new Error("The workflow changed before the non-atomic update could be sent.");
      }
      assertWorkflowGraphConsistent(immediatelyCurrent.nodes, immediatelyCurrent.connections);
      const body = writableWorkflow(immediatelyCurrent);
      const bodyNodes = z.array(nodeSchema).parse(body.nodes);
      const target = requireUniqueNode(bodyNodes, input.nodeId);
      setUnknownPath(target, segments, structuredClone(input.value));
      assertMutatedNodeValid(target, root);
      body.nodes = bodyNodes;
      assertWorkflowGraphConsistent(bodyNodes, connectionsSchema.parse(body.connections));
      const updated = workflowSchema.parse(
        await client.request({
          method: "PUT",
          path: `/workflows/${pathSegment(input.workflowId)}`,
          body,
        }),
      );
      assertWorkflowIdentity(updated, input.workflowId);
      assertUniqueWorkflowNodes(updated.nodes);
      assertWorkflowGraphConsistent(updated.nodes, updated.connections);
      assertWorkflowStatePreserved(immediatelyCurrent, updated, "n8n_update_node");
      assertWritableWorkflowDataLanded(body, updated, "n8n_update_node");
      assertSensitiveWorkflowDataPreserved(
        immediatelyCurrent.pinData,
        immediatelyCurrent.staticData,
        updated,
        "n8n_update_node",
      );
      const updatedTarget = requireUniqueNode(updated.nodes, input.nodeId);
      if (!equivalent(readUnknownPath(updatedTarget, segments), input.value)) {
        throw new Error(
          "n8n did not confirm the requested node value in its response. The workflow update may already have been applied and must be inspected immediately.",
        );
      }
      return {
        workflowId: updated.id,
        versionId: updated.versionId,
        nodeId: input.nodeId,
        path: input.path,
        updated: true,
        atomic: false,
        residualRisk:
          "The n8n Public API force-saves workflow updates and cannot provide atomic compare-and-swap protection.",
      };
    },
  }),
  defineTool({
    name: "n8n_workflows_delete",
    title: "Delete workflow",
    description:
      "Permanently delete one workflow and its saved definition. Use n8n_workflows_archive when reversible removal is sufficient and n8n_workflows_get for inspection. Unsafe mode and exact target confirmation are required; returns the ID with deleted=true.",
    operation: "unsafe",
    outputDataDescription:
      "Object with the validated input workflowId and deleted=true. Identity is bound to the request and does not rely on an upstream response body.",
    input: { workflowId: identifier("Stable ID of the workflow to delete."), confirmation },
    confirmation: (input) => ({
      supplied: input.confirmation,
      expected: `DELETE ${input.workflowId}`,
    }),
    handler: async (input, context) => {
      await context
        .client()
        .request({ method: "DELETE", path: `/workflows/${pathSegment(input.workflowId)}` });
      return { workflowId: input.workflowId, deleted: true };
    },
  }),
  ...(["activate", "deactivate"] as const).map((action) =>
    defineTool({
      name: `n8n_workflows_${action}`,
      title: `${action === "activate" ? "Activate" : "Deactivate"} workflow`,
      description:
        action === "activate"
          ? "Activate one workflow so production triggers can accept future events. Use it only after n8n_workflows_get review; use n8n_workflows_deactivate to stop future triggers. Unsafe mode and exact confirmation are required; returns allowlisted state metadata."
          : "Deactivate one workflow's production triggers without deleting saved data or stopping current work. Use n8n_workflows_activate to reverse this state or n8n_workflows_archive for lifecycle removal. Unsafe mode and exact confirmation are required; returns state metadata.",
      operation: "unsafe",
      outputDataDescription:
        action === "activate"
          ? "Target-bound workflow metadata with required id and active=true; optional name, type, archive state, versionId, and timestamps are included when supplied by n8n, while all other fields are omitted."
          : "Target-bound workflow metadata with required id and active=false; optional name, type, archive state, versionId, and timestamps are included when supplied by n8n, while all other fields are omitted.",
      input: {
        workflowId: identifier(
          `Stable ID of the workflow to ${action === "activate" ? "activate" : "deactivate"}.`,
        ),
        confirmation,
      },
      confirmation: (input) => ({
        supplied: input.confirmation,
        expected: `${action.toUpperCase()} ${input.workflowId}`,
      }),
      handler: async (input, context) =>
        parseWorkflowLifecycleMetadata(
          await context.client().request({
            method: "POST",
            path: `/workflows/${pathSegment(input.workflowId)}/${action}`,
          }),
          input.workflowId,
          action,
        ),
    }),
  ),
  defineTool({
    name: "n8n_workflows_get_version",
    title: "Get workflow version",
    description:
      "Get one retained historical workflow snapshot. Use it when exact historical nodes/connections are needed; use n8n_workflows_get for current state or n8n_workflows_diff for value-free comparison. Returns validated identity and structure, subject to Community retention.",
    operation: "read-only",
    outputDataDescription:
      "Historical snapshot with workflowId, versionId, optional name, nodes, and connections. Historical settings, pin data, and static data are unavailable from the supported Public API.",
    input: {
      workflowId: identifier("Stable ID of the workflow whose retained history is requested."),
      versionId: identifier("Stable retained workflow version ID to retrieve."),
    },
    handler: async (input, context) => {
      const historical = historicalWorkflowSchema.parse(
        await fetchWorkflowVersion(
          context.client(),
          `/workflows/${pathSegment(input.workflowId)}/${pathSegment(input.versionId)}`,
        ),
      );
      assertHistoricalWorkflowIdentity(historical, input.workflowId, input.versionId);
      return historicalWorkflowForOutput(historical);
    },
  }),
  defineTool({
    name: "n8n_workflows_get_tags",
    title: "Get workflow tags",
    description:
      "List the tags currently assigned to one workflow. Use it before n8n_workflows_update_tags when assignments must be preserved; use n8n_tags_list to discover all available tags. Returns a bounded validated collection with exact truncation counts.",
    operation: "read-only",
    outputDataDescription:
      "Object with data (at most 100 validated tag records), totalCount, truncated, and exact omittedCount. Each tag may include id, name, createdAt, and updatedAt.",
    input: {
      workflowId: identifier("Stable ID of the workflow whose tag assignments are requested."),
    },
    handler: async (input, context) =>
      boundedTagCollection(
        await context
          .client()
          .request({ path: `/workflows/${pathSegment(input.workflowId)}/tags` }),
      ),
  }),
  defineTool({
    name: "n8n_workflows_update_tags",
    title: "Update workflow tags",
    description:
      "Replace the complete tag assignment for one workflow; this is not a merge. Use n8n_workflows_get_tags first to preserve existing assignments and n8n_tags_create for a missing tag; an empty array clears all tags. Returns n8n's validated assignment.",
    operation: "write",
    outputDataDescription:
      "Array of at most 100 validated tag records returned by n8n after replacing the workflow's complete assignment. An empty returned array represents no assigned tags.",
    destructive: true,
    input: {
      workflowId: identifier(
        "Stable ID of the workflow whose complete tag assignment will be replaced.",
      ),
      tagIds: z
        .array(identifier("Stable workflow tag ID to assign."))
        .max(100)
        .describe(
          "Complete replacement list of up to 100 tag IDs; an empty array clears all assignments.",
        ),
    },
    handler: async (input, context) =>
      z
        .array(tagSchema)
        .max(100)
        .parse(
          await context.client().request({
            method: "PUT",
            path: `/workflows/${pathSegment(input.workflowId)}/tags`,
            body: input.tagIds.map((id) => ({ id })),
          }),
        ),
  }),
  ...(["archive", "unarchive"] as const).map((action) =>
    defineTool({
      name: `n8n_workflows_${action}`,
      title: `${action === "archive" ? "Archive" : "Unarchive"} workflow`,
      description:
        action === "archive"
          ? "Archive one workflow without deleting it. Use it instead of n8n_workflows_delete when reversible lifecycle removal is required; use n8n_workflows_deactivate only to stop triggers. Unsafe mode and exact confirmation are required; returns archive state."
          : "Restore one archived workflow without activating it. Use it to reverse n8n_workflows_archive; call n8n_workflows_activate separately only if triggers should resume. Unsafe mode and exact confirmation are required; returns archive state.",
      operation: "unsafe",
      outputDataDescription:
        action === "archive"
          ? "Target-bound workflow metadata with required id and isArchived=true; optional name, type, active state, versionId, and timestamps are included when supplied by n8n, while all other fields are omitted."
          : "Target-bound workflow metadata with required id and isArchived=false; optional name, type, active state, versionId, and timestamps are included when supplied by n8n, while all other fields are omitted.",
      input: {
        workflowId: identifier(
          `Stable ID of the workflow to ${action === "archive" ? "archive" : "restore from archive"}.`,
        ),
        confirmation,
      },
      confirmation: (input) => ({
        supplied: input.confirmation,
        expected: `${action.toUpperCase()} ${input.workflowId}`,
      }),
      handler: async (input, context) =>
        parseWorkflowLifecycleMetadata(
          await context.client().request({
            method: "POST",
            path: `/workflows/${pathSegment(input.workflowId)}/${action}`,
          }),
          input.workflowId,
          action,
        ),
    }),
  ),
  defineTool({
    name: "n8n_workflows_diff",
    title: "Compare workflow versions",
    description:
      "Compare one retained workflow version with another or current state. Use it for value-free review; use n8n_workflows_get_version when raw historical structure is needed. Returns counts, coverage, and up to 200 changes; unavailable historical fields are explicit.",
    operation: "read-only",
    outputDataDescription:
      "Value-free comparison with workflowId, from/to selectors, comparisonCoverage, summary counts, byte-budgeted changes (up to 200), truncated, and exact omittedDetails. Modified nodes name changed fields; parameterChanges expose only sanitized paths, presence, value types, changed=true, and exact truncation metadata, while credential changes expose only referenceChanged=true. Raw values and webhook identifiers are never returned.",
    input: {
      workflowId: identifier("Stable ID of the workflow whose versions will be compared."),
      fromVersionId: identifier("Retained baseline version ID for the comparison."),
      toVersionId: identifier(
        "Optional retained target version ID; omit to compare with current.",
      ).optional(),
      ignoreLayout: z
        .boolean()
        .default(true)
        .describe("Ignore node position-only changes when true (default true)."),
    },
    handler: async (input, context) => {
      if (input.toVersionId === input.fromVersionId) {
        throw new Error("The two explicit workflow version selectors must differ.");
      }
      const client = context.client();
      const from = diffSnapshot(
        await fetchWorkflowVersion(
          client,
          `/workflows/${pathSegment(input.workflowId)}/${pathSegment(input.fromVersionId)}`,
        ),
      );
      assertHistoricalWorkflowIdentity(from, input.workflowId, input.fromVersionId);
      let to: DiffSnapshot;
      if (input.toVersionId) {
        to = diffSnapshot(
          await fetchWorkflowVersion(
            client,
            `/workflows/${pathSegment(input.workflowId)}/${pathSegment(input.toVersionId)}`,
          ),
        );
        assertHistoricalWorkflowIdentity(to, input.workflowId, input.toVersionId);
      } else {
        to = asHistoricalCurrent(
          workflowSchema.parse(
            await client.request({
              path: `/workflows/${pathSegment(input.workflowId)}`,
              query: { excludePinnedData: booleanQuery(true) },
            }),
          ),
        );
      }
      if (from.workflowId !== input.workflowId || to.workflowId !== input.workflowId) {
        throw new Error("A workflow snapshot did not belong to the requested workflow.");
      }
      const computed = computeWorkflowDiff(from, to, input.ignoreLayout);
      const base = {
        workflowId: input.workflowId,
        fromVersionId: input.fromVersionId,
        toVersionId: input.toVersionId ?? "current",
        ignoreLayout: input.ignoreLayout,
        summary: computed.summary,
        comparisonCoverage: computed.comparisonCoverage,
      };
      return fitChangesToOutputBudget(base, computed.changes);
    },
  }),
]);
