import { z } from "zod";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const PROTOTYPE_SEGMENT = /^(?:__proto__|prototype|constructor)$/;
const MAX_SAFE_JSON_NODES = 20_000;
const MUTABLE_NODE_ROOTS = new Set([
  "parameters",
  "position",
  "disabled",
  "retryOnFail",
  "maxTries",
  "waitBetweenTries",
  "continueOnFail",
  "onError",
  "notes",
  "notesInFlow",
  "alwaysOutputData",
  "executeOnce",
]);

export const identifier = z
  .string()
  .regex(IDENTIFIER, "Use 1-128 ASCII letters, digits, underscores, or hyphens.");
export const cursor = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) => !CONTROL_CHARACTERS.test(value),
    "Cursor must not contain control characters.",
  );
export const pageLimit = (maximum = 100, defaultValue = maximum) =>
  z.number().int().min(1).max(maximum).default(defaultValue);
export const confirmation = z.string().min(1).max(300);
export const tagName = z
  .string()
  .min(1)
  .max(24)
  .refine((value) => value === value.trim(), "Tag name must not have surrounding whitespace.")
  .refine(
    (value) => !CONTROL_CHARACTERS.test(value),
    "Tag name must not contain control characters.",
  );

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assertSafeJson(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  let scheduled = 1;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    visited += 1;
    if (visited > MAX_SAFE_JSON_NODES || current.depth > 20) {
      throw new Error("The input exceeds the safe JSON complexity limit.");
    }
    if (Array.isArray(current.value)) {
      if (scheduled + current.value.length > MAX_SAFE_JSON_NODES) {
        throw new Error("The input exceeds the safe JSON complexity limit.");
      }
      scheduled += current.value.length;
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (isRecord(current.value)) {
      const entries = Object.entries(current.value);
      if (scheduled + entries.length > MAX_SAFE_JSON_NODES) {
        throw new Error("The input exceeds the safe JSON complexity limit.");
      }
      scheduled += entries.length;
      for (const [key, child] of entries) {
        if (PROTOTYPE_SEGMENT.test(key)) {
          throw new Error("Prototype-related object keys are not allowed.");
        }
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (current.value && typeof current.value === "object") {
      throw new Error("Only plain JSON-compatible objects are allowed.");
    }
  }
}

export const safeJsonValue = z.unknown().superRefine((value, context) => {
  try {
    assertSafeJson(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "The value is not safe JSON.",
    });
  }
});

export const requiredSafeJsonValue = safeJsonValue.refine(
  (value) => value !== undefined,
  "A JSON value is required.",
);

export function validateDotPath(path: string): readonly string[] {
  if (path.length < 1 || path.length > 512 || CONTROL_CHARACTERS.test(path)) {
    throw new Error("Each update path must contain 1-512 printable characters.");
  }
  const segments = path.split(".");
  if (segments.length > 16) throw new Error("Each update path may contain at most 16 segments.");
  for (const segment of segments) {
    if (!segment || segment.length > 64 || PROTOTYPE_SEGMENT.test(segment)) {
      throw new Error("The update path contains a forbidden segment.");
    }
    if (/^\d+$/.test(segment)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index > 1_000 || String(index) !== segment) {
        throw new Error("Array path indexes must be canonical integers from 0 through 1000.");
      }
    } else if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(segment)) {
      throw new Error("Object path segments contain unsupported characters.");
    }
  }
  const root = segments[0];
  if (!root || !MUTABLE_NODE_ROOTS.has(root)) {
    throw new Error("The update path targets an immutable or unsupported node field.");
  }
  if (
    root === "position" &&
    (segments.length !== 2 || (segments[1] !== "0" && segments[1] !== "1"))
  ) {
    throw new Error("Node position updates must target exactly position.0 or position.1.");
  }
  return segments;
}

function readChild(container: Record<string, unknown> | unknown[], segment: string): unknown {
  if (!Array.isArray(container)) return container[segment];
  if (!/^\d+$/.test(segment)) {
    throw new Error("Array values require numeric path segments.");
  }
  return container[Number(segment)];
}

function writeChild(
  container: Record<string, unknown> | unknown[],
  segment: string,
  value: unknown,
): void {
  if (!Array.isArray(container)) {
    container[segment] = value;
    return;
  }
  if (!/^\d+$/.test(segment)) {
    throw new Error("Array values require numeric path segments.");
  }
  container[Number(segment)] = value;
}

export function setUnknownPath(
  target: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  let current: Record<string, unknown> | unknown[] = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    if (segment === undefined || nextSegment === undefined)
      throw new Error("The update path is incomplete.");
    const existing = readChild(current, segment);
    if (existing === undefined) {
      const replacement: Record<string, unknown> | unknown[] = /^\d+$/.test(nextSegment) ? [] : {};
      writeChild(current, segment, replacement);
      current = replacement;
    } else if (Array.isArray(existing) || isRecord(existing)) {
      current = existing;
    } else {
      throw new Error("The update path would replace a non-container intermediate value.");
    }
  }
  const last = segments.at(-1);
  if (last === undefined) throw new Error("The update path is empty.");
  writeChild(current, last, value);
}

export function pathSegment(value: string): string {
  return encodeURIComponent(identifier.parse(value));
}
