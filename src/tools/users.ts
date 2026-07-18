import { z } from "zod";
import { defineTool, type ToolDefinition } from "./definition.js";
import { booleanQuery, numberQuery } from "./common.js";
import { confirmation, cursor, identifier, pageLimit, pathSegment } from "./schemas.js";

const email = z.string().email().max(254);
const userLookup = z.union([identifier, email]);
const userSchema = z.object({
  id: identifier,
  email: email.optional(),
  firstName: z.string().max(128).nullable().optional(),
  lastName: z.string().max(128).nullable().optional(),
  role: z.string().max(128).optional(),
  disabled: z.boolean().optional(),
  isPending: z.boolean().optional(),
  createdAt: z.string().max(64).optional(),
  updatedAt: z.string().max(64).optional(),
});
const userListSchema = z.object({
  data: z.array(userSchema).max(100),
  nextCursor: cursor.nullable().optional(),
});

function encodedLookup(value: string): string {
  return identifier.safeParse(value).success
    ? pathSegment(value)
    : encodeURIComponent(email.parse(value));
}

export const userTools: readonly ToolDefinition[] = Object.freeze([
  defineTool({
    name: "n8n_users_list",
    title: "List users",
    description: "List users visible through the n8n Public API.",
    operation: "read-only",
    input: {
      includeRole: z.boolean().default(true),
      limit: pageLimit(),
      cursor: cursor.optional(),
    },
    handler: async (input, context) =>
      userListSchema.parse(
        await context.client().request({
          path: "/users",
          query: {
            includeRole: booleanQuery(input.includeRole),
            limit: numberQuery(input.limit),
            cursor: input.cursor,
          },
        }),
      ),
  }),
  defineTool({
    name: "n8n_users_get",
    title: "Get user",
    description: "Get one user by stable ID or exact email address.",
    operation: "read-only",
    input: { userIdOrEmail: userLookup, includeRole: z.boolean().default(true) },
    handler: async (input, context) =>
      userSchema.parse(
        await context.client().request({
          path: `/users/${encodedLookup(input.userIdOrEmail)}`,
          query: { includeRole: booleanQuery(input.includeRole) },
        }),
      ),
  }),
  defineTool({
    name: "n8n_users_create",
    title: "Invite user",
    description: "Invite one non-owner user after exact email confirmation.",
    operation: "unsafe",
    input: {
      email,
      role: z.enum(["global:member", "global:admin"]).default("global:member"),
      confirmation,
    },
    confirmation: (input) => ({ supplied: input.confirmation, expected: `INVITE ${input.email}` }),
    handler: async (input, context) => {
      await context.client().request({
        method: "POST",
        path: "/users",
        body: [{ email: input.email, role: input.role }],
      });
      return { invited: true, email: input.email, role: input.role };
    },
  }),
  defineTool({
    name: "n8n_users_delete",
    title: "Delete user",
    description:
      "Delete one API-eligible user after exact confirmation. Ownership handling follows n8n's supported Public API behavior.",
    operation: "unsafe",
    input: { userId: identifier, confirmation },
    confirmation: (input) => ({ supplied: input.confirmation, expected: `DELETE ${input.userId}` }),
    handler: async (input, context) => {
      await context.client().request({
        method: "DELETE",
        path: `/users/${pathSegment(input.userId)}`,
      });
      return { userId: input.userId, deleted: true };
    },
  }),
]);
