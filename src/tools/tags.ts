import { z } from "zod";
import { defineTool, type ToolDefinition } from "./definition.js";
import { numberQuery } from "./common.js";
import { confirmation, cursor, identifier, pageLimit, pathSegment, tagName } from "./schemas.js";

const tagSchema = z
  .object({
    id: identifier(),
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
    description:
      "List one page of workflow tags. Use it to discover stable tag IDs; use n8n_tags_get instead when the ID is already known. Returns validated tag metadata and an optional cursor for the next page.",
    operation: "read-only",
    outputDataDescription:
      "Object with data (up to 100 validated tag records) and nextCursor (string or null). Each tag includes id, name, and optional createdAt/updatedAt timestamps.",
    input: { limit: pageLimit(), cursor: cursor.optional() },
    handler: async (input, context) => {
      const page = tagListSchema.parse(
        await context.client().request({
          path: "/tags",
          query: { limit: numberQuery(input.limit), cursor: input.cursor },
        }),
      );
      return { ...page, nextCursor: page.nextCursor ?? null };
    },
  }),
  defineTool({
    name: "n8n_tags_get",
    title: "Get tag",
    description:
      "Get one workflow tag by its stable ID. Use it to verify a known tag before assigning, renaming, or deleting it; use n8n_tags_list for discovery. Returns validated tag metadata without changing workflows.",
    operation: "read-only",
    outputDataDescription:
      "One validated tag record with id, name, and optional createdAt/updatedAt timestamps.",
    input: { tagId: identifier("Stable ID of the workflow tag to retrieve.") },
    handler: async (input, context) =>
      tagSchema.parse(
        await context.client().request({ path: `/tags/${pathSegment(input.tagId)}` }),
      ),
  }),
  defineTool({
    name: "n8n_tags_create",
    title: "Create tag",
    description:
      "Create one workflow tag. Use it for a new reusable label; use n8n_tags_update when the tag already exists, and n8n_workflows_update_tags to assign it. Returns validated metadata and never assigns the new tag automatically.",
    operation: "write",
    outputDataDescription:
      "Created tag record with validated id, name, and optional createdAt/updatedAt timestamps.",
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
    description:
      "Rename one workflow tag without changing its stable ID or assignments. Use it for an existing tag; use n8n_tags_create for a new label and n8n_workflows_update_tags for assignments. Returns validated updated metadata.",
    operation: "write",
    outputDataDescription:
      "Updated tag record with validated id, name, and optional createdAt/updatedAt timestamps.",
    input: { tagId: identifier("Stable ID of the workflow tag to rename."), name: tagName },
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
    description:
      "Permanently delete one workflow tag. Use it only after n8n_tags_get and affected-workflow review; use n8n_tags_update when a rename is sufficient. Unsafe mode and exact confirmation are required; returns the ID with deleted=true.",
    operation: "unsafe",
    outputDataDescription:
      "Object with the validated input tagId and deleted=true. Identity is bound to the request and does not rely on an upstream response body.",
    input: { tagId: identifier("Stable ID of the workflow tag to delete."), confirmation },
    confirmation: (input) => ({ supplied: input.confirmation, expected: `DELETE ${input.tagId}` }),
    handler: async (input, context) => {
      await context
        .client()
        .request({ method: "DELETE", path: `/tags/${pathSegment(input.tagId)}` });
      return { tagId: input.tagId, deleted: true };
    },
  }),
]);
