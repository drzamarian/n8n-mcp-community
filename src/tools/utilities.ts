import { z } from "zod";
import {
  createN8nReadClient,
  inspectWorkflow,
  IntrospectInputError,
  IntrospectInputSchema,
  IntrospectOutputError,
  IntrospectResultSchema,
  renderIntrospect,
} from "../introspect/index.js";
import { sanitizeIntrospectResultForOutput } from "../introspect/sanitize.js";
import { NODE_DOCUMENTATION } from "../content/node-docs.js";
import { defineTool, type ToolDefinition } from "./definition.js";
import { booleanQuery, numberQuery, requireSafeAscii } from "./common.js";
import { cursor, identifier, pageLimit } from "./schemas.js";
import { compareCodeUnits } from "../introspect/order.js";
import { securityAuditSchema } from "./response-contracts.js";

const workflowSearchSchema = z.object({
  data: z
    .array(
      z.object({
        id: identifier(),
        name: z.string().min(1).max(256),
        active: z.boolean(),
        nodes: z.array(z.object({ type: z.string().min(1).max(256) }).passthrough()).max(1_000),
        tags: z
          .array(z.object({ name: z.string().min(1).max(256) }).passthrough())
          .max(100)
          .optional(),
      }),
    )
    .max(100),
  nextCursor: cursor.nullable().optional(),
});

const nodeInventoryPageSchema = z.object({
  data: z
    .array(
      z.object({
        id: identifier(),
        nodes: z.array(z.object({ type: z.string() }).passthrough()).max(1_000),
      }),
    )
    .max(100),
  nextCursor: cursor.nullable().optional(),
});

