import { z } from "zod";
import { defineTool, type ToolDefinition } from "./definition.js";
import { numberQuery } from "./common.js";
import { confirmation, cursor, identifier, pageLimit, pathSegment, tagName } from "./schemas.js";

const tagSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(256),
    createdAt: z.string().max(64).optional(),
    updatedAt: z.string().max(64).optional(),
  })
  .strict();
const tagListSchema = z.object({
  data: z.array(tagSchema).max(100),
  nextCursor: cursor.nullable().optional(),
});

export const tagTools: readonly ToolDefinition[] = Object.freeze([
  defineTool({
    name: "n8n_tags_list",
    title: "List tags",
    description: "List workflow tags.",
    operation: "read-only",
    input: { limit: pageLimit(), cursor: cursor.optional() },
    handler: async (input, context) =>
      tagListSchema.parse(
        await context.client().request({
          path: "/tags",
          query: { limit: numberQuery(input.limit), cursor: input.cursor },
        }),
      ),
  }),
  defineTool({
    name: "n8n_tags_get",
    title: "Get tag",
    description: "Get one workflow tag by ID.",
    operation: "read-only",
    input: { tagId: identifier },
    handler: async (input, context) =>
      tagSchema.parse(
        await context.client().request({ path: `/tags/${pathSegment(input.tagId)}` }),
      ),
  }),
  defineTool({
    name: "n8n_tags_create",
    title: "Create tag",
    description: "Create a workflow tag.",
    operation: "write",
    input: { name: tagName },
    handler: async (input, context) =>
      tagSchema.parse(
        await context
          .client()
          .request({ method: "POST", path: "/tags", body: { name: input.name } }),
      ),
  }),
  defineTool({
    name: "n8n_tags_update",
    title: "Update tag",
    description: "Rename one workflow tag.",
    operation: "write",
    input: { tagId: identifier, name: tagName },
    handler: async (input, context) =>
      tagSchema.parse(
        await context.client().request({
          method: "PUT",
          path: `/tags/${pathSegment(input.tagId)}`,
          body: { name: input.name },
        }),
      ),
  }),
  defineTool({
    name: "n8n_tags_delete",
    title: "Delete tag",
    description: "Permanently delete one workflow tag after exact confirmation.",
    operation: "unsafe",
    input: { tagId: identifier, confirmation },
    confirmation: (input) => ({ supplied: input.confirmation, expected: `DELETE ${input.tagId}` }),
    handler: async (input, context) => {
      await context
        .client()
        .request({ method: "DELETE", path: `/tags/${pathSegment(input.tagId)}` });
      return { tagId: input.tagId, deleted: true };
    },
  }),
]);
