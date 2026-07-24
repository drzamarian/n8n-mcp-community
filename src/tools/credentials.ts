import { z } from "zod";
import { defineTool, type ToolDefinition } from "./definition.js";
import { booleanQuery, numberQuery } from "./common.js";
import {
  assertSafeJson,
  confirmation,
  cursor,
  identifier,
  pageLimit,
  pathSegment,
  safeJsonValue,
} from "./schemas.js";
import { credentialTypeSchema } from "./response-contracts.js";

const credentialMetadataSchema = z.object({
  id: identifier(),
  name: z.string().min(1).max(256),
  type: z.string().min(1).max(256),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  isManaged: z.boolean().optional(),
  isGlobal: z.boolean().optional(),
  isResolvable: z.boolean().optional(),
});

const credentialTypeIdentifier = z
  .string()
  .regex(
    /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,128}$/,
    "Use 1-128 ASCII letters, digits, dots, underscores, or hyphens; '.' and '..' are not allowed.",
  )
  .describe(
    "Public n8n credential type: 1-128 ASCII letters, digits, dots, underscores, or hyphens.",
  );

function credentialTypePathSegment(value: string): string {
  return encodeURIComponent(credentialTypeIdentifier.parse(value));
}

const credentialListSchema = z.object({
  data: z.array(credentialMetadataSchema).max(100),
  nextCursor: cursor.nullable().optional(),
});

// n8n's canonical node credential reference is { id: string | null; name: string }, and legacy
// imports can carry name-only strings or unresolved null ids. Coerce any shape to a bounded
// { id } so a single unresolved reference can never abort the whole page scan; unresolved
// references (null/absent/non-scalar id, or a legacy string form) are counted but never matched.
const workflowCredentialReferenceSchema = z
  .unknown()
  .transform((reference): { readonly id: string | null } => {
    if (reference !== null && typeof reference === "object" && !Array.isArray(reference)) {
      const { id } = reference as Record<string, unknown>;
      if (typeof id === "string" || typeof id === "number") return { id: String(id) };
    }
    return { id: null };
  });

const usageWorkflowSchema = z.object({
  id: identifier(),
  name: z.string().min(1).max(256),
  active: z.boolean(),
  nodes: z
    .array(
      z.object({
        id: identifier().optional(),
        name: z.string().min(1).max(256),
        type: z.string().min(1).max(256),
        credentials: z.record(workflowCredentialReferenceSchema).optional(),
      }),
    )
    .max(1_000),
});

const usageListSchema = z.object({
  data: z.array(usageWorkflowSchema).max(100),
  nextCursor: cursor.nullable().optional(),
});

