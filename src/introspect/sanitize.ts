import { createHash } from "node:crypto";
import { sanitizeForOutput, sanitizeLabelForOutput } from "../security/redaction.js";
import { IntrospectResultSchema, type Finding, type IntrospectResult } from "./contracts.js";

const SAFE_FINDING_ENTITY_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export function safeEntityKey(input: string): string {
  const normalized = input.replace(/[^A-Za-z0-9_-]/g, "_");
  if (normalized.length <= 128) return normalized || "unknown";
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `${normalized.slice(0, 95)}_${digest}`;
}

function hasConsistentFindingIdentity(finding: Finding): boolean {
  return (
    SAFE_FINDING_ENTITY_KEY.test(finding.affectedEntity.key) &&
    finding.id === `${finding.ruleId}:${safeEntityKey(finding.affectedEntity.key)}`
  );
}

export function sanitizeIntrospectResultForOutput(result: IntrospectResult): IntrospectResult {
  const sanitized = IntrospectResultSchema.parse(sanitizeForOutput(result).data);
  for (const [index, source] of result.findings.entries()) {
    const target = sanitized.findings[index];
    if (target === undefined || !hasConsistentFindingIdentity(source)) continue;
    target.affectedEntity.key = source.affectedEntity.key;
    target.id = `${target.ruleId}:${safeEntityKey(source.affectedEntity.key)}`;
  }
  return IntrospectResultSchema.parse(sanitized);
}

export function fingerprintError(error: unknown, nodeRef?: string): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const errorClass = typeof record.name === "string" ? record.name : "Error";
  const rawMessage = typeof record.message === "string" ? record.message.slice(0, 4_096) : "";
  const reducedMessage = rawMessage
    .normalize("NFKC")
    .replace(/"[^"]*"|'[^']*'/g, "[VALUE]")
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[UUID]")
    .replace(/\b\d+(?:\.\d+)?\b/g, "[NUMBER]")
    .replace(/\b[A-Za-z0-9_+/=-]{20,}\b/g, "[TOKEN]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  const material = `${errorClass.slice(0, 80)}|${nodeRef ?? "unknown"}|${reducedMessage}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export function optionalLabel(value: string, include: boolean): string | undefined {
  return include ? sanitizeLabelForOutput(value) : undefined;
}
