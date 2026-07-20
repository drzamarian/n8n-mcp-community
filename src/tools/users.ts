import { z } from "zod";
import { defineTool, type ToolDefinition } from "./definition.js";
import { booleanQuery, numberQuery } from "./common.js";
import {
  confirmation,
  cursor,
  encodePathSegment,
  identifier,
  pageLimit,
  pathSegment,
} from "./schemas.js";

const email = z.string().email().max(254);
const userLookup = z.union([identifier(), email]);
const userSchema = z.object({
  id: identifier(),
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
const invitationResultSchema = z
  .object({
    user: z
      .object({
        id: identifier(),
        email,
        role: z.enum(["global:member", "global:admin"]).optional(),
        emailSent: z.boolean(),
        inviteAcceptUrl: z.string().url().max(4_096).optional(),
      })
      .optional(),
    error: z.string().max(4_096).optional(),
  })
  .passthrough();
const invitationResponseSchema = z.array(invitationResultSchema).max(1);

function encodedLookup(value: string): string {
  return identifier().safeParse(value).success
    ? pathSegment(value)
    : encodePathSegment(email.parse(value));
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
      const response = invitationResponseSchema.parse(
        await context.client().request({
          method: "POST",
          path: "/users",
          body: [{ email: input.email, role: input.role }],
        }),
      );
      const invitation = response[0];
      if (
        !invitation?.user ||
        invitation.error?.trim() ||
        invitation.user.email.toLowerCase() !== input.email.toLowerCase() ||
        (invitation.user.role !== undefined && invitation.user.role !== input.role)
      ) {
        throw new Error(
          "n8n did not confirm the requested invitation. A pending user may already have been created; inspect n8n before retrying.",
        );
      }
      const delivery = invitation.user.emailSent
        ? "email_sent"
        : invitation.user.inviteAcceptUrl
          ? "manual_link_available_in_n8n"
          : "not_delivered";
      return {
        userCreated: true,
        invited: delivery !== "not_delivered",
        userId: invitation.user.id,
        email: invitation.user.email,
        requestedRole: input.role,
        roleConfirmedByResponse: invitation.user.role === input.role,
        emailSent: invitation.user.emailSent,
        delivery,
        inviteAcceptUrlReturned: false,
      };
    },
  }),
  defineTool({
    name: "n8n_users_delete",
    title: "Delete user",
    description:
      "Delete one API-eligible user after exact confirmation. Ownership handling follows n8n's supported Public API behavior.",
    operation: "unsafe",
    input: { userId: identifier(), confirmation },
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
