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

const credentialMetadataSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(256),
  type: z.string().min(1).max(256),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  isManaged: z.boolean().optional(),
  isGlobal: z.boolean().optional(),
  isResolvable: z.boolean().optional(),
});

const credentialListSchema = z.object({
  data: z.array(credentialMetadataSchema).max(100),
  nextCursor: cursor.nullable().optional(),
});

const workflowCredentialReferenceSchema = z
  .object({ id: z.union([z.string(), z.number()]).transform(String) })
  .passthrough();

const usageWorkflowSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(256),
  active: z.boolean(),
  nodes: z
    .array(
      z.object({
        id: identifier.optional(),
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
    description: "Create a credential while keeping credential values out of output and logs.",
    operation: "write",
    input: {
      name: z.string().min(1).max(128),
      type: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
      data: z.record(safeJsonValue),
      isResolvable: z.boolean().optional(),
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
    description: "Permanently delete one stored credential after exact confirmation.",
    operation: "unsafe",
    input: { credentialId: identifier, confirmation },
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
    description: "Get the supported public schema for one credential type.",
    operation: "read-only",
    input: { credentialType: identifier },
    handler: async (input, context) =>
      z.record(z.unknown()).parse(
        await context.client().request({
          path: `/credentials/schema/${pathSegment(input.credentialType)}`,
        }),
      ),
  }),
  defineTool({
    name: "n8n_credentials_list",
    title: "List credentials",
    description:
      "List credential metadata through the public endpoint verified in n8n Community 2.30.5 and 2.30.7. Credential values are never returned.",
    operation: "read-only",
    input: { limit: pageLimit(), cursor: cursor.optional() },
    handler: async (input, context) =>
      credentialListSchema.parse(
        await context.client().request({
          path: "/credentials",
          query: { limit: numberQuery(input.limit), cursor: input.cursor },
        }),
      ),
  }),
  defineTool({
    name: "n8n_credentials_get",
    title: "Get credential",
    description: "Get public metadata for one credential without retrieving secret values.",
    operation: "read-only",
    input: { credentialId: identifier },
    handler: async (input, context) =>
      credentialMetadataSchema.parse(
        await context.client().request({ path: `/credentials/${pathSegment(input.credentialId)}` }),
      ),
  }),
  defineTool({
    name: "n8n_credentials_update",
    title: "Update credential",
    description:
      "Update credential metadata or values while keeping secret material out of output and logs.",
    operation: "write",
    destructive: true,
    input: {
      credentialId: identifier,
      name: z.string().min(1).max(128).optional(),
      type: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,128}$/)
        .optional(),
      data: z.record(safeJsonValue).optional(),
      isGlobal: z.boolean().optional(),
      isResolvable: z.boolean().optional(),
      isPartialData: z.boolean().default(false),
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
    description: "Test one stored credential. This may contact the credential's external service.",
    operation: "unsafe",
    openWorld: true,
    input: { credentialId: identifier, confirmation },
    confirmation: (input) => ({
      supplied: input.confirmation,
      expected: `TEST ${input.credentialId}`,
    }),
    handler: async (input, context) => {
      const result = z
        .object({ status: z.string().max(64), message: z.string().max(512).optional() })
        .parse(
          await context.client().request({
            method: "POST",
            path: `/credentials/${pathSegment(input.credentialId)}/test`,
          }),
        );
      return { credentialId: input.credentialId, ...result };
    },
  }),
  defineTool({
    name: "n8n_credentials_usage",
    title: "Find credential usage",
    description: "Scan one bounded workflow page for exact references to one credential ID.",
    operation: "read-only",
    input: {
      credentialId: identifier,
      cursor: cursor.optional(),
      limit: pageLimit(100, 50),
      active: z.boolean().optional(),
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
      for (const workflow of page.data) {
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
      };
    },
  }),
]);
