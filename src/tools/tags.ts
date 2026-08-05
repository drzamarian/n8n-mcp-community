import { z } from "zod";
import { defineTool, type ToolDefinition } from "./definition.js";
import { numberQuery } from "./common.js";
import { cursor, identifier, pageLimit, pathSegment, tagName } from "./schemas.js";

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
      "List one Public API page of workflow tags. Omit cursor for page one; for later pages, pass nextCursor back unchanged. limit sizes only the current page, so continue until nextCursor is null for complete coverage. Use n8n_tags_get when the stable tag ID is known. Requires tag-list permission and never changes assignments; returns validated metadata and nextCursor.",
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
      "Get one workflow tag. tagId is the stable tag identity returned by n8n_tags_list or create; a tag name or workflow ID is not accepted. Use it before assigning, renaming, or deleting the tag. The ID identifies the reusable tag itself, not an assignment, so this call neither lists nor changes assigned workflows. Requires tag-read permission; returns validated ID, name, and optional timestamps.",
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
      "Create and persist one reusable workflow label as an additive write. name is the literal display label, not a tag ID or workflow assignment; it must already be trimmed. Duplicate-name handling belongs to n8n, and creation never assigns the tag to a workflow. Use n8n_tags_update for an existing tag and n8n_workflows_update_tags to assign it. Requires write/unsafe mode plus create permission; returns validated metadata.",
    operation: "write",
    outputDataDescription:
      "Created tag record with validated id, name, and optional createdAt/updatedAt timestamps.",
    destructive: false,
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
      "Rename one existing workflow tag while preserving its ID and assignments. tagId is the stable selector from n8n_tags_list or get; name is the complete new display label, not another ID. Duplicate-name acceptance belongs to n8n. Use n8n_tags_create for a new label and n8n_workflows_update_tags to change assignments. Requires write/unsafe mode plus tag-update permission; returns validated metadata.",
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
      "Permanently delete one workflow tag, which can remove that label from many workflows. tagId must be the stable ID from n8n_tags_list or get; a tag name or workflow ID is not accepted. Review the target and affected workflows first, or use n8n_tags_update when a rename is enough. No rollback is provided. Requires unsafe mode plus tag-delete permission; returns the request-bound tagId with deleted=true.",
    operation: "unsafe",
    outputDataDescription:
      "Object with the validated input tagId and deleted=true. Identity is bound to the request and does not rely on an upstream response body.",
    input: { tagId: identifier("Stable ID of the workflow tag to delete.") },
    handler: async (input, context) => {
      await context
        .client()
        .request({ method: "DELETE", path: `/tags/${pathSegment(input.tagId)}` });
      return { tagId: input.tagId, deleted: true };
    },
  }),
]);
