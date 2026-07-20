import type { N8nConnectionConfig } from "../config.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Bounded set of Public API path prefixes whose entire namespace is available only
 * from the documented n8n Community 2.30.5 floor onward (see docs/compatibility.md).
 * A 404 on one of these on an otherwise-reachable instance is a below-floor indicator,
 * so the upstream_error message names the floor. Kept deliberately narrow: `/workflows`
 * is excluded because it exists below the floor and its version-history 404 is already
 * mapped by the workflow tools, so guidance here would double-transform it.
 */
const FLOOR_MARKER_PATH_PREFIXES = ["/credentials", "/insights", "/community-packages"] as const;

const FLOOR_GUIDANCE =
  "This endpoint requires the documented support floor, n8n Community 2.30.5 or newer, or the resource does not exist.";

function isFloorMarkerPath(path: string): boolean {
  return FLOOR_MARKER_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function isSafeEncodedPath(path: string): boolean {
  if (!/^\/[A-Za-z0-9_./%~-]*$/.test(path) || /%(?![A-Fa-f0-9]{2})/.test(path)) {
    return false;
  }
  for (const rawSegment of path.split("/").slice(1)) {
    if (rawSegment === "") return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return false;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("%") ||
      /[\u0000-\u001f\u007f-\u009f]/.test(decoded)
    ) {
      return false;
    }
  }
  return true;
}

export class N8nApiError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "N8nApiError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly root?: boolean;
  readonly timeoutMs?: number;
  readonly responseMode?: "json" | "status";
}

async function readBounded(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new N8nApiError("response_too_large", "The n8n response exceeds the 2 MiB limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export class N8nClient {
  readonly #config: N8nConnectionConfig;

  constructor(config: N8nConnectionConfig) {
    this.#config = config;
  }

  async request(options: RequestOptions): Promise<unknown> {
    if (!isSafeEncodedPath(options.path)) {
      throw new N8nApiError("invalid_path", "The requested n8n API path is invalid.");
    }
    const prefix = options.root ? "" : "/api/v1";
    const basePath = this.#config.apiUrl.pathname.replace(/\/$/, "");
    const requestRoot = `${basePath}${prefix}`.replace(/\/{2,}/g, "/");
    const requestedPath = `${requestRoot}${options.path}`.replace(/\/{2,}/g, "/");
    const url = new URL(this.#config.apiUrl.href);
    url.pathname = requestedPath;
    url.search = "";
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const requiredPathPrefix = requestRoot === "" ? "/" : `${requestRoot}/`;
    if (
      url.origin !== this.#config.apiUrl.origin ||
      url.pathname !== requestedPath ||
      !url.pathname.startsWith(requiredPathPrefix)
    ) {
      throw new N8nApiError(
        "origin_mismatch",
        "The n8n request origin or API path changed unexpectedly.",
      );
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        throw new N8nApiError("request_too_large", "The n8n request exceeds the 2 MiB limit.");
      }
    }

    let response: Response;
    try {
      // Construct the headers inside the try so an API key that is not a legal HTTP
      // header value maps to the constant request_failed message instead of a raw
      // TypeError whose text can embed the key.
      const headers = new Headers({ "X-N8N-API-KEY": this.#config.apiKey });
      if (body !== undefined) headers.set("Content-Type", "application/json");
      response = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      throw new N8nApiError(
        "request_failed",
        "The n8n request failed before a response was received.",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new N8nApiError(
        "redirect_rejected",
        "The n8n response attempted a redirect.",
        response.status,
      );
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength &&
      /^\d+$/.test(contentLength) &&
      Number(contentLength) > MAX_RESPONSE_BYTES
    ) {
      await response.body?.cancel();
      throw new N8nApiError("response_too_large", "The n8n response exceeds the 2 MiB limit.");
    }
    const bytes = await readBounded(response);
    if (!response.ok) {
      // A 404 on a floor-marker Public API path (namespaces present only from the
      // documented 2.30.5 floor) carries a stable, secret-free guidance sentence naming
      // the floor. The error code and status are unchanged, so any tool-level 404 mapping
      // that keys on error.status still fires; this only enriches the message additively.
      const base = `The n8n API returned HTTP ${response.status}.`;
      const message =
        response.status === 404 && !options.root && isFloorMarkerPath(options.path)
          ? `${base} ${FLOOR_GUIDANCE}`
          : base;
      throw new N8nApiError("upstream_error", message, response.status);
    }
    if (options.responseMode === "status") {
      return { ok: true, status: response.status };
    }
    if (bytes.byteLength === 0) return null;
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new N8nApiError("invalid_json", "The n8n API returned invalid JSON.");
    }
  }
}
