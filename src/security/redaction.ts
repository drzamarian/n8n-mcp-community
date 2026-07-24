import { isOfficialN8nDocumentationUrl } from "../content/official-urls.js";

const SENSITIVE_KEY =
  /(?:api[-_]?key|authorization|bearer|cookie|credential|password|passphrase|passwd|pwd|secret|signature|token|private[-_]?key|client[-_]?secret)/i;
const PROTOTYPE_KEY = /^(?:__proto__|prototype|constructor)$/;
const STRUCTURAL_IDENTIFIER_KEY = /^(?:id|[A-Za-z][A-Za-z0-9]*Ids?)$/;
const STRUCTURAL_MAP_KEY = /^(?:connections|pinData|properties|runData)$/;
const SENSITIVE_DESCRIPTOR_VALUE_KEY = /^(?:default|example|examples|value)$/i;
const PHONE_SEMANTIC_KEY = /(?:phone|mobile|whatsapp|waId)/i;
const SAFE_IDENTIFIER_VALUE = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_CURSOR_VALUE = /^[\x21-\x7e]{1,2048}$/;
const SAFE_ERROR_FINGERPRINT_VALUE = /^[a-f0-9]{16}$/;
// Keep this narrow internal form synchronized with PRIVACY_LITERAL_SECRET in the
// Introspect rule catalog; importing Introspect here would reverse the security-layer dependency.
const SAFE_LITERAL_SECRET_FINDING_ID_VALUE = /^PRIVACY_LITERAL_SECRET:node-(?:[1-9]\d{0,2}|1000)$/;
const EMAIL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;
const PHONE_CANDIDATE = /(?:\+?\d[\d ().-]{7,}\d)/g;
const HIGH_CONFIDENCE_CREDENTIAL_REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_.-]{8,}\b/g, "[SECRET]"],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[SECRET]"],
  [/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[SECRET]"],
  [/\b(?:AKIA|ASIA)[A-Za-z0-9]{16,124}\b/g, "[SECRET]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[SECRET]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[SECRET]"],
];
const MANDATORY_VALUE_REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[JWT]"],
  [
    /\b((?:[A-Za-z][A-Za-z0-9_.-]{0,63})?(?:api[-_ ]?key|token|secret|passphrase|password|passwd|pwd|authorization|credential|signature|client[-_ ]?secret|private[-_ ]?key|connect\.sid|cookie|session[-_ ]?id|session[-_ ]?token|session[-_ ]?key|session)(?:[0-9]+|[A-Za-z])?)["']?\s*[:=]\s*(?:"[^"\\\r\n]*(?:\\.[^"\\\r\n]*)*"?|'[^'\\\r\n]*(?:\\.[^'\\\r\n]*)*'?|[^"'?,;&}\s]+)/gi,
    "$1=[REDACTED]",
  ],
];
const TOKEN_REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\b[A-Za-z0-9_+/=-]{40,}\b/g, "[TOKEN]"],
];
const VALUE_REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g, "[CNPJ]"],
  [/\d{3}\.\d{3}\.\d{3}-\d{2}/g, "[CPF]"],
  [/\bpix[\s:-]*[\w.@-]{8,}/gi, "[PIX]"],
  [/\b(?:[A-Z0-9]+_)*(?:SECRET|TOKEN|API_KEY)(?:_[A-Z0-9]+)+\b/gi, "[SECRET]"],
];
const OPAQUE_PATH_CHARACTERS = /^[A-Za-z0-9._~+/=-]+$/;
const OPAQUE_HEXADECIMAL_PATH = /^[A-Fa-f0-9]{24,64}$/;
const INJECTION_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [
    /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?\b/gi,
    "[FILTERED-INJECTION]",
  ],
  [/\b(?:system|assistant|developer)\s*:\s/gi, "[FILTERED-ROLE]: "],
  [/<\/?(?:system|assistant|developer|prompt|instructions?)>/gi, "[FILTERED-TAG]"],
];

export interface SanitizedOutput {
  readonly data: unknown;
  readonly redacted: boolean;
  readonly untrusted: true;
}

