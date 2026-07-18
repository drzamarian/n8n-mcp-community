import { z } from "zod";
import { cursor } from "./schemas.js";

export const apiIdentifier = z.union([z.string(), z.number()]).transform(String);

export const entitySchema = z.object({ id: apiIdentifier }).passthrough();

export const listEnvelopeSchema = z
  .object({
    data: z.array(z.record(z.unknown())).max(100),
    nextCursor: cursor.nullable().optional(),
  })
  .passthrough();

export function booleanQuery(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

export function numberQuery(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

export function requireSafeAscii(value: string, label: string, maximumLength = 256): string {
  if (
    value.length < 1 ||
    value.length > maximumLength ||
    !/^[\x20-\x7e]+$/.test(value) ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must contain 1-${maximumLength} trimmed printable ASCII characters.`);
  }
  return value;
}

export function projectMetadata(value: unknown): Record<string, unknown> {
  const source = z.record(z.unknown()).parse(value);
  const allowed = [
    "id",
    "name",
    "type",
    "active",
    "isArchived",
    "createdAt",
    "updatedAt",
    "versionId",
    "workflowId",
    "status",
    "startedAt",
    "stoppedAt",
    "mode",
    "finished",
    "retryOf",
    "retrySuccessId",
    "role",
    "disabled",
  ] as const;
  const output: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.hasOwn(source, key)) output[key] = source[key];
  }
  return output;
}