const communityPackageSchema = z.object({
  packageName: z.string().max(256).optional(),
  installedVersion: z.string().max(128).optional(),
  authorName: z.string().max(256).optional(),
  authorEmail: z.string().max(256).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

function boundedCommunityPackageCollection(value: unknown) {
  const raw = z.array(z.unknown()).max(10_000).parse(value);
  const data = z.array(communityPackageSchema).parse(raw.slice(0, 100));
  return {
    data,
    totalCount: raw.length,
    truncated: raw.length > data.length,
    omittedCount: raw.length - data.length,
  };
}

const insightsSchema = z
  .object({
    total: z.record(z.unknown()),
    failed: z.record(z.unknown()),
    failureRate: z.record(z.unknown()),
    timeSaved: z.record(z.unknown()),
    averageRunTime: z.record(z.unknown()),
  })
  .passthrough();

function includesQuery(value: string | undefined, query: string): boolean {
  return value?.toLocaleLowerCase("en-US").includes(query) ?? false;
}

export const utilityTools: readonly ToolDefinition[] = Object.freeze([
  defineTool({
    name: "n8n_health",
    title: "Check n8n health",
    description:
      "Perform one redirect-free same-origin /healthz request with a 10-second timeout. This tool accepts no arguments and requires the configured n8n URL and API key; remote plaintext HTTP also requires N8N_ALLOW_INSECURE_HTTP=1. Use it for HTTP reachability, then use n8n_workflows_list to test API-key capability. No workflow data is read or changed. Returns ok=true and the successful status, never the upstream body.",
    operation: "read-only",
    outputDataDescription:
      "Object with ok=true and the successful n8n health endpoint HTTP status. It proves bounded reachability, not authenticated Public API capability.",
    input: {},
    handler: async (_input, context) =>
      z.object({ ok: z.literal(true), status: z.number().int() }).parse(
        await context.client().request({
          path: "/healthz",
          root: true,
          responseMode: "status",
          timeoutMs: 10_000,
        }),
      ),
  }),
  defineTool({
    name: "n8n_insights_summary",
    title: "Get insights summary",
    description:
      "Get n8n's official instance insights aggregates. Use it when the Community endpoint exists; use n8n_introspect for one workflow's diagnostics. startDate and endDate are inclusive offset-aware bounds, and supplying both requires startDate <= endDate; omitting both requests n8n's default range. Requires insights-read permission and never fabricates unavailable metrics; returns totals, failures, rates, time saved, and runtime aggregates.",
    operation: "read-only",
    outputDataDescription:
      "Validated aggregate object with total, failed, failureRate, timeSaved, and averageRunTime records; additional upstream aggregate fields may be present and are sanitized.",
    input: {
      startDate: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("Inclusive range start as an ISO 8601 date-time with UTC offset."),
      endDate: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe(
          "Inclusive range end as an ISO 8601 date-time with UTC offset; not before startDate.",
        ),
    },
    handler: async (input, context) => {
      if (
        input.startDate !== undefined &&
        input.endDate !== undefined &&
        Date.parse(input.startDate) > Date.parse(input.endDate)
      ) {
        throw new Error("startDate must not be later than endDate.");
      }
      return insightsSchema.parse(
        await context.client().request({
          path: "/insights/summary",
          query: {
            startDate: input.startDate,
            endDate: input.endDate,
          },
        }),
      );
    },
  }),
  defineTool({
    name: "n8n_audit_generate",
    title: "Generate security audit",
    description:
      "Run n8n's broad, non-destructive instance security scan. Omit categories to use n8n's complete default, or supply the exact risk areas to include. daysAbandonedWorkflow is independent: it changes only the inactive-workflow age threshold and does not select categories. Use n8n_introspect for one workflow. Requires unsafe mode and owner-authorized API access; returns a sanitized but untrusted report without changing configuration.",
    operation: "unsafe",
    preserveValidatedRootRecordValues: true,
    outputDataDescription:
      "Map of upstream report titles to validated reports. Each report has one official risk category and bounded sections with recommendations plus typed locations or instance details; all content is sanitized and untrusted.",
    destructive: false,
    input: {
      categories: z
        .array(z.enum(["credentials", "database", "nodes", "filesystem", "instance"]))
        .max(5)
        .optional()
        .describe("Optional audit categories; omit to let n8n use its default complete selection."),
      daysAbandonedWorkflow: z
        .number()
        .int()
        .min(1)
        .max(3_650)
        .optional()
        .describe("Age threshold in days for classifying an inactive workflow as abandoned."),
    },
    handler: async (input, context) =>
      securityAuditSchema.parse(
        await context.client().request({
          method: "POST",
          path: "/audit",
          body:
            input.categories === undefined && input.daysAbandonedWorkflow === undefined
              ? {}
              : {
                  additionalOptions: {
                    ...(input.categories === undefined ? {} : { categories: input.categories }),
                    ...(input.daysAbandonedWorkflow === undefined
                      ? {}
                      : { daysAbandonedWorkflow: input.daysAbandonedWorkflow }),
                  },
                },
        }),
      ),
  }),
  defineTool({
    name: "n8n_search_workflows",
    title: "Search workflows",
    description:
      "Search one workflow page for a case-insensitive substring. query is matched locally only in the fields named by searchIn; active filters upstream first. Omit cursor for page one, then keep query, searchIn, active, and limit unchanged when passing nextCursor. This is not a global index; use n8n_workflows_list for an unsearched page. Requires workflow-list permission; returns at most 50 value-free matches and explicit scan state.",
    operation: "read-only",
    outputDataDescription:
      "Object with query, workflowsExamined, matches (up to 50 identity/state records with matchedIn scopes), nextCursor, scanComplete, and truncated. It covers one requested workflow page, not a global index.",
    input: {
      query: z
        .string()
        .trim()
        .min(2)
        .max(128)
        .describe("Case-insensitive substring to find (2-128 characters after trimming)."),
      searchIn: z
        .array(z.enum(["name", "nodes", "tags"]))
        .min(1)
        .max(3)
        .default(["name"])
        .describe(
          "Workflow fields to search locally: name, node type, or tag name (default name).",
        ),
      active: z
        .boolean()
        .optional()
        .describe(
          "When supplied, request only active or inactive workflows before local matching.",
        ),
      cursor: cursor.optional(),
      limit: pageLimit(100, 100),
    },
    handler: async (input, context) => {
      const page = workflowSearchSchema.parse(
        await context.client().request({
          path: "/workflows",
          query: {
            active: booleanQuery(input.active),
            cursor: input.cursor,
            limit: numberQuery(input.limit),
            excludePinnedData: "true",
          },
        }),
      );
      const query = input.query.toLocaleLowerCase("en-US");
      const allMatches = page.data
        .map((workflow) => {
          const matchedIn = input.searchIn.filter((scope) => {
            if (scope === "name") return includesQuery(workflow.name, query);
            if (scope === "nodes") {
              return workflow.nodes.some((node) => includesQuery(node.type, query));
            }
            return (workflow.tags ?? []).some((tag) => includesQuery(tag.name, query));
          });
          return {
            workflowId: workflow.id,
            workflowName: workflow.name,
            active: workflow.active,
            matchedIn,
          };
        })
        .filter((workflow) => workflow.matchedIn.length > 0);
      const matches = allMatches.slice(0, 50);
      return {
        query: input.query,
        workflowsExamined: page.data.length,
        matches,
        nextCursor: page.nextCursor ?? null,
        scanComplete: page.nextCursor === undefined || page.nextCursor === null,
        truncated: allMatches.length > matches.length,
      };
    },
  }),
  defineTool({
    name: "n8n_get_node_docs",
    title: "Get node documentation",
    description:
      "Return one immutable bundled reference. node is an exact local key—webhook, code, http-request, or if—not an arbitrary n8n node-type string. Use n8n_list_node_types to inventory observed types and official docs for anything else. Requires no n8n URL, API key, network, or elevated mode; it never follows the included URL. Returns source/fetched provenance, canonical type, title, summary, guidance, and official URL.",
    operation: "read-only",
    outputDataDescription:
      "Bundled reference with source=bundled_offline_reference, fetched=false, node type, title, concise summary/guidance, and official documentation URL. No network fetch occurs.",
    openWorld: false,
    input: {
      node: z
        .enum(["webhook", "code", "http-request", "if"])
        .describe("Bundled core-node reference to return: webhook, code, http-request, or if."),
    },
    handler: async (input) => ({
      source: "bundled_offline_reference",
      fetched: false,
      ...NODE_DOCUMENTATION[input.node],
    }),
  }),
  defineTool({
    name: "n8n_list_node_types",
    title: "List observed node types",
    description:
      "Inventory node types observed across workflow pages; this proves usage, not installation. Omit cursor to start at page one. maxPages limits how many pages this call follows; active and limit apply to every page, so keep them unchanged when continuing from nextCursor. Complete coverage requires starting at page one and reaching the end. Use n8n_get_node_docs for bundled references. Requires workflow-list permission; returns counts and exact coverage, capped at 30 seconds or 20,000 nodes.",
    operation: "read-only",
    outputDataDescription:
      "Observed-workflow inventory with scope/availabilityStatement, up to 500 sorted types and counts, page/workflow/node counters, coverage booleans, nextCursor, resultComplete, truncated, and omittedTypeCount.",
    input: {
      cursor: cursor.optional(),
      limit: pageLimit(100, 100),
      maxPages: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(4)
        .describe("Maximum consecutive workflow pages to scan in this call (1-10; default 4)."),
      active: z
        .boolean()
        .optional()
        .describe("When supplied, scan only active or inactive workflows."),
    },
    handler: async (input, context) => {
      const client = context.client();
      const deadlineAt = Date.now() + 30_000;
      const seenCursors = new Set<string>();
      if (input.cursor !== undefined) seenCursors.add(input.cursor);
      const inventory = new Map<string, { nodes: number; workflows: Set<string> }>();
      let nextCursor: string | null = input.cursor ?? null;
      let pagesScanned = 0;
      let workflowsScanned = 0;
      let nodesScanned = 0;
      let reachedEnd = false;

      while (pagesScanned < input.maxPages) {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0)
          throw new Error("The observed-node scan exceeded its shared deadline.");
        const page = nodeInventoryPageSchema.parse(
          await client.request({
            path: "/workflows",
            query: {
              cursor: nextCursor ?? undefined,
              limit: numberQuery(input.limit),
              active: booleanQuery(input.active),
              excludePinnedData: "true",
            },
            timeoutMs: Math.min(20_000, remainingMs),
          }),
        );
        pagesScanned += 1;
        workflowsScanned += page.data.length;
        for (const workflow of page.data) {
          const workflowTypes = new Set<string>();
          for (const node of workflow.nodes) {
            nodesScanned += 1;
            if (nodesScanned > 20_000) {
              throw new Error("The observed-node scan exceeded its 20,000-node budget.");
            }
            const type = requireSafeAscii(node.type, "Node type");
            const entry = inventory.get(type) ?? { nodes: 0, workflows: new Set<string>() };
            entry.nodes += 1;
            inventory.set(type, entry);
            workflowTypes.add(type);
          }
          for (const type of workflowTypes) inventory.get(type)?.workflows.add(workflow.id);
        }
        const cursorFromPage = page.nextCursor ?? null;
        if (cursorFromPage === null) {
          nextCursor = null;
          reachedEnd = true;
          break;
        }
        if (seenCursors.has(cursorFromPage)) {
          throw new Error("n8n returned a repeated workflow pagination cursor.");
        }
        seenCursors.add(cursorFromPage);
        nextCursor = cursorFromPage;
      }

      const allTypes = [...inventory.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([type, observed]) => ({
          type,
          observedNodeCount: observed.nodes,
          observedWorkflowCount: observed.workflows.size,
        }));
      const types = allTypes.slice(0, 500);
      const startedAtBeginning = input.cursor === undefined;
      return {
        scope: "observed_workflows",
        availabilityStatement: "Types not observed in this bounded scan have unknown availability.",
        types,
        pagesScanned,
        workflowsScanned,
        nodesScanned,
        startedAtBeginning,
        reachedEnd,
        nextCursor,
        resultComplete: startedAtBeginning && reachedEnd && types.length === allTypes.length,
        truncated: types.length < allTypes.length,
        omittedTypeCount: allTypes.length - types.length,
      };
    },
  }),
  defineTool({
    name: "n8n_introspect",
    title: "Inspect n8n workflow",
    description:
      "Inspect one workflow and saved executions with 23 deterministic local rules. profile sets paired defaults: quick uses 24h/20 and caps maxExecutions at 25; deep uses 168h/50 and reads at most four redacted details. includeSanitizedLabels=false keeps labels opaque; true opts into bounded sanitized labels. Use n8n_audit_generate for instance security or n8n_workflows_get for raw structure. Requires workflow/execution read permission; never executes or calls AI; returns findings and coverage.",
    operation: "read-only",
    outputDataDescription:
      "Direct Introspect result containing schema/engine versions, status, workflow facts, sample coverage, finding/rule counts, metrics, bounded findings, rule coverage, limitations, and guidance. Every top-level field has its own published schema description.",
    outputSchema: IntrospectResultSchema,
    formatResult: (value) => {
      // Validate the engine's own result as a local invariant: a mismatch is an internal
      // output failure (invalid_output), never upstream n8n response-shape drift.
      const parsedResult = IntrospectResultSchema.safeParse(value);
      if (!parsedResult.success) throw new IntrospectOutputError();
      const sanitizedResult = sanitizeIntrospectResultForOutput(parsedResult.data);
      const rendered = renderIntrospect(sanitizedResult);
      return {
        content: [
          { type: "text", text: rendered.summary },
          { type: "text", text: rendered.json },
        ],
        structuredContent: { ...sanitizedResult },
      };
    },
    input: {
      workflowId: identifier("Stable ID of the workflow to inspect without executing it."),
      profile: z
        .enum(["quick", "deep"])
        .default("quick")
        .describe(
          "Use quick for metadata triage or deep for up to four redacted execution details.",
        ),
      lookbackHours: z
        .number()
        .int()
        .min(1)
        .max(720)
        .optional()
        .describe("History window in hours; defaults to 24 for quick and 168 for deep."),
      maxExecutions: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Maximum saved executions to inspect; defaults to 20 for quick and 50 for deep, with quick capped at 25.",
        ),
      includeSanitizedLabels: z
        .boolean()
        .default(false)
        .describe(
          "Include bounded pattern-sanitized workflow/node labels instead of opaque identifiers only (default false).",
        ),
    },
    handler: async (input, context) => {
      // Local input validation (including the quick-profile execution-count rule) fails
      // closed as invalid_input before any n8n request, so it is never misreported as an
      // upstream response-shape mismatch.
      const parsedInput = IntrospectInputSchema.safeParse(input);
      if (!parsedInput.success) throw new IntrospectInputError();
      const parsed = parsedInput.data;
      const connection = context.connection();
      const readClient = createN8nReadClient({
        baseUrl: connection.apiUrl.href.replace(/\/$/, ""),
        apiKey: connection.apiKey,
      });
      return inspectWorkflow(readClient, parsed);
    },
  }),
  defineTool({
    name: "n8n_community_packages_list",
    title: "List community packages",
    description:
      "List bounded metadata for installed n8n community packages. This call accepts no arguments, filters, cursor, or limit; it keeps at most 100 endpoint records and reports exact omissions. Use n8n_list_node_types for types observed in workflows. It does not download or inspect contents. Requires package-list permission, never installs, updates, or removes packages, and returns untrusted metadata with author emails redacted.",
    operation: "read-only",
    outputDataDescription:
      "Object with data (at most 100 package metadata records), totalCount, truncated, and exact omittedCount. Records may include packageName, installedVersion, author metadata, and timestamps; author emails are redacted.",
    input: {},
    handler: async (_input, context) =>
      boundedCommunityPackageCollection(
        await context.client().request({ path: "/community-packages" }),
      ),
  }),
]);
