import { z } from "zod";

function boundedRecord(valueSchema: z.ZodTypeAny, maximumKeys: number, maximumKeyLength: number) {
  return z.record(valueSchema).superRefine((value, context) => {
    const keys = Object.keys(value);
    if (keys.length > maximumKeys) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected no more than ${maximumKeys} keys.`,
      });
    }
    if (keys.some((key) => key.length > maximumKeyLength)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected keys no longer than ${maximumKeyLength} characters.`,
      });
    }
  });
}

function textArray() {
  return z.array(z.string()).max(1_000);
}

function credentialProperty() {
  return z
    .object({
      type: z.string(),
      enum: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .max(1_000)
        .optional(),
    })
    .strict();
}

function requiredFields() {
  return z
    .object({
      required: textArray(),
    })
    .strict();
}

function credentialDependency() {
  return z
    .object({
      if: z
        .object({
          properties: boundedRecord(z.record(z.unknown()), 1_000, 256),
          required: textArray().optional(),
        })
        .strict()
        .optional(),
      then: z
        .object({
          allOf: z.array(requiredFields()).max(1_000),
        })
        .strict()
        .optional(),
    })
    .strict();
}

/**
 * n8n Community 2.30.7 Public API credential-schema response.
 *
 * The root discriminators and generated property definitions are exact. Conditional JSON-Schema
 * keywords remain open only below `if.properties`, where n8n deliberately emits condition-specific
 * JSON-Schema fragments (enum, const, not, numeric bounds, or string patterns).
 */
export const credentialTypeSchema = z
  .object({
    additionalProperties: z.literal(false),
    type: z.literal("object"),
    properties: boundedRecord(credentialProperty(), 1_000, 256),
    allOf: z.array(credentialDependency()).max(1_000).optional(),
    required: textArray(),
  })
  .strict();

function credentialLocation() {
  return z
    .object({
      kind: z.literal("credential"),
      id: z.string(),
      name: z.string(),
    })
    .strict();
}

function nodeLocation() {
  return z
    .object({
      kind: z.literal("node"),
      workflowId: z.string(),
      workflowName: z.string(),
      nodeId: z.string(),
      nodeName: z.string(),
      nodeType: z.string(),
    })
    .strict();
}

function communityLocation() {
  return z
    .object({
      kind: z.literal("community"),
      nodeType: z.string(),
      packageUrl: z.string(),
    })
    .strict();
}

function customLocation() {
  return z
    .object({
      kind: z.literal("custom"),
      nodeType: z.string(),
      filePath: z.string(),
    })
    .strict();
}

function standardLocations() {
  return z.union([
    z.array(nodeLocation()).max(10_000),
    z.array(credentialLocation()).max(10_000),
    z.array(communityLocation()).max(10_000),
    z.array(customLocation()).max(10_000),
  ]);
}

function standardAuditSection() {
  return z
    .object({
      title: z.string(),
      description: z.string(),
      recommendation: z.string(),
      location: standardLocations(),
    })
    .strict();
}

function auditedWorkflowNode() {
  return z
    .object({
      name: z.string(),
      type: z.string(),
      typeVersion: z.number().finite(),
      position: z.array(z.number().finite()).length(2),
      parameters: z.record(z.unknown()),
      iconData: z
        .object({
          type: z.string(),
          fileBuffer: z.string(),
        })
        .strict()
        .optional(),
    })
    .passthrough();
}

function nextVersion() {
  return z
    .object({
      name: z.string(),
      nodes: z.array(auditedWorkflowNode()).max(1_000),
      createdAt: z.string(),
      description: z.string(),
      documentationUrl: z.string(),
      hasBreakingChange: z.boolean(),
      hasSecurityFix: z.boolean(),
      hasSecurityIssue: z.boolean(),
      securityIssueFixVersion: z.string(),
    })
    .strict();
}

function instanceAuditSection() {
  return z
    .object({
      title: z.string(),
      description: z.string(),
      recommendation: z.string(),
      location: z.array(nodeLocation()).max(10_000).optional(),
      settings: boundedRecord(z.unknown(), 10_000, 256).optional(),
      nextVersions: z.array(nextVersion()).max(1_000).optional(),
    })
    .strict();
}

function standardAuditReport() {
  return z
    .object({
      risk: z.enum(["database", "credentials", "nodes", "filesystem"]),
      sections: z.array(standardAuditSection()).max(10_000),
    })
    .strict();
}

function instanceAuditReport() {
  return z
    .object({
      risk: z.literal("instance"),
      sections: z.array(instanceAuditSection()).max(10_000),
    })
    .strict();
}

/**
 * n8n Community 2.30.7 Public API security-audit response.
 *
 * Report titles are upstream-defined map keys, while every report, section, and location is
 * discriminated by the official n8n audit types. Breadth limits keep validation deterministic.
 */
export const securityAuditSchema = boundedRecord(
  z.union([standardAuditReport(), instanceAuditReport()]),
  64,
  512,
);

export type WorkflowLifecycleAction = "activate" | "deactivate" | "archive" | "unarchive";

function workflowMetadataShape(idSchema: z.ZodTypeAny) {
  return {
    id: idSchema,
    name: z.string().max(256).nullable().optional(),
    type: z.string().max(256).nullable().optional(),
    active: z.boolean().nullable().optional(),
    isArchived: z.boolean().nullable().optional(),
    createdAt: z.string().max(64).nullable().optional(),
    updatedAt: z.string().max(64).nullable().optional(),
    versionId: z.string().nullable().optional(),
  };
}

function lifecycleSchema(action: WorkflowLifecycleAction, idSchema: z.ZodTypeAny) {
  const shape = workflowMetadataShape(idSchema);
  return action === "activate" || action === "deactivate"
    ? z.object({
        ...shape,
        active: z.literal(action === "activate"),
      })
    : z.object({
        ...shape,
        isArchived: z.literal(action === "archive"),
      });
}

/** Public output schema for one target-bound workflow lifecycle transition. */
export function workflowLifecycleMetadataSchema(action: WorkflowLifecycleAction): z.ZodTypeAny {
  return lifecycleSchema(action, z.string());
}

/**
 * Parse the full upstream workflow response into the public lifecycle projection and bind it to
 * the requested workflow. Unknown full-workflow fields are deliberately stripped.
 */
export function parseWorkflowLifecycleMetadata(
  value: unknown,
  expectedWorkflowId: string,
  action: WorkflowLifecycleAction,
): Record<string, unknown> {
  const parsed = lifecycleSchema(action, z.union([z.string(), z.number()]).transform(String)).parse(
    value,
  );
  if (parsed.id !== expectedWorkflowId) {
    throw new Error(`n8n returned a different workflow identity after ${action}.`);
  }
  return parsed;
}