export const credentialTools: readonly ToolDefinition[] = Object.freeze([
  defineTool({
    name: "n8n_credentials_create",
    title: "Create credential",
    description:
      "Create one credential from a supported public schema. Use n8n_credentials_schema first; use n8n_credentials_update when the credential already exists. Secret values belong only in input and are excluded from logs and output; returns metadata only.",
    operation: "write",
    outputDataDescription:
      "Validated credential metadata with id, name, type, optional timestamps, managed/global flags, and resolvability. Stored credential values are never returned.",
    input: {
      name: z
        .string()
        .min(1)
        .max(128)
        .describe("Human-readable credential name (1-128 characters)."),
      type: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,128}$/)
        .describe("Public n8n credential type returned by n8n_credentials_schema."),
      data: z
        .record(safeJsonValue)
        .describe("Credential field values matching the selected public schema; never returned."),
      isResolvable: z
        .boolean()
        .optional()
        .describe("Optional n8n resolvability flag for credential types that support it."),
    },
    handler: async (input, context) => {
      assertSafeJson(input.data);
      return credentialMetadataSchema.parse(
        await context.client().request({ method: "POST", path: "/credentials", body: input }),
      );
    },
  }),
  defineTool({
    name: "n8n_credentials_delete",
    title: "Delete credential",
    description:
      "Permanently delete one stored credential, which can break referencing workflows. Use n8n_credentials_usage first; use n8n_credentials_update when replacement is sufficient. Unsafe mode and exact confirmation are required; returns the ID with deleted=true.",
    operation: "unsafe",
    outputDataDescription:
      "Object with the validated input credentialId and deleted=true. Identity is bound to the request because n8n does not consistently return the deleted credential ID.",
    input: { credentialId: identifier("Stable ID of the credential to delete."), confirmation },
    confirmation: (input) => ({
      supplied: input.confirmation,
      expected: `DELETE ${input.credentialId}`,
    }),
    handler: async (input, context) => {
      await context
        .client()
        .request({ method: "DELETE", path: `/credentials/${pathSegment(input.credentialId)}` });
      return { credentialId: input.credentialId, deleted: true };
    },
  }),
  defineTool({
    name: "n8n_credentials_schema",
    title: "Get credential schema",
    description:
      "Get the Public API field schema for one credential type. Use it before n8n_credentials_create or replacement-data updates; use n8n_credentials_get for stored metadata. Returns schema fields supplied by n8n, never stored secret values.",
    operation: "read-only",
    outputDataDescription:
      "Validated Public API schema object for the requested credential type. It describes accepted fields and constraints but never contains stored credential values.",
    input: {
      credentialType: credentialTypeIdentifier,
    },
    handler: async (input, context) =>
      credentialTypeSchema.parse(
        await context.client().request({
          path: `/credentials/schema/${credentialTypePathSegment(input.credentialType)}`,
        }),
      ),
  }),
  defineTool({
    name: "n8n_credentials_list",
    title: "List credentials",
    description:
      "List one page of credential metadata through the endpoint supported from n8n Community 2.30.5. Use it for discovery; use n8n_credentials_get when the ID is known. Returns metadata and a cursor, never credential values.",
    operation: "read-only",
    outputDataDescription:
      "Object with data (up to 100 credential metadata records) and nextCursor (string or null). Records contain allowlisted metadata only; credential values are rejected.",
    input: { limit: pageLimit(), cursor: cursor.optional() },
    handler: async (input, context) => {
      const page = credentialListSchema.parse(
        await context.client().request({
          path: "/credentials",
          query: { limit: numberQuery(input.limit), cursor: input.cursor },
        }),
      );
      return { ...page, nextCursor: page.nextCursor ?? null };
    },
  }),
  defineTool({
    name: "n8n_credentials_get",
    title: "Get credential",
    description:
      "Get public metadata for one stored credential. Use it when the ID is known; use n8n_credentials_list for discovery and n8n_credentials_schema for type fields. Returns validated metadata without retrieving secret values.",
    operation: "read-only",
    outputDataDescription:
      "One validated credential metadata record with id, name, type, optional timestamps, managed/global flags, and resolvability; no stored credential values.",
    input: { credentialId: identifier("Stable ID of the credential metadata to retrieve.") },
    handler: async (input, context) =>
      credentialMetadataSchema.parse(
        await context.client().request({ path: `/credentials/${pathSegment(input.credentialId)}` }),
      ),
  }),
  defineTool({
    name: "n8n_credentials_update",
    title: "Update credential",
    description:
      "Update selected metadata or values on an existing credential. Use n8n_credentials_schema for data fields; use n8n_credentials_create for a new credential. Supply at least one field, and data when changing type; returns metadata without secret values.",
    operation: "write",
    outputDataDescription:
      "Updated credential metadata with id, name, type, optional timestamps, managed/global flags, and resolvability. Supplied credential values are never echoed.",
    destructive: true,
    input: {
      credentialId: identifier("Stable ID of the credential to update."),
      name: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe("Replacement human-readable credential name (1-128 characters)."),
      type: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,128}$/)
        .optional()
        .describe("Replacement public credential type; requires replacement data when supplied."),
      data: z
        .record(safeJsonValue)
        .optional()
        .describe("Replacement or partial credential field values; never returned."),
      isGlobal: z.boolean().optional().describe("Optional replacement for the n8n global flag."),
      isResolvable: z
        .boolean()
        .optional()
        .describe("Optional replacement for the n8n resolvability flag."),
      isPartialData: z
        .boolean()
        .default(false)
        .describe(
          "Treat supplied data as partial rather than complete replacement data (default false).",
        ),
    },
    handler: async (input, context) => {
      if (
        input.name === undefined &&
        input.type === undefined &&
        input.data === undefined &&
        input.isGlobal === undefined &&
        input.isResolvable === undefined
      ) {
        throw new Error("Provide at least one credential field to update.");
      }
      if (input.type !== undefined && input.data === undefined) {
        throw new Error("Changing a credential type also requires replacement credential data.");
      }
      if (input.data !== undefined) assertSafeJson(input.data);
      return credentialMetadataSchema.parse(
        await context.client().request({
          method: "PATCH",
          path: `/credentials/${pathSegment(input.credentialId)}`,
          body: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.type === undefined ? {} : { type: input.type }),
            ...(input.data === undefined ? {} : { data: input.data }),
            ...(input.isGlobal === undefined ? {} : { isGlobal: input.isGlobal }),
            ...(input.isResolvable === undefined ? {} : { isResolvable: input.isResolvable }),
            isPartialData: input.isPartialData,
          },
        }),
      );
    },
  }),
  defineTool({
    name: "n8n_credentials_test",
    title: "Test credential",
    description:
      "Test one stored credential by allowing n8n to contact its external service. Use n8n_credentials_get for metadata-only inspection; do not call this when network contact is unwanted. Unsafe mode and exact confirmation are required; returns a bounded value-free status.",
    operation: "unsafe",
    outputDataDescription:
      "Object with credentialId, bounded status (at most 64 characters), optional message (at most 512 characters), and truncated=true when either upstream string was shortened.",
    openWorld: true,
    input: {
      credentialId: identifier("Stable ID of the stored credential to test."),
      confirmation,
    },
    confirmation: (input) => ({
      supplied: input.confirmation,
      expected: `TEST ${input.credentialId}`,
    }),
    handler: async (input, context) => {
      // The external test already ran by the time this response arrives, so an over-long
      // status/message must be truncated rather than rejected: discarding a completed outcome
      // would report a generic error for a side effect that genuinely happened.
      const raw = z.object({ status: z.string(), message: z.string().optional() }).parse(
        await context.client().request({
          method: "POST",
          path: `/credentials/${pathSegment(input.credentialId)}/test`,
        }),
      );
      const status = raw.status.slice(0, 64);
      const message = raw.message === undefined ? undefined : raw.message.slice(0, 512);
      const truncated =
        status.length < raw.status.length ||
        (raw.message !== undefined && message !== undefined && message.length < raw.message.length);
      return {
        credentialId: input.credentialId,
        status,
        ...(message === undefined ? {} : { message }),
        ...(truncated ? { truncated: true } : {}),
      };
    },
  }),
  defineTool({
    name: "n8n_credentials_usage",
    title: "Find credential usage",
    description:
      "Scan one bounded workflow page for exact references to a credential ID. Use it before n8n_credentials_update or deletion; use n8n_credentials_get for metadata only. Continue nextCursor for full coverage; returns matching workflows/nodes and unresolved counts.",
    operation: "read-only",
    outputDataDescription:
      "Object with credentialId, workflowsExamined, matchingWorkflowCount, workflows with at most 200 total node details and 20 per workflow, nextCursor, scanComplete, truncation counts, referencesScanned, and referencesUnresolved.",
    input: {
      credentialId: identifier("Stable credential ID whose workflow references should be found."),
      cursor: cursor.optional(),
      limit: pageLimit(100, 50),
      active: z
        .boolean()
        .optional()
        .describe("When supplied, scan only active or inactive workflows."),
    },
    handler: async (input, context) => {
      const page = usageListSchema.parse(
        await context.client().request({
          path: "/workflows",
          query: {
            cursor: input.cursor,
            limit: numberQuery(input.limit),
            active: booleanQuery(input.active),
            excludePinnedData: "true",
          },
        }),
      );
      const matches: Array<Record<string, unknown>> = [];
      let matchingWorkflowCount = 0;
      let omittedNodeDetails = 0;
      let retainedNodeDetails = 0;
      let referencesScanned = 0;
      let referencesUnresolved = 0;
      for (const workflow of page.data) {
        for (const node of workflow.nodes) {
          for (const reference of Object.values(node.credentials ?? {})) {
            referencesScanned += 1;
            if (reference.id === null) referencesUnresolved += 1;
          }
        }
        const nodes = workflow.nodes.filter((node) =>
          Object.values(node.credentials ?? {}).some(
            (reference) => reference.id === input.credentialId,
          ),
        );
        if (nodes.length === 0) continue;
        matchingWorkflowCount += 1;
        const available = Math.max(0, 200 - retainedNodeDetails);
        const details = nodes.slice(0, Math.min(20, available));
        retainedNodeDetails += details.length;
        omittedNodeDetails += nodes.length - details.length;
        matches.push({
          workflowId: workflow.id,
          workflowName: workflow.name,
          active: workflow.active,
          matchingNodeCount: nodes.length,
          nodes: details.map((node) => ({
            nodeId: node.id ?? null,
            nodeName: node.name,
            nodeType: node.type,
          })),
          detailsTruncated: details.length < nodes.length,
        });
      }
      return {
        credentialId: input.credentialId,
        workflowsExamined: page.data.length,
        matchingWorkflowCount,
        workflows: matches,
        nextCursor: page.nextCursor ?? null,
        scanComplete: page.nextCursor === undefined || page.nextCursor === null,
        truncated: omittedNodeDetails > 0,
        omittedNodeDetails,
        referencesScanned,
        referencesUnresolved,
      };
    },
  }),
]);