export interface SanitizationOptions {
  readonly preserveValidatedRootRecordValues?: boolean;
}

export interface SanitizationResult {
  readonly output: SanitizedOutput;
  readonly structurallyReduced: boolean;
}

export class OutputLimitError extends Error {
  constructor() {
    super("The sanitized result exceeds the output limit. Use narrower filters or pagination.");
    this.name = "OutputLimitError";
  }
}

interface SanitizationState {
  nodes: number;
  redacted: boolean;
  structurallyReduced: boolean;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function redactPhone(value: string): string {
  PHONE_CANDIDATE.lastIndex = 0;
  return value.replace(PHONE_CANDIDATE, (candidate) =>
    candidate.replace(/\D/g, "").length >= 10 ? "[PHONE]" : candidate,
  );
}

function redactBasicCredential(value: string): string {
  let output = value.replace(/\bBasic\s*:\s*[^\s,;]+/gi, "Basic [REDACTED]");
  output = output.replace(/\bBasic[ \t]+([^\s,;]*:[^\s,;]+)/gi, "Basic [REDACTED]");
  return output.replace(
    /\bBasic[ \t]+([A-Za-z0-9+/]{4,}={0,2})(?![A-Za-z0-9+/=])/gi,
    (candidate, encoded: string) => {
      try {
        return Buffer.from(encoded, "base64").toString("utf8").includes(":")
          ? "Basic [REDACTED]"
          : candidate;
      } catch {
        return candidate;
      }
    },
  );
}

function redactUrlCredential(value: string): string {
  // Redact userinfo credentials embedded in URLs (scheme://user:password@host) for
  // any host shape (dotted, single-label such as localhost, IPv4, bracketed IPv6)
  // and percent-encoded credentials, without touching URLs that carry no userinfo.
  // The userinfo class excludes only the host/path/query delimiters, so it spans to
  // the LAST "@" before the host; this fully redacts passwords that contain a literal
  // "@" (e.g. mongodb://user:p@ss@host) instead of leaking the suffix. The scheme
  // quantifier is bounded so a long delimiter-free run cannot force quadratic backtracking.
  return value.replace(/([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)[^/?#\s]+@/g, "$1[REDACTED]@");
}

function looksLikeOpaquePathSegment(value: string): boolean {
  if (value.length < 24 || !OPAQUE_PATH_CHARACTERS.test(value)) return false;
  // Encoding-aware detection closes the entropy blind spot for fixed-width hexadecimal IDs:
  // repeated hex digits can carry 96+ bits while scoring below the generic Shannon threshold.
  if (OPAQUE_HEXADECIMAL_PATH.test(value)) return true;
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= (value.length >= 32 ? 3.5 : 4);
}

function sanitizeString(
  value: string,
  structuralKey?: string,
): { value: string; redacted: boolean } {
  const boundedInput = value.length > 131_072 ? value.slice(0, 131_072) : value;
  const normalizedInput = boundedInput.normalize("NFKC");
  let output = normalizedInput
    .slice(0, 131_072)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  let redacted =
    boundedInput !== value || normalizedInput.length > 131_072 || output !== boundedInput;
  for (const [pattern, replacement] of HIGH_CONFIDENCE_CREDENTIAL_REDACTIONS) {
    pattern.lastIndex = 0;
    const filtered = output.replace(pattern, replacement);
    redacted ||= filtered !== output;
    output = filtered;
  }
  if (structuralKey !== undefined && PHONE_SEMANTIC_KEY.test(structuralKey)) {
    const withPhone = redactPhone(output);
    redacted ||= withPhone !== output;
    output = withPhone;
  }
  const withoutBasicCredential = redactBasicCredential(output);
  redacted ||= withoutBasicCredential !== output;
  output = withoutBasicCredential;
  const withoutUrlCredential = redactUrlCredential(output);
  redacted ||= withoutUrlCredential !== output;
  output = withoutUrlCredential;
  const validatedInternalValueIsSafe =
    (structuralKey === "fingerprint" && SAFE_ERROR_FINGERPRINT_VALUE.test(output)) ||
    (structuralKey === "id" && SAFE_LITERAL_SECRET_FINDING_ID_VALUE.test(output)) ||
    ((structuralKey === "documentationUrl" || structuralKey === "officialUrl") &&
      isOfficialN8nDocumentationUrl(output));
  if (validatedInternalValueIsSafe) return { value: output, redacted };
  for (const [pattern, replacement] of MANDATORY_VALUE_REDACTIONS) {
    pattern.lastIndex = 0;
    const filtered = output.replace(pattern, replacement);
    redacted ||= filtered !== output;
    output = filtered;
  }
  for (const [pattern, replacement] of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    const filtered = output.replace(pattern, replacement);
    redacted ||= filtered !== output;
    output = filtered;
  }
  const structuralValueIsSafe =
    structuralKey === "nextCursor"
      ? SAFE_CURSOR_VALUE.test(output)
      : structuralKey !== undefined &&
        STRUCTURAL_IDENTIFIER_KEY.test(structuralKey) &&
        SAFE_IDENTIFIER_VALUE.test(output);
  if (structuralValueIsSafe) return { value: output, redacted };
  for (const [pattern, replacement] of TOKEN_REDACTIONS) {
    pattern.lastIndex = 0;
    const filtered = output.replace(pattern, replacement);
    redacted ||= filtered !== output;
    output = filtered;
  }
  for (const [pattern, replacement] of VALUE_REDACTIONS) {
    pattern.lastIndex = 0;
    const filtered = output.replace(pattern, replacement);
    redacted ||= filtered !== output;
    output = filtered;
  }
  const withEmail = output.replace(EMAIL, "[EMAIL]");
  redacted ||= withEmail !== output;
  output = withEmail;
  const withPhone = redactPhone(output);
  redacted ||= withPhone !== output;
  output = withPhone;
  if (output.length > 32_768) {
    output = `${output.slice(0, 32_767)}\u2026`;
    redacted = true;
  }
  return { value: output, redacted };
}

function sanitizeValue(
  value: unknown,
  state: SanitizationState,
  depth: number,
  structuralKey?: string,
  preserveChildKeys = false,
  sensitiveDescriptor = false,
  treatSensitiveKeyAsStructural = false,
): unknown {
  state.nodes += 1;
  if (state.nodes > 20_000 || depth > 20) {
    state.redacted = true;
    state.structurallyReduced = true;
    return "[TRUNCATED]";
  }
  if (typeof value === "string") {
    const result = sanitizeString(value, structuralKey);
    state.redacted ||= result.redacted;
    return result.value;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, 1_000);
    if (limit < value.length) {
      state.redacted = true;
      state.structurallyReduced = true;
    }
    return value
      .slice(0, limit)
      .map((item) =>
        sanitizeValue(item, state, depth + 1, structuralKey, false, sensitiveDescriptor),
      );
  }
  if (typeof value === "bigint") {
    state.redacted = true;
    state.structurallyReduced = true;
    return value.toString();
  }
  if (typeof value !== "object") {
    state.redacted = true;
    state.structurallyReduced = true;
    return "[UNSUPPORTED]";
  }

  const prototype = Reflect.getPrototypeOf(value);
  if (
    Buffer.isBuffer(value) ||
    value instanceof Map ||
    value instanceof Set ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    state.redacted = true;
    state.structurallyReduced = true;
    return "[UNSUPPORTED_OBJECT]";
  }

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    compareStrings(left, right),
  );
  const sensitiveSibling = entries.some(
    ([key, candidate]) =>
      (key === "key" || key === "name") &&
      typeof candidate === "string" &&
      SENSITIVE_KEY.test(candidate),
  );
  const originalKeys = new Set(entries.map(([key]) => key));
  for (const [entryIndex, [key, child]] of entries.slice(0, 1_000).entries()) {
    if (PROTOTYPE_KEY.test(key)) {
      state.redacted = true;
      continue;
    }
    const sanitizedKey = sanitizeString(key);
    let outputKey = key;
    if (sanitizedKey.redacted) {
      let placeholderIndex = entryIndex + 1;
      do {
        outputKey = `[REDACTED_KEY_${placeholderIndex}]`;
        placeholderIndex += 1;
      } while (originalKeys.has(outputKey) || Object.hasOwn(output, outputKey));
      state.redacted = true;
      state.structurallyReduced = true;
    }
    if (
      !treatSensitiveKeyAsStructural &&
      !preserveChildKeys &&
      SENSITIVE_KEY.test(key) &&
      !STRUCTURAL_IDENTIFIER_KEY.test(key)
    ) {
      output[outputKey] = "[REDACTED]";
      state.redacted = true;
      continue;
    }
    if (sensitiveDescriptor && SENSITIVE_DESCRIPTOR_VALUE_KEY.test(key)) {
      output[outputKey] = "[REDACTED]";
      state.redacted = true;
      continue;
    }
    if (sensitiveDescriptor && child !== null && typeof child === "object") {
      output[outputKey] = "[REDACTED]";
      state.redacted = true;
      continue;
    }
    if (key === "value" && sensitiveSibling) {
      output[outputKey] = "[REDACTED]";
      state.redacted = true;
      continue;
    }
    if (
      preserveChildKeys &&
      (SENSITIVE_KEY.test(key) || (structuralKey === "properties" && sanitizedKey.redacted))
    ) {
      if (structuralKey === "properties" && child !== null && typeof child === "object") {
        output[outputKey] = sanitizeValue(child, state, depth + 1, key, false, true);
      } else {
        output[outputKey] = "[REDACTED]";
        state.redacted = true;
      }
      continue;
    }
    output[outputKey] = sanitizeValue(
      child,
      state,
      depth + 1,
      key,
      STRUCTURAL_MAP_KEY.test(key),
      false,
    );
  }
  if (entries.length > 1_000) {
    state.redacted = true;
    state.structurallyReduced = true;
  }
  return output;
}

export function sanitizeForOutputDetailed(
  value: unknown,
  options: SanitizationOptions = {},
): SanitizationResult {
  const state: SanitizationState = { nodes: 0, redacted: false, structurallyReduced: false };
  const data = sanitizeValue(
    value,
    state,
    0,
    undefined,
    false,
    false,
    options.preserveValidatedRootRecordValues ?? false,
  );
  return {
    output: { data, redacted: state.redacted, untrusted: true },
    structurallyReduced: state.structurallyReduced,
  };
}

export function sanitizeForOutput(
  value: unknown,
  options: SanitizationOptions = {},
): SanitizedOutput {
  return sanitizeForOutputDetailed(value, options).output;
}

export function sanitizeLabelForOutput(value: string, maxLength = 120): string {
  const normalized = value.slice(0, 4_096).normalize("NFKC").slice(0, 4_096);
  const sanitized = sanitizeString(normalized).value.replace(/\s+/g, " ").trim();
  return sanitized.length <= maxLength
    ? sanitized
    : `${sanitized.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

export function sanitizePathSegmentForOutput(
  value: string,
  maxLength = 64,
): { readonly value: string; readonly redacted: boolean } {
  const normalized = value.slice(0, 4_096).normalize("NFKC").slice(0, 4_096);
  if (
    SENSITIVE_KEY.test(normalized) ||
    PROTOTYPE_KEY.test(normalized) ||
    looksLikeOpaquePathSegment(normalized)
  ) {
    return { value: "[REDACTED]", redacted: true };
  }
  const sanitized = sanitizeString(normalized);
  const compact = sanitized.value.replace(/\s+/g, " ").trim();
  if (sanitized.redacted || compact.length === 0) {
    return { value: "[REDACTED]", redacted: true };
  }
  return {
    value:
      compact.length <= maxLength
        ? compact
        : `${compact.slice(0, Math.max(0, maxLength - 1))}\u2026`,
    redacted: compact.length > maxLength,
  };
}

export function boundedJson(value: unknown, maxBytes = 256 * 1024): string {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > maxBytes) {
    throw new OutputLimitError();
  }
  return text;
}
