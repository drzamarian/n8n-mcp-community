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
      "List one Public API page of workflow tags. Use it to discover stable tag IDs; use n8n_tags_get when the ID is already known. cursor resumes the prior page and limit bounds only this request, so continue nextCursor until null when complete coverage matters. Requires tag-list permission and never changes assignments; returns validated metadata and nextCursor.",
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
      "Get one workflow tag by stable ID. Use it to verify a known target before assigning, renaming, or deleting it; use n8n_tags_list for discovery. tagId identifies the reusable tag itself, not a workflow assignment, so this call neither lists nor changes assigned workflows. Requires tag-read permission; returns validated ID, name, and optional timestamps.",
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
      "Create and persist one workflow tag as an additive write. Use it for a new reusable label; use n8n_tags_update when the tag exists and n8n_workflows_update_tags to assign it. name must already be trimmed, and duplicate-name handling belongs to n8n; creation never changes any workflow assignment. Requires write/unsafe mode plus tag-create permission; returns validated metadata.",
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
      "Rename one existing workflow tag while preserving its stable ID and current assignments. Use n8n_tags_create for a new label and n8n_workflows_update_tags to change assignments. tagId selects the existing record and name is its complete replacement; duplicate-name acceptance belongs to n8n. Requires write/unsafe mode plus tag-update permission; returns validated metadata.",
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
      "Permanently delete one workflow tag, which can remove that label from multiple workflows. Use n8n_tags_get plus affected-workflow review first; use n8n_tags_update when a rename is sufficient. No rollback is provided. Requires unsafe mode plus tag-delete permission; returns the request-bound ID with deleted=true.",
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
